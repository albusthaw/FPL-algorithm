# FPL AI Engine Plan — Efficient, Gated, Provider-Agnostic

**Document status:** Authoritative build specification for the AI layer.
Companion to `fpl-project.md` (§7 — this doc is its implementation contract)
and `fpl-api-integration-plan.md` (whose anti-bug framework, §1.2 error
taxonomy and §1.6 Definition of Done, applies to AI adapters too).

Design goal in one sentence: **the smallest possible number of tokens, spent
only when a human asks, producing schema-valid verdicts that can never
corrupt the rankings, with every token accounted to a user.**

---

## 1. The invocation gate (restated as architecture, not policy)

- Every AI call requires an `AIInvocation` context:
  `{triggered_by_user_id, trigger_kind: run_button | image_parse |
  admin_action, run_id?}`. The gateway constructor takes it as a required
  argument; there is no default.
- The scheduler/cron container is wired WITHOUT the AI gateway dependency —
  scheduled code cannot reference it (compile-time impossibility, verified
  by an architectural test that walks the dependency graph).
- **No retries across runs, no background continuation:** if a Run's AI pass
  fails partway, the run completes degraded (stale adjustments, flagged);
  the user decides whether to press Run again. The system never "finishes
  the AI pass later" on its own.
- The token ledger writes are keyed to `triggered_by_user_id` — an AI call
  without a human to bill is unrepresentable in the schema
  (`ai_calls.user_id NOT NULL`).

## 2. Architecture

```
Run button / image upload / admin action
        │  (AIInvocation)
┌───────▼────────────────────────────────────────────────────┐
│ AI ENGINE                                                   │
│  Selector (max-1 alive) → BudgetGuard (estimate ≥ balance?) │
│  → BatchPlanner (skip logic, batching, §5)                  │
│  → PromptBuilder (stable-prefix layout, §6)                 │
│  → ProviderAdapter (1 of 7, §4)                             │
│  → Validator (schema + bounds, single repair retry, §7)     │
│  → Accountant (usage → ledger, §8)                          │
│  → VerdictWriter (ai_adjustment into the run matrix)        │
└─────────────────────────────────────────────────────────────┘
```

All components are provider-independent except ProviderAdapter. The adapter
interface (extends `fpl-project.md` §7.1):

```ts
interface AIProviderAdapter {
  key: string
  supportsVision: boolean
  supportsNativeJsonSchema: boolean       // drives Validator strictness
  analyse(batch: PlayerNewsBundle[], inv: AIInvocation): Promise<ProviderResult>
  parseTeamImage(img: Buffer, inv: AIInvocation): Promise<ProviderResult>
  estimateTokens(batch): Promise<number>  // provider-accurate where possible
  healthCheck(): Promise<AIProviderHealth>
}
interface ProviderResult {
  raw: unknown
  usage: { promptTokens: number; completionTokens: number;
           cachedPromptTokens: number }   // normalised from provider fields (§8)
  finishReason: 'complete'|'length'|'filtered'|'refused'
}
```

The **max-1-alive gate** stays as specified (transactional flip; activating
one deactivates the incumbent atomically). Switching providers mid-run is
refused (a run pins the provider it started with).

## 3. What the AI is asked (unchanged contract, restated for the engine)

Input per player: a compact matrix summary + only-new-since-last-analysis
news snippets. Output per player: `{player_uid, adjustment: −20..+20 int,
rationale: ≤160 chars, confidence: 0..1}`. The engine — not the model —
enforces bounds by clamping and flags out-of-range responses as validator
warnings. Statistical outputs never wait on AI (degradation semantics in
`fpl-engines-plan.md` §6.4).

## 4. Provider dossiers (integration contracts)

Facts below from provider documentation current mid-2026; anything drifting
is caught by each adapter's probe (§10). Pricing is stored in
`model_config.ai_pricing` (per-provider $/Mtok in/out/cached) — **data, not
code** — because it changes often.

### 4.1 Anthropic (Claude) — reference adapter (built first)

- `POST https://api.anthropic.com/v1/messages`, headers `x-api-key`,
  `anthropic-version`. SDK: `@anthropic-ai/sdk` (TypeScript backend).
- **Structured output:** `output_config: {format: ...}` / SDK
  `messages.parse()` validating against our verdict schema (the old
  `output_format` param is deprecated — do not use); strict tool-use
  (`strict: true`, `additionalProperties: false`) is the fallback shape for
  older models. This gives schema-guaranteed JSON — Validator can skip
  repair retries for this adapter.
- **Prompt caching:** `cache_control: {type: "ephemeral"}` breakpoints
  (max 4); minimum cacheable prefix ≈ 1024 tokens; 5-min TTL default
  (1-hour option); verify effectiveness via
  `usage.cache_read_input_tokens` — if 0 across a run's batches, a prefix
  invalidator crept in (alert in dev, §6 layout prevents it).
  Usage fields: `input_tokens`, `output_tokens`,
  `cache_creation_input_tokens`, `cache_read_input_tokens`.
- **Pre-run estimation:** `POST /v1/messages/count_tokens` is **free** —
  the Anthropic adapter's `estimateTokens()` is exact, not heuristic.
- **Batch API** (50% discount, results ≤24 h, keyed by `custom_id`, any
  order): NOT used for interactive Runs (latency), but exposed as an
  admin-only "overnight deep pass" option later — out of v1 scope.
- Models: cheap tier (Haiku class, $1/$5 per Mtok) default for verdict
  batches; mid tier (Sonnet class) config-selectable for vision parsing.
  Model ids live in config; the adapter queries `GET /v1/models` at
  health-check to validate the configured id still exists.
- Errors: 429 (honour `retry-after`), 529 overloaded (backoff + jitter),
  400 schema/validation (no retry — bug), `stop_reason` checked on every
  response. Vision: base64 image blocks in user content.

### 4.2 OpenAI (ChatGPT)

- Responses API (`POST /v1/responses`) as primary surface (Chat Completions
  kept as adapter fallback flag), `Authorization: Bearer`.
- Structured output: `response_format`/`text.format` `json_schema` with
  `strict: true` — schema-guaranteed. Vision: image input parts.
- Prompt caching: automatic for prefixes ≥1024 tokens; discount surfaced in
  `usage.prompt_tokens_details.cached_tokens` — same §6 layout exploits it;
  no explicit breakpoints needed.
- Estimation: no free count endpoint → `estimateTokens()` uses local
  tokenizer approximation (+10% safety margin, §8.3).
- Errors: 429 with `retry-after`, `x-ratelimit-*` headers persisted like
  football quota headers; content-filter finishes map to `filtered`.

### 4.3 Google Gemini

- `POST /v1beta/models/{model}:generateContent`, header `x-goog-api-key`.
- Structured output: `generationConfig.responseMimeType:
  "application/json"` + `responseSchema` — schema-guided (not as strict as
  OpenAI/Anthropic; Validator keeps repair retry ON).
- Caching: implicit caching on recent prefixes plus explicit
  `cachedContents` API (min token thresholds apply; TTL-managed). v1 uses
  implicit only (our shared prefix is typically under explicit-cache
  minimums per batch anyway); usage via `usageMetadata`
  (`promptTokenCount`, `candidatesTokenCount`, `cachedContentTokenCount`).
- Free tier exists (rate-limited) — good default for zero-budget installs;
  429/503 handling with backoff. Vision: `inline_data` parts. Free
  `countTokens` endpoint → exact estimation.

### 4.4 DeepSeek

- `https://api.deepseek.com` — OpenAI-compatible chat completions; current
  cheap-tier models (V4-Flash class) at ~$0.14/M in (miss) / ~$0.0028/M in
  (**cache hit — 50× cheaper**) / ~$0.28/M out. **Context caching is
  automatic** (disk-based, no opt-in): usage fields
  `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` — our §6 layout
  converts directly into these hits. Cheapest per-verdict provider by an
  order of magnitude.
- JSON mode: `response_format: {type: "json_object"}` — **the word "json"
  must appear in the prompt** or the request errors; not schema-strict →
  Validator repair retry ON.
- Rate limiting is dynamic (requests may be held open under load rather
  than 429'd) — adapter sets a generous HTTP timeout (120 s) and treats
  held-then-completed as success. Vision: not assumed (supportsVision=false
  until the probe proves otherwise).

### 4.5 Moonshot Kimi

- `https://api.moonshot.ai/v1` — OpenAI-compatible; kimi-k2 family; long
  context. JSON mode as DeepSeek (repair retry ON). Explicit context-cache
  API exists with TTL and its own pricing — v1 does NOT use it (complexity
  > benefit at our batch sizes); flag `supportsExplicitCache` reserved.
  International (.ai) platform, not the .cn one. Tiered RPM by deposit
  level — probe records the account's tier. Vision variants exist per model
  (probe-verified).

### 4.6 Ollama (self-hosted, zero token cost)

- `http://localhost:11434` — native `/api/chat` preferred (richer usage
  fields: `prompt_eval_count`, `eval_count`) with OpenAI-compat `/v1`
  fallback.
- **Structured outputs:** `format: <JSON schema>` (supported since v0.5) —
  grammar-constrained, so schema compliance is strong; keep repair retry ON
  (small local models still drift).
- Config: `keep_alive` set to `30m` so the model stays warm across a Run's
  batches; `num_ctx` sized to batch prompt (default 8192); recommended
  small instruct models for this workload documented in the admin UI
  (qwen/llama/gemma-class 7–14 B — exact list is config, revisited per
  release).
- **No auth by default** → install.sh binds it to localhost only and the
  health check REFUSES a non-loopback Ollama URL unless
  `OLLAMA_ALLOW_REMOTE=true` + a reverse-proxy auth note. Tokens still
  recorded (credits cost 0 by default, configurable so admins can meter
  local GPU use too).

### 4.7 Modal.com — bring-your-endpoint

- Modal is serverless GPU compute, not an LLM API: the supported pattern is
  the admin deploys an **OpenAI-compatible server (e.g. vLLM) as a Modal web
  endpoint** and pastes its URL + auth into config. The adapter is the
  OpenAI-compatible adapter with two extra headers when configured
  (`Modal-Key`, `Modal-Secret` proxy auth).
- **Cold starts are real** (container spin-up on first request):
  `healthCheck()` doubles as a pre-warm — the Run screen calls it when the
  user opens the run panel, so the container is warm by launch; first-call
  timeout 180 s. Billing is per-GPU-second on the admin's Modal account —
  our accountant records tokens with a configurable $/Mtok equivalence for
  credit metering.
- The setup guide (with a reference vLLM deploy snippet) ships in
  `docs/ai-providers/modal.md`.

## 5. Efficiency measure #1 — send less (the BatchPlanner)

Ordered filters, each logged with counts into the run report:

1. **Hard exclusions:** user's manual skip-list (bottom-X pre-checked, user-
   editable — unchanged from fpl-project §7.3).
2. **No-news skip:** zero new news items mapped to the player since his last
   analysed verdict → skip (adjustment carries forward, flagged `stale`).
3. **Verdict cache:** hash = (player_uid, sorted news-item ids, matrix-
   summary quantised to 1 dp, prompt version). Hit within 24 h → reuse at
   zero cost. Stored in `ai_verdict_cache`.
4. **News dedup + trim:** near-duplicates collapsed (integration plan §2.5);
   max ⚙5 items/player, each trimmed to headline + ⚙320-char snippet;
   source-tier ordering keeps the most reputable.
5. **Batching:** remaining players grouped ⚙20/request (per-provider max in
   adapter config), grouped **by team** where possible (shared context
   compresses: one line of team news context serves several players).

Expected effect (order-of-magnitude, verified in the E-package): a typical
mid-week Run analyses 60–150 players instead of 700+, at ~300–500 tokens per
player → tens of thousands of tokens, not millions.

## 6. Efficiency measure #2 — pay less per token (cache-aware prompt layout)

One layout serves all providers, because every provider's caching (explicit
Anthropic breakpoints, automatic OpenAI/DeepSeek prefix caching, Gemini
implicit) rewards the same property: **a byte-stable prefix, volatile
suffix**.

```
[SYSTEM — frozen per prompt_version]           ← never varies within a season
  role, task, scoring rules digest, output schema, examples
[RUN CONTEXT — stable within one Run]          ← varies per run only
  gameweek, deadline, global notes
--- cache boundary (Anthropic: cache_control here) ---
[BATCH — volatile]
  per player: UID | pos | club | price | terse matrix line | news lines
```

Rules: no timestamps, no run ids, no user names anywhere in the first two
blocks; JSON keys in canonical sorted order; the per-player serialisation is
a fixed-order pipe-delimited line (≈40% fewer tokens than pretty JSON —
measured claim to re-verify in the E-package). The system block alone
exceeds the ~1k-token caching minimums, so from batch #2 of every Run, the
prefix is a cache hit on every provider that supports it — on DeepSeek that
is a 50× price cut on the prefix, on Anthropic 10× (0.1× read multiplier),
on OpenAI ~2×.

`prompt_version` is a config row; ANY change to the frozen block bumps it
(invalidates verdict cache coherently and explains cost shifts in the admin
charts).

## 7. Structured output & validation (one Validator for all)

- Canonical zod schema for the verdict array; per-provider enforcement per
  §4 (`supportsNativeJsonSchema` decides whether repair retry is armed).
- **Single repair retry, ever:** on invalid JSON/schema → one follow-up
  message containing the validator errors + "return ONLY corrected JSON".
  Still invalid → the batch is marked `failed_validation`, its players keep
  stale adjustments, the run report says so. No retry loops — retries are
  the classic silent token furnace.
- Bounds & sanity: clamp adjustment to [−20, +20]; unknown player_uids in a
  response are dropped + logged (hallucinated players must not write);
  missing players get `no_verdict` (stale carry-forward); duplicate UIDs →
  last-wins + warning.
- `finishReason='length'` → the batch splits in two and retries once each
  (the only auto-split), with the token cost of both halves billed.
- `filtered`/`refused` → batch skipped, flagged, never retried
  automatically.

## 8. Token accounting (exact, per provider)

### 8.1 Usage-field normalisation map

| Provider | prompt | completion | cached |
|---|---|---|---|
| Anthropic | `usage.input_tokens` | `usage.output_tokens` | `cache_read_input_tokens` (+`cache_creation_input_tokens` tracked separately as write-premium) |
| OpenAI | `usage.prompt_tokens`* | `usage.completion_tokens`* | `prompt_tokens_details.cached_tokens` |
| Gemini | `usageMetadata.promptTokenCount` | `candidatesTokenCount` | `cachedContentTokenCount` |
| DeepSeek | `prompt_cache_miss_tokens + prompt_cache_hit_tokens` | `usage.completion_tokens` | `prompt_cache_hit_tokens` |
| Kimi | OpenAI-shaped | OpenAI-shaped | probe-verified |
| Ollama | `prompt_eval_count` | `eval_count` | n/a |
| Modal | whatever the deployed server reports (OpenAI-shaped for vLLM) | | |

*Responses-API naming (`input_tokens`/`output_tokens`) normalised the same
way — the adapter owns the mapping, one test per adapter pins it.

### 8.2 Credits

`credits = ceil( (prompt−cached)·P_in + cached·P_cached + completion·P_out )`
with per-provider prices from `model_config.ai_pricing`, normalised so
**1 credit ≈ $0.001 of provider cost** (making credits comparable across
providers; Ollama defaults to 0). Debited atomically per §10.2 of
fpl-project; every `ai_calls` row stores raw usage + computed credits +
pricing version, so admin cost charts can be reconciled against provider
invoices monthly.

### 8.3 Pre-run estimate

Exact where the provider gives a counter (Anthropic count_tokens, Gemini
countTokens — both free); local tokenizer approximation +10% margin
elsewhere. The Run screen shows `estimate ± margin`, blocks launch when
`estimate > balance`, and the final report shows estimate vs. actual (drift
> 25% raises a tuning task — the estimator is a tested component, not a
guess).

## 9. Vision pipeline (per-provider notes)

Anthropic / OpenAI / Gemini: first-class image inputs (base64 blocks / image
parts / inline_data) — the parse prompt requests the strict ParsedTeam
schema (same Validator). Kimi: model-dependent (probe). DeepSeek/Ollama:
`supportsVision=false` unless the probe proves otherwise (Ollama vision
models exist — llava/qwen-vl class — admin chooses a vision-capable local
model to enable it). Modal: depends on the deployed model. The UX rule
stands: no vision on the alive provider → clear message naming which
providers support it; never a silent second-provider call. Images are
downscaled client-side to ≤1568 px longest edge before upload (token cost of
vision scales with pixels; this is the single biggest vision saving).

## 10. Testing & probes

- **MockProvider** (8th adapter, dev/CI only): deterministic verdicts,
  scriptable failures (invalid JSON ×N, 429, filtered, length) — E2E runs
  and the run-report UI are tested against it with zero cost.
- Recorded-response contract tests per real adapter (same discipline as the
  football adapters).
- **Probe script per provider** (`scripts/probe/ai-<key>.ts`): auth, one
  minimal completion, one schema-enforced completion, one vision call where
  claimed, usage-field presence assertions, price-list freshness check
  against `ai_pricing`. Run at enable-time from the admin panel; failures
  keep the provider un-enableable with the reason shown.
- Accounting invariants in CI: Σ ai_calls.credits per run == ledger debit;
  no ai_calls row without user_id; scheduler-context AI call → compile/test
  failure (the §1 architectural test).

## 11. Build order (extends fpl-project Phase 5)

| # | Package | Exit criteria |
|---|---|---|
| A1 | Engine skeleton + MockProvider + Validator + Accountant + gate test | E2E Run with mock: verdicts written, ledger correct, scheduler cannot reach gateway |
| A2 | Anthropic adapter (reference: native schema + explicit caching + free count) | live probe green; cache_read>0 from batch #2; estimate within 5% |
| A3 | OpenAI + Gemini adapters | probes green; usage maps pinned |
| A4 | DeepSeek + Kimi (OpenAI-compatible base class) | probes green; DeepSeek cache-hit fields observed |
| A5 | Ollama + Modal | local run zero-cost path; Modal pre-warm flow |
| A6 | BatchPlanner filters + verdict cache + run-report counts | measured: ≤25% of players analysed on a typical mid-week run; cache hit-rate visible |
| A7 | Vision parse + confirmation screen wiring | screenshot → confirmed team ≤ 2 provider calls |

---

*End of AI engine plan.*
