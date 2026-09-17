'use strict';

/**
 * Groq adapter presenting the Anthropic Messages shape.
 *
 * Every call helper in lib/anthropic.js takes a `client` and calls
 * client.messages.create({...}). This implements that one method against Groq's
 * OpenAI-compatible endpoint, so all nine AI routes work unchanged — no call
 * sites touched, no prompts rewritten, checkStopReason() still works.
 *
 * Translated:
 *   system: string | [{type:'text', text, cache_control}]  -> system message
 *   messages[].content: string | content blocks            -> flattened text
 *   output_config.format.json_schema                       -> response_format
 *   output_config.effort                                   -> dropped (no equivalent)
 *   cache_control                                          -> dropped (Groq caches
 *                                                            automatically, prefix-based)
 * Returned:
 *   {content:[{type:'text',text}], stop_reason}  with finish_reason mapped so
 *   truncation and refusal still fail closed rather than returning partial text.
 */
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

// Every Claude model the app names collapses onto one free-tier model.
//
// These are Groq model ALIASES, not pinned snapshots: Groq does not expose
// dated versions for open models, so the weights behind a name can change and
// a name can be decommissioned outright. FALLBACK_MODEL covers that — it is
// deliberately same-family, because structured-output (json_schema) support
// differs between families and the interview route depends on it.
const DEFAULT_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';
const FALLBACK_MODEL = process.env.GROQ_MODEL_FALLBACK || 'openai/gpt-oss-120b';

// Only a model being gone justifies a retry on another model. A 429 must NOT
// fall back — that would burn a second quota and hide the rate limit from the
// caller, which is exactly the silent degradation we refuse to do. 5xx is a
// provider blip, not a missing model, so it propagates too.
function isModelUnavailable(status, detail) {
  if (status !== 400 && status !== 404) return false;
  return /model|decommission|deprecat|not.?found|does not exist/i.test(detail || '');
}

function flatten(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && (b.type === 'text' || typeof b.text === 'string'))
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

function mapStopReason(finish) {
  if (finish === 'length') return 'max_tokens';
  if (finish === 'content_filter') return 'refusal';
  return 'end_turn';
}

/**
 * Groq reports its own rate-limit state on every response. Reading those is
 * strictly better than estimating token spend locally: it is the provider's
 * accounting, it already knows about cached tokens (which do not count toward
 * limits), and it survives restarts of our process being out of step.
 *
 * "x-ratelimit-reset-*" come back as durations like "7.66s" or "2m59.56s".
 */
function parseReset(v) {
  if (!v) return null;
  const m = String(v).match(/(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?/);
  if (!m) return null;
  const mins = Number(m[1] || 0), secs = Number(m[2] || 0);
  const ms = Math.round((mins * 60 + secs) * 1000);
  return ms > 0 ? ms : null;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function createGroqClient(apiKey, { fetchImpl, model } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const chosenModel = model || DEFAULT_MODEL;
  const fallbackModel = FALLBACK_MODEL;

  // Last-seen provider limits, plus our own running totals. In-memory and
  // single-instance, like every other counter in this app.
  const state = {
    requestsRemaining: null, requestsLimit: null, requestsResetMs: null,
    tokensRemaining: null, tokensLimit: null, tokensResetMs: null,
    updatedAt: null,
    calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0,
    avgTokensPerCall: null,
  };

  // Rolling 24h ledger of tokens we have actually spent. Groq's headers tell us
  // what is left in the CURRENT window, but not which window, so this is the
  // figure the daily budget is enforced on: measured, ours, unambiguous.
  const DAY_MS = 24 * 60 * 60 * 1000;
  let spend = [];   // [{t, tokens}]
  function tokensUsedLast24h() {
    const cut = Date.now() - DAY_MS;
    if (spend.length > 500) spend = spend.filter((e) => e.t >= cut);
    return spend.reduce((n, e) => (e.t >= cut ? n + e.tokens : n), 0);
  }

  function readLimits(headers) {
    if (!headers || typeof headers.get !== 'function') return;
    const rr = num(headers.get('x-ratelimit-remaining-requests'));
    const rl = num(headers.get('x-ratelimit-limit-requests'));
    const tr = num(headers.get('x-ratelimit-remaining-tokens'));
    const tl = num(headers.get('x-ratelimit-limit-tokens'));
    if (rr !== null) state.requestsRemaining = rr;
    if (rl !== null) state.requestsLimit = rl;
    if (tr !== null) state.tokensRemaining = tr;
    if (tl !== null) state.tokensLimit = tl;
    state.requestsResetMs = parseReset(headers.get('x-ratelimit-reset-requests')) ?? state.requestsResetMs;
    state.tokensResetMs = parseReset(headers.get('x-ratelimit-reset-tokens')) ?? state.tokensResetMs;
    state.updatedAt = Date.now();
  }

  function recordUsage(usage) {
    if (!usage) return;
    state.calls += 1;
    state.promptTokens += usage.prompt_tokens || 0;
    state.completionTokens += usage.completion_tokens || 0;
    state.totalTokens += usage.total_tokens || 0;
    const cached = usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens;
    state.cachedTokens += cached || 0;
    state.avgTokensPerCall = Math.round(state.totalTokens / state.calls);
    spend.push({ t: Date.now(), tokens: usage.total_tokens || 0 });

    // Token counts only -- never prompt or completion text (D3). Gives the
    // deploy log the same picture /api/usage serves, so headroom is visible
    // without hitting the endpoint.
    const left = state.tokensRemaining !== null ? state.tokensRemaining : '?';
    const reqLeft = state.requestsRemaining !== null ? state.requestsRemaining : '?';
    console.log(
      `${new Date().toISOString()} groq-usage in=${usage.prompt_tokens || 0} ` +
      `out=${usage.completion_tokens || 0} cached=${cached || 0} ` +
      `avg=${state.avgTokensPerCall} tokens-left=${left} requests-left=${reqLeft}`
    );
  }

  return {
    isGroq: true,
    model: chosenModel,

    /**
     * What's left before the free tier fills up.
     *
     * requestsLeft / tokensLeft come from Groq's own headers. callsLeft is the
     * binding one: whichever of the two runs out first, expressed in requests,
     * using our measured average tokens per call. Null until the first call --
     * we do not guess, because a made-up number here is worse than no number.
     */
    limits() {
      const avg = state.avgTokensPerCall;
      const byTokens = (state.tokensRemaining !== null && avg) ? Math.floor(state.tokensRemaining / avg) : null;
      const byRequests = state.requestsRemaining;
      let callsLeft = null, boundBy = null;
      if (byTokens !== null && byRequests !== null) {
        callsLeft = Math.min(byTokens, byRequests);
        boundBy = byTokens <= byRequests ? 'tokens' : 'requests';
      } else if (byTokens !== null) { callsLeft = byTokens; boundBy = 'tokens'; }
      else if (byRequests !== null) { callsLeft = byRequests; boundBy = 'requests'; }

      const usedToday = tokensUsedLast24h();
      return {
        model: chosenModel,
        tokensUsedLast24h: usedToday,
        requestsLeft: state.requestsRemaining, requestsLimit: state.requestsLimit,
        tokensLeft: state.tokensRemaining, tokensLimit: state.tokensLimit,
        resetsInMs: { requests: state.requestsResetMs, tokens: state.tokensResetMs },
        avgTokensPerCall: avg,
        callsLeft, boundBy,
        observed: {
          calls: state.calls, totalTokens: state.totalTokens,
          promptTokens: state.promptTokens, completionTokens: state.completionTokens,
          cachedTokens: state.cachedTokens,
        },
        measuredAt: state.updatedAt,
      };
    },

    tokensUsedLast24h,

    messages: {
      async create(params = {}) {
        try {
          return await send(chosenModel, params);
        } catch (err) {
          if (err && err.modelUnavailable && fallbackModel && fallbackModel !== chosenModel) {
            // Status only — never the prompt or the response body (D3).
            console.log(`${new Date().toISOString()} groq model-fallback ${chosenModel}->${fallbackModel}`);
            return await send(fallbackModel, params);
          }
          throw err;
        }
      },
    },
  };

  async function send(modelId, params) {
        const messages = []; // eslint-disable-line

        const systemText = flatten(params.system);
        if (systemText) messages.push({ role: 'system', content: systemText });

        for (const m of params.messages || []) {
          messages.push({ role: m.role, content: flatten(m.content) });
        }

        // gpt-oss models are REASONING models: they emit hidden reasoning tokens
        // that count against the completion budget. Two consequences.
        //
        // 1. Groq documents max_completion_tokens for these, not max_tokens.
        //    Both are sent so the adapter still works against a non-reasoning
        //    OpenAI-compatible endpoint.
        // 2. output_config.effort is Anthropic's knob for the same thing and
        //    this app already sets it deliberately (medium to generate a CV,
        //    low for an interview turn). It maps straight onto reasoning_effort
        //    instead of being dropped. Default is "low": on a free tier whose
        //    binding limit is tokens per day, invisible reasoning is the most
        //    expensive thing we can buy without seeing it.
        const effort = (params.output_config && params.output_config.effort) || 'low';
        const body = {
          model: modelId,
          max_tokens: params.max_tokens,
          max_completion_tokens: params.max_tokens,
          reasoning_effort: ['low','medium','high'].includes(effort) ? effort : 'low',
          temperature: 0.3,
          messages,
        };

        // Structured output (interviewTurn) — Anthropic's output_config.format
        // maps onto the OpenAI-compatible response_format.
        const fmt = params.output_config && params.output_config.format;
        if (fmt && fmt.type === 'json_schema' && fmt.schema) {
          body.response_format = {
            type: 'json_schema',
            json_schema: { name: 'response', schema: fmt.schema, strict: true },
          };
        }

        const resp = await doFetch(GROQ_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        readLimits(resp.headers);
        if (!resp.ok) {
          const detail = await resp.text().catch(() => '');
          const err = new Error(`groq: HTTP ${resp.status}`);
          err.status = resp.status;
          // Status only in the message; detail kept off the log path (D3).
          err.detail = detail.slice(0, 500);
          err.modelUnavailable = isModelUnavailable(resp.status, detail);
          throw err;
        }

        const data = await resp.json();
        recordUsage(data.usage);
        const choice = (data.choices && data.choices[0]) || {};
        const text = (choice.message && choice.message.content) || '';

        return {
          content: [{ type: 'text', text }],
          stop_reason: mapStopReason(choice.finish_reason),
          usage: data.usage,
          model: data.model,
        };
  }
}

module.exports = { createGroqClient, GROQ_URL, DEFAULT_MODEL, FALLBACK_MODEL, isModelUnavailable };
