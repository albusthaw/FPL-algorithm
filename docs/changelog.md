# Changelog

## v1.4.4 — 2026-08-21 · schema 13

Migration 0013 (`live_event_stats`, `price_predictions`). engineupgradeplus.md
release 4 — "the live gameweek": in-play scoring, team sheets, one merged
availability truth, and price intelligence.

- **B3 — live gameweek engine** (fixes M2): FPL's free `event/{gw}/live` +
  `fixtures?event=` endpoints finally used. A 2-minute in-play poll persists
  per-player live stats with our OWN bonus projection from the BPS boards
  (3/2/1 with FPL's exact tie sharing — property-tested), keeps fixture
  states/scores current, and pushes the X2 SSE data channel
  (`/api/live/stream`) so open dashboards refresh within a poll of reality.
  `GET /api/live` serves the scoreboard, the top-points board, the price
  ticker, and — with `?teamId=` — YOUR live total with auto-sub preview
  (bench order, formation minimums, GK-for-GK) and effective-captain
  doubling (vice steps in when the captain blanks). Dashboard gained the
  gameweek clock: deadline countdown, LIVE scores, projected bonus, ticker.
- **B2 — predicted + confirmed XIs** (fixes S2): every run now writes a
  predicted XI per next-event fixture from our own minutes model
  (formation-valid, `lineups` kind=predicted); the fixture preview endpoint
  returns predicted AND confirmed sheets. API-Football fixture ids are
  mapped daily (kickoff+team-pair matching, entitlement-learned), the
  KO-window job pulls confirmed sheets T−90→KO for mapped fixtures, and a
  landed sheet triggers ONE `mini_lineup` fast-path run — the orchestrator
  now honors the kind: no news pull, no indexing, no re-sync, straight to
  stats → match → publish (AI structurally unreachable, as ever).
- **A3/C3 — availability reconciliation** (fixes S3: the table shipped in
  0004 with no writer): one pass merges FPL flags + chance_next, active
  structured injuries, and tier-1/2 news-text hints into
  `availability_state` per (player, next fixture) — p_available, a state
  label, evidence, and a CONFLICT flag when FPL says fine but the press
  says out. C3's return-date extraction parses "out for six weeks" /
  "ruled out for 2-3 weeks" / FPL's "Expected back 15 Nov" into dates and
  compares them to the kickoff. L3 minutes now consume the reconciled cap.
  Runs after every bootstrap sync window and inside every full run.
- **A2 — price intelligence** (fixes S9's noisy momentum too): an
  ownership-scaled threshold model (⚙ `price_model`,
  θ = θ_base · (own%/10)^power) predicts tonight's risers/fallers at 22:30
  UTC into `price_predictions`; each morning the calls are scored against
  actual `price_events` and θ_base is refit as a NEW config version
  (over-calling raises the bar, missing real moves lowers it — data, not
  code). `GET /api/prices/predictions` serves the board with yesterday's
  scorecard; Weekly's price-risk panel gained fall-urgency
  (tonight/soon/watch); the L12 momentum z-term now normalises net
  transfers by the same ownership-aware threshold.
- Tests: 13 new (bonus tie-sharing matrix, auto-sub rules incl. formation
  minimums, live poller against a fake FPL, return-date extraction,
  reconciliation conflicts, threshold scaling + calibration raising θ).
  161 backend tests green.

## v1.4.3 — 2026-08-21 · schema 12 (no migration)

engineupgradeplus.md release 3 — "the nervous system": the keyless RSS
anchor, matchday-aware scheduling, indexer correctness, published match
previews, the user-facing news surface, and the A6 quick features.

- **C1 — RSS ingestion engine** (fixes N1): a keyless always-on news anchor
  (`rss` provider row, outside the max-2 switch) pulling ⚙ `rss_feeds`
  (BBC / Sky / Guardian by default) with conditional GETs (ETag /
  Last-Modified persisted per feed) and a dependency-free RSS 2.0 parser
  (CDATA, entities, tag stripping). Items flow into the SAME news_items
  store, near-dup pool and indexer as NewsData — at zero credits.
  Live-verified: BBC 81 items parsed, Sky 20; a CDN-blocked feed (Guardian
  403s Node's HTTP client) fails alone and never blocks the others.
- **C2 — matchday-aware scheduler**: one 15-minute tick classifies the
  matchday phase (in-play / KO-window 90 min / deadline-24h / quiet) and
  pulls RSS + NewsData on ⚙ `news_scheduler` cadences, indexing after each
  pull; a 02:15 UTC price-watch bootstrap sync lands FPL price changes
  before the 03:30 micro-run re-ranks. All statistical — the AI layer stays
  structurally unreachable from the scheduler.
- **C6 — indexer correctness**: possessives are stripped before
  normalisation ("Haaland's brace" now links — N2); signal classification
  gained a negation guard with clause-boundary scope ("will NOT be banned"
  no longer classifies, "not banned, but refused to train" still does —
  N4); story clustering corroborates by shared player + shared signal
  category, so the same story under an editorially different headline
  clusters ("Haaland suspended" ↔ "City dealt major blow" — N3); the AI
  bundle window reads ⚙ `human_factors.news_signals.window_days` instead of
  a hard-coded 7 (N5).
- **B1 — match previews published** (fixes M1/M8): every insight row now
  carries win/draw/loss probabilities and top scorelines (Poisson over the
  blended lambdas); new `GET /api/fixtures/:uid/preview` adds clean-sheet
  odds and h2h context from our own imported fixture history; the dashboard
  match-engine card shows percentages and the most likely score.
- **C5 — news product surface** (closes N6's product gap): dashboard
  Newsroom feed (story-deduped, corroboration counts, signal badges, player
  chips) via `GET /api/news/feed`; per-player news timeline on the player
  page via `GET /api/players/:uid/news`; player photos cached under
  `DATA_DIR/media/` (official FPL photo by fpl_code, TheSportsDB cutout
  fallback) and served same-origin at `/api/media/players/…` because the
  CSP blocks external image hosts by design (X2). Daily scheduler pass
  keeps the cache warm.
- **A6 — quick engine features** (fixes S5): per-player venue splits in L0
  (xGI/90 at venue ÷ overall, shrunk toward neutral, bounded ±15%) scale
  the fixture attack multiplier; FPL's ICT index joins the stat score as ⚙
  `stat_score_weights.w8` (default 0.05) z-term; `ep_next` (FPL's own xPts
  benchmark) and ICT appear as sortable display columns on the rankings.
- Tests: 13 new (RSS parser on real-shape XML, negation matrix, possessive
  linking + cross-headline clustering against the DB, matchday phases,
  venue-split shrinkage). 148 backend tests green.

## v1.4.2 — 2026-08-21 · schema 12

Migration 0012 (`user_teams.kind` + `source_run_id`). engineupgradeplus.md
release 2 — "the product asks": squad-style everywhere with savable builds,
the Run data-depth selector on a real subscription model, and the captaincy
display fix.

- **P2 — Weekly squad style**: `/api/modes/weekly` now returns the engine's
  picked best XI for the selected team (same `pickStartingXi`, same
  `PitchView` payload as Initial/Chips — formation, C/V armbands, bench
  order), plus a post-transfer variant: every suggestion row gained a
  "preview XI" button that re-picks the XI with the move applied.
- **P2 — Savable builds**: every generated squad — Initial XI, Free Hit
  build, Wildcard build, Weekly XI (pre- or post-transfer) — has "Save as
  team". `user_teams` grew `kind`
  (`manual|imported|initial_xi|freehit|wildcard|weekly`, default manual) and
  `source_run_id`, so a build remembers which run priced it. Teams page
  shows kind + run badges; screenshot confirms land as `imported`; clones
  inherit their source's kind.
- **P1 — provider subscription model** (⚙ `provider_plans`): a researched
  tier catalog per provider (free/pro/standard/basic…, each with depth,
  rate and cost) with an admin plan selector on every Data-provider card.
  Selecting a plan snapshots the tier into model_config, finally fills
  `api_providers.quota_limit` from the plan's rate (audit X5), and re-arms
  entitlement probes — learned denials are cleared so each gated scope gets
  ONE fresh try under the new plan.
- **P1 — Run data-depth selector**: the Run screen's Data-window table
  gained a per-source "Pull depth" dropdown (days / months / seasons /
  career; admin-gated). Options = the selected plan's reach ∩ the
  entitlement table's learned denials, and refused options stay visible with
  the reason — "why can't I select 5 years on NewsData free" is answered in
  the dropdown itself. Selections write ⚙ `history_depth.per_provider`; the
  next launch run backfills exactly what was selected through the resumable
  `history_pulls` ledger and reports what was pulled and what the plan
  refused.
- **P1 — new backfill executors**: football-data past seasons
  (`?season=YYYY`, paid scope, PLAN_DENIED learned), API-Football 2022–2024
  fixtures + season injury logs (historical injuries land `is_active=false`
  as pattern data), NewsData archive sweep (paid tiers), Understat
  per-season xG aggregates (merged into `player_season_history.stats` beside
  the FPL career numbers). All ledgered, resumable, entitlement-guarded.
- **B5 — captaincy display = ceiling** (audit M3): the pool was ordered by
  simulated P90 ceiling but displayed the doubled mean, so rank 1 could show
  a lower number than rank 2. The stored score is now the ceiling; the
  Weekly panel labels it and shows the mean alongside.
- Tests: 10 new integration tests (kind roundtrip, plan catalog + quota
  fill, depth folding, plan ∩ entitlement gating, plan-refusal report lines
  with zero API calls). 135 backend tests green.

## v1.4.1 — 2026-08-21 · schema 11

Migration 0011 (`key_audit`). engineupgradeplus.md release 1 — "stop the
bleeding": the two live bugs (key wipe X1, OpenAI vision 400 X4) plus the
mechanisms that end their bug classes (P4 capability registry, P3 OCR-first
image parsing, X3 vision budget guard).

- **X1 — API keys can no longer be silently wiped**: `upsertEnvVar` now
  takes an exclusive lock file around its read-modify-write of
  `shared/.env` (O_EXCL, stale-lock takeover, atomic tmp+rename, mode 600),
  resolves the env file once through `realpath` (ENV_FILE wins), and every
  admin key change writes a `key_audit` row (env var, actor, old/new last-4
  hint, set/clear — never the value). The server logs a provider
  key-presence report at boot, and `rehearse-upgrade.sh` now plants a
  synthetic key before upgrading and fails the rehearsal if the env-merge
  loses it.
- **P4 — AI model-capability registry** (⚙ `ai_model_capabilities`): ordered
  pattern rules resolve per-(provider, model) capabilities — token
  parameter (`max_tokens` vs `max_completion_tokens`), temperature
  free/locked, per-MODEL vision, JSON mode, max-output floor. All five
  adapters (openai-compatible, anthropic, gemini, ollama, mock) build
  request bodies from the registry, never hard-coded params. This fixes the
  reported bug: image upload with OpenAI gpt-5-era models 400'd with
  "Unsupported parameter: 'max_tokens'… use 'max_completion_tokens'".
- **Learned capability overrides**: a live 400 that names the fix is parsed
  (`learnFromParamError`), the request is retried once with the corrected
  parameter, and the lesson is persisted to `ai_providers.config.capabilities`
  — the AI-side mirror of ingest entitlement learning. Selecting a model in
  the admin panel fires a 16-token capability probe; the admin AI card shows
  the resolved capabilities (vision / token param / temperature) per
  provider, plus a vision-model override (unlocks e.g. DeepSeek's separate
  vision model).
- **Anthropic/Gemini correctness**: repair-retry messages are user-role-only
  (assistant-first messages 400 on current Anthropic models); temperature is
  omitted for the 4.6+/5-family; Gemini 2.5-era gets max-output headroom for
  thinking tokens; default Anthropic models bumped to current IDs.
- **X3 — vision budget guard**: non-admin image parses are refused (402)
  before the AI call when the token balance is under
  ⚙ `ai.vision_estimate_credits`; a `finish_reason: length` truncation now
  returns 422 "truncated" instead of a JSON-parse error.
- **P3 — OCR-first image parsing** (⚙ `vision_pipeline`): team screenshots
  are OCR'd locally first (tesseract.js WASM + sharp preprocessing: 2×
  upscale, grayscale, normalise, sharpen, auto-negate on dark themes; the
  eng.traineddata model ships inside the release payload, cache under
  DATA_DIR). When ≥ `min_names` name-like lines are found, the noisy text
  goes to the TEXT model to reformat into the 15-player contract — no vision
  tokens spent. Vision remains the fallback ladder (images downscaled to
  ≤1568px JPEG before upload). The Teams page shows which path parsed the
  image.
- Tests: 15 new unit tests (registry resolution, learned-retry against a
  fake 400, adapter body shapes per provider, env-lock 20-writer race, real
  OCR extraction from a synthetic FPL-style screenshot). 125 backend tests
  green.

## v1.4.0 — 2026-08-21 · schema 10

Migration 0010 (news engine + history ledger). The data-provider system
revisit: a news storage engine + indexer that actually reaches the AI pass,
historical depth up to ~20 years where sources allow, and news-driven
human factors in the statistical engine.

- **Why**: 129 successful news pulls had produced 174 stored articles, 64
  player links and 38 covered players — AI batches of 2–17 players while
  hundreds exist. Root causes: near-duplicate stories were DROPPED at pull
  time; entity linking ran once at insert and never again; and the alias
  matcher normalised text with the resolver's token-SORTING canonicaliser,
  so a multi-word name only ever matched when it happened to be
  alphabetical ("Luca Marchetti" linked, "Nico Duarte" never could).
- **News storage engine**: exact URL repeats now bump seen_count/last_seen
  (corroboration, not garbage); near-duplicate titles insert and cluster
  into stories (story_id); signal categories stored per item; full-text
  GIN index. Overlapping coverage corroborates a story — it never repeats
  in the AI prompt (one representative per story per player) and never
  double-counts in signals.
- **News indexer** (new run stage, statistical): one systematic pass —
  order-preserving entity linking (normaliseText), keyword signal
  classification, story clustering — with a rolling 7-day re-scan so
  alias improvements retroactively link older articles. Live: links 64→105,
  covered players 38→52 on the first two passes.
- **Pull throughput**: nextPage pagination, alternating query packs
  (availability terms / broad club news for human-factor stories), explicit
  per-sweep credit budgets (⚙ news_pull). Live: one sweep fetched 150
  articles (15 requests × 10) vs ~10 per pull before.
- **Human factors v2** (⚙ human_factors.news_signals): keyword-classified
  categories — disciplinary, unprofessional conduct, transfer talk,
  contract disputes, personal events, morale boosts, managerial change —
  applied as bounded xPts multipliers (clamped [0.90, 1.03]) with
  corroboration gating (negative categories need a tier-1/2 source or 2+
  independent items). Evidence stored per player per run
  (player_matrix.human_signals). No AI involved — scheduled runs stay
  statistical by construction.
- **Historical depth** (⚙ history_depth, default: last 7 days): per-source
  reach researched and displayed on the Run screen ("Data window") and in
  Admin → Data coverage, with a depth selector, career-aggregates toggle,
  Backfill-now button and a resumable history_pulls ledger. Live-verified:
  vaastav per-GW seasons (2016-17 →, 3 seasons imported = 40,055 match
  rows) and the FPL element-summary career sweep — 600 players, 2,040
  season rows, 0 failures, reaching back to **2006/07** (~20 years).
  NewsData archive (paid: 6 mo/2 y/5 y), football-data (free: current
  season), API-Football (free: 3 seasons) documented in the coverage table.
- Fixed: NEWSDATA_KEY had been emptied in shared/.env — restored via the
  admin key route; the AUTH circuit resets on the next successful pull.

## v1.3.0 — 2026-08-21 · schema 9

Migration 0009 (`team_identities`). The statistical-engine expansion
(statengineexpansion.md, executed in full): market-grade premium spread,
human factors, a data-coverage audit, and provider hardening.

- **Why**: the initial-XI suggestion led the line with a £6.0 rotation
  striker while Haaland projected only 15% above him over 6 GWs. Root
  causes verified against live data and market references (fplreview.com,
  fplcopilot.com, fantasyfootballfix.com): minutes EWMA poisoned by
  cameos, penalties stored but never scored, flat bonus, one-prior-fits-
  every-price shrinkage, horizon regression treating all starters alike.
- **X1 minutes realism** (⚙ `minutes_realism`): E[min|start] now blends the
  player's OWN started-matches average (new L0 feature) with the position
  table; every-week starters (start share ≥0.95) hold p_start 0.95.
- **X2 set-piece EV** (⚙ `set_piece_ev`): explicit penalty expected value
  for designated takers with the taker's penalty xG removed from the base
  rate (non-penalty xG when imported, calibrated deduction otherwise);
  corner/direct-FK first takers get a dead-ball xA stream.
- **X3 bonus rides returns** (⚙ `bonus_model`): E[bonus] scales with
  expected goal involvement per position instead of flat profile means.
- **X4 gentler decay + slower attacking stabilisation**
  (⚙ `feature_decay`, `feature_factory.shrinkage_k_attacking`).
- **X5 human factors** (⚙ `human_factors`): ownership-momentum term in
  stat_score (bounded w7); suspension-tightrope haircut for players one
  yellow from a ban.
- **X7 price-continuous attacking prior** (⚙ `price_prior`): attacking
  rates shrink toward a price-scaled target — a £6.0 and a £15.5 forward
  no longer share a prior.
- **X8 horizon start target** (⚙ `minutes_realism.horizon_target_mult`):
  the 6-GW start-probability target is the player's own long-run start
  share, not the positional base — premiums stop bleeding phantom minutes.
- **Optimiser**: ILP variables declared as true binaries (the `ints`
  declaration let the solver take cheap players twice and silently fall
  back to greedy); captain doubling added to the objective; 1% MIP gap +
  5s time limit. Initial squads now carry a premium spearhead.
- **Data-coverage audit** (X6): `GET /api/admin/data-coverage` + admin
  "Data coverage" tab — per-player history/news/identity/set-piece/matrix
  presence with a gaps filter. Verified: 600/600 active players in the
  latest run.
- **team_identities table** (migration 0009): provider team-id mappings
  moved out of player_identities (whose FK rejected them, silently
  emptying the API-Football team map and flooding the resolution queue).
  API-Football adapter seeds it lazily; club-name alias map added;
  in-200 `access` errors (account suspended) classify as AUTH.
- **TheSportsDB**: free keys cap the league search at 10 rows — the
  adapter backfills remaining clubs per-team; live-verified 20/20 badges.
- Gates: Haaland 6.80 next-1 / 37.07 next-6 (market 6.6–6.8 / 37.9);
  FWD top-1 vs top-10 spread 17.0; £6.0 rotation striker at 54% of
  Haaland; captaincy #1/#2 = B.Fernandes/Haaland. 95 backend tests green.

## v1.2.0 — 2026-08-21 · schema 8

No migration. Every provider pull live-verified with real keys; the AI pass
now covers the whole news set; captaincy picks by simulated ceiling.

- **News pull**: club rotation actually rotates (offset walks the pull log);
  a user-triggered Run sweeps ALL 20 clubs (one request each), background
  polls keep the small rotating window. Live-verified with a real
  NewsData.io key: real articles inserted, players linked.
- **Sportmonks adapter rewritten against the live v3 API**: sidelined is a
  TEAM include (`teams?include=sidelined.player` — it no longer exists on
  Player), cursor pagination handled (next_cursor is a full URL; per_page is
  refused alongside cursor). Live-verified: 80 sidelined records across
  pages (free plan = Danish/Scottish only; EPL resolution needs a paid plan).
- **TheSportsDB**: switched to `search_all_teams` by league name (the id
  lookup serves a different roster on the demo key) and added the FPL-short-
  name → registered-name map (Man City → Manchester City …). Live: 10 club
  badges matched.
- **Understat**: the league page stopped embedding data (2026 redesign) —
  the adapter now uses the site's own `getPlayersStats` endpoint with the
  legacy script extraction as fallback. Live: 537 players' xG pulled.
- **AI pass fixed for reasoning models**: a truncated batch (output-length
  cap) now splits in two and retries once each — the single auto-split the
  AI plan §7 requires (it previously fell into the unrepairable repair
  path and the whole batch went stale). DeepSeek gets max_tokens 8192.
  Live: 21/21 news-bearing players analysed (was 2).
- **Captaincy by simulated P90 ceiling** (engines plan §5.3.3): a seeded
  2,000-draw simulation over the composer's own probabilities replaces the
  normal ±1.28σ approximation, which overpriced a defender's bounded
  clean-sheet floor against a striker's right-skewed haul ceiling.
  Live: Haaland over Gabriel, for the right reason.
- **Distinct ranks**: expected-points tiebreaks in the ranking — no more
  five-way tie at #1 (one per position at the score cap).
- Run pre-flight explains eligibility before launch; DeepSeek default model
  is deepseek-v4-flash.

## v1.1.0 — 2026-08-21 · schema 8

No migration. API keys in the admin panel, AI model choice, engine cold-start
fix, table sorting, plain-language UI.

- **API keys are entered in the admin panel** (Data providers / AI provider
  tabs). Keys are stored server-side in `shared/.env` — never in the
  database, never sent back to the browser (status + last-4 hint only) — and
  take effect immediately, no restart. The old way (editing `shared/.env`
  by hand + restart) still works.
- **Enabling is key-gated server-side**: a football provider cannot be
  enabled and an AI provider cannot be activated without its key (clear
  message instead of failed pulls). FPL anchor, Understat, TheSportsDB,
  Ollama and the mock need no key.
- **AI model choice per provider** with a "Load models" button that fetches
  the provider's live model list (OpenAI-compatible `/models`, Anthropic,
  Gemini, Ollama tags). The choice is stored in the provider's config.
- **Engine cold-start fixed** (the all-NaN / everyone-rank-1 / Haaland-at-6%
  bug on fresh installs): Dixon-Coles no longer divides by zero with no
  finished matches (priors are the fit); "new signing" no longer applies to
  the entire league when history is empty; players without match history get
  an ownership-based start prior (69%-owned ⇒ ~90% start, 0.3%-owned ⇒
  ~20%); every number is sanitised before it reaches the database. First run
  on a fresh install now auto-imports last season's history (statistical
  data only).
- **Run screen**: skip-list bulk buttons (Unselect all · Bottom 20/30/40/
  50/60%), and the pre-flight now explains WHY nobody is eligible (e.g. "no
  news provider is enabled") before you launch.
- **Players table**: every column header sorts (click again to flip).
- Plain language everywhere: no "NaN" (dashes instead), no "(stale)"
  ("carried forward"), friendlier status labels and stage names.

## v1.0.3 — 2026-08-21 · schema 8

No migration (scripts-only release). Fresh-server provisioning.

- install.sh/reinstall.sh now install missing prerequisites on a fresh box
  (root + apt): Node 22 via NodeSource, PostgreSQL 16 (PGDG
  repo fallback when the distro archive lacks it), nginx, curl/unzip — and
  start the postgres server. Without root/apt they fail fast with the exact
  missing list and manual commands. `ensure_prerequisites` runs BEFORE
  version.json is parsed (parsing needs node).
- Firewall: install.sh/reinstall.sh configure ufw — SSH allowed FIRST
  (lockout guard), then 80/443, default deny incoming, enable if inactive;
  the app port stays loopback-only behind nginx. `NO_FIREWALL=true` to skip.
- upgrade.sh VERIFIES prerequisites and firewall (never installs packages or
  changes rules — upgrades stay unsurprising) and fails fast if the box is
  broken (e.g. postgres down).
- psql_super gains a root `runuser` fallback for minimal Debian without sudo;
  reinstall --purge terminates connections and quotes the DB identifier.
- Rehearsals pin PROVISION=false NO_FIREWALL=true (never touch the host).
- Hardening from adversarial review (all confirmed by traced repro):
  `set -Eeuo pipefail` so the ERR trap fires inside step functions (failures
  now banner properly and upgrade auto-restore is reachable);
  `DPkg::Lock::Timeout=300` on all apt calls (no first-boot race against
  unattended-upgrades); PGDG fallback keyed on an explicit `apt-cache policy`
  availability probe (a transient apt failure is no longer misdiagnosed, apt
  stderr reaches the log); server detection keyed on the postgres binary, not
  the psql client (client-only boxes now get the server installed; remote
  DB_HOST needs client only); `ca-certificates`+`gnupg` installed before any
  https bootstrap fetch; ufw allows the port(s) sshd REALLY listens on
  (live sockets → sshd_config → 22) before enabling — no lockout on
  non-default SSH ports.

## v1.0.2 — 2026-08-20 · schema 8

No migration (scripts-only release).

- Site domain: install.sh/reinstall.sh default to `fpl.minthantthaw.me` with
  a keep-or-change prompt (non-interactive runs take the default silently);
  the choice is stored as `SITE_DOMAIN` in `shared/.env` and an nginx server
  block is written (skipped gracefully without nginx/systemd).
- upgrade.sh detects the installed site from `shared/.env` and never changes
  it — an end-of-run guard (`verify site + credentials unchanged`) proves
  `SITE_DOMAIN`, `shared/credentials.txt`, and the nginx config are
  untouched, on the upgrade path and the --rollback path alike.
- Admin credentials: created once by install.sh, saved to
  `shared/credentials.txt` (chmod 600) and displayed in a SIGN-IN block at
  the end of install.sh, upgrade.sh, and reinstall.sh. Upgrades never modify
  users; reruns of install.sh keep the existing admin and credentials file.
- rehearse-upgrade.sh now also asserts: default domain written, credentials
  file created and its credentials actually log in, second install leaves
  credentials unchanged, and upgrades preserve site + credentials
  byte-for-byte.

## v1.0.1 — 2026-08-20 · schema 8

- Migration 0008: hot-path indexes (news recency, verdict cache by player,
  ai_calls listing, player_match_stats by fixture). Purely additive.

## v1.0.0 — 2026-08-20 · schema 7

Initial release. Migrations 0001–0007.

- FPL official API anchor ingest (bootstrap, fixtures, element-summary) with
  UID registry (`plr_<ulid>`), entity-resolution cascade + admin review queue,
  and the 2025-26 historical import (vaastav) for model training.
- Statistical engine L0–L12: feature factory (football-time decay,
  position×price-band shrinkage priors), Dixon-Coles team strength with xG
  blend, Shin odds de-margin + blend, minutes model v1 (undroppable floors,
  confirmed-lineup override), attacking/DEFCON/GK/bonus/discipline models,
  xPts composer (2026/27 constants — verified 100.00% against 16,923
  historical rows), horizons, stat_score percentile ranking.
- Match engine: leverage, MCI, target/captaincy lists, coverage & gaps,
  DGW/BGW detection, chip-window scoring under the 26/27 two-set rules.
- FPL engine: rules model, ILP optimiser + greedy fallback, transfer
  suggester, team valuation.
- AI layer: max-1 gateway, 7 provider adapters + mock, BatchPlanner
  (exclusions / no-news skip / verdict cache / batching), cache-aware prompt
  layout, single-repair validator, exact per-provider usage accounting,
  human-only invocation (architectural test enforces the scheduler cannot
  reach the AI gateway).
- Run orchestrator with SSE progress + advisory-lock single-run.
- Frontend (React + Vite, Gridiron glass theme): login gate, dashboard,
  players + detail, three modes, Your Teams with vision upload +
  confirmation screen, run screen, full admin panel.
- Auth (argon2id, server-side sessions, throttling), token ledger (atomic),
  admin APIs. install.sh / upgrade.sh (9-step + auto-restore + --rollback) /
  reinstall.sh / build-release.sh (i.zip) / rehearse-upgrade.sh.

### Later (parked, out of v1 scope)
Odds modelling beyond 1X2/O-U, mini-leagues, price-change prediction,
L11 Monte Carlo (interface reserved, flag off), L3/L4 learned v2 models.
