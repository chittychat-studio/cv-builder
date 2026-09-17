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

# CV Builder → free SaaS for school leavers

Analysis, 18 Sep 2026. Nothing here is implemented. No API credits have been spent.

Confidence tags: **[Certain]** = I read it in your code or observed it directly ·
**[Likely]** = strong inference from observed evidence · **[Guessing]** = say so and check.

---

## 0. The uncomfortable part first

**CertSafari is not free because it found cheap AI. It is free because it makes no AI call
when you use it.** Every token was spent once, offline, by the operator, and the output was
baked into the site as static content. What you experience as "AI analyses my answers" is
[Likely] a pre-written rationale attached to each question plus deterministic arithmetic over
your answer history.

That pattern does not port to a CV builder cleanly, because of a structural difference:

| | CertSafari | CV Builder |
|---|---|---|
| What is the product? | **Their** content (question bank) | **The user's** content (their CV) |
| Can it be generated ahead of time? | Yes — one bank serves every learner | No — every CV is different |
| Marginal AI cost per user | £0 | > £0, irreducibly |

So "make it free like CertSafari" cannot be answered by swapping a model. It has to be
answered by asking, per endpoint, *which work is actually per-user*. Most of yours isn't.
That is the real finding, and it is good news — see §3.

**Second uncomfortable point:** your users are 16–18. They are minors under UK law. Right
now you have almost no compliance surface, because you have **no accounts, no database, and
store nothing** — that is your single best asset and it happened by accident. The obvious way
to control abuse on a free tier (accounts + quotas + saved CVs) destroys it and pulls you
under the ICO Age Appropriate Design Code. **The free version can cost more in legal exposure
than the paid one.** Design rule for the whole migration: *stay account-less*.

**Third:** a free, unauthenticated LLM endpoint on the public internet is a free LLM proxy
for everyone else. Your dominant cost risk is abuse, not genuine students.

---

## 1. What CertSafari actually does — evidence, not assumption

Observed 18 Sep 2026 by loading the site and reading its network traffic.

**[Certain]**
- Next.js app on Vercel. Question pages are server-rendered/static: the full question text,
  all four options and "Show answer & explanation" arrive in the page payload. No inference
  round-trip to display a question or its explanation.
- Learner-path API routes are `POST /api/get-quizzes`, `POST /api/certificate-progress`,
  `POST /api/certificate-focus-areas`. For an anonymous session they returned `{"data":[]}`
  and `[]` instantly. These are progress storage and aggregation endpoints.
- Banks are versioned like build artifacts, not like live output: *"Question bank created:
  14 Jul 2026 · Question bank last updated: 13 Sep 2026 · Guide checked for updates: 10 Sep
  2026."*
- Their own description of how questions are made: *"Multiple models and a judge-LLM
  cross-check questions for accuracy and relevance"* — a build-time pipeline, not a request
  handler.
- No signup, no ads, no tracking. Progress is anonymous, synced via optional IDs.
- Funding is **donations**: *"Running CertSafari comes with costs—server infrastructure, API
  usage, and maintenance."* API usage is a content-production cost, not a per-user cost.
- User-generated content (exam experiences, study notes) fills the gaps that would otherwise
  need generation.

**[Certain] — verified directly, 18 Sep 2026.** I clicked "Show answer & explanation" on a
practice question with the network log open. The full per-option rationale appeared
instantly — a correct-answer line plus a separate paragraph explaining why **each** of A, B,
C and D is right or wrong. **Network requests fired during that reveal: zero.** No XHR, no
fetch, no streaming response; only Next.js route-prefetch chunks. The explanation was already
in the page payload. It was written once, offline, and shipped as static content.

**Corroboration (18 Sep 2026).** An independent read of CertSafari's public material by
another assistant reached the same conclusion unprompted: batch pre-generation by multiple
models, a judge-LLM cross-check against official documentation, results cached to a static
database, and *"instant explanations without triggering or paying for real-time API calls."*
Note the limit of that agreement — it rests on the same public pages this document cites, so
it corroborates the reading rather than adding a new source. The direct network observation
above remains the strongest evidence.

**[Likely]** — `certificate-focus-areas` is deterministic per-domain scoring over stored
answers rather than a model call: it is named after the exam's fixed domain list, returned
instantly, and returned `[]` for a session with no answer history. To settle it completely
you would need a session with real answer history behind it.

### CORRECTION — 18 Sep 2026, later the same day

The claim above ("zero live LLM calls anywhere in the learner path") was **too broad and is
withdrawn**. Evidence: a screenshot of quiz mode in which the learner typed a free-text answer
— *"audit hook immediately after each edit"* — and the system mapped it to the correct
multiple-choice option, whose text was *"A PostToolUse hook matched to Edit and Write, since
it runs after the tool has executed and the change has already landed on disk"*, and marked
it correct.

Those two strings share the token "hook" and little else. No keyword, fuzzy or edit-distance
match bridges them. **Something performed semantic matching at request time.** [Certain]

What survives unchanged, and what this actually reveals — CertSafari runs **two** patterns,
not one:

| | Pattern A — precompute & serve | Pattern B — classify into a precomputed space |
|---|---|---|
| Used for | Questions, correct answers, per-option rationales | Mapping a free-text answer onto one of the options |
| When it runs | Build time, offline, once | Request time, live |
| Cost per user | £0 | Small — one short classification, not a generation |
| Output | Long prose | **An option ID.** The prose it unlocks is still Pattern A |

Look again at the screenshot: after the mapping, what the learner is shown — the correct-answer
line and the option rationale — is still the pre-written static content from Pattern A. The
live call did not write a single word of the feedback. It chose an index.

**[Guessing] — and it matters commercially:** this could be an LLM classification call or an
embedding-similarity match (embed the typed answer, cosine it against option embeddings
computed at build time, take the nearest). An embedding call costs roughly a thousandth of a
generation call and returns in ~100ms. To tell them apart: time it. Sub-200ms and instant =
embeddings. A second or more, especially streaming = an LLM. The network log on that request
would settle it.

Either way the economic shape holds: the expensive output is precomputed, and the only live
work is a cheap decision about *which* precomputed output to show.

### CORRECTION 2 — 18 Sep 2026, from a screen recording

The embedding hypothesis above is **wrong and withdrawn**. Measured from a 60fps screen
capture of quiz mode, frames sampled at 5fps:

| Frame | t (s) | State |
|---|---|---|
| f_001–f_004 | 29.0–29.8 | Textarea holds the typed answer `cache control` (13/500). Button: **Submit Answer** |
| f_005 | ~29.8 | Button → **Grading…** with spinner; answer area replaced by skeleton loaders |
| f_006–f_014 | 30.0–31.6 | Still **Grading…** |
| f_015 | ~31.8 | Verdict renders |

**Round trip ≈ 2.0s** (bounded 1.8–2.2s). The UI's own hint under the textarea reads
*"Grading usually takes about 3 seconds."* An embedding lookup returns in ~100ms. **This is a
live LLM generation call.** [Certain]

The response content confirms it. The verdict was not a stored distractor rationale — it
named the learner's own words back: *"The relevant feature is fine-grained tool streaming with
eager_input_streaming, **not cache control**"*, plus a **Missing:** line stating the specific
concept the answer lacked. "cache control" was free text the learner typed; no pre-written
option uses that phrasing. Note also that the free text was **not** mapped onto an option —
the "Your answer" box shows her raw string verbatim, and the correct option is flagged
separately. It is being graded directly against the correct answer, not classified into the
option set.

### So what CertSafari actually does — final, corrected

Two modes, and **the split between them is the cost-control design**, not an accident:

| | Multiple-choice mode | Free-text mode |
|---|---|---|
| How the learner acts | Clicks an option, reveals | **Types an answer** |
| Live model call | **None** (verified: zero network requests on reveal) | **Yes** — ~2s LLM grading |
| Feedback source | Pre-written per-option rationale | Generated, references the learner's words |
| Who uses it | Everyone, constantly | Whoever opts in, occasionally |
| Cost per interaction | £0 | > £0 |

**The default path is free. The paid path is the one the user has to deliberately choose by
typing.** High intent, low frequency, self-limiting. And they set the expectation out loud
(*"about 3 seconds"*), which buys them the freedom to use a slower, cheaper model. The
generated output is also tiny — a verdict line plus a "Missing:" line, maybe 40 tokens.

They are paying for those calls. Donations fund it. **That is option E in §4**, and it was
always option E — the earlier sections were right about the economics and wrong about the
mechanism.

### What this changes for CV Builder

Your app is currently shaped the **opposite** way: the model fires on the default path, at
almost every interaction — suggestions per step, polish per field, generation at the end,
import at the start. CertSafari's actual lesson is not "precompute everything". It is:

1. **Make the deterministic path the default**, and make it good enough to stand alone (§3.1,
   §3.2 still hold — the suggestion bank and the template renderer).
2. **Make the model call an explicit, labelled action the student chooses**, not something
   that fires as they move through the form. `/api/polish` should be a button on a field, not
   an automatic pass.
3. **Keep generated output short.** Their grading response is ~40 tokens. Your `generate-cv`
   is budgeted at 2000. Short outputs are what make a per-call cost survivable.
4. **Say the cost out loud in the UI.** "Takes a few seconds" lets you pick a cheaper model
   without it reading as a fault.
5. **Someone still pays.** No arrangement of the above removes that. Return to §4.

### CORRECTION 3 — the free-text mode is free *recall*, not an opt-in shortcut

Re-reading the captured frames: before submit the screen shows the question, an empty
textarea with a type-from-memory placeholder, a character counter (13/500) and **Submit
Answer**. **No options are on screen.** A–D appear only *after* grading, alongside the
verdict. The learner types blind; the reveal is the reward.

So the claim in CORRECTION 2 that "almost everyone clicks an option — £0" and that the paid
path is rare and self-limiting was **wrong**. In this mode there is no option to click, and
the captured session header reads *"Question 6 of 50"*. **Every question in a 50-question
free-recall quiz is a graded LLM call.**

**What that does to the arithmetic — less than you would think.** Per graded answer: roughly
a few hundred tokens in (question + options + correct answer + the learner's sentence) and
~40 tokens out (verdict line + "Missing:" line). Fifty of those is on the order of tens of
thousands of input tokens and a couple of thousand output tokens for a **whole 50-question
quiz**. On a cheap model that is pennies per complete quiz, not per question. The conclusion
in §1 holds; the reasoning about frequency did not.

**And the design lesson is better than the one I drew before.** They did not put the model on
the cheap path — they put it on the path that actually teaches. Free recall then reveal is
pedagogically stronger than recognise-from-four-options, and it is the mode that costs money.
They spend where it changes the outcome and spend nothing everywhere else (question text,
option rationales, progress, domain scoring — all precomputed or deterministic).

**Transferred to CV Builder:** spend the budget on `/api/polish`, where a 17-year-old who
cannot phrase their Saturday job gets something they could not produce alone. Spend nothing
on laying out a CV from fields you already hold structured (§3.2), or on suggestions that a
reviewed bank serves better (§3.1). The test for every call is not "is it cheap" but "does
this change what the student ends up with".

**Do not copy** the donation model as your plan. It funds *their* content pipeline, which is
a one-off cost per exam. It would have to fund *your* per-user inference, which grows with
success. Donations scale sublinearly with users; per-user inference scales linearly. That
gap is where free AI products die.

---

## 2. Your app as it stands **[Certain]**

Read from `server.js`, `lib/anthropic.js`, `lib/licensing.js`, `public/cv-builder.html`.

- Node + Express, no database, single instance. In-memory rate limits and licence cache.
- Four model endpoints, all `claude-sonnet-4-5`, all behind one gate
  (`gateAIRequest` → `licensing.checkAccess` → rate limiter):

| Endpoint | max_tokens | Called | Truly per-user? |
|---|---|---|---|
| `/api/generate-cv` | 2000 | once at the end | **Partly** |
| `/api/suggest` | 700 | per step, repeatable | **No** |
| `/api/polish` | 300 | per field, many times | **Yes** |
| `/api/import-cv` | 1500 | once, optional | **Yes, but cheap-able** |

- Access control: `BETA_MODE=true` → free, 10/hr per IP. `BETA_MODE=false` → `X-License-Key`
  validated against Lemon Squeezy, 30/hr per key, 402 + checkout URL otherwise.
- Privacy posture is already strong: CV content is never written to disk or logged; the
  licence key lives in a JS variable, not localStorage; import files are held in memory only.
  **Keep all of this.** It is the part that makes a free product for minors defensible.

### Two defects the free model will expose that the paid model hid **[Certain]**

1. **Per-IP rate limiting breaks for schools.** `rateLimiter` buckets beta traffic on
   `ip:${req.ip}`. A school or college NATs its whole network behind one or two public IPs.
   With `betaRateLimit = 10`, the eleventh student in an IT suite gets a 429 caused by her
   classmates. Under the paid model this never surfaced because paying users bucket on key.
2. **In-memory everything pins you to one instance.** Already noted in your README. Fine at
   zero traffic, fatal the first time a teacher shares the link with a year group and you
   scale out.

---

## 3. Endpoint-by-endpoint: what can stop being an AI call

This is the CertSafari move applied to your app.

### 3.1 `/api/suggest` → **static bank. Delete the model call entirely.**

The prompt's real inputs are *target role*, *subjects*, and *entries so far*. The first two
have small closed domains; the third is only used to avoid repetition, which is a filter, not
a generation problem. So:

- Offline, generate 20–30 suggestion bullets for each (target role × builder step) pair.
- Commit them as `data/suggestions/<role>.json` with a `generatedAt` stamp, exactly like
  CertSafari versions a bank.
- `/api/suggest` becomes a lookup: pick the bullets for the role/step, drop any whose subject
  the student already listed, shuffle, return 4–6.

Cost per student: £0. Latency: ~0ms instead of 2–4s. Offline-capable. And you can *read every
suggestion before it ships*, which you cannot do with live generation — meaningful when the
audience is minors.

**What it costs you:** suggestions stop being tailored to the individual and become tailored
to the bucket. For this feature that is a small loss — the prompt already forbids anything
personalised ("never invent facts", "phrase every suggestion as a question").

### 3.2 `/api/generate-cv` → **deterministic template + AI only for the feedback block**

You already collect fully structured data: `name, city, email, phone, links, school,
schooldates, gcse, alevels[], projects[], quant, skills, jobs[], responsibility, sport,
fitness, awards, interests` (from `EXTRACT_PROMPT` — the same shape the form fills).

Rendering structured fields into a one-page UK CV in Markdown is a **templating problem**.
Your `SYSTEM_PROMPT` even specifies the output format rigidly ("First line: `# Name`",
"Second line: contact details separated by ` | `", "`## Section` headings", "no tables") —
you are paying a model to obey a format you could just emit.

Split it:

- `lib/render/cv.js` — pure function, structured fields → the CV Markdown. Zero cost, zero
  latency, zero fabrication risk, deterministic output, unit-testable. **Fails open in the
  good direction: every student gets a complete CV even when AI is unavailable.**
- The genuinely generative part is the section after `---`: the weaknesses and the
  *"Three actions for the next six months to create public evidence"*. Keep that as a model
  call at ~600 max_tokens instead of 2000.

**What it costs you:** the model's sentence-level polish on bullets. Mitigate by routing that
through `/api/polish` per bullet (opt-in) rather than rewriting the whole CV.

### 3.3 `/api/polish` → **irreducible. This is the one real per-user cost.**

Rewriting a student's rough note is exactly the work that cannot be precomputed. Accept it,
and make it the *only* thing your free budget funds. At 300 max_tokens it is also your
cheapest call. Levers: smaller/cheaper model, per-session cap (e.g. 15 polishes), and
explicit refusal when the cap is hit rather than silent degradation.

### 3.4 `/api/import-cv` → **regex-first, model as fallback**

The expensive part is already deterministic: `pdf-parse` and `mammoth` do the extraction. The
model only reshapes text into JSON. A rules pass (email, phone, URL, UK date ranges,
`SUBJECT — GRADE` lines, section headings) recovers most fields on a conventionally formatted
CV. Call the model only for the residue, or only when the rules pass yields under N fields.

**Also consider dropping this feature from the free tier.** Its users are school leavers with
*no* CV to import — that is the premise of the product. [Guessing] on usage; check your logs
(you log route + status, so the counts are there).

---

## 4. The residue: options for calls you cannot eliminate, ranked

After §3 the only guaranteed per-user calls are `/api/polish` and the feedback block.

| # | Option | £/user | Data risk with minors' CVs | Effort | Verdict |
|---|---|---|---|---|---|
| A | Static bank + deterministic render (§3) | 0 | none — nothing leaves your server | M | **Do this first, regardless** |
| B | Free-tier API (Gemini / Groq / Cloudflare Workers AI / OpenRouter `:free`) | 0 to a ceiling | **See warning** | S | Viable *only* after checking training terms |
| C | On-device (Chrome built-in Prompt API, WebLLM) | 0 | none — never leaves the device | L | Progressive enhancement, not baseline |
| D | BYOK — student pastes their own key | 0 | n/a | S | **Dead.** A 17-year-old has no API key |
| E | Keep paying, fund it elsewhere (donations / school licence / sponsor) | > 0 | as today | S–M | The only option that also earns |

**Warning on B, and it may decide the whole thing:** several providers' *free* tiers reserve
the right to use submitted content to improve their models; paid tiers of the same providers
do not. A school leaver's CV is personal data about a minor — name, school, town, email,
phone. Sending that to a free tier that trains on it is a materially different act from
sending it to a paid API that does not. **Verify the current terms of any provider before you
route a single CV through it, and put the conclusion in writing in this repo.** I am not
going to assert what any given provider's terms say today — check them directly.
This also affects which endpoints you may route where: `/api/suggest` carries no personal
data after §3.1 and could go anywhere; `/api/polish` and `/api/import-cv` carry the student's
own words.

**On C:** genuinely attractive for this audience — zero cost, zero data egress, and your
privacy page gets stronger, not weaker. But Chrome-only, and a model download that school
Chromebooks and a student's phone on 4G will not tolerate. Ship it as: *if the browser has
it, use it; otherwise fall back to the server*. That also caps your server spend, because
your better-equipped users stop costing you anything.

**On E — the one worth arguing for:** "free for kids" and "someone pays" are not in conflict
if the payer is not the kid. A sixth-form college or careers service paying a flat annual fee
for unmetered access, while individual students use it free and account-lessly, keeps every
privacy property above and gives you revenue. Your existing `lib/licensing.js` provider
interface already implements exactly this — the key becomes an *institution* key, and the gate
raises a quota instead of unlocking a wall. **Do not delete that code.**

---

## 5. File-by-file change list

### Keep, unchanged
- `lib/providers/lemonsqueezy.js` — retarget at institutions later, don't rewrite now.
- The no-logging / no-persistence discipline in `server.js` and `lib/anthropic.js`.
- All four prompt constants. They are good and hard-won; they move, they don't change.

### Modify
| File | Change |
|---|---|
| `lib/licensing.js` | `betaMode` → `tier` resolution returning `{tier:'free'\|'school', quota}`. A missing key is no longer 402; it is the free tier. Keep the provider interface and the 10-min cache verbatim. |
| `server.js` | `gateAIRequest` returns a tier + quota instead of allow/deny. Add a **global daily circuit breaker** (`AI_DAILY_BUDGET_CALLS`) that returns `503` with an honest reason when tripped — *fail closed with a stated reason, never a plausible-looking fallback output*. Remove 402/checkout from the AI paths. |
| `public/cv-builder.html` | Delete the licence-key panel (lines ~487–497) and the four `402` branches (~1160, ~1202, ~1247, ~1322). Replace with: a "Free. No account. Nothing saved." badge; an honest degraded state ("writing help is at today's limit — your CV is still complete and downloadable"); a donate / *for schools* link. |
| `lib/anthropic.js` | Move to `lib/providers/ai/anthropic.js`, unchanged internals. |
| `.env.example`, `README.md` | Rewrite around tiers and budget, drop the "flipping to paid" section. |
| `test/app.test.js` | Add: quota exhaustion → 503 with reason; `/api/suggest` answers correctly **with no model client configured at all**; `generate-cv` returns a full CV when the model client throws. |

### Add
| File | Purpose |
|---|---|
| `lib/providers/ai/index.js` | Model-provider interface mirroring your payments one: `{ name, complete({system, messages, maxTokens}) }`. Makes Anthropic / a free tier / an on-device passthrough swappable in one line, same as you did for payments. |
| `lib/render/cv.js` | Deterministic structured-fields → Markdown CV renderer (§3.2). |
| `data/suggestions/*.json` | Pre-generated suggestion banks, versioned, committed (§3.1). |
| `scripts/build-suggestions.js` | The offline generator. **Spends API credits — needs your approval and a printed estimate before it runs.** |
| `lib/quota.js` | Replaces `createRateLimiter`. Buckets on an anonymous browser ID (CertSafari's pattern) **with** an IP ceiling, so one school's NAT cannot starve a class (§2, defect 1). Plus the global daily counter. |
| `lib/abuse.js` | Cloudflare Turnstile verification on model endpoints. Free, no PII, no account, works for minors — the right answer to "free endpoint becomes someone's LLM proxy". Plus an `Origin` check and a tighter body cap than the current 200kb. |
| `SCHOOLS.md` | The institution offer, if you take option E. |

---

## 6. Sequencing

**Phase 1 — no API spend, no new dependencies.** `lib/render/cv.js` + tests. Shrink
`generate-cv` to the feedback block. Fix the quota bucketing. This alone cuts your largest
call from 2000 to ~600 max_tokens and makes the app usable with the model switched off.

**Phase 2 — one approved batch spend.** Build the suggestion banks; `/api/suggest` stops
touching a model forever. Review every line before committing.

**Phase 3 — decide the residue.** Write down the provider decision *and the terms you
verified*, then implement B or C behind `lib/providers/ai/`.

**Phase 4 — funding.** Turnstile + circuit breaker live, then donations and/or the schools
offer. Do not open the free tier to the public before Phase 4 ships.

---

## 7. What this costs you — stated plainly

- **You lose the only revenue line this repo has.** Lemon Squeezy is functional today. Free
  is a decision to earn nothing from individuals, permanently, in exchange for volume you
  have not yet proven exists. [Guessing] on your current conversion — you have the numbers.
- **Suggestions get worse in a way you will notice and students won't.** Bucketed, not
  individual.
- **Deterministic CV rendering loses model prose.** It gains: reproducibility, offline
  operation, zero fabrication, and testability.
- **You take on an abuse-prevention job you don't have today**, because the licence key was
  doing that work for free.
- **Free-tier providers may train on minors' CVs.** Unverified as of this document.

The cheaper path I rejected: leave `BETA_MODE=true` and just eat the API bill. It costs you
nothing to build and nothing until it works — and then it costs you unboundedly, with no
circuit breaker, no abuse control, and a per-IP limiter that punishes exactly the schools you
want. That is not a free product; it is an uncapped liability with a nice landing page.

---

## 8. Decisions still open — record in `CLAUDE.md` once made

1. Free for individuals, permanently? (kills Lemon Squeezy for B2C)
2. Account-less confirmed as a hard constraint?
3. Provider for the residue — and what do its training terms actually say?
4. Keep `/api/import-cv` in the free tier at all?
5. Funding: donations, school licence, both, neither?
6. ~~Is the CertSafari finding in §1 verified?~~ — **settled 18 Sep 2026.** The explanation
   path makes no live model call; the content is static. See §1.
