# FPL Algorithm — Development Plan

**Project codename:** `fpl-algorithm`
**Document status:** Master development plan (v1.0) — this file is the single source of truth for the build.
**Companion documents:**
- `theme.html` — visual/design inspiration. Its design language (editorial layout, glass buttons, glass chips, glass input groups, mono kickers, serif display type) MUST be carried into `CLAUDE.md` so every build session follows it.
- `howupgradeshouldwork-1.md` — the release/upgrade architecture that `install.sh`, `upgrade.sh`, and `reinstall.sh` MUST implement exactly.
- `fpl-engines-plan.md` — **authoritative deep build spec** for the Statistical Engine and Match Engine: exact data sources & endpoint field references, interpretation guide, the ingestion→UID pipeline, all twelve model layers, integration DAG, and per-package acceptance gates. §5 and §6 below are the summaries; that document is the implementation contract.

---

## 1. Vision

A self-hosted Fantasy Premier League decision engine. It continuously ingests
football data (stats, fixtures, injuries, news), maintains an internal player
database where every player has a rich **data matrix** and an **overall
score**, runs a **statistical engine built from scratch** (probabilities,
expected points, starting-XI likelihood), then layers an **AI analysis pass**
on top of the news feed to re-rank players. The frontend gives the manager
three modes — **Initial Team Selection**, **Free Hit / Wildcard**, and
**Weekly** — all powered by the same core **FPL Engine**, plus a **Your
Teams** area (unlimited saved teams) where a team can be created or updated by
**uploading a screenshot of the real FPL team**.

The system is multi-user, gated behind login, token-metered (AI usage costs
tokens; only admins can top up tokens), fully mobile-responsive, and installed
/ upgraded through `install.sh`, `upgrade.sh`, and `reinstall.sh`.

---

## 2. High-level architecture

```
┌─────────────────────────────  Frontend (React + Vite + TS)  ─────────────────────────────┐
│  Login / Gate   Initial Mode   FreeHit·Wildcard Mode   Weekly Mode   Your Teams   Admin   │
│  (glassmorphism design system derived from theme.html — see §12)                          │
└────────────────────────────────────────┬──────────────────────────────────────────────────┘
                                         │ REST + SSE (run progress)
┌────────────────────────────────────────┴──────────────────────────────────────────────────┐
│                          Backend (Node.js 22 + TypeScript + Fastify)                      │
│                                                                                           │
│  ┌──────────────┐  ┌───────────────┐  ┌──────────────┐  ┌─────────────┐  ┌────────────┐  │
│  │  Data Ingest  │→│  Player DB &  │→│ Statistical  │→│    Match    │→│    FPL     │  │
│  │  Layer (APIs) │  │  UID Registry │  │   Engine     │  │   Engine    │  │   Engine   │  │
│  └──────────────┘  └───────────────┘  └──────────────┘  └─────────────┘  └────────────┘  │
│         ↑                                     ↑                                ↑          │
│  ┌──────┴───────┐                     ┌───────┴────────┐              ┌────────┴───────┐ │
│  │ API Gateway   │                     │  AI Gateway    │              │ Vision Pipeline │ │
│  │ (max 2 alive) │                     │ (max 1 alive)  │              │ (image → team)  │ │
│  └──────────────┘                     └────────────────┘              └────────────────┘ │
│                                                                                           │
│  Auth & Sessions │ Token Ledger │ Admin API │ Run Orchestrator │ Feature Kernel │ Cron    │
└────────────────────────────────────────┬──────────────────────────────────────────────────┘
                                         │
                              PostgreSQL 16 (+ Knex migrations)
```

**Stack decision (latest stable, pinned):**

| Layer | Choice | Why |
|---|---|---|
| Backend | **Node.js 26** (26.x — Current line, enters LTS Oct 2026) + TypeScript 5.x latest + **Fastify 5** | Latest runtime per project requirement; native `Temporal` API for all date/GW-deadline maths; matches the upgrade architecture in `howupgradeshouldwork-1.md` (Node/TS project) |
| DB | **PostgreSQL 18** (18.6+) + Knex migrations | Latest major; `uuidv7()` built-in (UID generation), async I/O perf gains; the upgrade doc's backup/restore machinery is built around `pg_dump`/`pg_restore` |
| Frontend | **React 19 + Vite 7** + TypeScript | Latest stable SPA toolchain, served from `frontend/dist` per the release layout |
| Scheduler | node-cron in-process | Simple; jobs are re-entrant and idempotent |
| Realtime | Server-Sent Events | Run-button progress + token counter streaming; no websocket infra needed |
| Process manager | systemd unit pointing at `current/backend/dist/server.js` | Per upgrade doc |

**Version policy:** always adopt the **latest stable** major of every stack
component at build time, then **pin exactly** — `"engines": {"node": ">=26"}`
in package.json plus an install-time runtime check (per the upgrade doc's
"Node version drift" pitfall: a release built for Node 26 must refuse to
start under an older runtime), lockfiles committed, PostgreSQL major pinned
in `install.sh` with the same existence-check discipline. Upgrading a major
version of anything is a normal release through `upgrade.sh`, never an
in-place drift.

Repository layout:

```
fpl-algorithm/
├── CLAUDE.md                  # build rules: theme, conventions, upgrade rules (see §12, §14)
├── fpl-engines-plan.md        # deep build spec for statistical + match engines (authoritative)
├── version.json               # { "version": "x.y.z", "schema": N }
├── backend/
│   ├── src/
│   │   ├── core/              # kernel, feature registry, config, logging
│   │   ├── ingest/            # API provider adapters + gateway (max-2 switch)
│   │   ├── players/           # UID registry, entity resolution, player matrix
│   │   ├── stats/             # statistical engine (from scratch)
│   │   ├── match/             # match engine
│   │   ├── fpl/               # FPL engine (rules, squads, transfers, chips, optimiser)
│   │   ├── ai/                # AI gateway (max-1 switch), providers, token accounting
│   │   ├── vision/            # team-screenshot → structured team pipeline
│   │   ├── auth/              # login, sessions, roles
│   │   ├── tokens/            # ledger, admin top-ups
│   │   ├── admin/             # user management API
│   │   └── run/               # Run Orchestrator (news pull → AI → stats → re-rank)
│   └── migrations/            # 0001_core.ts, 0002_... (forward-only, immutable)
├── frontend/
│   └── src/                   # modes, your-teams, admin, design system
├── scripts/
│   ├── lib.sh                 # shared shell library (logging, spinner, error trap)
│   ├── install.sh
│   ├── upgrade.sh
│   └── reinstall.sh
└── docs/
    ├── api-analysis/          # one analysis doc per external API (see §4.4)
    └── changelog.md
```

---

## 3. Internal Player Database & UID Registry

The **single most important invariant**: every FPL player exists exactly once
in our database under an internal UID, and every piece of data from every
external source is attached to that UID. No duplicates, no orphans.

### 3.1 UID scheme

- Internal UID: `plr_<ulid>` (e.g. `plr_01J5X9M3QK...`) — opaque, permanent,
  never reused, never derived from any external ID (external IDs change
  between seasons and between providers).
- The **FPL official API** (`bootstrap-static` → `elements[]`) is the
  *anchor source*: a player exists in our DB iff they exist in FPL. FPL's
  `element.code` (the stable cross-season player code, not the per-season
  `id`) is the primary external key.

### 3.2 Entity resolution (cross-provider identity mapping)

Each external provider has its own player IDs and name spellings
("Son Heung-min" / "Heung-Min Son" / "H. Son"). A mapping table resolves them:

```
player_identities
  player_uid      → players.uid
  provider        (fpl | api_football | sportmonks | ...)
  provider_id     (text)
  provider_name   (as the provider spells it)
  confidence      (1.00 exact / matched score)
  matched_by      (code | exact_name | fuzzy | manual)
  UNIQUE (provider, provider_id)
```

Resolution pipeline, in order:
1. Exact match on shared identifiers (some providers expose FPL code or opta ID).
2. Normalised name + team + position + birthdate match.
3. Fuzzy name match (trigram similarity ≥ threshold) **queued for manual
   confirmation** in the admin UI — never auto-merged below the threshold.
4. Unmatched provider records are parked in a review queue; they never create
   a second player row.

### 3.3 The player data matrix

Every player carries a versioned matrix — one row per player per computation
run — so history is preserved and rank changes are explainable:

```
player_matrix (append-only; one row per player per run)
  player_uid, run_id, gameweek, computed_at
  ── availability ─────────────────────────────
  p_start_xi          probability of starting XI (0–1)
  p_appearance        probability of ≥60 min
  injury_status       (fit | doubt_25 | doubt_50 | doubt_75 | out | suspended)
  injury_detail       text + expected return GW
  ── production ───────────────────────────────
  xg_per90, xa_per90, xgi_per90, shots_per90, key_passes_per90
  npxg_per90, box_touches_per90
  ── defensive / GK ───────────────────────────
  xcs (clean-sheet prob next fixture), saves_per90, defcon_per90 (DC points rate)
  ── FPL economics ────────────────────────────
  price, selected_by_pct, price_change_trend, transfers_in_net
  ── form & schedule ──────────────────────────
  form_ewma           exponentially weighted recent FPL points
  minutes_trend       EWMA of minutes
  fdr_next1, fdr_next3, fdr_next6   (our own fixture difficulty, §5.4)
  ── model outputs ────────────────────────────
  xpts_next1, xpts_next3, xpts_next6   expected FPL points (§5)
  stat_score          0–100 from the statistical engine
  ai_adjustment       −20…+20 from the AI pass (0 if AI skipped)
  ai_rationale        short text the AI produced
  overall_score       clamp(stat_score + ai_adjustment, 0, 100)
  rank_overall, rank_position          dense ranks recomputed per run
```

Raw ingested facts (per-match stats, injuries, news items) live in their own
normalised tables (`player_match_stats`, `injuries`, `news_items`,
`price_events`) keyed by `player_uid`; the matrix is a *derived snapshot*.

---

## 4. Data ingestion — API integrations

### 4.1 The anchor: FPL official API (always on, not counted in the max-2 switch)

`https://fantasy.premierleague.com/api/` is free, keyless, and canonical for
everything FPL-specific. It is the backbone, not an optional provider:

| Endpoint | Gives us |
|---|---|
| `bootstrap-static/` | all players (prices, ownership, status flags, per-90s, xGI, FPL's own `chance_of_playing_next_round`), teams, GW deadlines |
| `fixtures/?event={gw}` | fixtures + FPL's team strength based difficulty |
| `element-summary/{id}/` | per-player match history + upcoming fixtures |
| `event/{gw}/live/` | live GW points |
| `entry/{id}/...` | (optional later) read a user's real FPL entry |

Polling: `bootstrap-static` every 30 min on match days / 6 h otherwise;
fixtures daily; element-summary lazily with a 24 h cache.

### 4.2 The five pluggable providers (max two alive)

At least five integrations ship in v1. Each is an **adapter** implementing one
common interface; a DB-backed switch enforces **at most 2 enabled at any
moment** (enabling a third from the admin UI forces the user to pick one to
disable first — enforced again server-side with a transactional check, never
trust the UI).

| # | Provider | Tier | What we take from it | Notes |
|---|---|---|---|---|
| 1 | **API-Football (api-sports.io)** | Free 100 req/day; paid from ~$25/mo | injuries endpoint, lineups (predicted + confirmed), fixtures, player stats, odds | Best injury + lineup coverage; v3 REST |
| 2 | **Sportmonks Football API** | Free plan (limited leagues); paid tiers | xG, lineups, `sidelined` entity (injuries/suspensions with expected return), predictions, odds | Deep includes system; 24/7 verified data |
| 3 | **football-data.org** | Free 10 req/min (PL included) | fixtures, results, standings, scorers | Great free fallback for fixtures/results |
| 4 | **NewsData.io / NewsAPI.org** (news class) | Free dev tier; paid for volume | football news articles (injury rumours, press-conference quotes, transfer news) filtered by PL keywords | This is the *news* feed the AI reads |
| 5 | **TheSportsDB** | Free (patreon key for more) | team/player metadata, badges/photos, events | Cheap enrichment + media assets |
| 6 | **Understat** (stretch, unofficial) | Free | shot-level xG history | No formal API — scraper adapter, clearly flagged as fragile |

Provider adapter contract (every adapter must implement):

```
interface FootballProvider {
  key: string
  capabilities: Set<'fixtures'|'injuries'|'lineups'|'news'|'stats'|'odds'>
  healthCheck(): Promise<ProviderHealth>        // auth ok, quota remaining
  pull(capability, params): Promise<NormalisedRecord[]>
  quota(): { used: number; limit: number; resetAt: Date }
}
```

Rules the gateway enforces:
- **Max 2 alive** — `api_providers` table has an `enabled` boolean; a DB
  constraint-style transactional check (`SELECT count(*) ... FOR UPDATE`)
  rejects a third enable.
- Every pull is logged to `api_pull_log` (provider, endpoint, records,
  quota consumed, latency, errors) — this powers the analysis docs (§4.4).
- Per-provider rate limiting + circuit breaker: N consecutive failures →
  provider auto-marked `degraded`, surfaced in admin, gateway falls back to
  the other enabled provider for overlapping capabilities.
- All responses are cached (per-endpoint TTL) so re-runs don't burn quota.
- Normalisation happens **inside the adapter**: nothing outside `ingest/`
  ever sees a provider-shaped payload.

### 4.3 Capability routing

The ingest layer asks for a *capability* ("give me injuries"), not a provider.
The gateway resolves which enabled provider serves it, with a configured
priority order per capability (e.g. injuries: API-Football → Sportmonks →
FPL's own `chance_of_playing` flags as last resort).

### 4.4 API analysis plan (deliverable: `docs/api-analysis/*.md`)

Before each adapter is written, a spike task produces an analysis doc per API
— this is a required artifact, not optional:

1. **Auth & quota mechanics** — key type, rate limits, quota reset windows,
   what an over-quota response looks like.
2. **Endpoint map** — which endpoints we need, their request/response shapes,
   pagination style.
3. **Data quality probe** — pull one full GW of PL data, diff against FPL
   official; measure latency of injury news vs. reality (how fast did it know
   about the last five real injuries?).
4. **ID mapping strategy** — how this provider's player/team IDs map to our
   UIDs (§3.2), sample collision cases.
5. **Failure modes** — timeout behaviour, partial data, maintenance windows.
6. **Cost model** — requests per full refresh, requests per day at our polling
   cadence, when the free tier runs out, monthly paid cost projection.

Each doc ends with a go/no-go and the polling schedule for that provider.

---

## 5. Statistical Engine (built from scratch)

> **Authoritative spec: `fpl-engines-plan.md` Parts 1–4** — exact endpoint
> field references, interpretation guide, the twelve model layers with
> formulas, calibration targets, and acceptance gates. This section is the
> executive summary.

No third-party prediction library. The engine is a pipeline of explicit,
testable models. All probabilities land in the player matrix.

### 5.1 Minutes model → `p_start_xi`, `p_appearance`

- Inputs: last N starting lineups (confirmed lineups from providers), minutes
  EWMA, rotation pattern per manager (start-rate in last 6), FPL's
  `chance_of_playing_next_round`, injury records, suspension state,
  cup-congestion flag (fixture 3 days before/after).
- Model: logistic model on engineered features; v1 can start as a calibrated
  heuristic tree (documented weights) and graduate to logistic regression
  fitted on last-two-seasons data. Output is a genuine probability, validated
  by calibration plots (predicted 70% starters should start ~70% of the time).

### 5.2 Team goals model → fixture scorelines

- Poisson/Dixon-Coles style: attack strength × defence weakness × home
  advantage, fitted on rolling season data with time-decay weights.
- Outputs per fixture: expected goals for/against each team, clean-sheet
  probability (`P(GA=0)` from the Poisson), win/draw/loss probabilities.
- Where an enabled provider supplies odds, implied probabilities are blended
  in (odds are the strongest public signal) with a configurable weight.

### 5.3 Player expected points model → `xpts_next{1,3,6}`

For each player × fixture, compose per the official FPL scoring rules
(2026/27 rules incl. defensive-contribution points — DEF: +2 at 10 CBIT;
MID/FWD: +2 at 12 CBIRT — and the 2026/27 BPS rebalance; full constants
table in `fpl-engines-plan.md` §2.4):

```
xPts = p_appearance · appearance_pts
     + E[goals]  · goal_pts(position)        E[goals]  = xg_per90 · exp_minutes/90 · fixture_adj
     + E[assists]· assist_pts                same shape from xa_per90
     + p_cs(min≥60) · cs_pts(position)       from team goals model
     + E[defcon_pts] + E[save_pts] + E[bonus] (bonus via BPS proxy regression)
     − E[cards] − E[goals_conceded_penalty]
```

`fixture_adj` scales per-90 rates by opponent strength from §5.2.
Sum over horizons 1/3/6 GWs (chip planning needs the longer horizons).

### 5.4 Own fixture difficulty (FDR)

FPL's 1–5 FDR is crude. Ours: continuous 0–10 per fixture per side of the
ball (attacking difficulty vs. defensive difficulty differ — a team that
concedes lots but scores lots is easy for your forwards, bad for your
defenders). Derived from the §5.2 strength parameters + home/away splits.

### 5.5 `stat_score` (0–100)

Weighted composite over the matrix, position-normalised (a 70 for a GK and a
70 for a MID mean "equally good pick"):

```
stat_score = w1·z(xpts_next3) + w2·z(form_ewma) + w3·p_start_xi
           + w4·value_score(xpts/price) + w5·fixture_outlook − penalties(injury, suspension)
```

Weights live in a `model_config` table (admin-tunable, versioned), not in
code. Every run records the config version used → reproducibility.

### 5.6 Validation harness

- Backtest on the previous full season: replay GW by GW, compare predicted
  xPts to actual points (RMSE, Spearman rank correlation per position).
- Calibration reports for every probability output.
- Regression tests pin model outputs for a frozen fixture dataset so refactors
  can't silently change predictions.

---

## 6. Match Engine (match compatibility)

> **Authoritative spec: `fpl-engines-plan.md` Part 5** (computations,
> algorithms, output tables) and **Part 6** (full integration DAG, interface
> contracts, snapshot isolation, fast paths). This section is the executive
> summary.

Purpose: tell the frontend modes **which players from which upcoming matches
are the best to move on** — the bridge between fixtures and picks.

Per upcoming gameweek (and over 3/6 GW horizons):

1. Score every fixture for *attacking exploitability* and *defensive
   exploitability* (from §5.4).
2. Rank matches: "GW12: Spurs vs SHU is the highest-leverage attacking match;
   Arsenal away at Luton is the best clean-sheet match."
3. For each high-leverage match, surface the top-N players **by
   overall_score × p_start_xi** on the favoured side → the "players to target
   from this match" list.
4. Compatibility with *your* team: given a selected/uploaded team, compute
   fixture-coverage gaps (e.g. "you have no exposure to the two easiest
   attacking fixtures of GW14") and double-gameweek/blank-gameweek detection
   — the raw signal for Free Hit / Wildcard timing (§8.2).

Outputs feed all three modes as `match_insights` records per run.

---

## 7. AI Analysis Layer

> **Authoritative spec: `fpl-ai-engine-plan.md`** — provider-by-provider API
> contracts, the efficiency architecture (caching, batching, token
> accounting), error handling, and the invocation gate. This section is the
> executive summary.

### 7.0 HARD RULE — AI never runs automatically

**The AI layer is invoked ONLY by an explicit human action**: the Run button,
an image-upload parse, or an explicit admin-triggered action. It is **never**
invoked by cron/scheduled jobs, background pollers, the nightly micro-run,
the lineup-confirmed fast path, application startup, upgrades, retries of
failed runs, or any other automatic trigger. Scheduled jobs are statistical
only. If a future feature wants scheduled AI, it must be a new, default-OFF,
per-user opt-in setting that names its schedule and token cost explicitly —
and it does not exist in v1. This rule is enforced in code (the AI gateway
requires a `triggered_by_user_id` on every call and rejects calls from the
scheduler context), asserted in tests, and recorded in `CLAUDE.md`.

### 7.1 Provider roster & the max-1 gate

Seven providers ship behind one gateway. **Exactly one may be alive** at any
moment (DB flag + the same transactional guard pattern as the API switch;
activating one atomically deactivates the current one).

| Provider | API | Notes |
|---|---|---|
| DeepSeek | `api.deepseek.com` (OpenAI-compatible) | very cheap tokens |
| Gemini | Google AI Studio / `generativelanguage.googleapis.com` | free tier available; vision-capable |
| ChatGPT (OpenAI) | `api.openai.com` | vision-capable |
| Claude (Anthropic) | `api.anthropic.com` | vision-capable |
| Ollama | self-hosted `localhost:11434` | zero token cost; needs a pulled model; token accounting still recorded (as 0-cost) |
| Kimi (Moonshot) | `api.moonshot.ai` (OpenAI-compatible) | long context |
| Modal.com | user-deployed inference endpoint on Modal | adapter calls a configured Modal web endpoint |

Adapter contract:

```
interface AIProvider {
  key: string
  supportsVision: boolean
  analyse(batch: PlayerNewsBundle[], opts): Promise<AIAdjustment[]>   // structured JSON out
  parseTeamImage(image): Promise<ParsedTeam>                          // vision providers only
  estimateTokens(batch): number
  usage(): { promptTokens; completionTokens }                         // per call, recorded
}
```

- All prompts demand **structured JSON output** (player_uid, adjustment
  −20…+20, one-line rationale, confidence); responses are schema-validated and
  rejected/retried once on invalid JSON.
- If the alive provider lacks vision, image upload falls back with a clear
  message telling the admin which providers support vision — we never
  silently call a second provider.

### 7.2 What the AI actually does

The AI does **not** replace the statistical engine. Per run:

1. Receives, per player: a compact matrix summary + the *new since last run*
   news items mapped to that player (title, snippet, source, age).
2. Judges only what stats can't see: press-conference hints, "trained fully
   today", tactical role changes, manager quotes, transfer sagas, morale.
3. Returns a bounded adjustment `ai_adjustment ∈ [−20, +20]` + rationale.
4. `overall_score = clamp(stat_score + ai_adjustment, 0, 100)` → re-rank.

Bounded adjustment is a hard rule: the AI can never move a player more than
20 points, so a hallucination can't destroy the ranking.

### 7.3 Token-saving measures

1. **Exclusion list (manual, required feature):** players ranked in the
   bottom-X (configurable, default bottom 25%) of the *last* run are
   pre-checked as "skip AI" in the run screen; the user can toggle any player
   in/out before launching. Skipped players keep `ai_adjustment` from their
   last analysed run, flagged `stale`.
2. **News-driven batching:** players with **zero new news items** since their
   last AI pass are skipped automatically (nothing for the AI to read).
3. **Compact serialisation:** matrix fields are sent as a terse fixed-order
   CSV-ish block, not verbose JSON; shared context (scoring rules, GW info)
   is sent once per batch, not per player.
4. **Batching:** N players per request (default 20) to amortise the system
   prompt; provider-specific max set per adapter.
5. **News dedup + truncation:** near-duplicate articles collapsed
   (title-similarity), snippets hard-capped, max M articles per player.
6. **Pre-run estimate:** `estimateTokens()` shown *before* the run starts
   ("~48,300 tokens ≈ 49 credits — proceed?").
7. **Response caching:** same player + same news-set hash within 24 h → cached
   verdict, zero tokens.

### 7.4 The Run button & Run Orchestrator

One button (per mode and on the dashboard) triggers the full pipeline. It is a
background job with SSE progress streaming to the UI:

```
RUN pipeline (run_id recorded, every stage timed + logged):
 1. NEWS PULL     — gateway pulls news + injuries from the ≤2 enabled providers
 2. INGEST        — normalise, map to player UIDs, dedup vs. seen items
 3. STATS         — statistical engine recomputes the full matrix (§5)
 4. MATCH         — match engine recomputes match insights (§6)
 5. AI PASS       — alive provider analyses the non-excluded, news-bearing players
 6. RE-RANK       — overall_score + ranks written as a new matrix snapshot
 7. REPORT        — token usage warning: "This run used 51,204 tokens
                    (prompt 44k / completion 7k) = 52 credits. Balance: 448."
```

- Tokens are **debited from the launching user's balance** (admins: unlimited,
  usage still recorded for cost visibility).
- Insufficient estimated balance → run refused before step 1 with the
  estimate shown.
- Concurrency: one run at a time system-wide (advisory lock); a second click
  attaches to the live run's progress stream instead of starting another.
- Every run is stored in `runs` (who, when, providers used, tokens used,
  players analysed/skipped, duration per stage) — the admin panel charts this.

---

## 8. FPL Engine & the three frontend modes

The **FPL Engine** is the shared core every mode calls. It owns:

- **Rules model:** squad = 15 (2 GK / 5 DEF / 5 MID / 3 FWD), ≤3 per club,
  £100.0m initial budget, valid formations, captain/vice, bench order,
  transfer rules (1 free/GW, banked max 5, −4 hits), and the **2026/27 chip
  system: two full chip sets (Wildcard, Free Hit, Triple Captain, Bench
  Boost = 8 chips), set 1 usable only up to the GW19 deadline with no
  carry-over, set 2 covers GW20–38** — encoded as pure, unit-tested
  functions with season-versioned rule configs (FPL changes rules yearly;
  the AM-chip experiment of 24/25 proved shapes can appear and vanish).
- **Squad optimiser:** maximise Σ expected points subject to the rule
  constraints. Implementation: linear programming via a small ILP solver
  (e.g. `javascript-lp-solver`) with a documented greedy+swap fallback;
  objective is configurable (xpts_next1 vs next3 vs next6 + bench weighting).
- **Transfer suggester:** given a current squad, enumerate 1- and 2-transfer
  moves (and hit-taking variants), score each by Δ expected points over the
  chosen horizon minus hit cost, return the top suggestions with reasoning
  pulled from matrix + match insights + AI rationales.
- **Team valuation:** rate any 15-man squad 0–100 (points potential, fixture
  coverage, bench strength, captaincy options, budget efficiency).

### 8.1 Mode 1 — Initial Team Selection (GW1)

- Builds the optimal GW1 squad from scratch (optimiser, horizon next-6 by
  default since early fixtures matter).
- Interactive: lock players you insist on, ban players, set budget aside,
  re-optimise around constraints.
- Also accepts an **image upload or saved team**: "here's my draft — rate it
  and show what the engine would change" (diff view: out/in, Δxpts, Δbudget).

### 8.2 Mode 2 — Free Hit / Wildcard

- **When:** the match engine scans upcoming GWs for chip-worthiness — double
  gameweeks, blank gameweeks, extreme fixture swings, and *your team's*
  fixture-coverage gap score (§6.4). Produces a per-GW chip score with a
  recommendation: "Best Free Hit window: GW29 (blank GW, only 4 of your
  players have a fixture). Wildcard value peaks GW19."
- **What:** for the chosen GW, builds the full chip squad (Free Hit: 1-GW
  horizon; Wildcard: 6-GW horizon) from the uploaded / selected team's budget
  and shows the complete diff against the current team.
- Input team via image upload or **Your Teams** picker, like every mode.

### 8.3 Mode 3 — Weekly

- User states (or the saved team stores) **free transfers available** and
  bank balance.
- Engine returns ranked suggestions: best 0-transfer move (captaincy + bench
  order only), best 1-transfer, best 2-transfer, and whether any hit is worth
  it (Δxpts > 4 rule with horizon reasoning) — each with expected-points
  delta, matrix evidence, and the AI's news rationale for players involved.
- Also surfaces: injury alerts inside your squad, price-change risk, and the
  match-engine "players to target this GW" list.

---

## 9. Your Teams & the image-upload vision pipeline

### 9.1 Your Teams (unlimited)

- Every user can save **unlimited teams** (name, squad of 15 player UIDs,
  bank, free transfers, chips used, notes).
- Rendered **FPL-style**: pitch view with shirts, captain badge, bench row —
  the signature visual of the app (see §12).
- A team can be created three ways: picked player-by-player (searchable list
  backed by the player DB), **uploaded as a screenshot**, or cloned from
  another saved team. Teams are editable at will, including re-upload of a
  fresh screenshot to overwrite the squad ("sync from image").

### 9.2 Image upload pipeline (used by all three modes + Your Teams)

```
image → validate (type/size, strip EXIF) → alive AI provider (vision)
      → structured JSON: 15 × {name, club, price?, captain?, bench_position?}
      → entity resolution against player DB (same machinery as §3.2)
      → CONFIRMATION SCREEN: parsed team shown on the pitch; ambiguous
        players flagged with a picker ("Did you mean L.Díaz (LIV) or Díaz (CRY)?")
      → user confirms → saved team / fed into the mode
```

- Vision calls cost tokens like any AI call (estimated up front, debited,
  reported).
- Never auto-trust OCR: the confirmation screen is mandatory; a mis-parsed
  team silently feeding the optimiser would produce garbage advice.
- If the alive provider has no vision support, the UI explains and offers
  manual entry.

---

## 10. Security, auth, users & the token economy

### 10.1 Authentication & gating

- Username/email + password login. **Argon2id** hashing, per-user salt.
- Sessions: httpOnly, Secure, SameSite=Lax cookies backed by a server-side
  `sessions` table (revocable); idle + absolute expiry.
- Login throttling: per-account and per-IP exponential backoff + lockout
  counter; all auth events audited.
- **No self-registration.** Users exist only when an admin creates them
  (per requirements: manual add). First-run bootstrap: `install.sh` creates
  the initial admin and prints a one-time credential.
- Every API route behind auth middleware; role checks (`user` / `admin`)
  server-side on every admin route — the frontend hiding a button is never
  the security boundary.
- CSRF protection on state-changing routes, strict CORS (same-origin),
  Helmet-style security headers, rate limiting on all public endpoints.
- All secrets (API keys for providers/AI) live in `shared/.env`, never in the
  DB, never sent to the frontend; admin UI shows only key *status* (set /
  valid / quota), never key values.
- Input validation with a schema library (zod) on every route; file uploads
  size/type-capped and stored under `shared/data/uploads/`.
- Dependency audit + `npm audit` in CI; security review checklist before
  each release.

### 10.2 Users, tokens, admin

```
users            id, email, name, password_hash, role (user|admin), status, created_by
token_ledger     id, user_id, delta (+top-up / −run cost), balance_after,
                 reason (topup | run | vision | refund), run_id?, admin_id?, created_at
```

- **Token = the app's AI credit unit** (1 credit ≈ 1k model tokens; the
  conversion rate per provider lives in `model_config` so cheap providers
  cost fewer credits).
- Users start at an admin-set balance. Every run/vision call debits the
  ledger atomically (`SELECT ... FOR UPDATE`), balance can never go negative.
- **Out of tokens →** runs are refused with a friendly screen: "You're out of
  credits. Contact your admin to top up." (admin contact info configurable).
- **Only admins top up**, via the admin panel; every top-up is a ledger row
  with the admin's id — full audit trail. There is no payment integration in
  scope; payment happens off-app between user and admin.
- **Admins have unlimited tokens** (no debit, but usage still recorded so the
  admin sees true cost).
- Admin panel: create/disable users, reset passwords, top up tokens, view
  per-user usage charts, manage the API max-2 switch and AI max-1 switch,
  tune model weights, view run history and pull logs.

---

## 11. Database schema (summary)

Forward-only Knex migrations per `howupgradeshouldwork-1.md` (never edit a
released migration; never destructive; `down()` throws).

```
0001_core            users, sessions, token_ledger, model_config, feature_states
0002_players         players (uid, fpl_code, name, position, club, ...), player_identities
0003_ingest          api_providers (enabled max-2 guard), api_pull_log, news_items,
                     news_player_map, injuries, price_events
0004_stats           player_match_stats, team_strength, fixtures, player_matrix, runs
0005_ai              ai_providers (alive max-1 guard), ai_calls (tokens, cost, latency),
                     ai_verdict_cache, ai_exclusions (per-user manual skip list)
0006_teams           user_teams, user_team_players, team_uploads (image meta + parse result)
0007_match_engine    match_insights, chip_recommendations
```

---

## 12. Frontend & design system

### 12.1 Design language (from `theme.html` → codified in `CLAUDE.md`)

`theme.html` ("The Gridiron Weekly") defines the aesthetic: **editorial
sports-journal meets glassmorphism**. `CLAUDE.md` must carry these rules so
every build session, human or AI, produces consistent UI — explicitly *not*
generic AI-looking gradients-on-dark:

- **Palette:** paper `#F6F4EF`, ink `#1B1D1A`, navy `#1C2B4A`, brick
  `#B23A2E`, brass `#B8892F`, line `#D9D4C7` — as CSS custom properties.
- **Type:** Source Serif 4 (display/headlines), Public Sans (body),
  JetBrains Mono (kickers, stats, numbers). Mono uppercase kickers with
  letter-spacing introduce every section.
- **Glass elements everywhere it counts:** `btn-glass`, `btn-glass-dark`,
  `chip-glass`, `glass-input-group` patterns from theme.html (layered
  gradients, `backdrop-filter: blur`, inset highlights, soft shadows) —
  reused for the Run button, mode switcher chips, login card, token balance
  pill, and **the admin backend too** (the admin panel gets the same navy
  stat-panels, glass tables and charts — no bare bootstrap-looking admin).
- **Signature components:** power-rankings list (rank number, body, ▲▼ change
  chip) reused for player rankings; navy stat-panel for GW-at-a-glance;
  matchup-compare card for the match engine; striped standings table style
  for data tables.
- **The pitch view:** FPL-style green pitch with shirt cards, captain badge,
  price + xpts chips per player — designed within the same palette (brass
  captain badge, glass player chips).

### 12.2 Responsiveness & quality bar (hard requirements)

- **Every page fully responsive** 360 px → 4K: no horizontal page scroll, no
  text overflow/overlap ever. Wide tables scroll inside their own container
  (theme.html's `.table-wrap` pattern). Pitch view reflows to a stacked
  layout on narrow screens.
- Follow theme.html's breakpoint discipline (mobile drawer nav, collapsing
  grids at 900/760/640/560/480).
- Visual QA gate: Playwright screenshot tests at 5 viewport widths on every
  page; overflow assertions (`scrollWidth <= clientWidth`) in CI.
- Accessibility: focus-visible outlines (theme.html style), semantic
  headings, WCAG AA contrast.

### 12.3 Pages

| Page | Contents |
|---|---|
| Login | glass card, brand masthead, errors, throttle messaging |
| Dashboard | last run summary, token balance pill, Run button, top rank movers, next deadline |
| Mode: Initial | optimiser controls, locks/bans, pitch view, diff view, image upload |
| Mode: Free Hit/Wildcard | chip-timing timeline chart, per-GW chip scores, chip squad + diff |
| Mode: Weekly | transfer suggestions ranked, injury alerts, captaincy, match-engine targets |
| Your Teams | unlimited team cards, pitch view, upload/sync-from-image, clone |
| Players | full ranking table (power-rankings style), player detail with matrix history sparkline |
| Run screen | pre-run token estimate, exclusion checklist (§7.3.1), live SSE progress, token report |
| Admin | users + tokens, API switch (max 2), AI switch (max 1), model weights, run/pull logs, cost charts |

---

## 13. Installation & upgrade system

Implements `howupgradeshouldwork-1.md` **exactly** — that document is the
spec; this section only maps it onto this project. `CLAUDE.md` must reference
it so no build session deviates.

- **Layout:** `/opt/fpl-algorithm/{current → releases/x.y.z, releases/,
  shared/{.env,data/}, backups/}`. Release dirs immutable; uploads, logs and
  generated files live only in `shared/data` behind `DATA_DIR`; systemd unit
  points at `current/backend/dist/server.js`.
- **`version.json`** at repo root: `{ "version": "x.y.z", "schema": N }`;
  exposed via `/api/system/info` with `{applied, available, dbAhead}`.
- **Migrations:** numbered, forward-only, immutable once released, never
  destructive (copy-forward on reshape), `down()` throws, idempotent SQL
  where cheap.
- **Mismatch guards:** CLI migrate guard + server boot guard, both exiting
  78 when the DB is ahead of the code.
- **`install.sh`:** idempotent — creates layout, postgres role/db (existence
  -checked; existing DB parked, never dropped), generates `shared/.env`
  (once), installs deps, runs migrations, installs systemd unit + nginx
  config, creates the first admin user, health-checks, prints the summary
  box + log path. Quiet console, full transcript to a timestamped log.
- **`upgrade.sh`:** the exact 9-step sequence — preflight (refuse downgrade
  by schema int) → **verified** `pg_dump` backup (`pg_restore --list`) →
  stage side-by-side → `npm ci` in staged release → stop service → migrate
  **from the staged release** → atomic symlink flip → start → health check
  requiring the new version. Any failure in steps 6–9 auto-restores
  (drop-all-then-restore into an empty schema). `--rollback` flag flips back
  + restores latest dump. At least one previous release always kept on disk.
- **`reinstall.sh`:** fresh install semantics with explicit, loudly-confirmed
  handling of existing data (park the DB + keep `shared/`, or `--purge` with
  a typed confirmation phrase) — never silently destroys anything.
- All three share `scripts/lib.sh` (logging, spinner, error trap, summary
  box).
- **Feature kernel (§9 of the upgrade doc):** backend features
  (ingest providers, AI providers, modes) register via manifests into
  `feature_states` (`ON CONFLICT DO NOTHING`) so toggles survive upgrades and
  new features arrive through the normal upgrade pipe.
- **Ship procedure per release:** bump version (+schema if migrating), tests
  green, build zip artifact, **rehearse install→upgrade→rollback in an
  isolated prefix**, changelog entry, tag.

---

## 14. CLAUDE.md (to be written first, in Phase 0)

`CLAUDE.md` is the standing instruction file for every future build session.
It must contain, at minimum:

1. **Theme contract:** the palette, fonts, glass component recipes, and
   responsive rules of §12.1–12.2, with pointers into `theme.html` line
   ranges — "all new UI, including admin, follows this; no generic AI theme."
2. **Upgrade contract:** "read `howupgradeshouldwork-1.md` before touching
   migrations or scripts; migrations are immutable and forward-only; every
   release bumps version.json."
3. **Architecture invariants:** player UID rules (§3), max-2 API / max-1 AI
   gates enforced server-side, AI adjustment bounds, token ledger atomicity,
   no secrets to frontend, and **AI is never invoked automatically — only by
   explicit human action (§7.0); scheduled jobs are statistical only.**
4. **Engines contract:** "any work on ingestion, the statistical engine, or
   the match engine follows `fpl-engines-plan.md` — layer boundaries,
   snapshot isolation, leakage rules, and acceptance gates are
   non-negotiable; config values marked ⚙ live in `model_config`, never in
   code."
5. **Version policy:** latest stable majors, pinned (Node 26 / PostgreSQL 18
   / Fastify 5 / React 19 / Vite 7 at time of writing); runtime checks per
   §2.
6. **Definition of done:** typecheck + tests + Playwright responsive
   screenshots green; no page with horizontal overflow.

---

## 15. Development phases

| Phase | Scope | Exit criteria |
|---|---|---|
| **0. Foundations** (wk 1–2) | Repo scaffold, CLAUDE.md, version.json, migrations 0001–0002, auth + sessions + admin bootstrap, `scripts/lib.sh` + first `install.sh`, CI (typecheck/test/lint) | install.sh brings up a login-gated empty app on a clean VM |
| **1. Player DB + FPL anchor** (wk 2–4) | FPL official API ingest, player registry + UID + identity mapping, players table UI, cron polling | Full PL player list with live prices/status, zero duplicate players |
| **2. Ingest gateway + 2 providers** (wk 4–7) | API analysis docs (§4.4) for all 5+, gateway with max-2 switch + quota log + circuit breaker, adapters #1 API-Football & #4 news provider; admin API-switch UI | Injuries + news flowing in, mapped to UIDs; third-enable correctly refused |
| **3. Statistical engine** (wk 7–11) | Work packages E1–E8 of `fpl-engines-plan.md` Part 7: ingestion→UID pipeline, historical import + feature factory, Dixon-Coles + odds blend, minutes model, production models, xPts composer, backtest harness, stat_score/matrix | E-package exit criteria in the engines plan; backtest beats naive + FPL `ep_next` benchmarks; calibration plots acceptable; matrix visible in player detail |
| **4. Match engine** (wk 11–12) | Work packages E9–E10: fixture leverage, players-to-target, coverage/gaps, DGW/BGW, chip-window scoring (two-set 26/27 rules), integration DAG + fast paths | E9/E10 exit criteria; match_insights per GW rendering in UI; lineup-confirmed mini-run < 30 s |
| **5. AI layer + Run** (wk 12–16) | AI gateway max-1 + all 7 adapters, structured verdicts, token ledger + estimates + warnings, exclusion list, caching, Run Orchestrator + SSE run screen | Full run: news → AI → stats → re-rank with accurate token report; Ollama path works offline |
| **6. FPL engine + 3 modes** (wk 16–20) | Rules model, optimiser, transfer suggester, team valuation; Initial / FH-WC / Weekly pages | Optimiser produces valid squads under all constraints (property tests); all 3 modes usable end-to-end |
| **7. Your Teams + vision** (wk 20–22) | Unlimited teams, pitch view, image upload pipeline + confirmation screen, sync-from-image in all modes | Screenshot of a real FPL team parses to a confirmed 15-man squad |
| **8. Admin + polish** (wk 22–24) | Full admin panel (tokens, switches, weights, logs, charts) in the glass theme; responsive QA sweep; remaining provider adapters (#2/#3/#5) | Playwright responsive suite green on every page at 5 widths |
| **9. Release engineering** (wk 24–26) | Finish `upgrade.sh` + `reinstall.sh`, feature kernel, release zip builder, rehearsal runbook, security review, changelog | Rehearsed v1.0.0→v1.1.0 upgrade + rollback in isolated prefix passes |

Cross-cutting, every phase: migrations follow the immutability rules from day
one; every feature lands with tests; UI lands responsive, not "responsive
later".

---

## 16. Testing strategy

- **Unit:** FPL rules model (formations, budgets, ≤3/club, chip rules) as
  exhaustive property-based tests; statistical models against frozen fixture
  data; UID resolution edge cases (duplicate names, transfers between clubs).
- **Integration:** provider adapters against recorded HTTP fixtures (nock) —
  never live APIs in CI; gateway max-2 / AI max-1 guards under concurrent
  enable attempts; token ledger under concurrent debits.
- **Backtests:** §5.6 harness run per release; rank-correlation regression
  thresholds.
- **E2E (Playwright):** login gate, full run flow with a mock AI provider,
  image-upload confirmation flow, admin top-up flow, responsive/overflow
  assertions at 360/480/768/1024/1440.
- **Upgrade rehearsal:** scripted install(prev) → upgrade(new) → verify →
  rollback in an isolated prefix, required for every release containing a
  migration (per the ship procedure).

---

## 17. Risks & mitigations

| Risk | Mitigation |
|---|---|
| FPL API is unofficial (no SLA, can change shape) | Schema-validate every pull; alert + freeze on shape drift; last-good snapshot retained |
| Free-tier quotas too small at our polling cadence | Cost model in each API analysis doc (§4.4); caching; capability fallback to the second enabled provider |
| AI hallucinated verdicts corrupt rankings | Bounded ±20 adjustment; structured-output validation; rationale stored + surfaced; stats always recoverable without AI |
| Vision mis-parses team screenshots | Mandatory confirmation screen; entity-resolution pickers for ambiguity |
| Entity-resolution mistakes (wrong player merged) | Confidence thresholds; manual review queue; identity mappings reversible (append-only) |
| Token accounting drift vs. provider billing | Record provider-reported usage per call; admin cost charts reconcile monthly |
| Upgrade destroys data | Impossible by construction if §13 is followed: verified backups, forward-only migrations, rehearsals, auto-restore |
| Scope creep (odds modelling, mini-leagues, price predictions) | Out of scope for v1; parked in changelog "later" section |

---

## 18. Explicit out-of-scope for v1

- In-app payments (token purchase is an off-app conversation with the admin).
- Automated actions against the user's real FPL account (no writes to
  fantasy.premierleague.com).
- Leagues/social features, price-change prediction models, mobile native app.

---

*End of plan. Build order starts at Phase 0; `CLAUDE.md` is the first file
written.*
