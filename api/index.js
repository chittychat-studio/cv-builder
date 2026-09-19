'use strict';

/**
 * Vercel entry point.
 *
 * server.js already exports createApp() and only calls listen() when run
 * directly, so the same app object serves both hosts: Render runs
 * `node server.js`, Vercel invokes this handler. No fork, no second codebase.
 *
 * Only /api/* reaches here — vercel.json serves public/ as static assets from
 * the CDN, which is the whole point of the move: the page loads instantly
 * instead of waiting on a cold container.
 *
 * vercel.json uses the explicit builds/routes form rather than
 * outputDirectory + rewrites. Auto-detection sees package.json's Express
 * dependency, classifies this as a backend framework project, and then looks
 * for a server entrypoint inside the output directory -- "No entrypoint found
 * in output directory: public". Declaring both builds removes the guesswork.
 *
 * KNOWN LIMITATION (CLAUDE.md D14): Vercel functions are stateless between
 * invocations, so the in-memory rate limiter, the daily token ledger and the
 * Groq rate-limit header state do not persist reliably. Per-visitor limits are
 * best-effort here. The backstop is Groq's own free-tier ceiling (1,000
 * requests and 200,000 tokens a day, no billing attached), so the worst case is
 * students being refused, not a bill.
 */
const { createApp } = require('../server');

const app = createApp();

module.exports = (req, res) => app(req, res);
