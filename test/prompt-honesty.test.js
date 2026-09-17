'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { SYSTEM_PROMPT } = require('../lib/anthropic');

// These guard properties we decided deliberately. If someone "improves" the
// prompt later by promising ATS rankings or keyword stuffing, these fail.

test('the prompt does not claim an ATS ranks or scores CVs', () => {
  assert.match(SYSTEM_PROMPT, /does not rank or\s*'?\s*\+?\s*'?reject/i);
  assert.ok(!/top \d+|rank(ing)? higher|beat the ATS|ATS score/i.test(SYSTEM_PROMPT),
    'must not promise a ranking position that ATS software does not produce');
});

test('keyword alignment is bounded by what the candidate actually did', () => {
  assert.match(SYSTEM_PROMPT, /Never introduce a tool, system or skill absent from the facts/);
  assert.match(SYSTEM_PROMPT, /claiming experience they do not have is not/);
});

test('missing search terms are reported honestly, never inserted', () => {
  assert.match(SYSTEM_PROMPT, /Never tell them to insert a\s*'?\s*\+?\s*'?term they cannot back up/);
});

test('the no-invention rule survives', () => {
  assert.match(SYSTEM_PROMPT, /Use ONLY supplied facts/);
  assert.match(SYSTEM_PROMPT, /Never invent a number/);
});

test('the prompt clears Groq\'s minimum cacheable prefix', () => {
  const approxTokens = SYSTEM_PROMPT.length / 4;
  assert.ok(approxTokens > 1024,
    `system prompt is ~${Math.round(approxTokens)} tokens; needs >1024 to cache on any Groq model`);
});
