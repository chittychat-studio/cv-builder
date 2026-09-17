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

function createGroqClient(apiKey, { fetchImpl, model } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const chosenModel = model || DEFAULT_MODEL;
  const fallbackModel = FALLBACK_MODEL;

  return {
    isGroq: true,
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

        const body = {
          model: modelId,
          max_tokens: params.max_tokens,
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
