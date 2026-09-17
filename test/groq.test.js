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

// --- model aliasing and fallback ------------------------------------------

function seqFetch(replies, seen) {
  let i = 0;
  return async (url, init) => {
    seen.push(JSON.parse(init.body).model);
    const r = replies[i++];
    if (r.status) return { ok: false, status: r.status, text: async () => r.text };
    return { ok: true, json: async () => r.json };
  };
}

const okReply2 = { choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] };

test('a decommissioned model falls back to the secondary model', async () => {
  const seen = [];
  const client = createGroqClient('k', {
    fetchImpl: seqFetch(
      [{ status: 404, text: '{"error":{"message":"The model `openai/gpt-oss-20b` does not exist"}}' },
       { json: okReply2 }],
      seen
    ),
  });
  const r = await client.messages.create({ max_tokens: 10, system: 'S', messages: [] });
  assert.equal(r.content[0].text, 'OK');
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1], 'must retry on a different model');
});

test('a rate limit does NOT fall back — it would burn a second quota and hide the limit', async () => {
  const seen = [];
  const client = createGroqClient('k', {
    fetchImpl: seqFetch([{ status: 429, text: 'rate limit reached' }, { json: okReply2 }], seen),
  });
  await assert.rejects(() => client.messages.create({ max_tokens: 10, system: 'S', messages: [] }),
    (e) => e.status === 429);
  assert.equal(seen.length, 1, 'must not retry on 429');
});

test('a provider 5xx does not fall back either', async () => {
  const seen = [];
  const client = createGroqClient('k', {
    fetchImpl: seqFetch([{ status: 503, text: 'upstream unavailable' }, { json: okReply2 }], seen),
  });
  await assert.rejects(() => client.messages.create({ max_tokens: 10, system: 'S', messages: [] }));
  assert.equal(seen.length, 1);
});

test('a non-model 400 does not fall back', async () => {
  const seen = [];
  const client = createGroqClient('k', {
    fetchImpl: seqFetch([{ status: 400, text: 'invalid temperature' }, { json: okReply2 }], seen),
  });
  await assert.rejects(() => client.messages.create({ max_tokens: 10, system: 'S', messages: [] }));
  assert.equal(seen.length, 1);
});

// --- usage / headroom reporting -------------------------------------------

function hdrs(map) {
  return { get: (k) => (k.toLowerCase() in map ? map[k.toLowerCase()] : null) };
}

test('limits() is null until a call has happened — it never guesses', () => {
  const c = createGroqClient('k');
  const l = c.limits();
  assert.equal(l.callsLeft, null);
  assert.equal(l.avgTokensPerCall, null);
});

test('reads Groq rate-limit headers and reports calls remaining', async () => {
  const client = createGroqClient('k', {
    fetchImpl: async () => ({
      ok: true,
      headers: hdrs({
        'x-ratelimit-limit-requests': '1000',
        'x-ratelimit-remaining-requests': '940',
        'x-ratelimit-limit-tokens': '8000',
        'x-ratelimit-remaining-tokens': '6000',
        'x-ratelimit-reset-tokens': '7.66s',
        'x-ratelimit-reset-requests': '2m59.5s',
      }),
      json: async () => ({
        choices: [{ message: { content: 'x' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 900, completion_tokens: 100, total_tokens: 1000,
                 prompt_tokens_details: { cached_tokens: 400 } },
      }),
    }),
  });
  await client.messages.create({ max_tokens: 10, system: 'S', messages: [] });
  const l = client.limits();

  assert.equal(l.requestsLeft, 940);
  assert.equal(l.tokensLeft, 6000);
  assert.equal(l.avgTokensPerCall, 1000);
  // 6000 tokens / 1000 per call = 6 calls; 940 requests left. Tokens bind.
  assert.equal(l.callsLeft, 6);
  assert.equal(l.boundBy, 'tokens');
  assert.equal(l.resetsInMs.tokens, 7660);
  assert.equal(l.resetsInMs.requests, 179500);
  assert.equal(l.observed.cachedTokens, 400);
});

test('reports requests as the binding constraint when they run out first', async () => {
  const client = createGroqClient('k', {
    fetchImpl: async () => ({
      ok: true,
      headers: hdrs({ 'x-ratelimit-remaining-requests': '3', 'x-ratelimit-remaining-tokens': '7000' }),
      json: async () => ({
        choices: [{ message: { content: 'x' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 90, completion_tokens: 10, total_tokens: 100 },
      }),
    }),
  });
  await client.messages.create({ max_tokens: 10, system: 'S', messages: [] });
  const l = client.limits();
  assert.equal(l.callsLeft, 3);
  assert.equal(l.boundBy, 'requests');
});

test('rate-limit headers are read from error responses too', async () => {
  const client = createGroqClient('k', {
    fetchImpl: async () => ({
      ok: false, status: 429,
      headers: hdrs({ 'x-ratelimit-remaining-tokens': '0', 'x-ratelimit-reset-tokens': '30s' }),
      text: async () => 'rate limit reached',
    }),
  });
  await assert.rejects(() => client.messages.create({ max_tokens: 10, system: 'S', messages: [] }));
  const l = client.limits();
  assert.equal(l.tokensLeft, 0);
  assert.equal(l.resetsInMs.tokens, 30000);
});

// --- reasoning models ------------------------------------------------------

test('output_config.effort maps onto reasoning_effort instead of being dropped', async () => {
  const cap = {};
  const client = createGroqClient('k', { fetchImpl: fakeFetch(cap, okReply) });
  await client.messages.create({
    max_tokens: 6000, system: 'S', messages: [],
    output_config: { effort: 'medium' },
  });
  assert.equal(cap.body.reasoning_effort, 'medium');
  assert.equal(cap.body.max_completion_tokens, 6000, 'reasoning models use max_completion_tokens');
  assert.ok(!('output_config' in cap.body));
});

test('reasoning effort defaults to low — hidden reasoning is the costliest thing on a token-bound free tier', async () => {
  const cap = {};
  const client = createGroqClient('k', { fetchImpl: fakeFetch(cap, okReply) });
  await client.messages.create({ max_tokens: 100, system: 'S', messages: [] });
  assert.equal(cap.body.reasoning_effort, 'low');
});

test('an unrecognised effort value falls back to low rather than being sent through', async () => {
  const cap = {};
  const client = createGroqClient('k', { fetchImpl: fakeFetch(cap, okReply) });
  await client.messages.create({
    max_tokens: 100, system: 'S', messages: [], output_config: { effort: 'maximum' },
  });
  assert.equal(cap.body.reasoning_effort, 'low');
});
