# enginesupgrade.md — Statistical, Match & News engine major upgrade plan

**Status: PLAN (nothing here is implemented yet).** Written 2026-08-21 after a
full codebase audit, live probes of all six provider keys, a Playwright gap
audit against the running v1.4.0 install, and market research. Supersedes the
documents now archived in `Old Markdown/`. Every package below obeys
CLAUDE.md Rule #1 (forward-only migrations, ⚙ constants in `model_config`,
mutable state behind `DATA_DIR`, human-only AI invocation).

The one-word brief: the engines are **correct but inert**. They compute once
per run and go quiet. This plan makes them *responsive* (they react to the
world within minutes: lineups, price moves, breaking news, live matches) and
*lively* (the product surfaces motion: countdowns, tickers, live boards,
faces, probabilities — not just a ranked table).

---

## Part 0 — How this plan was built (evidence, all from 2026-08-21)

1. **Full code audit** of `backend/src` (stats L0–L9 + engine, match engine,
   news indexer/signals, adapters, orchestrator, scheduler, routes) and the
   frontend pages. Findings in Part 1.
2. **Live probes with the supplied keys** (results + exact failure text in
   Part 2). NewsData's daily credits were exhausted mid-probe — itself a
   finding; API-Football's account is still suspended from the 2026-08-20
   quota burn.
3. **Playwright gap audit** — `e2e/tests/07-engine-gap-audit.spec.ts` (new,
   committed with this plan; the only code this turn). It soft-probes the
   live app for 20 capabilities this plan proposes and logs PRESENT/GAP.
   Result on v1.4.0: **20 / 20 GAP** (list in Part 3 headers). The spec stays
   green today; as packages land, its lines flip to PRESENT and it becomes
   the upgrade's progress meter.
4. **Market research** on what the live-FPL tool market ships (LiveFPL,
   fplform, Premier Fantasy Tools, Fantasy Football Scout price predictor,
   FPL Review) and on model-side state of the art (Dixon-Coles bivariate
   extensions). Sources at the end.

---

## Part 1 — Audit findings

### 1.1 Statistical engine (L0–L9, `stats/engine.ts`)

| # | Finding | Evidence |
|---|---------|----------|
| S1 | **The entire L2 odds layer is dead code.** Shin de-margin, market-λ solve, freshness-decayed blend — all implemented, property-tested, and never fed: `odds_snapshots` has **0 rows**; no odds provider was ever wired. Every fixture prediction runs on Dixon-Coles alone (`wMkt = 0`). | `psql: odds_snapshots → 0` |
| S2 | **The confirmed-lineup fast path has no source.** `predictMinutes` has a `confirmedLineup` override (§6.5) and the orchestrator has a `mini_lineup` run kind — but `lineups` has **0 rows** and *nothing anywhere triggers a mini_lineup run*. The minutes model never learns an actual team sheet. | `psql: lineups → 0`; `grep mini_lineup` → only the type union |
| S3 | **`injuries` is empty.** API-Football injuries are plan-denied for the current season (free = 2022–2024); Sportmonks free covers Denmark/Scotland. Availability truth is FPL flags + news text only; the `availability_state` table (0 rows) was never given a writer. | Part 2 probes |
| S4 | **No price intelligence.** `price_events` has 0 rows. Bootstrap ingests `cost_change_event`, `transfers_in_event/out_event` every 6 h, then discards the trajectory. No rise/fall prediction, no selling-price awareness in the suggester. | `psql: price_events → 0` |
| S5 | **`team_style_stats` empty → `defconOppMult` is a dead input** (always 1). Opponent style never adjusts DEFCON probability. | `psql: team_style_stats → 0` |
| S6 | **No calibration loop.** `model_errors` exists in the schema and in `truncateAll` — no code reads or writes it. xPts have never been scored against actual FPL points; decay/shrinkage constants are hand-set, not backtested. | `grep model_errors backend/src` → nothing |
| S7 | **Ingested-but-unused FPL fields**: `ep_next`/`ep_this` (FPL's own expected points — a free sanity benchmark), `ict_index`/`influence`/`creativity`/`threat` (free style features), `form`, `event_points`. | fpl.ts schema vs stats usage |
| S8 | **Variance is a crude independent-term sum** (documented v1 shortfall); the captaincy simulator already draws real distributions per player but its machinery isn't reused for σ or for squad-level distributions. | l9-composer.ts comment |
| S9 | Home/away venue split exists only via the fixture multiplier; per-player venue splits (some strikers are home-heavy) are not modelled. | l0-features.ts |

### 1.2 Match engine (`match/engine.ts`)

| # | Finding | Evidence |
|---|---------|----------|
| M1 | **Win/draw/loss and scoreline probabilities are computed and thrown away.** L1's `predictFromLambdas` produces pHome/pDraw/pAway + full score grids per fixture; `match_insights` stores only FDR leverage numbers. The API exposes no probability anywhere (gap-audit: `pHome` absent from `/api/insights`). | audit spec line `api · win/scoreline probabilities → GAP` |
| M2 | Everything is **pre-deadline planning**; there is no in-gameweek mode at all. No live points, no live bonus (BPS), no auto-sub projection, no live captaincy delta. The FPL endpoints for all of this (`event/{id}/live`, `event-status`, `fixtures?event=` with `started/minutes/stats`) are free, keyless, and unused. | Part 2.1 probes |
| M3 | No head-to-head context, no referee context, no kickoff time / venue / broadcast surface on any insight (kickoff_utc is stored but not shown). | gap audit `match · *` all GAP |
| M4 | No predicted lineups. Target lists and captaincy assume the minutes model's priors right up to kickoff even when the team sheet is public an hour before. | S2 |
| M5 | Volatility flag = "a postponed fixture exists". No congestion (UCL/Europa midweek), no manager-change window, no weather. | engine.ts:56 |
| M6 | Chip valuations use a top-11-by-xpts proxy benchmark (fine) but never see DGW/BGW *probabilities* — only already-scheduled fixtures. Cup-clash projection absent. | engine.ts:265 |

### 1.3 News engine (`news/*`, newsdata adapter)

| # | Finding | Evidence |
|---|---------|----------|
| N1 | **Single provider, hard credit ceiling.** NewsData free = 200 credits/day, 10 articles each, `latest` = last 48 h only; the daily budget exhausted *during this audit's probes* (`ApiLimitExceeded`). Volume-dependent features (signals corroboration, coverage) starve on it. | Part 2.4 |
| N2 | **RSS is free, rich, and unused**: BBC football feed 87 items, Guardian 66, Sky 20 — live-probed HTTP 200, keyless. Club-official feeds exist for most PL clubs. | Part 2.6 |
| N3 | The v1.4.0 indexer links/classifies/clusters well, but signal categories stop at classification: no sentiment magnitude, no press-conference timing awareness (Fri/Sat pressers are when availability truth lands), no link from news text to *predicted lineups* ("expected to start", "set to miss out"). | signals.ts |
| N4 | News reaches the AI pass and the human-factor multipliers, but **no user-facing surface**: no dashboard feed, no player news timeline, no signal badges (gap audit: all GAP, despite `human_signals` sitting in the matrix since v1.4.0). | gap audit `players/dashboard` |
| N5 | Structured injury feeds and text news are never reconciled into one availability record with confidence + expected-return date (`availability_state` unwritten, see S3). | S3 |
| N6 | **Key persistence bug (cross-cutting, urgent)**: `API_FOOTBALL_KEY` and `NEWSDATA_KEY` were found EMPTY in `shared/.env` twice across two days, and `SPORTMONKS_TOKEN`/`FOOTBALL_DATA_TOKEN` were missing entirely — keys silently vanish, providers then fail AUTH and trip circuits. Suspect the `.env` writer's read-modify-write racing concurrent writes (six PUTs in a row survive, so the writer works in isolation), or the upgrade env-merge. Must be root-caused with a file-lock + audit-log fix. | probes this session |

### 1.4 Liveliness of the product surface (Playwright gap audit, all 20 = GAP)

Dashboard: no deadline countdown, no live GW board, no price ticker, no news
feed, no confirmed-XI indicator, no SSE refresh. Players: no photos, no
sparklines, no signal badges, no price predictions, no drill-down detail with
news timeline. Match surface: no win %, no scorelines, no h2h, no predicted
XI, no referee, no kickoff/venue. API: no probabilities, no `human_signals`,
no per-event xPts curve exposed.

---

## Part 2 — Live provider capability matrix (probed 2026-08-21 with the supplied keys)

### 2.1 FPL official API (keyless) — the liveliness goldmine, mostly unused
- `bootstrap-static` ✅ in use. **GW1 deadline was hours away at probe time**
  (`2026-08-21T17:30Z`) — 600 elements, `ep_next`, ICT, transfer counts all
  present and currently discarded (S7).
- `fixtures/?event=1` ✅ probed: 10 fixtures with `started`, `minutes`,
  `finished_provisional`, `stats` (goals/assists/bonus/BPS arrays per
  fixture) — the in-GW live source. **Unused.**
- `event/{id}/live/` ✅ probed (empty until kickoff — correct shape source
  for per-player live stats: minutes, goals, assists, bonus, BPS, total
  points per element). **Unused.**
- `event-status/` ✅ probed: bonus-added / league-update state per day.
  **Unused.**
- `element-summary/{id}` ✅ in use since v1.4.0 (career history_past).
- Etiquette: no auth, but production polling must stay ≤ 1 req/s with backoff
  and the existing snapshot-first layer.

### 2.2 football-data.org (key `959f…835d`, free tier) — best free current-season structured source
- `competitions/PL/matches?status=SCHEDULED` ✅ **355 scheduled matches**
  with `utcDate`, `matchday`, team ids; `referees[]` fills near kickoff;
  finished matches carry full-time/half-time scores.
- `competitions/PL/standings` ✅ live table (`form` populates once played).
- `competitions/PL/scorers` ✅ (goals + **penalties** split — free pen-taker
  validation).
- `matches/{id}/head2head` ✅ available on free tier (rate-limited 10/min).
- Odds: ❌ "Activate Odds-Package" — paid.
- Free tier = current season only (multi-season is paid).

### 2.3 API-Football / api-sports.io (key `03f8…d4c1`, free plan)
- **Account currently SUSPENDED** (in-200 `access` error; began after the
  2026-08-20 injuries backfill burned the daily quota; needs a visit to
  dashboard.api-football.com to reactivate).
- Free plan = **seasons 2022–2024 only** (verbatim: "Free plans do not have
  access to this season, try from 2022 to 2024") → **no current-season
  lineups, odds, events, injuries or predictions on the free key.** 100
  req/day when active.
- Consequence for this plan: API-Football's live features (confirmed lineups
  ~20–40 min pre-kickoff, live odds, live events, injuries) are designed in
  as a **paid-key adapter behind the existing entitlement-learning layer** —
  first-class when a key with coverage appears, invisible otherwise. The
  free key remains useful only for 2022–24 historical enrichment.

### 2.4 NewsData.io (key `pub_eb41…b1a1b`, free plan)
- `latest` ✅ works (v1.4.0 sweeps live-verified); free = last 48 h, 10
  results/request, ~200 credits/day — **exhausted mid-audit**
  (`ApiLimitExceeded`), proving the ceiling is binding in normal use.
- `domainurl` source filtering: behaves as paid-gated on free (errors).
  `archive` endpoint: paid only (6 mo / 2 y / 5 y by plan).
- Consequence: NewsData becomes the *keyword-search complement*; volume must
  come from RSS (2.6).

### 2.5 TheSportsDB (key `123`, free) & Sportmonks (token `O6VH…hkc`)
- TSDB `eventsround.php?id=4328&r=1&s=2026-2027` ✅ **all 10 GW fixtures**
  with date/time/venue/status + event thumbnails; `eventsnextleague` ✅;
  `searchplayers` ✅ returns **player cutout images** (`strCutout`) — free
  faces for the UI. No TV listings on free; v2 livescores are premium.
  League search caps at 10 rows (v1.4.0 already backfills per-team).
- Sportmonks free = Danish Superliga + Scottish Premiership (+playoffs)
  confirmed via `/v3/football/leagues`. **No EPL on free** — adapter stays
  dormant behind entitlements; nothing in this plan depends on it.

### 2.6 RSS (keyless, unlimited within politeness)
- BBC football `feeds.bbci.co.uk/sport/football/rss.xml` → HTTP 200, **87
  items**; Guardian `theguardian.com/football/rss` → 200, 66 items; Sky
  `skysports.com/rss/12040` → 200, 20 items. Club-official and aggregator
  feeds add per-club streams. This is the news volume the signal layer needs.

### 2.7 DeepSeek (key `sk-60a1…5067`)
- Live-verified in v1.2.0 (real analysis passes, batching, usage
  normalisation). Not re-spent during this docs-only audit; no AI-engine
  changes are in scope here beyond feeding it better bundles.

---

## Part 3 — Upgrade packages

Legend: every ⚙ constant lands in `model_config` (seeded on upgrade; nested
additions to existing keys use the jsonb-merge migration pattern proven in
0010). Scheduled paths stay statistical — nothing below invokes AI.

### ENGINE A — Statistical engine

**A1 · Market blend resurrection (fills S1).**
Wire an odds source into `odds_snapshots` so the L2 blend finally runs:
(a) primary: API-Football `/odds` adapter behind entitlements (paid key);
(b) free fallback: FPL's own `ep_next` as a *pseudo-market* prior — solve a
per-position mapping xPts↔ep_next each run and blend with ⚙ small weight
(`l2.w_ep_next ≈ 0.15`), so the engine is never blind to the market view.
Acceptance: with a synthetic odds row inserted, fixture λs shift per the
blend test; with none, behaviour is unchanged.

**A2 · Price-change intelligence (fills S4).**
Track `transfers_in_event − transfers_out_event` deltas per bootstrap poll
into `price_events` (new writer, table exists); model the community-standard
ownership-scaled threshold: `P(rise tonight) = σ((netTransfers −
θ(ownership)) / s)` with ⚙ `price_model.thresholds` refit weekly from
observed changes (`cost_change_event` gives ground truth daily — a free,
self-calibrating loop). Surfaces: risers/fallers ticker, predicted-change
column, and the transfer suggester gains sell-price urgency ("act before
02:30 UTC").
Acceptance: ≥85% precision on next-night rises after 2 weeks of data (the
market leaders claim ~100%; 85% is the gate on our smaller signal).

**A3 · Availability reconciliation (fills S3, writes `availability_state`).**
One writer merges: FPL `status/chance/news` (anchor) + news-engine
`disciplinary/personal_event` signals + press-conference-window recency (see
C2) + structured injury feeds when entitled. Output per player:
`{state, p_available_next, expected_return_event, confidence, sources[]}` —
consumed by L3 (replacing the raw chance-flag math), shown as the injury
detail everywhere.
Acceptance: every `status != 'a'` player carries a populated
availability_state row with ≥1 source; L3 doubt handling reads from it.

**A4 · Backtest & calibration harness (fills S6 — the correctness engine).**
CLI + admin surface: walk-forward replay over the imported seasons (3
per-GW seasons already in the DB, 10 available): for each historical GW,
run L0–L9 as-of that GW's deadline, score vs actual FPL points into
`model_errors` (per player-GW: xPts, actual, position, price band), and
report MAE / RPS / rank-correlation + calibration curves (predicted-vs-
actual deciles). Then: grid-search ⚙ constants (decay ξ, shrinkage k/k_att,
price-prior elasticity, minutes table) against the backtest and write the
winning values as NEW `model_config` versions (versioned, reversible, never
hard-coded).
Acceptance: a `backtest` admin tab shows per-season MAE and calibration
plots; at least one refit demonstrably beats the hand-set constants
out-of-sample; every future engine change must not regress the backtest.

**A5 · Opponent-style DEFCON multiplier (fills S5).**
Populate `team_style_stats` per team from the per-GW history already in the
DB (shots conceded proxies via opponents' CBIT/CBIRT rates, crossing volume
via corner share from set-piece data) and feed the existing
`defconOppMult ∈ [0.8, 1.25]` input for real.
Acceptance: multiplier ≠ 1 for ≥ 15 teams; DEFCON hit-rate calibration in A4
improves.

**A6 · Venue-split rates + style features (fills S7/S9).**
L0 adds home/away split attacking rates (shrunk, min-minutes-gated ⚙) and
ingests ICT/threat as z-features in `stat_score` (⚙ w8, default small).
`ep_next` joins the matrix as a display benchmark column ("FPL's own view")
— cheap trust-building.

**A7 · Distribution-true variance (fills S8).**
Reuse the captaincy Monte Carlo (already seeded + deterministic) to produce
per-player point distributions for the next event (P10/P50/P90 stored on the
matrix) replacing the independent-term σ; squad-level distribution for the
Modes pages ("this XI: 48–71 pts, 80% band").

### ENGINE B — Match engine

**B1 · Match previews: publish the probabilities we already compute (fills M1).**
Persist per fixture: pHome/pDraw/pAway, top-5 scorelines with probabilities,
pCS both sides, E[goals] — into `match_insights.reasons` (no schema change)
plus a `GET /api/fixtures/:uid/preview`; render as a matchup-feature card
(theme.html 148–159) with a scoreline mini-heatmap.
Acceptance: gap-audit lines `match · win/draw/loss`, `match · scorelines`,
`api · probabilities` flip to PRESENT.

**B2 · Predicted + confirmed lineups (fills M2/M4, S2).**
Two stages: (a) *predicted XI* per team from our own minutes model (top-11
by p_start within formation constraints ⚙) published with each run —
zero new data needed; (b) *confirmed XI* ingestion: API-Football lineups
adapter behind entitlements (paid), plus a news-text fallback (N3 lineup
hints). Confirmed rows land in `lineups`, and the **scheduler finally
triggers the `mini_lineup` fast-path run** in the 90→20 min pre-kickoff
window (cadence in C2) so captaincy/targets re-rank on team sheets.
Acceptance: predicted XI visible per fixture; when a lineups row exists, a
mini_lineup run fires within 5 min and `p_start` snaps to 0.99/0.02.

**B3 · Live gameweek engine (fills M2 — the flagship).**
New statistical module `match/live.ts` polling (C2 cadence, snapshot-first)
`event/{gw}/live` + `fixtures?event=` + `event-status` during matches:
- live per-player points/minutes/BPS into a new `live_event_stats` table
  (run-independent, latest-state upsert; migration 0011);
- **live bonus projection** from the BPS ranking per fixture (the standard
  3/2/1 allocation with tie rules);
- **auto-sub & captaincy projection** per saved user team (who blanks, who
  comes off the bench, live team total);
- deadline countdown + "matches in play" state on the dashboard via the
  existing SSE bus (`runEvents`) — a new `live` event channel.
Everything here is arithmetic over official data — no AI, no simulation
needed. Acceptance: during a live match the dashboard board updates ≤ 60 s
behind the API; bonus projection matches FPL's awarded bonus ≥ 90% of
fixtures at final whistle.

**B4 · Fixture context enrichment (fills M3/M5).**
football-data: standings position + form string into fixture previews; h2h
(last 5 meetings) on the preview card; referee name when present.
TheSportsDB: venue + event thumbnail (probed OK, key 123). Congestion
upgrade: flag teams with midweek continental fixtures (fixture-density
already computed; extend window to all competitions via TSDB team events).
DGW/BGW probability from postponements + cup-round calendar (⚙ heuristic).

**B5 · Insight explainability.**
Every target/captaincy row gains a one-line "because" built from its stored
reasons (leverage kind, xPts, ceiling, signals) — rendered in the UI, fed to
the AI pass as context (bundles already carry matrix lines).

### ENGINE C — News engine

**C1 · RSS ingestion engine (fills N1/N2 — the volume unlock).**
New keyless adapter `ingest/adapters/rss.ts`: ⚙ feed registry seeded with
BBC/Sky/Guardian + per-club official feeds (data, editable in admin),
15-min poll (C2), conditional GET (ETag/Last-Modified) for politeness,
title+description into the same `news_items` store → the v1.4.0 indexer
(linking, signals, stories) works unchanged on top. NewsData drops to
keyword-search duty within its 200/day budget (targeted player queries for
top-owned players missing coverage).
Acceptance: ≥300 new articles/day sustained at zero credits; covered-player
count (data-coverage tab) ≥150 within a week of GW football.

**C2 · Matchday-aware scheduler (cross-engine nervous system).**
Replace the flat crons with a cadence table (⚙ `scheduler`):
- quiet day: bootstrap 6 h, RSS 15 min, fixtures daily (as now);
- deadline−24 h: bootstrap 30 min (exists), RSS 10 min, press-conf window
  weighting on (N3);
- kickoff−90→−20 min: lineup checks every 5 min (B2), RSS 5 min;
- matches in play: `event/live` + fixture polls every 1–2 min (B3);
- 02:15–03:00 UTC: price-change watch (A2), then the nightly micro-run.
All statistical; all snapshot-first; per-provider budgets enforced.

**C3 · Availability + lineup hints from text (fills N3/N5).**
Extend the signal classifier with availability-grade patterns:
`ruled_out(weeks?)`, `doubt`, `back_in_training`, `expected_to_start`,
`set_to_miss`, `late_fitness_test` + an expected-return-date extractor
("out for six weeks" → event math). These flow into A3's reconciliation and
B2's predicted XI (a tier-1 "expected to start" nudges p_start ⚙ +0.05,
corroboration-gated, clamped as in v1.4.0).

**C4 · Sentiment magnitude (bounded, statistical).**
Lexicon-based polarity score per article (AFINN-style ⚙ word lists in
model_config, no AI) → story-level sentiment; feeds a *small* ⚙ term in the
human-factor multiplier (inside the existing [0.90, 1.03] clamp) and colours
the news UI. Never overrides structured availability.

**C5 · News product surface (fills N4 + half the gap audit).**
Dashboard news feed (story-deduped, signal-badged, tier-marked); player
detail drawer: news timeline + human_signals evidence + per-event xPts
sparkline (data already in the matrix); signal badges in the players table.
Player photos: TSDB cutouts (probed) cached to `DATA_DIR/media/players/`
(never inside the release dir — Rule 1c) with a nightly refresh job.

### Cross-cutting

**X1 · Key-persistence bug (N6) — first, before everything.** Root-cause the
`shared/.env` wipes: add an exclusive-lock writer (single writer path via
`setProviderSecret`), an append-only `key_audit` log (name, actor, old→new
last-4, timestamp), a boot-time guard that logs WHICH keys are empty-vs-set,
and an upgrade-rehearsal assertion that env keys survive the flip. Nothing
else in this plan is reliable while keys evaporate.

**X2 · SSE data-freshness channel.** The run-progress SSE bus gains
`data:{kind}` events (bootstrap synced, news indexed, lineups in, live tick,
price watch) so every page can show "as of 12s ago" and update without
reload (gap: dashboard SSE).

**X3 · Playwright gap audit as the progress meter.** Each package's
acceptance includes flipping its `07-engine-gap-audit` lines to PRESENT;
the spec is extended per package (assertions strengthen from soft to hard as
features ship). Full E2E + responsive discipline (360→4K) applies to every
new surface.

---

## Part 4 — Considered and rejected (for the record)

- **Sportmonks for EPL** — free plan is Denmark+Scotland only (probed);
  adapter stays dormant behind entitlements. Revisit only with a paid token.
- **API-Football current-season features on the free key** — hard plan wall
  (2022–2024 only) *and* the account is currently suspended; everything
  live-scoped from it is paid-gated by design. The user should reactivate
  the account at dashboard.api-football.com regardless, for the historical
  window.
- **NewsData archive backfill** — paid tiers only (6 mo/2 y/5 y); RSS +
  rolling window suffice for the signal layer.
- **Social media ingestion (X/Twitter ITK)** — no viable free API; rumours
  arrive via RSS aggregators anyway with source tiers to down-weight them.
- **Full ML match model (gradient boosting)** — research shows bivariate
  Poisson/DC remains competitive; the honest upgrade is calibration (A4) and
  market anchoring (A1), not a black-box swap. Revisit after A4 exists.

## Part 5 — Acceptance gates (release-blocking)

1. All 110+ backend tests and the full Playwright suite green; gap-audit
   lines for each shipped package flipped to PRESENT and hardened.
2. A4 backtest harness live, with a stored baseline; no engine change ships
   that regresses next-GW xPts MAE or rank correlation on the baseline.
3. B3 live board tracks a real match ≤ 60 s lag; bonus projection ≥ 90%
   final-whistle accuracy over a sampled GW.
4. A2 price predictor ≥ 85% precision on predicted rises after 14 days.
5. C1 delivers ≥ 300 articles/day at 0 news credits; covered players ≥ 150.
6. Availability: 100% of flagged players carry availability_state rows.
7. Rule #1 intact end-to-end: forward-only migrations (0011+ live tables,
   jsonb-merge for nested ⚙ additions), schema bump per migration, rehearsed
   upgrade + rollback per release, keys never in the repo (grep gate), site +
   credentials untouched by upgrades.

## Part 6 — Execution order (three releases)

- **v1.5.0 — "the nervous system":** X1 keys fix → C2 scheduler → C1 RSS →
  B1 previews (data already exists) → C5 news surface + photos → A6 quick
  features (ep_next column, ICT term). Migration 0011 (live tables +
  key_audit + feed registry seed). Mostly additive; ships fast.
- **v1.6.0 — "the live gameweek":** B3 live engine + X2 SSE → B2 predicted
  XI (+ lineups adapter behind entitlements) → A3/C3 availability
  reconciliation → A2 price intelligence.
- **v1.7.0 — "the calibrated engine":** A4 backtest harness → constant refit
  → A5 style multiplier → A7 distribution variance → B4 context enrichment →
  A1 odds blend (activates fully when a paid odds key arrives).

Each release: version bump, migration+schema bump when tables change, tests
+ Playwright + gap-audit, `build-release.sh`, rehearse (install / upgrade /
rollback), changelog, tag, push — per CLAUDE.md Rule 1e, no exceptions.

---

## Sources

- Live-tool market: [LiveFPL](https://www.livefpl.com/) ·
  [fplform live rank](https://fplform.com/fpl-live-rank) ·
  [Premier Fantasy Tools](https://www.premierfantasytools.com/live-fpl-rank/) ·
  [FPL Review](https://fplreview.com/)
- Price algorithm: [LiveFPL price changes](https://livefpl.com/blog/fpl-price-changes) ·
  [FPL Core threshold series](https://fplcore.wordpress.com/2026/02/23/one-threshold-to-rule-them-all-cracking-the-fpl-price-algorithm-part-3-of-7/) ·
  [Fantasy Football Scout price predictions](https://www.fantasyfootballscout.co.uk/fpl/price-predictions/) ·
  [tipmaster explainer](https://www.tipmaster.de/en-gb/guide/fpl-price-changes-explained-how-the-algorithm-actually-works/) ·
  [onefpl timing](https://onefpl.com/fpl-price-changes)
- Modelling: [Bivariate Dixon-Coles overview](https://www.emergentmind.com/topics/bivariate-dixon-and-coles-model) ·
  [DC time-weighting walkthrough](https://dashee87.github.io/football/python/predicting-football-results-with-statistical-modelling-dixon-coles-and-time-weighting/) ·
  [ML vs Poisson comparison](https://thexgfootballclub.substack.com/p/which-machine-learning-models-perform)
- News sources: [Feedspot PL RSS index](https://rss.feedspot.com/premier_league_rss_feeds/) ·
  [premierleague.com injuries](https://www.premierleague.com/en/latest-player-injuries) ·
  BBC/Sky/Guardian RSS (live-probed 2026-08-21)
- Provider docs: [football-data.org API](https://www.football-data.org/documentation/api) ·
  [API-Football](https://www.api-football.com/) ·
  [NewsData archive endpoint](https://newsdata.io/blog/all-about-news-archive-endpoint/)

*End of plan. Implementation starts only on explicit go-ahead, sliced as Part 6.*
