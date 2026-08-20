# FPL Engines — Statistical Engine & Match Engine: Deep Build Plan

**Document status:** Authoritative build specification for the two engines and
their integration. Companion to `fpl-project.md` (§5, §6, §15 phases 3–4).
Where this document and `fpl-project.md` overlap, **this document wins** for
engine internals; `fpl-project.md` wins for product scope.

This is a *plan*, not code. It is written so that any competent build session
can implement the engines without re-deriving decisions: every model states
its purpose, inputs (down to field names), method, outputs (down to table
columns), update cadence, validation, and failure mode. Read it top to
bottom once; then treat each numbered section as an implementable work
package.

---

## Table of contents

- **Part 1 — The data foundation:** what we receive, from where, in what shape
- **Part 2 — Interpretation guide:** what every field actually means (and its traps)
- **Part 3 — Ingestion → UID pipeline:** how data lands in the local player DB
- **Part 4 — The Statistical Engine:** twelve layers, model by model
- **Part 5 — The Match Engine:** computations, algorithms, outputs
- **Part 6 — Full integration:** the run DAG, contracts, snapshot isolation, fast paths
- **Part 7 — Build order, testing, acceptance gates**
- **Part 8 — Research references**

---
---

# Part 1 — The data foundation

## 1.1 Source inventory

| # | Source | Role | Auth | Cost | Cadence |
|---|---|---|---|---|---|
| S1 | **FPL official API** (`fantasy.premierleague.com/api/`) | Anchor: players, prices, status, fixtures, per-GW actuals, set-piece orders, DEFCON stats | none | free | 15 min–6 h (see §1.6) |
| S2 | **API-Football v3** (api-sports.io) | Injuries, predicted + confirmed lineups, fixture events, odds | API key header | free 100 req/day; paid tiers | injuries 2×/day; lineups burst pre-kickoff |
| S3 | **Sportmonks Football v3** | `sidelined` (injury/suspension periods with expected return), xG, lineups, predictions | token | free plan limited; paid | daily + pre-deadline |
| S4 | **football-data.org v4** | Fixtures/results/standings fallback | token | free (10 req/min) | daily |
| S5 | **News API class** (NewsData.io primary, NewsAPI.org alternate) | Article stream for the AI layer; also feeds keyword-based injury early-warning | key | free dev tier; paid volume | per Run + 4×/day |
| S6 | **Understat** (unofficial scrape) | Shot-quality metrics: player xG/xA/npxG/xGChain/xGBuildup, team xG, deep completions, PPDA | none | free | post-match day +1 |
| S7 | **Historical bootstrap datasets** (one-time + seasonal refresh) | Model training data before our own DB accumulates: `vaastav/Fantasy-Premier-League` (per-GW player CSVs back to 2016/17), `olbauday/FPL-Core-Insights` (FPL-ID-aligned match stats + team Elo), OpenFPL's published feature pipeline | none | free | one-time import + summer refresh |

Rules of engagement (restate from `fpl-project.md` §4): S1 is always on and
not counted by the max-2 provider switch; S2–S6 are adapters behind the
gateway; S7 is an offline import script, not a runtime provider.

**Why this mix:** the peer-reviewed OpenFPL work demonstrated that FPL API +
Understat features alone reach commercial-grade point-forecast accuracy, but
its stated #1 limitation is the absence of expected-minutes/lineup
information — exactly what S2/S3 supply. Our design = OpenFPL-class
statistical features + a real minutes model + market odds, which targets the
gap the paper itself identifies.

## 1.2 FPL official API — endpoint & field reference (receive contract)

### 1.2.1 `GET /api/bootstrap-static/`

One JSON document, ~2–4 MB. Top-level keys we consume: `events`, `teams`,
`elements`, `element_types`, `game_settings`, `chips` (season chip windows).

**`elements[]` (one per player) — fields we ingest, grouped:**

Identity & classification
- `id` (int, **per-season** element id — changes every season, never a key for us)
- `code` (int, **cross-season stable player code — our primary external key**)
- `first_name`, `second_name`, `web_name` (display + resolution aliases)
- `team` (per-season team id), `team_code` (stable club code)
- `element_type` (1 GK, 2 DEF, 3 MID, 4 FWD; tolerate new types — FPL added a
  type 5 "Assistant Manager" experiment in 24/25 and removed it; schema must
  not hard-fail on unknown types)

Availability & news
- `status`: `a` available · `d` doubtful · `i` injured · `s` suspended ·
  `u` unavailable/left · `n` ineligible (e.g. on loan against parent club)
- `chance_of_playing_this_round`, `chance_of_playing_next_round`:
  null | 0 | 25 | 50 | 75 | 100 (null ⇒ fit, treat as 100)
- `news` (free text, e.g. "Hamstring injury - Expected back 14 Sep"),
  `news_added` (timestamp)

Economics & ownership
- `now_cost` (int, price × 10 → £/m = now_cost/10)
- `cost_change_event`, `cost_change_start`
- `selected_by_percent` (string decimal), `transfers_in_event`, `transfers_out_event`

Season aggregates (Opta-fed)
- `total_points`, `event_points`, `minutes`, `starts`, `goals_scored`,
  `assists`, `clean_sheets`, `goals_conceded`, `own_goals`,
  `penalties_saved`, `penalties_missed`, `yellow_cards`, `red_cards`,
  `saves`, `bonus`, `bps`
- Defensive stat family (added with DEFCON):
  `defensive_contribution`, `clearances_blocks_interceptions`,
  `recoveries`, `tackles`
- Expected family: `expected_goals`, `expected_assists`,
  `expected_goal_involvements`, `expected_goals_conceded` (strings; season
  cumulative) and their `_per_90` variants; `saves_per_90`,
  `starts_per_90`, `clean_sheets_per_90`, `goals_conceded_per_90`
- `influence`, `creativity`, `threat`, `ict_index`
- FPL's own opinion: `form` (mean FPL pts of matches in last 30 days),
  `points_per_game`, `ep_this`, `ep_next` (FPL's expected points — we ingest
  as a **benchmark**, never as a model input, to avoid circularity when we
  evaluate ourselves against it)

Set-piece intelligence (gold for §4 Layer 4)
- `penalties_order` (1 = first-choice taker), `direct_freekicks_order`,
  `corners_and_indirect_freekicks_order` (+ `_text` variants)

**`teams[]`:** `id`, `code` (stable), `name`, `short_name`, and FPL's own
strength ratings `strength_overall_home/away`, `strength_attack_home/away`,
`strength_defence_home/away` (ingested as features/prior, not as our FDR).

**`events[]` (gameweeks):** `id`, `deadline_time`, `finished`,
`data_checked` (⇒ bonus/DEFCON final — see 2026/27 lockdown note in §2.4),
`is_current/is_next`, `average_entry_score`, `chip_plays`, `most_captained`.

### 1.2.2 `GET /api/fixtures/` and `/api/fixtures/?event={gw}`

Per fixture: `id`, `code`, `event` (null ⇒ unscheduled — blank/postponed),
`team_h`, `team_a`, `kickoff_time`, `started`, `finished`,
`finished_provisional`, `minutes`, `team_h_score`, `team_a_score`,
`team_h_difficulty`, `team_a_difficulty` (FPL's 1–5 FDR; ingested as
benchmark only), `stats[]` — per-identifier `{identifier, h:[{element,value}],
a:[...]}` for `goals_scored`, `assists`, `own_goals`, `penalties_saved`,
`penalties_missed`, `yellow_cards`, `red_cards`, `saves`, `bonus`, `bps`,
`defensive_contribution`.

**DGW/BGW detection is pure counting on this endpoint:** for each team ×
event, `n_fixtures`; 0 ⇒ blank, ≥2 ⇒ double. Unscheduled fixtures
(`event = null`) are pending rearrangements — the match engine flags affected
future GWs as "volatile" (§5.3.6).

### 1.2.3 `GET /api/element-summary/{element_id}/`

- `history[]` — this season, one row per fixture actually played by the
  player's team: `fixture`, `opponent_team`, `was_home`, `round`, `minutes`,
  all scoring stats incl. `expected_goals/assists/...`,
  `defensive_contribution`, `value` (price that GW), `selected`,
  `transfers_in/out`. **This is our per-match stats backbone.**
- `history_past[]` — prior seasons, season-level totals (incl. xG family
  since 22/23) — used for priors and new-season blending.
- `fixtures[]` — the player's upcoming fixtures with `difficulty`.

### 1.2.4 `GET /api/event/{gw}/live/`

`elements[{id, stats{...all counting stats...}, explain[{fixture,
stats[{identifier, points, value}]}]}]` — the authoritative per-GW points
decomposition. Used by the post-GW reconciliation pass (§3.5) and to verify
our composer reproduces FPL's arithmetic exactly (property test: our
`pointsFromStats()` must equal FPL's `explain` totals on every historical
row).

### 1.2.5 Smaller endpoints

`/api/event-status/` (bonus added? data checked?), `/api/dream-team/{gw}/`,
`/api/entry/{id}/…` (out of v1 scope — no reads of real user accounts).

## 1.3 Secondary provider payloads (what each adds, concretely)

### API-Football (S2)
- `GET /injuries?league=39&season=YYYY` → `[{player:{id,name}, team:{id},
  fixture:{id,date}, type: "Missing Fixture"|"Questionable", reason:
  "Knee Injury"|"Suspended"|…}]`. Fixture-scoped (who misses *this* match),
  which complements Sportmonks' period-scoped view.
- `GET /fixtures/lineups?fixture={id}` → formation + `startXI[]` +
  `substitutes[]` + coach. **Predicted lineups appear ~1–4 h pre-kickoff and
  confirmed ~40–60 min pre-kickoff** — probe exact timing in the S2 analysis
  doc; this powers the minutes-model override and the pre-deadline fast path
  (§6.5).
- `GET /odds?fixture={id}&bookmaker=…` → 1X2, over/under, both-teams-to-score,
  clean-sheet-adjacent markets for the odds blend (§4 Layer 2).
- `GET /fixtures/statistics`, `/fixtures/events` → shots, possession, cards
  timeline (enrichment; optional in v1).

### Sportmonks (S3)
- `sidelined` include on players/teams → `[{player_id, type_id/category
  (injury|suspension), start_date, end_date|null, games_missed,
  completed}]` — **period-based**, giving expected-return dates our
  `injuries` table stores as intervals.
- xG per fixture/player (paid tiers), predictions (their model's
  probabilities — benchmark only), lineups (alternative to S2).

### football-data.org (S4)
- `/v4/competitions/PL/matches` → schedule/results/standings. Pure fallback
  for fixtures if S1 shape ever drifts; no player detail on free tier.

### News class (S5)
- NewsData/NewsAPI: `{title, description, content(truncated), source,
  url, publishedAt, language}`. Query strategy: per-club query packs
  (`"Arsenal" AND (injury OR "ruled out" OR fitness OR "press conference"
  OR lineup OR rotation)`), English only, window = since last pull.
  Articles are **never trusted as facts** — they are AI input (fpl-project
  §7) and keyword-tagged early-warning signals (§3.4.6).

### Understat (S6) — scraping contract
No official API. League/player/match pages embed JSON in
`<script>` tags as hex-escaped strings passed to `JSON.parse` — the adapter
fetches HTML, regex-extracts `teamsData`/`playersData`/`datesData` (league
page), `shotsData` (match page), decodes `\xNN` escapes, parses JSON.
Metrics taken: player `xG, xA, npxG, npxGI, shots, key_passes, xGChain,
xGBuildup`, team `xG, xGA, deep, deep_allowed, ppda (att/def)`.
Fragility rules: schema-validate every extract; on breakage → provider
auto-degrades, engine falls back to FPL's own xG fields (S1 has
`expected_goals` since 22/23) with a logged quality downgrade. Respect
robots/ToS review before enabling by default; ship disabled.

### Historical training import (S7)
One-time scripts (not runtime): import 4+ seasons of per-GW player rows from
vaastav's dataset (aligned by FPL `code`), team Elo + match stats from
FPL-Core-Insights, and Understat season archives. Lands in the same canonical
tables (§3.3) flagged `source='historical_import'`. This is what Layers 1–8
train on at day zero; our own ingested rows take over as seasons accumulate.

## 1.4 Reception mechanics (how data physically arrives)

**Snapshot-first rule:** every fetch writes the raw body to
`raw_payloads(id, provider, endpoint, params_hash, fetched_at, http_status,
body jsonb/bytea, body_sha256)` *before* any parsing. Transform bugs are then
replayable without re-spending quota; 90-day retention.

**Delta detection:** compare `body_sha256` against the previous snapshot of
the same `(provider, endpoint, params_hash)`; identical ⇒ record
`unchanged=true`, skip transform. FPL doesn't honour ETags reliably, so hash
locally; for S2–S5 honour `ETag`/`If-Modified-Since` where offered.

**Politeness & resilience (all providers):** per-provider token-bucket rate
limiter; timeout 15 s; retries ×3 with jittered exponential backoff on
5xx/network only (never on 4xx); circuit breaker (5 consecutive failures →
`degraded` 30 min); `User-Agent` set honestly; all pulls logged to
`api_pull_log` (fpl-project §4.2).

## 1.5 Polling schedule (default; per-provider override in config)

| What | Source | When |
|---|---|---|
| bootstrap-static | S1 | every 6 h baseline; every 30 min from deadline−24 h to deadline; every 15 min during live matches |
| fixtures | S1 | daily 06:00; every 30 min on match days |
| element-summary | S1 | lazily on demand, 24 h cache; full sweep post-GW (see reconciliation) |
| event/{gw}/live | S1 | every 10 min while any fixture live; final pull after `data_checked=true` (note: since 26/27 the GW locks at 09:00 UK the day after the last match — schedule the truth pass after that) |
| injuries | S2 | 08:00 & 16:00 daily; hourly deadline−24 h |
| sidelined | S3 | daily 09:00 |
| lineups | S2/S3 | burst: every 5 min from kickoff−75 min to kickoff, per fixture (drives fast path §6.5) |
| odds | S2 | daily; every 2 h deadline−48 h |
| news | S5 | on every Run; plus 4×/day background |
| Understat | S6 | day after each match day, 10:00 |

Every scheduled job is idempotent and safe to re-run (snapshot + upsert
semantics); the cron layer never assumes the previous tick succeeded.

---
---

# Part 2 — Interpretation guide (field semantics & traps)

The single biggest source of silent model corruption is misreading a field.
This section is the canonical dictionary; the implementation must encode
these rules in the transform layer, with a unit test per trap.

## 2.1 FPL element fields — meaning and traps

| Field | Interpretation | Trap / rule |
|---|---|---|
| `id` | per-season element id | **Never persist as identity.** Used only inside one season's API calls. Our key is `code` → `player_uid` |
| `code` | stable across seasons | primary mapping key; collisions never observed but enforce UNIQUE anyway |
| `now_cost` | price ×10 (55 ⇒ £5.5m) | integer maths only; divide at display time |
| `status`+`chance_of_playing_*` | availability | null chance = 100%. `status` can be `a` while `news` says "lack of match fitness" — trust the tuple (status, chance, news_added recency), not one field |
| `form` | FPL's mean points over matches in last 30 days | not our EWMA; ingest as feature, don't confuse with Layer 0 form |
| `ep_next` | FPL's own xPts | **benchmark only — never a model input** (self-reference poisons evaluation) |
| xG family (`expected_goals` …) | Opta season cumulative, string typed | parse decimal; per-90 variants divide by minutes — **unstable below ~450 min**: apply shrinkage (§4 Layer 0), never rank raw per-90s |
| `selected_by_percent` | ownership of *active* managers | string; template/differential logic input |
| `penalties_order` etc. | set-piece hierarchy, 1 = first choice | may be null early season; maintain our own override table the admin can correct |
| `minutes`, counting stats | season totals to date | deltas per GW must come from element-summary/live, not by diffing bootstrap (bootstrap can be mid-match) |
| `team_h_difficulty` (fixtures) | FPL's 1–5 FDR | benchmark only; our FDR is continuous & side-specific (§4 Layer 1) |
| `events[].data_checked` | GW fully reviewed | bonus + DEFCON only final after this; since 26/27, review window extends to 09:00 UK next day — reconciliation waits for it |
| `fixtures[].event = null` | postponed/unscheduled | feeds BGW/DGW volatility flag; never drop the row |

## 2.2 Cross-provider injury semantics → one canonical model

Three shapes arrive: FPL's *flag* (status+chance+news text), API-Football's
*fixture-scoped absence* (this player misses this fixture, reason), and
Sportmonks' *period* (start/end/expected games missed). Canonical storage is
**period-based with confidence**, because periods are what a projection
horizon needs:

```
injuries
  id, player_uid, source, kind (injury|illness|suspension|other)
  body_part_or_reason text
  start_date, expected_return_date (nullable), actual_return_date (nullable)
  fixture_scope int[] (fixture ids explicitly ruled out, from S2)
  severity_class (minor|moderate|major)   -- mapped by reason taxonomy
  confidence numeric                      -- source trust × recency decay
  is_active bool, superseded_by id        -- versioned, append-only
```

Merge policy: same player + overlapping window + same kind ⇒ one logical
injury, multiple source rows linked; the **availability resolver** (§4 Layer
3 input) reads all active rows plus FPL's chance flag and produces one
`availability_state` per player per fixture with the precedence: confirmed
lineup (in/out) > FPL 0%/status i,s,u > S2 fixture-scoped miss > S3 period >
FPL 25/50/75 > news-keyword early warning (advisory only).

## 2.3 Odds interpretation

- 1X2 decimal odds → raw implieds `1/o`; sum > 1 (overround). Remove by
  **Shin's method** (accounts for favourite–longshot bias) with
  multiplicative normalisation as the simple fallback; store both.
- Over/under 2.5 (and 1.5/3.5 where present) constrain total λ; 1X2
  constrains λ difference — §4 Layer 2 solves the pair (λ_h, λ_a) that best
  reproduces the de-margined market under a Poisson grid.
- Line movement matters near deadline: store every odds snapshot
  (`odds_snapshots`), use latest-before-computation; never average across
  days.

## 2.4 FPL scoring rules, 2026/27 (the constants the composer encodes)

Verified against premierleague.com (July 2026 announcements):

| Event | GK | DEF | MID | FWD |
|---|---|---|---|---|
| Appearance <60′ / ≥60′ | 1 / 2 | 1 / 2 | 1 / 2 | 1 / 2 |
| Goal | 6 | 6 | 5 | 4 |
| Assist | 3 | 3 | 3 | 3 |
| Clean sheet (≥60′) | 4 | 4 | 1 | 0 |
| Every 3 saves | 1 | – | – | – |
| Penalty save | 5 | – | – | – |
| Every 2 goals conceded | −1 | −1 | – | – |
| **Defensive contribution (capped 2)** | – | +2 at **10 CBIT** | +2 at **12 CBIRT** | +2 at **12 CBIRT** |
| Penalty miss | −2 | −2 | −2 | −2 |
| Yellow / Red | −1 / −3 | same | same | same |
| Own goal | −2 | −2 | −2 | −2 |
| Bonus | 1–3 top-three BPS in match | | | |

CBIT = clearances+blocks+interceptions+tackles; CBIRT adds ball recoveries.
Thresholds are *not* multiplied — 20 CBIT is still +2.

**2026/27 BPS changes** (affect Layer 7 bonus model): being tackled no longer
costs −1 BPS; CBI now 1 BPS per **3** (was per 2); all saves 2 BPS with **+1
extra for big-chance saves**; penalty save 8→7 BPS. Intent: less DEFCON/bonus
overlap, more attacker/GK bonus. The complete current BPS table must be
captured into `docs/api-analysis/fpl-official.md` at build time and encoded
in a `bps_weights` config (versioned — FPL tweaks this most seasons).

**2026/27 chips:** two full chip sets (Wildcard, Free Hit, Triple Captain,
Bench Boost — 8 total); set 1 must be used by the GW19 deadline (13:30 GMT
Sat 2 Jan 2027), no carry-over; set 2 covers GW20–38. Transfers: 1 free/GW,
bankable to 5, extra transfers −4. These rules live in the FPL Engine but
the **match engine's chip-window scoring must respect set expiry** (§5.3.7).

**GW finalisation:** scores lock 09:00 UK the day after the GW's final match
(post-match Opta review window for BPS/DEFCON) — the reconciliation pass
(§3.5) triggers on `data_checked=true`, not on full-time whistles.

## 2.5 Understat metric semantics

`xGChain` (player involved anywhere in a possession ending in a shot) and
`xGBuildup` (same, excluding shots/key passes) capture involvement that
xG/xA miss — OpenFPL found them informative for MID/DEF. `deep` (passes
completed within ~20 yards of goal) and `PPDA` (passes allowed per defensive
action — pressing intensity) are *team-style* features used by the DEFCON
opponent adjustment (§4 Layer 5: high-possession opponents inflate CBIT
opportunities for defenders facing them) and by team strength as covariates.

## 2.6 Data-quality gates (hard rules before anything reaches models)

1. **Schema validation** (zod) on every transform; unknown enum values park
   the row in `quarantine_rows` + admin alert, never crash the pipeline.
2. **Bounds checks:** minutes 0–120 (extra time never in PL, but be safe),
   prices 35–160, xG per match 0–2.5 per player, probabilities 0–1.
3. **Staleness:** every canonical row carries `as_of`; models refuse inputs
   older than per-type thresholds (injuries 72 h, odds 24 h, lineups 3 h) and
   degrade per §4.16 instead of using stale data silently.
4. **Cross-source disagreement:** if S1 says `status=a` while S2/S3 report an
   active period covering the next fixture → resolver takes the pessimistic
   branch, flags `conflict=true`, surfaces in the run report.
5. **Referential integrity:** no stats row lands without a resolvable
   `player_uid` — unresolved rows go to the review queue (§3.2), never
   auto-create players.

---
---

# Part 3 — Ingestion → UID pipeline (updating the local player DB)

## 3.1 Four-layer write path

```
(1) raw_payloads          immutable snapshots (per fetch)          [§1.4]
        │  transform (pure functions, replayable)
(2) staging.*             provider-shaped rows, validated          [per provider]
        │  RESOLVE — the only place provider ids meet player_uids
(3) canonical.*           UID-keyed facts (upsert w/ provenance)   [§3.3]
        │  compute (Statistical Engine, Match Engine)
(4) derived.*             run-stamped snapshots (append-only)      [player_matrix, predictions, insights]
```

Invariants:
- Layer 2→3 is the **only** boundary where entity resolution runs; nothing
  downstream ever sees a provider id.
- Layer 3 tables are the *current best knowledge* (upserts allowed under
  provenance rules §3.4); layer 4 tables are **append-only per run_id** —
  the engines never overwrite a past run's outputs.
- Every layer-3/4 row carries `(source, as_of, run_id?)`.

## 3.2 Entity resolution — the algorithm (detail level: implementable)

Per staging row with `(provider, provider_player_id, name, team, position?,
birthdate?)`:

```
1. Cache hit: player_identities has (provider, provider_id) → uid.  DONE (99% path)
2. Cross-key: provider exposes fpl code / opta id we already hold → map, insert identity (matched_by=code, confidence 1.0)
3. Deterministic: normalise(name) — Unicode NFKD, strip diacritics, lowercase,
   drop punctuation, token-sort — exact match AND same club AND (position
   compatible) AND (birthdate match if both present) → map (exact_name, 0.98)
4. Fuzzy: trigram similarity ≥ 0.88 on normalised names within the same club,
   tie-broken by position + shirt number if present → queue for MANUAL review
   (fuzzy, similarity as confidence). Row parks in resolution_queue; the
   admin UI shows side-by-side candidate cards. NOTHING auto-merges here.
5. No candidate: resolution_queue with status=unmatched. If the provider row
   is for a player FPL doesn't have (e.g. a cup-only youth player), admin can
   mark ignore_permanently.
```

Supporting structures: `player_aliases(player_uid, alias, source)` — seeded
from `web_name`, full name, common transliterations; grown by every manual
resolution (the queue teaches the resolver). Identity rows are append-only;
un-mapping writes a tombstone + re-queues affected staging rows for
reprocessing (a wrong merge must be reversible — replay from raw_payloads
makes the canonical stats self-heal).

**UID lifecycle:** created only from S1 bootstrap (new `code` appears →
`plr_<ulid>` minted, identity row for provider=fpl written). January
signings appear automatically; departures flip `status=u` and stay forever;
position reclassifications (FPL occasionally re-types a player mid-season)
append to `player_position_history` — models read position **as of the
fixture date**, not current.

## 3.3 Canonical table specs (layer 3)

```
players                    uid PK, fpl_code UNIQUE, web_name, full_name, position,
                           team_uid, shirt, birthdate?, joined_at, status, flags jsonb
teams                      uid PK, fpl_code UNIQUE, name, short_name
player_identities          (provider, provider_id) UNIQUE → uid          [§3.2]
player_aliases             uid, alias, source
fixtures                   fixture_uid PK, fpl_fixture_id UNIQUE, event(gw)?, home_team_uid,
                           away_team_uid, kickoff_utc, state(scheduled|live|finished|checked|postponed),
                           scores, fpl_fdr_h, fpl_fdr_a
player_match_stats         (player_uid, fixture_uid) PK — one row per player per fixture:
                           minutes, starts, goals, assists, cs, conceded, og, pen_saved,
                           pen_missed, yc, rc, saves, bonus, bps, defcon_count, cbit, cbirt,
                           recoveries, tackles, xg, xa, xgi, xgc, npxg, xgchain, xgbuildup,
                           key_passes, shots, fpl_points, price_at_gw, provenance jsonb
player_season_history      (player_uid, season) — history_past import + our own season rollups
injuries                   [§2.2 shape]
availability_state         (player_uid, fixture_uid) — resolver output: p_available,
                           state enum, evidence jsonb, conflict bool, as_of
lineups                    (fixture_uid, team_uid, kind predicted|confirmed, formation,
                           starters uid[], bench uid[], as_of)
odds_snapshots             (fixture_uid, bookmaker, market, line?, prices jsonb, taken_at)
news_items + news_player_map   [fpl-project §11] — map rows carry match_kind
                           (alias_exact|alias_fuzzy|club_context) + confidence
price_events               (player_uid, date, old_cost, new_cost)
set_piece_roles            (player_uid, pens_order?, dfk_order?, corners_order?,
                           source fpl|admin_override, as_of)
team_style_stats           (team_uid, window, possession, ppda, deep, deep_allowed,
                           field_tilt?, as_of)                       [Understat/S2]
```

Upsert semantics: natural key ON CONFLICT DO UPDATE **only for fields owned
by the incoming source per the precedence matrix** (§3.4); every update
bumps `as_of` and appends the previous value to a lightweight
`field_audit` (player_uid, table, field, old, new, source, at) for the
fields that drive decisions (status, price, expected return).

## 3.4 Field precedence matrix (who wins per field)

| Field family | 1st | 2nd | 3rd | Notes |
|---|---|---|---|---|
| Post-match counting stats, FPL points, BPS, DEFCON | S1 (after `data_checked`) | S1 (provisional) | — | S1 is the game's own truth |
| xG/xA/shot quality | S6 Understat | S1 xG fields | S3 | if S6 disabled, S1 silently takes over (flagged in run report) |
| Injury existence/return | resolver blend | | | precedence inside §2.2 |
| Predicted lineup | S2 | S3 | — | confirmed lineup: first source to confirm wins; disagreement on *confirmed* ⇒ alert (should never happen) |
| Odds | S2 | — | — | single odds source in v1 |
| Price/ownership/status flags | S1 only | | | |
| Team style (PPDA/deep) | S6 | S2 stats | — | |

## 3.5 Post-GW reconciliation ("truth pass")

Trigger: `events[gw].data_checked = true` (≥09:00 UK day after last match).

1. Full `element-summary` + `event/{gw}/live` sweep → upsert final
   `player_match_stats` rows (provenance `fpl_final`).
2. Verify composer: recompute `pointsFromStats()` per player, diff against
   FPL's `explain` totals; any mismatch = P1 bug ticket (scoring constants
   drifted).
3. Write `model_errors` rows: for every player with a prediction in this GW,
   store (run_id, player_uid, gw, xpts_pred, points_actual, minutes_pred,
   minutes_actual, cs_prob, cs_actual, …) — this table **is** the living
   backtest and feeds the monitoring dashboards (§4.15).
4. Mark any active injury with the player having played ≥60′ as
   `actual_return_date = kickoff` (auto-close).
5. Refresh season rollups and time-decayed aggregates used by Layer 0.

## 3.6 Update flow summary (what touches the player DB when)

| Event | Writes |
|---|---|
| bootstrap poll | players (status/price/news/ownership/set-piece orders), price_events, teams |
| injuries/sidelined poll | injuries (+versions), availability_state refresh for affected players |
| lineup burst | lineups; availability_state override; triggers fast-path mini-run (§6.5) |
| odds poll | odds_snapshots |
| news poll | news_items, news_player_map (resolver on titles/bodies) |
| match finished | player_match_stats (provisional) |
| data_checked | truth pass §3.5 |
| Run button | derived.* only (matrix, predictions, insights) — **a Run never mutates canonical facts** |

---
---

# Part 4 — The Statistical Engine (twelve layers)

## 4.0 Design principles

1. **Layered, not monolithic:** each layer owns one quantity, consumes only
   lower layers + canonical tables, and is separately testable/replaceable.
   (This mirrors what the OpenFPL evaluation implies: feature quality and
   minutes information dominate algorithm choice.)
2. **Probabilities everywhere:** every layer outputs calibrated probabilities
   or expectations *with variance*, never bare point estimates.
3. **Config, not code:** every constant marked ⚙ lives in `model_config`
   (versioned rows; a run records the config version it used).
4. **Two implementations per layer where feasible:** a transparent v1
   (closed-form / GLM — explainable in the UI) and an optional v2 (gradient
   boosting per OpenFPL) behind the same interface; a config flag selects.
5. **Reproducibility:** run_id + config version + input snapshot hashes ⇒
   identical outputs (engines are pure w.r.t. the DB state they read).

Layer map (each = one module in `backend/src/stats/`):

```
L0 preparation → L1 team strength (Dixon-Coles) → L2 odds blend
→ L3 minutes (xMins) → L4 attacking production → L5 defensive contribution
→ L6 goalkeeper → L7 bonus → L8 discipline/misc → L9 xPts composer
→ L10 horizons/DGW → L11 simulation → L12 stat_score & ranking
```

## 4.1 L0 — Preparation (feature factory)

Purpose: turn canonical facts into model-ready, leakage-free features.

- **Per-90 with exposure control:** `rate90 = 90·Σx / Σmin` computed over
  windows of last **1, 3, 5, 10, 38 matches** (⚙ — the OpenFPL horizon set)
  plus season and career. Rates from < 450 min (⚙) are shrunk (below).
- **Time decay:** exponential weights `w = exp(−t_days · ξ_player)` with
  ⚙ ξ_player ≈ 0.01 (half-life ~70 days) for player rates; team-level decay
  handled inside L1.
- **Empirical-Bayes shrinkage:** every per-90 rate is blended toward its
  positional prior: `ratẽ = (n·rate + k·prior) / (n + k)` where n = minutes/90
  and ⚙ k ≈ 6 effective matches. Priors per position×price-band recomputed
  each season from history. This is the single most important guard against
  small-sample per-90 lies.
- **Venue splits:** home/away rate variants (OpenFPL: venue-specific points
  features carry signal).
- **New-season blending:** weight `α(gw)` slides from prior-season aggregates
  to current-season: α = n_current/(n_current + ⚙8) — by ~GW8 current season
  dominates. Promoted teams / newly-arrived players use league-conversion
  priors (⚙ Championship attacking output × 0.6 — refit from history) with
  double shrinkage.
- **Leakage rule:** every feature is computed **as-of the fixture's
  kickoff** (only rows with `kickoff < t`); the feature factory takes `t` as
  a parameter — the same code serves live runs and backtests (§4.15).

Outputs: `feature_store` rows (player_uid, fixture_uid, feature_version,
jsonb vector) — cached per run, reused by L3–L8 and by the AI layer's
compact player summaries.

## 4.2 L1 — Team strength: Dixon-Coles with xG blend

Purpose: per-fixture scoreline distribution — the root of clean sheets,
concessions, and fixture difficulty.

**Model.** Goals_h ~ Poisson(λ_h), Goals_a ~ Poisson(λ_a):

```
log λ_h = μ + α_home(i) − β_away(j) + γ        (attack i, defence j, home adv γ)
log λ_a = μ + α_away(j) − β_home(i)
identifiability: Σα = Σβ = 0
```

with the Dixon-Coles τ low-score correction applied to {0-0, 1-0, 0-1, 1-1}
via dependence parameter ρ (expected fitted range ≈ −0.03…−0.15), and
**time-decayed likelihood** `w(t) = exp(−ξ·Δdays)`, ⚙ ξ selected by
maximising out-of-sample predictive log-likelihood on the last two seasons
(grid 0.001–0.007/day; literature default ≈ 0.0018–0.0065).

**xG-blend target (our main deviation from vanilla DC):** fit on
pseudo-goals `g̃ = ⚙0.6·xG + 0.4·goals` per match (Understat team xG; fall
back to summed player xG from S1). xG is ~2× less noisy than goals per match,
so strengths converge faster after summer churn. Keep a goals-only fit in
parallel each week; alert if the two diverge beyond threshold (data issue).

**Fitting:** weighted MLE, Nelder-Mead or L-BFGS on the ~42 parameters
(20 attack, 20 defence, μ, γ, ρ), warm-started from last week's fit; refit
**weekly post-truth-pass** + after any postponement reshuffle. Fit window:
current + previous season (decay handles staleness). Promoted teams: prior
strength from Championship conversion, high initial variance.

**Optional refinement (v2, ⚙ off by default):** split defence into
β_open-play / β_set-piece if shot-type data available; not needed for v1.

**Derivations** (per fixture, stored in `fixture_predictions`):
- Scoreline grid P(h=x, a=y) for x,y ≤ 10 (τ-adjusted).
- `p_cs_home = P(a=0)`, `p_cs_away = P(h=0)`.
- Concession buckets for GK/DEF points: P(GA∈{0},{1},{2-3},{4-5},…) →
  E[−⌊GA/2⌋].
- Win/draw/loss, E[goals] each side.
- **Our FDR** (continuous, side-specific, 0–10): for team T vs opponent O,
  `fdr_attack = 10·F(λ_T_this_fixture / λ_T_neutral)` (how much the fixture
  inflates/deflates T's scoring), `fdr_defence = 10·(1 − p_cs_T_percentile)`.
  Published per fixture per team; the match engine and UI consume these,
  never FPL's 1–5.

**Validation:** ranked probability score (RPS) on 1X2 vs. bookmaker
de-margined probabilities as the ceiling benchmark and FPL FDR as the floor;
calibration of p_cs (predicted 30% CS fixtures → ~30% observed).

## 4.3 L2 — Odds blend

Purpose: where the market speaks, listen — bookmakers embed team news and
information we can't model.

Method: de-margin 1X2 + O/U (Shin, §2.3) → solve for (λ_h*, λ_a*) minimising
squared error to market {P(H),P(D),P(A),P(>2.5)} on the DC grid → blended
rates `λ_blend = ⚙w_mkt·λ* + (1−w_mkt)·λ_DC`, with w_mkt ≈ 0.65 when odds
< 48 h old, decaying to 0 for stale/absent odds. Store both raw and blended;
the run report shows when the market moved a prediction materially (>15%).
All downstream layers read λ_blend.

## 4.4 L3 — Minutes model (xMins) — *the highest-leverage model in the system*

Purpose: `p_start`, `p_60` (≥60′), `p_any` (any appearance), `E[min]` per
player per fixture. Commercial services' edge is precisely here (FPL Review
simulates minutes 1,000× per player); OpenFPL's stated weakness is lacking
it. We build it properly.

**Decomposition:**

```
E[min] = p_start·E[min|start] + (1−p_start)·p_sub·E[min|sub]
p_60   = p_start·P(≥60|start)                     (sub cameos ≥60′ are negligible)
p_any  = p_start + (1−p_start)·p_sub
```

**Feature set (v1 → v2 shared):** start share last 5 (decay-weighted),
minutes EWMA (⚙ half-life 4 club matches), started-last-match, availability
resolver state + FPL chance bucket, days since return from injury (ramp
feature: returns typically staged 20′→45′→60′→90′ — encode minutes-since-
return), fixture congestion (club matches within ±4 days incl. UEFA/cups —
needs S2 fixture list across competitions), competition context (league match
sandwiched between UCL legs), price tier & ownership (proxy for
"undroppable"), position, age bucket, new-signing-adaptation flag (< 4 club
matches), suspension-risk (4 yellows before GW19 cutoff / 9 before GW32 —
one booking from a ban), manager rotation index (club-level: mean XI churn
per match, last 10), late-window transfer rumour flag (from news keywords,
advisory).

**v1 (ship first): calibrated hierarchical heuristic** — a documented,
unit-tested decision table, e.g.:

```
status ∈ {i,s,u,n} or resolver p_available=0        → p_start = 0
confirmed lineup available: in XI → 0.99; benched → 0.02 (+p_sub .55); absent → 0.01
chance_of_playing = c (25/50/75)                    → p_start = base·c/100
else base from start-share bucket:
  started 5/5 and minutes_ewma > 80    → 0.93
  4/5                                   → 0.85
  3/5                                   → 0.68   (⚙ table, 12 rows)
  …
modifiers (multiplicative, capped):
  congestion & squad-role=rotational    × 0.85
  returned-from-injury < 2 matches      × 0.75
  new signing < 2 matches               × 0.70
E[min|start] from position×ewma table (defenders ~88, attackers ~78 …)
p_sub, E[min|sub] from season position tables
```

Every bucket/multiplier ⚙; the table is **calibrated on last two seasons of
confirmed lineups** (S7 import + S2 lineups): choose values minimising
Brier score of p_start.

**v2: logistic regression (p_start), gamma/quantile model (E[min|start])**
on the same features, isotonic-calibrated; promoted to default only when it
beats v1 on held-out Brier + log-loss. v3 (optional): gradient boosting.

**Confirmed-lineup override:** when confirmed XIs land (kickoff−~60′), the
fast path (§6.5) snaps p_start to 0.99/0.02/0.01 and re-composes xPts for
affected fixtures. For *future* fixtures beyond the next, p_start regresses
toward the model (uncertainty grows with horizon: multiply logit by
⚙0.9^(k−1) toward the positional base rate for fixture k ahead).

**Validation:** Brier + calibration curves per position and per bucket;
special report on "p_start ≥ 0.9 players who didn't start" (the manager-trust
killers). Target v1: Brier ≤ 0.12 on next-fixture starts (baseline
"started-last-match" ≈ 0.17 — verify on our data in the L3 analysis
notebook).

## 4.5 L4 — Attacking production (goals & assists)

Purpose: `E[goals]`, `E[assists]` per player per fixture.

**Per-90 attacking rates** (from L0, shrunk): npxG/90, xA/90, plus shots/90,
key passes/90, xGChain/90, xGBuildup/90 as v2 features.

**Finishing-skill policy:** default to xG (evidence: finishing
over-performance is mostly noise). A bounded skill multiplier
`clip(career_goals/career_xG, 0.85, 1.15)` (⚙) applies **only** for players
with ≥ ⚙2,500 career shots-context minutes — i.e., proven elite/poor
finishers get ±15% max; everyone else is pure xG.

**Penalties, explicitly:** remove penalty xG from open-play rates (npxG
handles this), then add expected penalty value separately:
`E[pens_taken] = team_pen_rate_per_match · λ_team_adj · taker_share(pens_order)`
· `E[goal|pen] ≈ 0.76·skill_adj`. Taker share from `set_piece_roles` (1st
takes ~85%, 2nd the rest when 1st absent — probability-weighted via L3
availability of the first-choice taker). Direct FKs analogous with tiny
rates; corners feed xA via the player's corner share.

**Fixture adjustment (the multiplier every rate gets):**

```
fixture_multiplier_att(T vs O) = λ_blend(T, this fixture) / λ_baseline(T)
E[goals] = npxG90_shrunk · E[min]/90 · fixture_multiplier_att + E[pen_goals]
E[assists] = xA90_shrunk · E[min]/90 · fixture_multiplier_att · ⚙assist_conv
```

where λ_baseline(T) is T's decay-weighted mean λ over a neutral schedule and
⚙assist_conv ≈ 1.05 calibrates xA → FPL-definition assists (FPL assists are
broader than Opta assists — includes won penalties/FK leading to goal, etc.;
fit the constant on history).

**Team-total consistency (v2 nicety, ⚙ off in v1):** rescale player
E[goals] within a team so Σ players ≈ λ_blend·(share of minutes) — prevents
double-counting when several teammates' rates are simultaneously high.

Output: `player_fixture_predictions` partial columns (e_goals, e_assists +
variances from the Poisson assumption).

## 4.6 L5 — Defensive contribution (DEFCON)

Purpose: `P(DEFCON hit)` per player per fixture — 2 pts at 10 CBIT (DEF) /
12 CBIRT (MID/FWD). This is new-ish scoring (25/26) that most public models
still handle crudely — an edge worth building well.

- Rates: CBIT/90 (DEF), CBIRT/90 (MID/FWD) from L0 (S1 exposes per-match
  `defensive_contribution`, `clearances_blocks_interceptions`, `tackles`,
  `recoveries` — we store per-match counts in `player_match_stats`).
- Distribution: counts are over-dispersed → **negative binomial** per player
  (dispersion pooled by position ⚙), giving
  `P(count ≥ threshold | E[min])` directly. v1 simplification: empirical
  per-player hit-rate over last ⚙15 matches, shrunk to position×role prior,
  scaled by E[min]/90 — ship this first, NB when per-match data accumulated.
- **Opponent adjustment:** defensive volume rises against high-possession,
  territory-dominant opponents. Multiplier from opponent's possession +
  `deep` + PPDA percentile (team_style_stats):
  ⚙ `defcon_mult ∈ [0.8, 1.25]`, fit by regressing team-conceded CBIT counts
  on opponent style over history.
- Game-state (v2): trailing teams defend more; approximated via win-prob from
  L1 (underdogs get a small positive DEFCON bump ⚙).

Output: `p_defcon` (+ E[defcon_pts] = 2·p_defcon).

## 4.7 L6 — Goalkeeper model

- Shots on target faced ≈ f(opponent λ_blend) via league SOT-per-xG ratio;
  `E[saves] = E[SOT_faced] · save_rate_shrunk(GK)`.
- Save points: `E[⌊saves/3⌋]` computed on the Poisson distribution of saves,
  **not** ⌊E[saves]/3⌋ (Jensen — the naive form systematically underpays
  high-save keepers).
- `E[pen_save_pts] = P(pen faced)·(1−0.76)·5` (league pen rate × opponent
  pen-win tendency).
- CS + concession terms come from L1 buckets; GK DEFCON is negligible but
  CBIT applies (rare) — reuse L5 with GK prior.
- 26/27 BPS note: all saves 2 BPS + big-chance save bonus → keepers' bonus
  ceiling rose; L7 must use the new weights.

## 4.8 L7 — Bonus points

Purpose: `E[bonus]` (0–3). Bonus is a **rank within the match**, so it's
inherently interactive — model accordingly, in two stages:

- **v1 (empirical, ships with L9):** P(bonus=b | position, event profile)
  lookup tables from the last two seasons — event profile = {scored, assisted,
  CS+DEFCON, high-saves, nothing} — shrunk, then
  `E[bonus] = Σ_b b·P(b|profile)·P(profile)` where P(profile) comes from
  L4–L6 outputs. Captures the big truth (a FWD goal ≈ 1.3 expected bonus; a
  DEF goal + CS ≈ 2.6) without simulating.
- **v2 (with L11 simulation):** per simulated match, compute every player's
  expected-BPS from simulated events × the current `bps_weights` config
  (2026/27 values §2.4), rank within match, award 3/2/1 (with FPL's tie
  rules), average over sims. This naturally prices the 26/27 BPS rebalancing
  (attackers/GKs up, CBI-heavy CBs down) — v1 tables must be refit on 26/27
  data as it accumulates since old-season bonus distributions embed old BPS.

## 4.9 L8 — Discipline & misc negatives

Per-90 shrunk rates × E[min]/90, with priors by position and role:
`E[yc_pts] = −1·yc90·…` (add ⚙ +20% vs high-card referees only if referee
assignments are ingested — v2), `E[rc]`, `E[og]`, `E[pen_miss]` (takers
only: E[pens]·0.24·(−2)), GK/DEF `E[concession_pts]` from L1 buckets
(computed on the distribution, not the mean).

## 4.10 L9 — xPts composer (per player per fixture)

Pure function over L1–L8 outputs + scoring constants (§2.4). Per position
(FWD shown; others add/remove terms per the table):

```
xPts = p_any·1 + p_60·1                                  (appearance)
     + E[goals]·goal_pts(pos)
     + E[assists]·3
     + p_60·p_cs_team·cs_pts(pos)                        (GK/DEF 4, MID 1)
     + E[defcon_pts]                                     (L5)
     + E[save_pts] + E[pen_save_pts]                     (GK, L6)
     + E[bonus]                                          (L7)
     − E[concession_pts] − E[yc]·1 − E[rc]·3 − E[og]·2 − E[pen_miss]·2
```

Also compose **variance**: independent-term approximation in v1
(σ² = Σ term variances; document the known correlation shortfall), exact from
L11 when simulation is on. Store per (player_uid, fixture_uid, run_id):
all components + total — **componentised, because the UI/AI must explain
every number** ("7.1 xPts: 2.0 appearance, 2.4 goals, 0.9 assists, 0.8 CS,
0.6 DEFCON, 0.4 bonus").

Property tests: composer × historical actual-event rows must reproduce FPL's
official points exactly (via §3.5 check); all probabilities in [0,1]; xPts
bounded sane (0–25).

## 4.11 L10 — Horizons & DGW/BGW aggregation

`xpts_next_k = Σ over the player's fixtures in the next k EVENTS` (not k
fixtures): DGWs naturally double-count (two fixtures in one event), BGWs
contribute 0. Store k ∈ {1, 3, 6} (⚙ +14 for chip planning parity with
commercial tools, cheap to add). Also store `xpts_per_event[]` for the next
8 events — the match/chip engine consumes the vector, not just sums.
Horizon-k minutes uncertainty from L3's regression-to-base applies.

## 4.12 L11 — Monte Carlo simulation layer (v2, interface reserved in v1)

⚙ N ≈ 5,000 sims per GW. Per sim: sample lineups (L3 Bernoullis, correlated
within team via position-group constraints — a team fields exactly 11),
sample match scorelines (L1 grid), allocate goals/assists to players by
rate shares conditioned on sampled minutes, sample DEFCON/saves/cards, award
bonus by simulated BPS rank (L7 v2). Deliverables the analytic path can't
give: full point distributions → `P(haul ≥ 10)`, `P(blank ≤ 2)`, captaincy
ceiling (P90), team-level correlation for the FPL engine's risk view, and
Bench Boost joint distributions. Runs post-L9 in the pipeline; behind config
flag `simulation.enabled`.

## 4.13 L12 — stat_score & ranking (0–100)

```
raw = ⚙w1·z_pos(xpts_next3) + ⚙w2·z_pos(xpts_next1) + ⚙w3·z_pos(form_ewma)
    + ⚙w4·p_start + ⚙w5·z_pos(xpts_next3 / price)         (value term)
    + ⚙w6·fixture_outlook (mean own-FDR next 3, sign-adjusted)
stat_score = 100·Φ_pos(raw)      (position-wise percentile map → uniform 0–100)
penalties: availability hard-caps — status i/s/u ⇒ score ≤ 25; doubt ⇒ ≤ 60 (⚙)
```

Default ⚙ w = (0.40, 0.15, 0.10, 0.15, 0.12, 0.08). Percentile mapping (not
min-max) keeps 70 meaning "top-30% of position" for GK and MID alike —
the cross-position comparability `fpl-project.md` §5.5 promises. Dense ranks
`rank_overall`, `rank_position` per run. The AI adjustment then applies
*after* this (fpl-project §7.2): `overall_score = clamp(stat_score + ai_adj,
0, 100)` — re-ranked into the final matrix snapshot.

## 4.14 Model registry & reproducibility

`model_runs(run_id, layer, model_version, config_version, fitted_params
jsonb, input_snapshot_hashes jsonb, fitted_at, metrics jsonb)` — every L1
fit, every L3 calibration, every composer execution registers here. Any
matrix row can be traced: run_id → config version → exact weights → input
hashes → raw payloads. No exceptions; this is what makes "why did his rank
drop?" answerable in the UI.

## 4.15 Validation & backtesting protocol

- **Walk-forward backtest:** for each historical GW g in the test range:
  restrict all inputs to `as_of < deadline(g)` (L0's leakage rule makes this
  free), run L0–L10, score against actuals. **Team-based CV** for any
  learned model (OpenFPL's design — folds split by club-season, not random
  rows, to stop team leakage).
- **Metrics:** RMSE + MAE of xPts (overall, per position, per return class —
  OpenFPL's zeros/blanks/tickers/haulers cut); Spearman of our rank vs.
  actual points; Brier + reliability curves for p_start, p_cs, p_defcon;
  RPS for 1X2.
- **Benchmarks to beat, in order:** (B1) naive last-4-average points, (B2)
  FPL's own `ep_next`, (B3) published OpenFPL RMSE figures on comparable
  splits; aspirational (B4) bookmaker-implied where markets exist.
- **Acceptance gates (CI-enforced):** a model change merges only if overall
  RMSE does not regress > ⚙1% and no position regresses > ⚙3%; golden-file
  tests pin exact outputs on a frozen fixture set to catch silent drift.
- **Live monitoring:** `model_errors` (§3.5) dashboards — rolling 6-GW RMSE
  vs. B1/B2, calibration drift alarms (predicted-vs-observed start rates
  diverging > 5pts triggers L3 recalibration task).

## 4.16 Cold start & degraded modes

| Condition | Behaviour |
|---|---|
| Season start (GW1–3) | L0 blending leans on prior season + promoted-team priors; xpts uncertainty widened (⚙ ×1.4); UI badges "early-season estimates" |
| No odds provider enabled | w_mkt = 0, pure DC — logged in run report |
| Understat disabled/broken | S1 xG fields substitute; xGChain/Buildup features nulled (v2 models must tolerate) |
| No lineup provider | L3 runs on statistical features only; confirmed-override path inert; run report warns |
| Player with zero PL history (new signing) | position×price prior + league-conversion multiplier from prior league if known (⚙ table); high variance; AI news pass is the main early signal |
| Mid-season rule change by FPL | scoring constants + bps_weights are config — hotfix release bumps config version, composer re-runs; §3.5 verification catches any missed constant |

---
---

# Part 5 — The Match Engine

## 5.1 Contract

**Consumers:** the three frontend modes, the FPL Engine (candidate pools,
chip logic), the AI prompt builder (fixture context), the dashboard.
**Reads (same run_id only):** `fixture_predictions` (L1/L2),
`player_fixture_predictions` (L9/L10), `availability_state`, `user_teams`.
**Writes:** `match_insights`, `target_lists`, `coverage_reports`,
`chip_recommendations` — all run-stamped, append-only.

## 5.2 Core quantities

Per fixture f, per side T:

```
att_leverage(T,f)  = percentile over next-⚙6-event fixtures of λ_blend(T,f)/λ_baseline(T)
def_leverage(T,f)  = percentile of p_cs(T,f)
leverage(T,f)      = max side-relevant leverage, 0–10 scale
volatility flag    = fixture in an event affected by unscheduled/postponed matches
```

Interpretation: att_leverage 9.2 = "this is one of the best attacking
fixtures any team has in the window" — the exact sentence the UI renders.

## 5.3 Computations

### 5.3.1 Match compatibility index (the "which match to move on" answer)
Per fixture: `mci = ⚙0.5·max(att_leverage_h, att_leverage_a) +
⚙0.3·max(def_leverage_h, def_leverage_a) + ⚙0.2·star_density`
(star_density = Σ top-decile overall_score players likely to start, both
sides). Ranked list per GW = "matches to mine for transfers", each with its
reason string composed from the dominant term.

### 5.3.2 Players-to-target lists
Per high-leverage fixture-side: top ⚙8 players by
`xpts_this_fixture · p_start`, partitioned by position, each row carrying
{xpts components, price, ownership, leverage context}. Global per-GW list =
union, deduped, re-ranked. **Differential variant:** same filtered to
ownership < ⚙10%, ranked by `xpts · p_start · (1 − own%)` — upside-seeking
mode for chasing rank.

### 5.3.3 Captaincy pool (feeds Weekly mode)
Top ⚙6 by `2·xpts_next1` with ceiling column (P90 from L11 when on,
else xpts + 1.28σ) — safe pick vs. ceiling pick labelling.

### 5.3.4 Team fixture-coverage & gap analysis
For a given saved/uploaded team S over window W (next ⚙3 events):
`coverage(S) = Σ_{f ∈ top-quartile leverage fixtures in W} exposure(S, f)`
where exposure counts S's likely starters on the favoured side of f,
position-weighted (attackers for att_leverage, DEF/GK for def_leverage).
**Gaps** = high-leverage fixture-sides where exposure = 0 → rendered as
"you have nobody for Spurs' home run" + the §5.3.2 list for exactly those
sides. This is the direct transfer-idea generator.

### 5.3.5 DGW/BGW detection
Pure counting per §1.2.2, projected ⚙10 events ahead, with volatility
flags on events that still have unscheduled fixtures (cup-clash windows).
Output: per-event per-team fixture counts — consumed by chip scoring and
rendered as the fixture-planner heat strip.

### 5.3.6 Fixture swing detection
Teams whose mean own-FDR improves/worsens ≥ ⚙2.0 between consecutive
3-event windows → "buy window opening/closing" signals with the GW boundary.

### 5.3.7 Chip-window scoring (2026/27 two-set rules)
For each future event e and each chip, a value score against the *user's
team* S (computed per saved team; cached per run):

```
FH(e,S)  = xpts(optimal 1-event squad, budget(S), e) − xpts(S, e)
WC(e,S)  = Σ_{k=e..e+⚙5} [xpts(optimal squad_k) − xpts(S_k)] − transfer-path value
BB(e,S)  = Σ bench-4 xpts in e for the post-optimisation squad (peaks in DGWs)
TC(e,S)  = max captain 2·xpts − baseline best single-event captain elsewhere
```

Optimal squads via the FPL Engine's optimiser in "quick" configuration
(⚙ time-boxed, cached per event×budget-band). **Set-expiry logic:** set-1
chips must schedule within events ≤ GW19, set-2 within GW20–38; the
recommender solves the assignment (each chip to its best feasible window,
greedy by value with lookahead) and adds **urgency**: unused set-1 chips
approaching GW19 get escalating "use-or-lose" flags starting ⚙4 events out.
Volatile events (5.3.5) carry a "wait — fixtures may move" caveat instead of
a hard recommendation.

### 5.3.8 Reason strings
Every insight row stores a structured `reasons jsonb` (term contributions)
from which the UI composes plain-English sentences and the AI prompt builder
draws context — no consumer ever re-derives why.

## 5.4 Output tables

```
match_insights        (run_id, fixture_uid, side, att_leverage, def_leverage,
                       mci, star_density, volatility, reasons jsonb)
target_lists          (run_id, event, scope global|fixture|differential|captaincy,
                       fixture_uid?, player_uid, rank, score, reasons jsonb)
coverage_reports      (run_id, team_id, window, coverage_score, gaps jsonb)
chip_recommendations  (run_id, team_id, chip, chip_set 1|2, event, value,
                       urgency, caveats jsonb, best_squad_ref?)
```

## 5.5 Validation

Backtest chip scores against history: would the recommender's FH/BB windows
have out-scored actual-average chip usage? Property tests: set-expiry never
violated; BB score = 0 when no DGW and bench is weak; coverage monotonic in
squad quality; every recommendation row has non-empty reasons.

---
---

# Part 6 — Full integration

## 6.1 The run DAG (what the Run button executes)

```
        ┌─ S2/S3/S5 pulls ─┐                     (skippable: stale-tolerant)
S1 pull ┤                  ├─ INGEST+RESOLVE ─ L0 ─ L1 ─ L2 ─┬─ L3 ─┐
        └─ odds pull ──────┘                                  │      ├─ L4..L8 ─ L9 ─ L10 ─ (L11) ─┐
                                                              └──────┘                              │
                                          AI pass (optional, gated, fpl-project §7) ◄───────────────┤
                                                              │                                     │
                                                   L12 stat_score + AI adj → player_matrix snapshot ┤
                                                              │                                     │
                                                       MATCH ENGINE (§5) ──────────────────────────┤
                                                              │                                     │
                                              FPL ENGINE precomputes (per saved team) ◄────────────┘
                                                              │
                                                       run report + SSE done
```

Dependencies are explicit in code as a typed DAG; stages declare
`inputs: TableRef[]` and `outputs: TableRef[]`, and the orchestrator
verifies at startup that every input is produced by an earlier stage or is
canonical — **integration is enforced by the runtime, not by convention.**

## 6.2 Interface contracts (the seams, as TypeScript signatures — shapes only)

```ts
// ingest → stats
getFeatures(playerUid, fixtureUid, asOf: Date): FeatureVector          // L0
// stats internal seams
fitTeamStrength(asOf): TeamStrengthParams                              // L1
predictFixture(fixtureUid, params, odds?): FixturePrediction           // L1+L2
predictMinutes(playerUid, fixtureUid): MinutesPrediction               // L3
composeXpts(playerUid, fixtureUid): XptsBreakdown                      // L9
// stats → match / fpl / ai
getPlayerPredictions(runId, horizon): PlayerFixturePrediction[]
getFixturePredictions(runId, events): FixturePrediction[]
// match → fpl / frontend
getInsights(runId, event): MatchInsight[]
getChipPlan(runId, teamId): ChipRecommendation[]
getCoverage(runId, teamId): CoverageReport
// fpl engine ← everything
optimiseSquad(objective, constraints, candidatePool?): SquadSolution   // pool from §5.3.2 shrinks ILP
suggestTransfers(teamId, freeTransfers, horizon): TransferSuggestion[]
```

Each seam is a module boundary with its own test double — the match engine
is tested against synthetic `FixturePrediction`s, the FPL engine against
synthetic insights, etc.

## 6.3 Snapshot isolation rules

- Engines **read canonical tables as-of run start** (repeatable-read
  transaction or explicit `as_of` filtering) and **read derived tables only
  from their own run_id**. A run is internally consistent even if a poll
  lands mid-run.
- The frontend reads "latest completed run" via a `runs.status='complete'`
  pointer — a failed run never becomes visible; the previous matrix stays
  live.
- Cross-run comparisons (rank movement arrows) always name both run_ids.

## 6.4 Failure & degradation semantics per stage

| Stage fails | Behaviour |
|---|---|
| S2/S3/S5 pull | continue with stale canonical data if within staleness gates (§2.6), else skip dependent adjustments; run report lists every degradation |
| L1 fit | reuse last week's params (they age gracefully); alert |
| L3 | **abort run** — minutes underpin everything; nothing downstream is meaningful |
| AI pass | matrix completes with ai_adjustment = last value (flagged stale) — statistical outputs never blocked by AI (fpl-project §7 principle) |
| Match engine | matrix still publishes; modes show "insights unavailable for this run" |
| Any stage crash | run marked failed, previous run stays live, structured error in run report |

## 6.5 Fast paths (mini-runs)

- **Lineup-confirmed path:** lineup burst (§1.5) detects confirmed XIs →
  targeted mini-run: L3 override → L9/L10 recompose for affected fixtures →
  L12 re-rank → match-engine refresh for that event only. Seconds, no AI, no
  token cost. This is what makes the tool live-useful in the final hour
  before deadline.
- **Nightly micro-run:** price changes + injury polls → availability resolver
  + L12 re-rank only (no model refits) — keeps the dashboard fresh between
  full Runs without burning quota or tokens.

**Hard rule (restated from `fpl-project.md` §7.0): neither fast path — nor
any scheduled or automatic execution of any kind — ever invokes the AI
layer.** Scheduled work is statistical only; `ai_adjustment` values simply
carry forward from the last human-triggered Run. The run orchestrator's
scheduled entry points are constructed without AI-gateway access so this is
structurally impossible, not merely configured off.

## 6.6 What each frontend mode consumes (read contracts)

| Mode | Reads |
|---|---|
| Initial (GW1) | player_matrix (xpts_next6 objective), optimiseSquad, target_lists global |
| Free Hit / Wildcard | chip_recommendations (+urgency), coverage_reports, DGW/BGW strip, optimiseSquad(1-event or 6-event) diff vs team |
| Weekly | suggestTransfers, captaincy pool, availability alerts for squad, target_lists (fixture + differential), price-risk list |
| Your Teams | team valuation (FPL engine) + coverage_reports per team |
| Player pages | matrix history + xPts component breakdown + model_errors track record ("how right have we been about him") |

## 6.7 Performance budget (full run, 700+ players, warm caches)

| Stage | Budget |
|---|---|
| pulls + ingest | ≤ 60 s (network-bound, parallel) |
| L0 feature factory | ≤ 20 s (set-based SQL + cached windows) |
| L1 fit + L2 | ≤ 10 s (warm-started optimiser) |
| L3–L10 all players | ≤ 30 s (pure functions, batch) |
| L11 (when on) | ≤ 120 s (worker threads) |
| Match engine | ≤ 10 s |
| FPL engine precompute (per team ≤ 2 s, lazy) | on demand |
| **Total (no AI, no sim)** | **≈ 2 min**; AI pass adds provider-dependent time, streamed via SSE |

---
---

# Part 7 — Build order & acceptance gates

Maps into `fpl-project.md` phases 3–4; each work package lands with its
tests and its section of the model registry.

| # | Work package | Depends on | Exit criteria |
|---|---|---|---|
| E1 | Snapshot/staging/resolve pipeline + canonical tables (§1.4, §3) | fpl-project phase 2 | replay-from-raw reproduces canonical bit-exact; resolver ≥ 99% auto-match on S2 PL players, 0 wrong auto-merges on labelled test set |
| E2 | Historical import (S7) + feature factory L0 | E1 | 4 seasons queryable; leakage test (features at t contain nothing dated ≥ t) green |
| E3 | L1 Dixon-Coles + L2 odds blend | E2 | RPS beats FPL-FDR baseline on backtest; p_cs calibrated ±3pts; weekly refit job stable |
| E4 | L3 minutes v1 + availability resolver | E1, E2 | Brier target met (§4.4); confirmed-lineup override verified on recorded burst data |
| E5 | L4–L8 production models | E3, E4 | per-component sanity ranges; composer property tests |
| E6 | L9–L10 composer + horizons | E5 | reproduces FPL `explain` arithmetic exactly on 2 seasons; golden files pinned |
| E7 | Backtest harness + gates + model_errors + dashboards (§4.15, §3.5) | E6 | beats B1 and B2 benchmarks overall and on ≥3 of 4 positions; CI gate wired |
| E8 | L12 + matrix snapshot + rank movement | E6 | full matrix run ≤ budget; UI explainability payloads complete |
| E9 | Match engine (§5) | E6 | chip set-expiry property tests; coverage/gap outputs validated on fixture scenarios incl. DGW/BGW |
| E10 | Integration DAG + fast paths + degradation matrix (§6) | E8, E9 | chaos tests: each stage-failure row behaves as §6.4; lineup mini-run < 30 s end-to-end |
| E11 | L11 simulation + L7 v2 bonus (optional flag) | E10 | sim vs analytic means agree within tolerance; P(haul) calibrated on backtest |
| E12 | L3 v2 / L4 v2 learned models (optional) | E7 | promoted only on beating v1 at the CI gates |

---

# Part 8 — Research references

- OpenFPL — open-source FPL forecasting, position-specific XGBoost/RF
  ensembles, feature sets, team-based CV, return-class evaluation:
  [arXiv:2508.09992](https://arxiv.org/abs/2508.09992) ·
  [repo](https://github.com/daniegr/OpenFPL)
- FPL Review model docs — xMins simulation & massive data model (the
  commercial benchmark's own description):
  [docs.fplreview.com](https://docs.fplreview.com/the-model/projections/xmins/)
- Dixon & Coles (1997) and modern implementations — τ correction, ρ range,
  time-decay ξ:
  [dashee87 walkthrough](https://dashee87.github.io/football/python/predicting-football-results-with-statistical-modelling-dixon-coles-and-time-weighting/) ·
  [ImpliedScore explainer](https://impliedscore.com/dixon-coles-model/)
- FPL API endpoint guides:
  [Oliver Looney](https://www.oliverlooney.com/blogs/FPL-APIs-Explained) ·
  [Frenzel Timothy](https://medium.com/@frenzelts/fantasy-premier-league-api-endpoints-a-detailed-guide-acbd5598eb19)
- 2026/27 official rule/BPS changes:
  [premierleague.com — changes overview](https://www.premierleague.com/en/news/4679873/all-you-need-to-know-about-changes-to-fpl-for-202627) ·
  [BPS changes](https://www.premierleague.com/en/news/4679946/whats-new-in-202627-fantasy-changes-to-bonus-points-system) ·
  [DEFCON](https://www.premierleague.com/en/news/4361991/whats-new-in-202526-fantasy-defensive-contributions)
- API-Football injuries endpoint: [api-football.com](https://www.api-football.com/news/post/new-endpoint-injuries) ·
  Sportmonks sidelined: [sportmonks.com](https://www.sportmonks.com/glossary/injuries-and-suspensions/)
- Historical datasets: [vaastav/Fantasy-Premier-League](https://github.com/vaastav/Fantasy-Premier-League) ·
  [FPL-Core-Insights](https://github.com/olbauday/FPL-Core-Insights)
- ICT index definition: [premierleague.com](https://www.premierleague.com/en/news/65567)

*End of engines plan. Implementation entry point: Part 7, package E1.*
