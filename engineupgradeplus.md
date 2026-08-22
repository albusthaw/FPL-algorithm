# engineupgradeplus.md — the comprehensive engine, AI, data-depth & product upgrade plan

**Status: PLAN (nothing here is implemented).** Written 2026-08-21.
Supersedes `enginesupgrade.md` (archived in `Old Markdown/` with the other
historical plans — its A/B/C/X packages are carried forward in Part 5, not
lost). Every package obeys CLAUDE.md Rule #1 (forward-only migrations,
⚙ constants in `model_config`, mutable state behind `DATA_DIR`, human-only
AI invocation) and the new **+0.0.1 version policy** (CLAUDE.md §8):
releases go 1.4.1 → 1.4.2 → 1.4.3, never +0.1.0.

---

## Part 0 — Method & evidence

1. **Full-code audit, zero skimming.** Every backend source file was read
   end-to-end this pass: all 5 stats layers + engine, match engine, news
   indexer/signals, all 4 ingest adapters + http/gateway/registry/errors/
   historical/backfill, the complete AI layer (gateway, prompt, validator,
   types, and all 5 provider adapters), all 7 route modules, core
   (config/env/secrets/db/kernel/model-config/logger), fpl
   (rules/optimiser/suggester), resolver, cli, server, scheduler, ledger —
   plus the full frontend (App, api, auth, Layout, PitchView, and all 7
   pages) and the DB's live table inventory (54 tables). Findings cite
   file:line.
2. **Live tests with the supplied keys** (2026-08-21): DeepSeek `/models`
   verified alive — and revealed `deepseek-v4-flash-vision-exp`, a
   vision-capable DeepSeek model our registry cannot express (Part 3).
   API-Football still suspended (dashboard action needed) and free-plan
   season-walled (2022–2024, verbatim error). football-data free tier
   re-verified (355 scheduled PL matches, standings, scorers with penalty
   splits, h2h). TheSportsDB key `123` re-verified (full GW rounds, player
   cutouts). NewsData free credits again exhausted mid-audit
   (`ApiLimitExceeded`) — the 200/day ceiling binds in normal use.
   Sportmonks free re-confirmed Denmark+Scotland only. RSS feeds live
   (BBC 87 / Guardian 66 / Sky 20 items, keyless). **No OpenAI key is
   currently stored** — the key your vision bug was hit with has since been
   wiped by the key-persistence bug (X1), so the bug is audited from your
   error text + the code path + provider documentation.
3. **Playwright gap elicitation** — two committed specs, the only code in
   this change: `07-engine-gap-audit.spec.ts` (20/20 liveliness GAPs, from
   the previous pass) and the new `08-product-gap-audit.spec.ts` (11 checks:
   10 GAP, 1 PRESENT — the read-only data window). Both suites green; each
   plan package's acceptance includes flipping its lines to PRESENT.
4. **Research**: OpenAI parameter drift (max_completion_tokens/temperature),
   Anthropic API current parameter rules, provider subscription tiers, and
   OCR tooling. Sources at the end.

---

## Part 1 — Line-level audit (what is actually built, and where it is wrong)

### 1.1 Statistical engine

| # | File:line | Finding |
|---|---|---|
| S1 | `stats/engine.ts:149` | L2 odds blend loads `odds_snapshots` — **0 rows, no writer anywhere**. Shin de-margin + market-λ solve + freshness blend (`l2-odds.ts`, fully tested) are dead code; `odds_used` is false on every fixture ever predicted. |
| S2 | `stats/engine.ts:322` | Confirmed-lineups read (`lineups` table) — **0 rows, no writer**. The §6.5 fast path and `mini_lineup` run kind exist but nothing ever triggers them (`grep mini_lineup` → the type union only). Minutes never see a team sheet. |
| S3 | `stats/engine.ts:317` | `injuries` — 0 rows. Sportmonks writer exists (`misc-providers.ts:69`) but free plan has no EPL; API-Football injuries plan-denied for current season. `availability_state` (0004) has **no writer at all**. |
| S4 | `stats/engine.ts:468-494` | `composeXpts` call **omits `defconOppMult`** — the composer input exists (`l9-composer.ts:52`), `team_style_stats` exists (0 rows, no writer), so opponent style never adjusts DEFCON. A declared, tested model input is silently always 1. |
| S5 | `fpl.ts:274` | `ep_next` ingested every 6h into `players.season_stats` marked "benchmark only" — then never read by anything: not the matrix, not the UI, not a calibration check. Same for `ict_index`/influence/creativity/threat, `form`, `event_points`. |
| S6 | `fpl.ts:517` | Element-summary upsert guard `WHERE excluded.as_of > player_match_stats.as_of OR …` is a tautology — `excluded.as_of` is always `now()`, always greater. Harmless today, but the "fpl_final wins" intent is not actually enforced. |
| S7 | `stats/engine.ts:385-391` | Finishing multiplier = career `goals / xG` — **xG includes penalties** while v1.3.0 moved pen EV to an explicit term. A penalty taker's finishing skill is overstated (Haaland's conversion inflated by ~25 career pens). Should be non-pen goals / npxG once npxg lands. |
| S8 | `stats/engine.ts:433-439` | Congestion = another **PL** fixture within 4 days. UCL/Europa/cup midweeks are invisible — precisely the congestion that causes rotation. |
| S9 | `stats/engine.ts:640` | Ownership-momentum z uses `transfers_in_event − transfers_out_event`, a *within-GW* counter that resets at each deadline — early in a GW it is mostly noise; the price-model netTransfer trajectory (P-series) is the right signal. |
| S10 | `l0-features.ts:249-260` (computePositionPriors path) | Price-band priors group **last season's rows under this season's price** — a player repriced from 8.0→6.0 donates 8.0-quality rows to the 6.0 band. Price-continuous priors (v1.3.0 X7) mask most of this; the band computation itself remains subtly biased. |
| S11 | `model_errors`, `feature_store`, `field_audit`, `pull_jobs`, `team_strength_fits` | Five schema tables with **no reader or writer** — the backtest/calibration loop (model_errors) was never built; the others are dead weight to either use or document as reserved. |
| S12 | `l9-composer.ts:154-157` | GK saves model: `input.saves90 > 0 ? 1 : 1` — a no-op ternary; save-rate is a constant 0.7 for everyone. Keeper quality (a real, persistent skill) never differentiates. |
| S13 | `stats/engine.ts:64` | Upcoming events filter `deadline > asOf − 36h`: during a live GW the *current* event stays "upcoming" for 36h — xptsN1 then means "rest of current GW + …" while the UI labels it "next". Correct-ish for mid-GW replans, but undocumented and untested. |
| S14 | `stats/engine.ts:308` | Season-start for tightrope yellows is computed from `asOf` month — August 1 boundary; FPL's actual amnesty (yellows reset at GW20 for the 5-yellow ban… league rules differ per threshold) is not modelled; acceptable simplification, worth a ⚙ note. |

### 1.2 Match engine

| # | File:line | Finding |
|---|---|---|
| M1 | `match/engine.ts:111-129` | `match_insights` stores FDR leverage only. `fixture_predictions` already holds pHome/pDraw/pAway + full concession grids **computed and never exposed**: no API returns a win probability or scoreline anywhere (gap-audit confirmed). |
| M2 | — | No in-gameweek mode at all: no live points, no BPS bonus projection, no auto-sub preview. FPL's free `event/{id}/live`, `event-status/`, `fixtures?event=` (with `started`/`minutes`/`stats`) are unused. |
| M3 | `match/engine.ts:245` | Captaincy ranks by simulated P90 **ceiling** but stores `score = doubled mean` — the UI shows rank 1 with a *lower* score than rank 2 (live-verified in v1.3.0). Works as designed, reads as a bug; the ceiling must be the displayed number. |
| M4 | `match/engine.ts:380-382` | Bench Boost value = 4 *weakest squad players'* xPts — that set can include a starter-quality player and excludes bench ORDER; correct value is the actual bench (XI complement) under the picked formation. |
| M5 | `match/engine.ts:376` | Wildcard value: `(best11 − yours) × 0.35` per GW over a ⚙ horizon — the 0.35 realisation factor is invented, unfitted, and undocumented as ⚙ (it is hard-coded). |
| M6 | `match/engine.ts:56` | Volatility = a postponed fixture exists. No European-competition congestion, no manager-change window, no cup-replay risk. |
| M7 | `match/engine.ts:471-479` | `simulateP90` draws one uniform for p60/pAny (correlated — good) but bonus is a hard-coded heuristic (returns≥2 → +3) rather than the ⚙ `bonus_model`; GK save points use `/3` literal instead of `rules.saves_per_point`. |
| M8 | `routes/modes.ts:262-274` | `/api/insights` returns leverage rows only — the dashboard's "match engine" surface can never show more than FDR numbers until M1 lands. |
| M9 | `match/engine.ts:296-302` | `xptsForEvent` sums pfp rows per event — DGW-aware (good) — but chip valuations use the RAW xpts sum without the captaincy double the XI actually gets; 3xc value uses max xPts (right) while FH/WC compare undoubled sums (inconsistent baseline). |

### 1.3 News engine

| # | File:line | Finding |
|---|---|---|
| N1 | `newsdata.ts:96-100` | Single provider with a **hard 200-credit/day ceiling — exhausted during both audit passes**. Volume features (signal corroboration, coverage breadth) starve. RSS (BBC/Sky/Guardian + club feeds, keyless, live-probed) remains unused. |
| N2 | `news/indexer.ts:88` | Alias phrase-matching is exact-substring after normalisation: "Haaland's brace" → `haalands brace` — the possessive **defeats the match** (` haaland ` not found; `normaliseText` strips apostrophes into joined `haalands`). Needs token-boundary matching with possessive stripping. |
| N3 | `news/indexer.ts:113-117` | Story clustering compares only against items that share the 7-day pool AND `other.id < item.id` — fine — but similarity is title-trigram only; same story with editorially different headlines ("Arteta confirms Saka out" vs "Saka ruled out for six weeks") never clusters. Entity+category overlap should corroborate. |
| N4 | `news/signals.ts` RULES | Keyword rules are English-idiom brittle (regex `\bban(ned)?\b` matches "Burnley ban…" contexts fine but also "banner"? — no: `\b` guards it; still, "suspended bridge" class false-positives exist). No negation handling ("NOT ruled out"). Corroboration gates damage, but a tier-1 false positive passes straight through. |
| N5 | `ai/bundles.ts:41-53` | Bundles dedupe nothing by story: three outlets on one injury = three snippets of the same fact in the prompt (token waste), and `cutoff` is a hard-coded 7 days rather than ⚙ `human_factors.news_signals.window_days`. |
| N6 | — | No press-conference-window awareness (Thu/Fri pressers are when availability truth lands), no expected-return-date extraction ("out for six weeks" → GW math), no sentiment magnitude, and **no user-facing news surface at all** (gap-audit: dashboard feed, player timeline, signal badges — all GAP despite `human_signals` sitting in the matrix). |

### 1.4 Product surface (Playwright-elicited, all committed as specs)

`07-engine-gap-audit`: 20/20 GAP — no deadline countdown, live GW board,
price ticker, news feed, confirmed-XI badge, SSE freshness, player photos,
sparklines-in-table, signal badges, price-prediction column, player
drill-down news timeline, win %, scorelines, h2h, predicted XI, referee,
kickoff/venue, API probabilities, API human_signals, API xpts-curve.

`08-product-gap-audit`: **weekly mode renders no squad-style pitch** (the
PitchView exists and is used by Initial/Chips — Weekly never calls it);
**no generated build is savable** (Initial XI, FH, WC, weekly XI all
evaporate on navigation); **the Run data window is read-only** (PRESENT as
a table, GAP as a selector; no per-provider plan setting exists anywhere);
**image parsing is AI-vision-gated with no OCR path** (a non-vision alive
provider hard-422s the upload); **the admin model picker knows nothing
about model capabilities** (no vision/param flags, no compatibility
warnings — exactly how the `max_tokens` 400 escaped to production).

### 1.5 Cross-cutting & integration-risk register

| # | Where | Risk |
|---|---|---|
| X1 | `core/env.ts:25-41` | **Key wipes (recurring, reproduced again this pass — OPENAI_API_KEY gone).** `upsertEnvVar` is read-modify-write with no lock: concurrent writers (server + CLI/migrate + a second admin PUT) can resurrect a stale snapshot, dropping keys written in between. `writableEnvFile()` also resolves differently when `ENV_FILE` is unset (release-relative path) — a process started without `ENV_FILE` writes a DIFFERENT file than one started with it, which *looks like* a wipe. Fix: exclusive file lock (`proper-lockfile` or `fs` O_EXCL lock-file), one canonical resolved path logged at boot, an append-only `key_audit` table (name, actor, old/new last-4, ts), boot-time "keys present" report, and an upgrade-rehearsal assertion that keys survive. |
| X2 | `server.ts:40` | CSP `img-src 'self' data:` — **remote player cutouts/badges will be blocked by our own CSP**. The photo plan must cache media under `DATA_DIR/media/` and serve same-origin (also the Rule-1c-correct design). TheSportsDB badge URLs already stored in `teams.strength.badge_url` are un-renderable today for the same reason. |
| X3 | `ai/gateway.ts:438-440` | Vision debits tokens AFTER the provider call: a non-admin with 0 balance burns real provider spend, then `applyTokens` throws and the route 500s — no pre-check like the run path has. |
| X4 | `routes/admin.ts:326` | Backfill concurrency guard is an in-process boolean — fine single-process, silently wrong under any future multi-process serving; note for the day PM2/cluster arrives. |
| X5 | `gateway.ts (ingest):68` | Quota headroom check reads `quota_used/quota_limit`, but `quota_limit` is never populated for any provider — another always-null guard. The subscription model (P1) is where limits become real. |
| X6 | `teams.ts:203-229` | Upload resolution loads the FULL player table per upload and trigram-scores in JS — fine at 600 players; flagged for when multi-league support raises the pool. |

---

## Part 2 — Provider subscription & historical-pull matrix (every site pulls differently)

This is the ground truth for **P1 (Run data selector + subscription model)**.
"Plan" rows the admin will select; depth and pull mechanics follow from it.
Live-probed facts marked ✓; plan-tier facts from provider docs/pricing pages.

### 2.1 FPL official (anchor — keyless, no plans)
- **Depth**: per-GW current season (`element-summary.history`); per-season
  career aggregates ✓ (`history_past` — every season of a player's FPL
  career, ~20y for veterans; already imported by v1.4.0's sweep).
- **Pull mechanics**: REST GET, no auth, no pagination; etiquette ≤1 rps
  (existing snapshot-first layer). Live GW: `event/{id}/live` ✓ (shape
  probed), `event-status/` ✓, `fixtures?event=` ✓.
- **Selector granularity**: days (news window) / seasons (career sweep on/off).

### 2.2 vaastav dataset (GitHub raw — keyless)
- **Depth**: per-GW CSVs seasons 2016-17 → previous ✓ (10 seasons; 2016-17
  fetch live-probed HTTP 200).
- **Pull mechanics**: 3 raw CSVs per season (`teams.csv`, `players_raw.csv`,
  `gws/merged_gw.csv`), one-shot import per season, resumable via the
  `history_pulls` ledger (already built). Cost: ~10-20 MB + ~17k rows/season.
- **Selector granularity**: seasons 1–10.

### 2.3 Understat (scraper — keyless)
- **Depth**: league player xG per season, 2014 → current (12 seasons).
- **Pull mechanics — distinct**: POST `main/getPlayersStats/` with
  `league=EPL&season=YYYY` (season = start year) ✓; per-player match-level
  data needs per-player pages (`player/{id}`) — N requests, politeness-bound.
  Names resolve through the review queue (no stable cross-key).
- **Selector granularity**: seasons (aggregates auto; match-level behind an
  explicit admin action because of the resolution burden).

### 2.4 football-data.org (key ✓ `…835d`)
- **Plans**: free TIER_ONE — 12 competitions, **current season only**,
  10 req/min ✓; paid tiers (TIER_TWO/THREE/FOUR, ~€/mo) unlock more
  competitions AND multi-season history via the same endpoints.
- **Pull mechanics — distinct**: `competitions/PL/matches?season=YYYY`
  (season = start year; free tier 403s past seasons — classify PLAN_DENIED
  and learn it), `standings?season=`, `scorers?season=` (pens split ✓),
  `matches/{id}/head2head?limit=` ✓. Rate ceiling means a multi-season
  backfill must pace at ≤10/min.
- **Selector granularity**: seasons, gated by learned tier.

### 2.5 API-Football / api-sports.io (key ✓ `…d4c1` — **account suspended**, reactivate at dashboard.api-football.com)
- **Plans**: Free — 100 req/day, **seasons 2022–2024 only** ✓ (verbatim
  denial), current season entirely walled. Pro (~$29/mo) — current season,
  7.5k req/day, injuries/lineups/odds/predictions/events. Ultra/Mega —
  deeper history (15+ years marketed) and higher volume.
- **Pull mechanics — distinct**: errors arrive INSIDE HTTP 200 (`errors`
  object — classifier already handles plan/rateLimit/requests/token/access);
  per-season params everywhere (`injuries?league=39&season=`,
  `fixtures?league=39&season=`, `odds?fixture=`); pagination via `paging`;
  entitlements learned per (endpoint, season) — already built.
- **Selector granularity**: seasons within the learned entitlement window;
  live features (lineups ~20-40min pre-KO, odds, events) auto-activate under
  a paid key via the same entitlement learning.

### 2.6 NewsData.io (key ✓ `…b1a1b` — free credits re-exhausted during audit ✓)
- **Plans**: Free — `latest` only (~last 48 h), 200 credits/day,
  10 results/credit, no `domainurl` filter ✓. Paid (Basic/Pro/Corporate) —
  `archive` endpoint with 6 months / 2 years / 5 years lookback, `size=50`,
  domain filtering.
- **Pull mechanics — distinct**: credit-metered pages (`nextPage` token);
  `archive?from_date&to_date` on paid; our sweep budget ⚙ already exists.
- **Selector granularity**: days (rolling window); months/years only when a
  paid key is entered and the archive entitlement probes green.

### 2.7 Sportmonks (token ✓ `…hkc`)
- **Plans**: Free — Danish Superliga + Scottish Premiership only ✓ (probed
  again this pass). Paid (European/Worldwide + per-league add-ons) — EPL,
  sidelined/lineups/odds/xG, multi-season history per plan.
- **Pull mechanics — distinct**: cursor pagination (`next_cursor` is a full
  URL ✓), `per_page` refused alongside cursor ✓, includes syntax
  (`teams?include=sidelined.player`), `filters=fixtureLeagues:8;seasons:X`.
- **Selector granularity**: dormant until a plan with EPL is detected.

### 2.8 TheSportsDB (key ✓ `123`)
- **Plans**: Free — v1 API, league search capped at 10 rows ✓ (per-team
  backfill built), rounds/next events ✓, player cutouts ✓, throttled.
  Premium ($9/mo Patreon) — v2 API, livescores, full historical event data.
- **Pull mechanics — distinct**: PHP-style endpoints
  (`eventsround.php?id=4328&r=N&s=2026-2027` ✓), key in the URL path.
- **Selector granularity**: media only; season event history under premium.

### 2.9 The subscription model to build (P1)
- New ⚙ `provider_plans` in `model_config` (data, editable in admin):
  `{provider: {plan: 'free'|'paid'|named-tier, depth: {…}, rate: {per_min?, per_day?, credits_day?}, expires?: date}}`.
- `api_providers.quota_limit` finally populated from the plan (fixes X5);
  the depth selector's options per provider = intersection of plan depth and
  the entitlement table's learned denials; a plan change re-arms entitlement
  probes (one cheap request per gated scope, learned, never hammered).
- Run screen: the existing Data-window table gains a **selector column**
  (days 7/14/30 · months 3/6 · seasons 1–10 · career on/off, options
  filtered per provider plan) writing ⚙ `history_depth` (extended shape) —
  the launch run then backfills exactly what was selected via the existing
  resumable `ensureHistoryDepth`.

---

## Part 3 — AI integration audit (all models, all providers) — SEPARATE PART

### 3.1 The reported bug, traced

`Menu → Your Team → image upload` → `routes/teams.ts:187 parseTeamImage` →
`ai/gateway.ts:431 adapter.parseTeamImage` →
`openai-compatible.ts:149`: the request body hard-codes **`max_tokens`**
(and `temperature: 0`). OpenAI's GPT-5-era and o-series models reject
`max_tokens` with exactly your error (`unsupported_parameter`, "use
'max_completion_tokens' instead") — and after that is fixed, the **same
models reject `temperature` ≠ 1** ("only the default (1) value is
supported"), so the naive one-line fix produces the *next* 400. The same two
hard-codings sit in the analyse path (`openai-compatible.ts:74-75`).

### 3.2 Full defect table (every provider adapter, read line-by-line)

| Provider (file) | Defect | Blast radius |
|---|---|---|
| OpenAI-compatible (`openai-compatible.ts:75,149`) | `max_tokens` + fixed `temperature` sent to models that reject both (GPT-5 family, o-series). DeepSeek/Kimi/vLLM/Modal still REQUIRE `max_tokens` — a global rename breaks them instead. | Analyse + vision 400 on modern OpenAI models (your bug). |
| OpenAI-compatible (`:162-168`) | Vision `finishReason` hard-coded `'complete'` — a truncated vision reply is undetectable; JSON parse then fails with an opaque 422 "could not produce a valid team parse". | Misdiagnosed vision failures. |
| OpenAI-compatible (`:105`) | `String(message.content)` — servers that return content as an array of parts yield `"[object Object]"`. | Silent validation failures on some compatible backends. |
| Anthropic (`anthropic.ts:72,93,106`) | `temperature` sent unconditionally — **removed (400) on the 4.6+/5 family**, including the adapter's own default vision model `claude-sonnet-5`. Identical failure shape to the OpenAI bug, currently latent because no Anthropic key is configured. | Anthropic analyse + vision 400 on every current model. |
| Anthropic (`anthropic.ts:89-98`) | `repair()` sends `[assistant, user]` — the Messages API requires the first message to be user-role; the repair call 400s every time it fires. | The single-repair-retry safety net is dead on Anthropic. |
| Anthropic (`anthropic.ts:70,91,129`) | Default model `claude-haiku-4-5-20251001` uses a date-suffixed ID; the canonical current ID is `claude-haiku-4-5`. Works today only as a legacy snapshot alias; also predates the models the account may actually want. | Fragile defaults, stale model list. |
| Gemini (`gemini.ts:34-35`) | `maxOutputTokens: 4096` on 2.5-era models — **thinking tokens spend from that same budget**; a long-thinking reply arrives with `MAX_TOKENS` and empty text. No `thinkingConfig` escape is set. | Empty analyse replies that read as validation failures. |
| Gemini (`gemini.ts:84-91`) | `repair()` sends contents starting with role `model` — v1beta requires user-first contents on generateContent. | Repair 400s on Gemini. |
| DeepSeek (registry `registry.ts:32` + gateway `:66-78`) | `supports_vision` is a per-PROVIDER boolean seeded false — but **`deepseek-v4-flash-vision-exp` exists (live-probed this pass)**. Vision capability is per-MODEL; the schema cannot express it, so the active provider wrongly hard-blocks uploads. | Your exact "vision leads to error" UX, one provider over. |
| Kimi (gateway `:84`) | Default `kimi-k2-0711-preview` — a 2025 preview snapshot as the 2026 default. | Stale default; likely deprecated upstream. |
| All adapters | No image preprocessing: an 8 MB upload becomes ~11 MB of base64; Anthropic caps images at 5 MB/8000px — oversized screenshots 400 there and waste tokens everywhere (a full-res phone screenshot ≈ 2-3× the tokens of a 1568px-wide resize). | Cost + avoidable 400s. |
| Gateway (`ai/gateway.ts:438`) | Vision debits AFTER the call with no BudgetGuard pre-check (X3). | Free-riding failure mode + 500 on insufficient balance. |
| Gateway (`ai/gateway.ts:441`) | Vision has no repair retry and no truncation split — one shot, then 422. | Screenshots that "almost parsed" are discarded, with credits spent. |
| Admin UI (`Admin.tsx` AiTab) | Model picker lists model IDs with zero capability metadata (gap-audit: GAP × 2) — an admin can select `gpt-5.x` or `o4-mini` with no warning that the adapter's params are incompatible. This is how the bug reached you. | The whole class recurs on every new model family. |

### 3.3 The fix design: a model-capability registry + probe-and-learn

One mechanism ends the whole class, mirroring the ingest layer's
entitlement learning:

1. **⚙ `ai_model_capabilities`** in `model_config` (data, admin-editable):
   ordered pattern rules →
   `{match: "gpt-5*|o[0-9]*", token_param: "max_completion_tokens",
   temperature: "fixed", vision: true, json: "json_schema"}`,
   `{match: "deepseek-*-vision-*", vision: true, token_param: "max_tokens"}`,
   `{match: "claude-*", temperature: "omit", token_param: "max_tokens"}`
   (current Anthropic models reject sampling params; `max_tokens` remains
   correct there), defaults per provider at the end. Seeded with the
   researched truth table; refit as data, never code (Rule #1 pattern).
2. **Request builder consults the registry**: token-param name, whether to
   send temperature at all, response-format mode, vision-message shape.
   `repair()` becomes user-role-only on every provider (previous output
   embedded IN the user message — valid everywhere, cache-friendlier too).
3. **Probe-and-learn on model selection** (admin picks a model → one
   ~1-token probe request): a 400 naming a parameter updates the provider's
   learned capabilities in `ai_providers.config.capabilities` and the picker
   shows the flags (fixes the gap-audit lines; the admin sees
   "vision ✓ · temperature locked · max_completion_tokens" before saving).
4. **Vision hardening**: sharp preprocessing (resize ≤1568px, JPEG q80 —
   also the OCR input), `finishReason` derived from the real
   `choices[0].finish_reason`, one repair retry for vision, BudgetGuard
   pre-check before the provider call, and per-model vision routing (a
   non-vision provider with a vision-capable sibling model can route the
   vision call to it — e.g. DeepSeek chat model for analyse,
   `…-vision-exp` for uploads — same key, zero extra config).
5. **Registry corrections**: `supports_vision` moves from seed-time boolean
   to derived-from-model; stale defaults refreshed (`claude-haiku-4-5`,
   current Kimi ID); pricing table gains the missing entries so
   `computeCredits` stops falling back to `{in:1, out:5}` for unknown keys.

Acceptance: with a capability-locked model configured, analyse + vision +
repair each succeed against a recorded-fixture fake server for every
provider family; the two `admin-ai` gap lines flip to PRESENT; a live
DeepSeek text call and (when you re-add an OpenAI key) a live GPT-5-class
vision parse complete without a 4xx.

---

## Part 4 — Product packages (the four asks)

### P1 · Run data-depth selector + provider subscription model
Build Part 2.9 exactly: ⚙ `provider_plans`, populated `quota_limit`,
per-provider plan selector in Admin → Data providers, and the Run screen's
data-window table gains per-source depth dropdowns (days / months / seasons
/ career — options = plan ∩ entitlements). Launch run backfills to the
selection through the existing resumable ledger; the report says what was
pulled and what the plan refused (so a "why can't I select 5 years on
NewsData free" is answered inline). New backfill executors where they do
not exist yet: football-data past seasons (paid tier), API-Football
2022–2024 fixtures/injuries (free window), NewsData archive (paid),
Understat season aggregates (admin-triggered). Migration 0011 adds nothing
here — plans and depth are model_config data.
*Gap lines to flip: `run · SELECTABLE depth`, `run · subscription-plan`.*

### P2 · Squad-style everywhere + savable builds
- **Weekly**: render the engine's picked best XI for the selected team as
  the same `PitchView` used by Initial/Chips (formation, C/V armbands,
  bench order), post-transfer variant when a suggestion is applied.
- **Savable builds**: every generated squad (Initial XI, Free Hit build,
  Wildcard build, Weekly XI snapshot) gets "Save as team" — POST the
  existing `/api/teams` payload, plus migration 0011:
  `user_teams.kind text NOT NULL DEFAULT 'manual'`
  (`manual|imported|initial_xi|freehit|wildcard|weekly`) and
  `user_teams.source_run_id bigint` so a build remembers which run priced
  it. Teams page shows kind badges; Chips/Weekly team pickers can filter to
  playable kinds. Bench order + captain/vice persist through the existing
  slot/bench columns (already in the schema — no reshape).
*Gap lines: `weekly · pitch`, `weekly · formation/armbands`,
`initial-xi · save`, `chips · save`.*

### P3 · OCR-first team-image parsing (token saver)
Replace the vision-only pipeline with a three-stage pipe in
`routes/teams.ts` → new `ocr/` module:
1. **Preprocess** (sharp, already-planned dependency): grayscale, 2×
   upscale, adaptive threshold — the published recipe for game-UI
   screenshots.
2. **OCR** with `tesseract.js` (pure WASM — no apt package, works inside
   the existing install.sh story; `eng.traineddata` ships INSIDE the
   release payload per Rule 1c immutability, worker cache under
   `DATA_DIR/ocr/`). Output: raw text lines + confidence.
3. **AI reformat (text-only)**: the OCR text (≈300–600 tokens) goes to the
   ALIVE provider's normal chat model with a strict "map to
   ParsedTeamSchema JSON" prompt — **no vision model needed at all**, so
   DeepSeek-class providers finally support uploads, and token cost drops
   from ~1.5–3k vision tokens to ~0.5–1k text tokens per parse (60–75%
   saving; exact numbers recorded per call in `ai_calls` as today).
   Existing resolution/confirmation flow unchanged (`teams.ts:198-247`).
Fallback ladder ⚙ `vision_pipeline`: `{ocr_first: true, min_names: 8,
fallback_vision: true}` — if OCR yields <8 candidate names and the provider
(per the P4 registry) has a vision-capable model, fall back to today's
vision call; otherwise return the OCR attempt with a clear "blurry
screenshot" message. `team_uploads.parse_result` records which stage won.
*Gap lines: `teams · OCR-first`, `teams · AI reformat`.*

### P4 · AI capability registry + adapter fixes
Part 3.3, shipped as one package (it gates P3's provider-agnostic reformat
call and unblocks your OpenAI vision path).

---

## Part 5 — Carried-forward engine packages (from the archived enginesupgrade.md)

Unchanged in intent, re-sequenced under the new versioning; the audit above
adds line-level targets to each. Summary:

- **A-series (statistical)**: A1 market blend (odds adapter behind
  entitlements + `ep_next` pseudo-market sanity term); A2 price-change
  intelligence (`price_events` writer exists ✓ — add the trajectory model +
  self-calibration vs `cost_change_event`, risers/fallers surface,
  suggester sell-price urgency; replaces S9's noisy momentum input); A3
  availability reconciliation (write `availability_state` from FPL flags +
  news signals + structured feeds; L3 consumes it — fixes S3); A4
  **backtest & calibration harness** (walk-forward over the imported
  seasons into `model_errors`; refit ⚙ constants as new config versions;
  every later engine change must not regress it — fixes S11 and M5's
  invented constants); A5 opponent-style DEFCON (`team_style_stats` writer
  — fixes S4); A6 venue splits + ICT/ep_next columns (fixes S5); A7
  distribution-true variance (reuse the seeded Monte Carlo; P10/P50/P90 on
  the matrix; fix S12's flat save-rate and M7's off-model bonus while in
  there); A8 npxG-aware finishing multiplier (fixes S7, needs npxg from
  Understat match-level or FPL when it ships it).
- **B-series (match)**: B1 publish win/draw/loss + top scorelines + h2h
  context (fixes M1/M8, football-data h2h ✓); B2 predicted XI (own minutes
  model) + confirmed-lineup ingestion + the mini_lineup trigger (fixes
  S2/M2-pre); B3 **live gameweek engine** (event/live + BPS bonus
  projection + auto-sub preview + SSE `live` channel — fixes M2); B4
  context enrichment (kickoff/venue/thumbnails TSDB ✓, standings + referee
  from football-data ✓, UCL congestion via TSDB team events — fixes S8/M6);
  B5 captaincy display = ceiling (fixes M3); B6 chip-valuation corrections
  (real bench for bboost, doubled-captain baseline, ⚙-ify the WC factor —
  fixes M4/M5/M9).
- **C-series (news)**: C1 RSS ingestion engine (feed registry ⚙, ETag
  conditional GETs, same indexer downstream — fixes N1); C2 matchday-aware
  scheduler cadences (quiet / deadline-24h / KO−90→−20 / in-play /
  price-watch 02:15Z); C3 availability + lineup hints from text (fixes half
  of N6, feeds A3/B2); C4 bounded lexicon sentiment (fixes rest of N6); C5
  news product surface (dashboard feed, player timeline drawer, signal
  badges, photos cached under `DATA_DIR/media/` served same-origin — X2
  constraint); C6 indexer correctness (possessive/token-boundary matching
  N2, entity+category story corroboration N3, negation guards N4, ⚙ window
  + story-dedup in bundles N5).
- **X-series (cross-cutting)**: X1 key-persistence fix FIRST (§1.5); X2
  SSE data-freshness channel; X3 vision BudgetGuard; X4/X5/X6 hardening
  notes above; S6 upsert-guard cleanup and S13 event-window documentation
  ride along with whichever package touches those files.

---

## Part 6 — Acceptance gates (release-blocking, cumulative)

1. Both gap-audit specs green with every shipped package's lines flipped to
   PRESENT and hardened from soft-log to assert.
2. AI: recorded-fixture contract tests per provider family × {analyse,
   repair, vision/OCR-reformat}; a capability-registry unit suite (pattern
   resolution, probe-learning); live smoke on DeepSeek text + one
   vision-capable provider when a key exists. No AI call path may contain a
   hard-coded `max_tokens`/`temperature` again (lint rule).
3. OCR: ≥13/15 names extracted on the reference screenshot set (pitch view
   + list view, light + dark), AI reformat ≤1k tokens/parse, vision
   fallback fires only under the ⚙ ladder. Credits per parse visibly drop
   in the AI-calls admin table.
4. Depth selector: options per provider provably = plan ∩ entitlements
   (unit-tested matrix); selecting deeper history triggers a resumable
   backfill whose ledger the Run report and admin History tab both show;
   PLAN_DENIED depths are un-selectable with the reason shown.
5. Squads: all five kinds savable/loadable/clonable; Weekly renders the
   pitch; a saved freehit build re-opened after three more runs still shows
   its source run and prices.
6. Engine packages keep their gates from the archived plan (backtest
   non-regression, live-board ≤60s lag, ≥90% bonus-projection accuracy,
   price-rise precision ≥85%, RSS ≥300 articles/day at 0 credits,
   availability rows for 100% of flagged players).
7. Rule #1 end-to-end every release: migration 0011+ forward-only with
   schema bump, jsonb-merge for nested ⚙ additions, rehearsed
   install/upgrade/rollback, keys-survive-upgrade assertion (new, from X1),
   `git grep` key-leak gate, site + credentials untouched.

## Part 7 — Execution order (+0.0.1 per release)

- **v1.4.1 — "stop the bleeding":** X1 key persistence (+`key_audit`) →
  P4 AI capability registry + all §3.2 adapter fixes → X3 vision
  BudgetGuard → P3 OCR-first pipeline (its cheap text path depends on P4).
  Migration 0011a (key_audit). Directly closes your reported bug and the
  token bleed.
- **v1.4.2 — "the product asks":** P2 squad styles + savable builds
  (migration 0011b: `user_teams.kind`, `source_run_id`) → P1 depth
  selector + subscription model → B5 captaincy display fix (one-liner
  riding along).
- **v1.4.3 — "the nervous system":** C1 RSS → C2 scheduler → C6 indexer
  correctness → B1 match previews → C5 news surface + photos (X2-compliant
  media cache) → A6 quick features.
- **v1.4.4 — "the live gameweek":** B3 live engine + X2 SSE → B2
  predicted/confirmed XI + mini_lineup trigger → A3/C3 availability
  reconciliation → A2 price intelligence.
- **v1.4.5 — "the calibrated engine":** A4 backtest harness → constant
  refits → A5/A7/A8 model corrections → B4/B6 context + chip fixes → A1
  odds blend (fully live when a paid odds key arrives).

Each release: version +0.0.1, migration+schema bump only when tables
change, full test + Playwright + gap-audit pass, `build-release.sh`,
rehearse install/upgrade/rollback, changelog, tag, push — CLAUDE.md Rule 1e,
no exceptions.

---

## Sources

- OpenAI parameter drift: [OpenAI community — max_tokens/temperature no longer allowed](https://community.openai.com/t/api-stopped-working-max-tokens-and-temperature-no-longer-allowed/1110863) ·
  [LiteLLM GPT-5 max_tokens issue](https://github.com/BerriAI/litellm/issues/13381) ·
  [GPT-5 temperature removal](https://github.com/RooCodeInc/Roo-Code/issues/6965) ·
  [GPT-5 API parameters guide 2026](https://crazyrouter.com/en/blog/gpt-5-api-parameters-guide-2026-unsupported-parameter-fixes) ·
  [OpenAI Help — controlling response length](https://help.openai.com/en/articles/5072518-controlling-the-length-of-openai-model-responses)
- Anthropic API parameter rules (temperature removed on current models,
  message-role requirements, current model IDs): Anthropic API docs via the
  bundled claude-api reference (verified 2026-08).
- Provider tiers: [football-data.org pricing](https://www.football-data.org/pricing) ·
  [football-data free-tier limits 2026](https://www.thestatsapi.com/blog/football-data-org-free-tier-limits-2026) ·
  [API-Football](https://www.api-football.com/) ·
  [NewsData archive endpoint](https://newsdata.io/blog/all-about-news-archive-endpoint/) ·
  Sportmonks/TheSportsDB plan pages (live-probed scopes 2026-08).
- OCR: [node-tesseract-ocr overview](https://products.fileformat.com/ocr/nodejs/node-tesseract-ocr/) ·
  [Tesseract + Sharp preprocessing walkthroughs](https://devsouvik2002.medium.com/building-an-ocr-powered-image-to-text-converter-with-tesseract-and-sharp-in-express-5e0a17b1e892) ·
  [OCR accuracy preprocessing guide](https://www.timsanteford.com/posts/how-to-ocr-with-tesseract-js-to-unlock-text-from-images/)
- Market/model references carried from the archived plan: LiveFPL, FPL Core
  price-threshold series, Fantasy Football Scout, bivariate Dixon-Coles
  literature (see `Old Markdown/enginesupgrade.md`).

*End of plan. Implementation starts on explicit go-ahead, sliced per Part 7.*
