> ## ⚠️ READ FIRST — this document was written against a STALE CLONE (18 Sep 2026)
>
> The local working copy was **9 commits behind `origin/main`**. `git log` showed a single
> "Initial commit"; `git fetch` was never run, so the whole analysis below was done against a
> much earlier, much smaller version of the app.
>
> **The real app has 9 AI endpoints, not 4:** `/api/generate-cv`, `/api/tailor`,
> `/api/suggest`, `/api/polish`, `/api/diagnose`, `/api/keyword-gap`, `/api/interview`,
> `/api/extract-text`, `/api/import-cv`, plus `/api/fetch-job` and a JobPilot integration
> (`JOBPILOT_API_URL` / `JOBPILOT_API_TOKEN`). It uses four different models
> (`claude-opus-5` generate, `claude-sonnet-5` light, `claude-haiku-4-5` extract,
> `claude-sonnet-5` interview at 8,000 max_tokens), has a `MONTHLY_AI_LIMIT` spend cap,
> typed refusal/truncation errors, and `BETA_MODE` now defaults to **false** (paid mode).
>
> **Still valid:** the CertSafari findings (§1 and its corrections) and the economic
> reasoning — those came from observation, not from this repo.
> **Void:** every endpoint-specific claim, the token arithmetic, D8, D11, and the D13 sizing.
> Redo against the real code before acting on any of it.

# CLAUDE.md — CV Builder

## Decision record

Analysis behind these: `FREE-SAAS-MIGRATION.md`.

### D1 — Free for school leavers, permanently (18 Sep 2026)
No paid plan for the school-leaver audience. Lemon Squeezy is **not** deleted — it is
retained for D2.

### D2 — Paid tiers for working professionals, later (18 Sep 2026)
A second audience (working employees) gets tier membership. `lib/licensing.js` and
`lib/providers/lemonsqueezy.js` are kept intact for this. Accounts, if ever introduced,
appear only on that adult tier.

### D3 — Account-less. Turnstile bot check only (18 Sep 2026)
No user accounts, no login, no database, no CV content stored server-side.
Rationale: users are 16–18, i.e. minors. Staying account-less keeps the product outside
the ICO Age Appropriate Design Code and preserves the existing "we store nothing" position.
Abuse control is a Cloudflare Turnstile challenge on model endpoints (free, no PII) plus an
Origin check — not authentication.
Consequence: quota buckets on an anonymous browser ID + an IP ceiling, never on a user.

### D4 — Free-tier model provider, OpenAI-*compatible*, not OpenAI (18 Sep 2026)
**OpenAI has no free API tier** — api.openai.com bills from the first token. The plan is an
OpenAI-*compatible* free tier so the existing SDK and call shape work unchanged.
**Chosen: Groq.** 14,400 req/day, 6,000 tok/min (Llama 3.1 8B), no training note,
OpenAI-compatible so `lib/providers/ai/` can use the OpenAI SDK shape unchanged.
Fallbacks, if Groq's terms or limits change (source: github.com/cheahjs/free-llm-api-resources,
figures unverified):
- **Cerebras** — 1M tok/day but 5 req/min. Fallback.
- **Cloudflare Workers AI** — 10,000 neurons/day. Unit needs converting.
- **Google AI Studio (Gemma 4)** — 14,400 req/day, 30 req/min. Training reportedly applies
  outside UK/EEA only; **must be verified before use**, not taken second-hand.
Ruled out on data: Mistral La Plateforme (requires opting into training), Kilo Gateway,
OpenCode Zen. Ruled out on quota: OpenRouter (50/day), Cohere (1,000/month), Gemini Flash
tiers (20/day).
Open: fabrication test against the chosen provider before it ships (see D6).

### D5 — Quota exhaustion fails closed, with an honest message (18 Sep 2026)
The quota is global and shared across all users on one key, so exhaustion is not any
individual's fault and there is no account to "log back into". On exhaustion the app returns
a stated reason and the UI says the writing help is at today's limit and the CV is complete
and downloadable. It never silently degrades or produces a plausible-looking substitute.

### D6 — Gate: small-model fabrication test before shipping
`POLISH_PROMPT` forbids adding numbers, dates, tools, organisations or outcomes the student
did not state. Small models are weakest on exactly these negative constraints. Before any
free-tier provider goes live: run a fixed set of rough notes through it and count
fabrications. A provider that invents a grade or employer is rejected regardless of price.

## Standing constraints
- Users are minors. No accounts, no CV content persisted, logs carry timestamps and statuses only.
- Deterministic path must work with the model switched off entirely.
- Any batch API spend is approved explicitly and estimated first.

### D7 — Every AI call goes through the free tier (18 Sep 2026)
No endpoint calls a paid API. All four model endpoints route through `lib/providers/ai/`
pointed at Groq (D4). Anthropic is retained only as a provider implementation for the future
paid professional tier (D2), never for the school-leaver product.

Consequence to design around: Groq's free limit is **6,000 tokens/minute shared across the
whole site**, not per user.
- `/api/import-cv` currently sends up to 15,000 characters (~3,750 tokens in, 1,500 cap out).
  **One import consumes most of a minute's budget for every user at once.** It must be cut
  down or dropped before D7 ships.
- `/api/generate-cv` at 2,000 max_tokens is the next worst offender — resolved by the
  feedback-only change below.

### D8 — The deterministic CV renderer already exists (18 Sep 2026, finding)
`public/cv-builder.html` `render()` (~line 734) already builds the complete CV from the form
fields client-side, with `formCVHtml` / `aiCVHtml` and a view toggle; PDF and Word export
work off whichever view is shown, and `viewMode` already defaults to `"form"`.
So `lib/render/cv.js` is **not needed** — the deterministic path is already the default and
already works with the model switched off. `/api/generate-cv` is producing an *alternative*
view, not the only one.
Consequence: shrinking `generate-cv` to feedback-only is a deletion, not a build.

### D9 — Rate-limit UX: bounded queue, honest wait, no vanity counter (18 Sep 2026)
Groq's 6,000 tokens/min is shared site-wide, so queueing is only viable once payloads are
small. Order: shrink payloads first, then queue.
- `/api/import-cv`: cut to ~3,000 chars in / 600 out before D7 ships (or drop it — school
  leavers have no CV to import).
- Queue is **bounded**: max depth and max wait (~60s). Past the bound, fail closed with D5's
  message. An unbounded queue under a burst is a slower outage, not a feature.
- Show the student **their** position and ETA, not a vanity count. A site-wide concurrency
  number appears only as the explanation during a wait ("12 requests ahead, ~25s") and never
  as an always-on counter — at launch traffic it would advertise an empty product.
- Counter is in-memory, stores nothing, resets on deploy. Same single-instance caveat as the
  quota.

### D10 — Security scope: guardrails sized to the real threat model (18 Sep 2026)
**There is no agent in this app** — four stateless prompt-in/text-out calls, no tools, no
filesystem, no autonomy. Agent-permission scoping does not apply and is not built.

In scope:
1. **Untrusted input is data, never instructions.** `/api/import-cv` parses PDF/DOCX from
   strangers — the one real injection surface. Extracted text is delimited, labelled as data
   to the model, and the returned JSON is shape-validated before use.
2. **Request middleware** ("hooks"): runs before and after every model call — injection
   screening on input, fabrication check on output, refusal logging.
3. **Output validation (added, not requested — and the highest-value control).** A free small
   model inventing a grade or employer is likelier than a successful injection and more
   damaging, because it lands on a real CV. Assert every proper noun, number and date in
   polished output appears in the student's input. Mechanical, cheap, catches D6's failure
   mode at runtime rather than only in tests.
4. **Env scoping.** One config module reads `process.env` once at boot; nothing else touches
   it. Today `server.js` reads it in several places.
5. **Eval suite.** Fixed corpus of rough notes and dirty CVs; asserts no invented grades,
   employers or dates, and that injection strings in an uploaded CV do not alter behaviour.
   Runs against the provider before shipping and on every provider change. This is D6's gate.
6. **Audit logging.** Keep the existing status-only discipline (never CV content). Add: which
   requests were refused, and why.
7. **DAST scan** of the endpoints once they change.

Out of scope, with reasons:
- **Training a security classifier.** Training data would be real CVs — minors' personal data,
  collected and retained. That undoes D3. At this volume, rule checks plus the model's own
  refusal are sufficient.
- **Agent permission scoping.** Nothing to scope.

### D11 — `/api/import-cv` is removed (18 Sep 2026)
Confirmed unused in the live Render deployment. Removing it:
- eliminates the endpoint that breaks D7 on its own (~5,250 tokens against a 6,000/min
  site-wide budget);
- **eliminates the only genuine prompt-injection surface in the app** — it was the one place
  untrusted third-party file content reached a model. D10 item 1 becomes moot;
- drops three dependencies (`multer`, `pdf-parse`, `mammoth`) and the file-upload attack
  surface with them.

### D12 — Live-deploy safety (18 Sep 2026)
`main` pushes to GitHub and Render deploys from it, so a commit to `main` is a production
deploy. All migration work happens on the `free-tier-migration` branch. Nothing is pushed or
merged without explicit approval (standing rule: human gate before public or irreversible).

### D13 — Model is `openai/gpt-oss-20b`, not Llama 3.1 8B (18 Sep 2026)
Verified against Groq's own docs, which contradict the community repo used for D4:
- Groq prompt caching is automatic and **cached tokens do not count toward rate limits** —
  TPM is our binding constraint, so this is headroom, not a cost saving. It supports only
  `gpt-oss-20b`, `gpt-oss-120b` and `gpt-oss-safeguard-20b`; **not** `llama-3.1-8b-instant`.
- Groq's rate-limit table does not list `llama-3.1-8b-instant` at all. The repo's
  "14,400 req/day" figure for it is unverified and possibly stale.
- `openai/gpt-oss-20b` free tier: 30 RPM, **1,000 RPD**, 8K TPM, 200K TPD.
Chosen for: caching eligibility, higher TPM (8K vs the 6K assumed in D9), and a larger model
being likelier to hold the no-fabrication constraints that D6 gates on.
Cost of the choice: a hard 1,000 requests/day site-wide (~300 student sessions at 3 calls
each). The D5 circuit breaker already handles that ceiling honestly.

Caching note: only the system prompt is a repeated prefix (~380 tokens on generate-cv, ~300
on polish). The student's facts differ every call and never cache across users, so at best
about a third of a generate-cv call is cacheable — and the minimum cacheable prefix is
128–1,024 tokens depending on model, which our shorter prompts may not clear. Measure
`usage.prompt_tokens_details.cached_tokens` before assuming any benefit.

### D14 — Deploy to Vercel; Render stays as fallback until Vercel is proven (19 Sep 2026)
Reason for moving: Render's free instance sleeps when idle, so the first visitor
waits ~50s for a cold start. The page is static — it should be instant.

Shape: `public/` is served from Vercel's CDN (`outputDirectory: "public"`), with
`/app` and `/privacy` rewritten to their HTML files. Only `/api/*` invokes a
function (`api/index.js`), which reuses the same `createApp()` Render runs — one
codebase, two hosts, no fork. `maxDuration` 60s (Hobby allows up to 300).

**Accepted limitation — per-visitor limits become best-effort.** Vercel functions
are stateless between invocations, so the in-memory rate limiter (10/hour,
100/month per IP), the 24h token ledger and the Groq rate-limit header state do
not persist reliably. Fluid compute reuses warm instances sometimes, never
dependably and never across concurrent ones.

Accepted because the backstop is financial, not procedural: Groq's free tier caps
at 1,000 requests and 200,000 tokens a day with **no billing attached**, so the
worst case is students being refused, not a bill. Durable counters (Upstash Redis
free tier) are the fix *if abuse actually appears* — not before. Same reasoning as
rejecting a self-hosted model: do not build for a problem you do not yet have.

Both deployments run from the same repo and share one Groq key, so their usage
adds against one quota and each keeps its own separate counters. Render is kept
only until Vercel is confirmed working, then retired.

Revisit if: real abuse appears, the app gains a paid tier (Vercel Hobby is
non-commercial — D2 would need Pro), or per-visitor limits need to be provable
rather than best-effort.
