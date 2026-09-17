'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createGroqClient } = require('../lib/groq');

function fakeFetch(captured, reply) {
  return async (url, init) => {
    captured.url = url;
    captured.body = JSON.parse(init.body);
    captured.auth = init.headers.Authorization;
    return {
      ok: true,
      json: async () => reply,
    };
  };
}

const okReply = { choices: [{ message: { content: 'HELLO' }, finish_reason: 'stop' }], usage: { total_tokens: 10 } };

test('flattens an Anthropic content-block system prompt into a system message', async () => {
  const cap = {};
  const client = createGroqClient('k', { fetchImpl: fakeFetch(cap, okReply) });
  await client.messages.create({
    model: 'claude-opus-5',
    max_tokens: 100,
    system: [{ type: 'text', text: 'SYSTEM RULES', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: 'facts here' }],
  });
  assert.deepEqual(cap.body.messages[0], { role: 'system', content: 'SYSTEM RULES' });
  assert.deepEqual(cap.body.messages[1], { role: 'user', content: 'facts here' });
});

test('flattens content-block message bodies (the cached interview transcript turn)', async () => {
  const cap = {};
  const client = createGroqClient('k', { fetchImpl: fakeFetch(cap, okReply) });
  await client.messages.create({
    max_tokens: 100,
    system: 'S',
    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'prior turn', cache_control: { type: 'ephemeral' } }] }],
  });
  assert.equal(cap.body.messages[1].content, 'prior turn');
});

test('maps output_config json_schema onto response_format', async () => {
  const cap = {};
  const schema = { type: 'object', properties: { done: { type: 'boolean' } }, required: ['done'] };
  const client = createGroqClient('k', { fetchImpl: fakeFetch(cap, okReply) });
  await client.messages.create({
    max_tokens: 100,
    system: 'S',
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: 'go' }],
  });
  assert.equal(cap.body.response_format.type, 'json_schema');
  assert.deepEqual(cap.body.response_format.json_schema.schema, schema);
  assert.ok(!('output_config' in cap.body), 'output_config must not be forwarded');
});

test('returns the Anthropic content shape so existing call sites are unchanged', async () => {
  const client = createGroqClient('k', { fetchImpl: fakeFetch({}, okReply) });
  const r = await client.messages.create({ max_tokens: 10, system: 'S', messages: [] });
  assert.deepEqual(r.content, [{ type: 'text', text: 'HELLO' }]);
  assert.equal(r.stop_reason, 'end_turn');
});

// Fail closed: truncation and refusal must still be detected by checkStopReason.
test('truncation maps to stop_reason max_tokens, not a silent partial answer', async () => {
  const reply = { choices: [{ message: { content: 'half an ans' }, finish_reason: 'length' }] };
  const client = createGroqClient('k', { fetchImpl: fakeFetch({}, reply) });
  const r = await client.messages.create({ max_tokens: 10, system: 'S', messages: [] });
  assert.equal(r.stop_reason, 'max_tokens');
});

test('a content filter maps to stop_reason refusal', async () => {
  const reply = { choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] };
  const client = createGroqClient('k', { fetchImpl: fakeFetch({}, reply) });
  const r = await client.messages.create({ max_tokens: 10, system: 'S', messages: [] });
  assert.equal(r.stop_reason, 'refusal');
});

test('an HTTP error throws with status only — no response body in the message', async () => {
  const client = createGroqClient('k', {
    fetchImpl: async () => ({ ok: false, status: 429, text: async () => 'quota exceeded for user X' }),
  });
  await assert.rejects(
    () => client.messages.create({ max_tokens: 10, system: 'S', messages: [] }),
    (e) => e.status === 429 && !/quota exceeded/.test(e.message)
  );
});
