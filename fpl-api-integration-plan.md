# FPL API Integration Plan — Provider Dossiers & Anti-Bug Engineering

**Document status:** Authoritative integration specification for every
external football-data provider. Companion to `fpl-project.md` (§4) and
`fpl-engines-plan.md` (Parts 1–3). Its purpose is **zero-surprise
implementation**: the classes of bug this document exists to prevent are
pull errors, database update errors, player-UID mismatches, and floods of
unnecessary manual identity verifications — plus every adjacent failure mode
we could identify per provider.

**Evidence base:** primary documentation, OpenAPI specs, and (for
API-Football) a third-party live-probe dossier verified against the real API
in August 2026. Facts that could not be verified from a primary source are
marked **VERIFY-AT-BUILD** and are folded into each provider's probe script
(Part 4) so they are checked by code, not by memory, before the adapter
ships.

---

## Table of contents

- **Part 1 — Cross-cutting anti-bug engineering** (applies to every adapter)
- **Part 2 — Provider dossiers:** FPL official · API-Football · Sportmonks ·
  football-data.org · News APIs · TheSportsDB · Understat
- **Part 3 — Provider pairing strategy** (what the max-2 switch should
  actually enable, given verified tier realities)
- **Part 4 — The verification probe protocol** (build-time, per provider)

---
---

# Part 1 — Cross-cutting anti-bug engineering

These rules are the adapter framework. Every provider dossier in Part 2 only
adds provider-specific parameters to this machinery — no adapter reimplements
any of it.

## 1.1 The five laws of the ingest layer

1. **Never trust the transport.** Success is not HTTP 200 — at least one
   provider (API-Football) returns errors *inside* HTTP 200. Every adapter
   defines `assertOk(response)` that inspects the body per its dossier before
   anything is parsed as data.
2. **Never trust the shape.** Every response passes a zod schema *for that
   endpoint* before transform. Schema-invalid payloads go whole into
   `quarantine_rows` with the raw snapshot id; the pull is marked
   `degraded`, an admin alert fires, and the previous canonical data stays
   live. A provider changing its shape must never corrupt the DB — it can
   only pause its own feed.
3. **Never trust a field's type.** Providers send numbers as strings
   (Sportmonks odds values, API-Football's `rating: "7.2"`, FPL's xG fields,
   TheSportsDB's everything). The transform layer owns ALL type coercion via
   per-field converters (`toDec`, `toInt`, `toUtc`) — coercion never happens
   in SQL or at display time, and a failed coercion quarantines the row, it
   never inserts NULL silently.
4. **Never write outside a transaction, never guess a conflict target.**
   §1.4 below.
5. **Never resolve identity in an adapter.** Adapters emit provider-shaped
   staging rows; the resolver (§1.5) is the single component that touches
   `player_identities`. This is what makes UID bugs impossible to introduce
   from a new provider adapter.

## 1.2 The unified error taxonomy → handling matrix

Every failure an adapter can encounter maps to exactly one of these classes;
the gateway implements the handling once:

| Class | Detection (per dossier) | Handling |
|---|---|---|
| `NETWORK` | timeout, DNS, connection reset, TLS | retry ×3, exponential backoff + jitter (2s/4s/8s); then mark pull failed, circuit-breaker counter +1 |
| `RATE_LIMITED` | 429; or in-200 `errors.rateLimit` (API-Football); `Retry-After` header if present | wait per header or provider-specific pacing; retry once; if still limited, defer job to next slot — never hammer |
| `QUOTA_EXHAUSTED` | daily/monthly counter at 0; in-200 `errors.requests`; 402-class messages | stop ALL non-critical pulls for this provider until reset time (tracked in `api_providers.quota_reset_at`); surface in admin; capability router fails over to the other enabled provider |
| `AUTH` | 401/403 with auth-shaped body | no retry; provider auto-disabled to `error` state; admin alert (key expired/revoked) |
| `PLAN_DENIED` | 403 plan messages (Sportmonks); in-200 `errors.plan` (API-Football) | no retry; **record the denied (endpoint, params) combination in `provider_entitlements` so the request is never constructed again**; admin alert with the exact plan message |
| `NOT_FOUND` | 404 on a specific resource | no retry; log; if the resource is a fixture/player we track, flag for reconciliation (may have been deleted upstream) |
| `SCHEMA_DRIFT` | zod validation failure | quarantine + degrade + alert (law #2) |
| `MAINTENANCE` | provider-specific (FPL "game is being updated"; 503s) | treat as transient; retry with long backoff (15 min); do not count toward circuit breaker during known windows (FPL GW rollover) |
| `EMPTY_OK` | 200 with legitimately empty data (lineups before they exist) | NOT an error; record `unchanged`/`not_yet_available`; no alert |

The `PLAN_DENIED` → `provider_entitlements` mechanism is the codification of
the single most important probe finding (Part 2.2): **coverage metadata is
not entitlement**. The adapter never assumes what the plan allows; it learns
from denials and from the Part 4 probe, and constructs only requests known to
be allowed. This kills the "wasted quota + confusing error" class of pull bug
at the root.

## 1.3 Pull pipeline hardening (recap + additions to `fpl-engines-plan.md` §1.4)

- **Snapshot-first** (raw body persisted + SHA-256 before parse) — unchanged.
- **Request construction is data-driven:** every scheduled pull is a row in
  `pull_jobs` (provider, capability, endpoint template, params, cadence,
  enabled). Adapters never build ad-hoc URLs; the probe (Part 4) and
  entitlement learning edit `pull_jobs`, so a plan change is a data change.
- **Pre-flight guards:** before constructing a request, check (a) provider
  enabled + not circuit-broken, (b) entitlement table allows this
  endpoint+params, (c) remaining quota ≥ reserve threshold (default keep 10%
  headroom for deadline-day bursts), (d) params within provider windows
  (e.g. API-Football free date window). A request that would fail is never
  sent — this is how "pull errors" become structurally rare.
- **Response headers are first-class data:** every dossier lists its quota
  headers; the gateway persists them on `api_pull_log` and updates
  `api_providers.quota_*`. Where headers are absent (some tiers omit them),
  the gateway maintains its own counters and treats provider counters as
  advisory — **never assume provider counters are monotonic** (API-Football's
  daily counter was observed going 77→75→78→76).
- **Pacing:** token-bucket per provider fed from the *observed* per-minute
  header when present, falling back to the dossier's safe default. Pacing is
  data, not code — plan upgrades need no deploy.
- **Clock discipline:** all provider timestamps normalised to UTC at the
  transform boundary using the dossier's stated timezone semantics; the app
  never does timezone math anywhere else. Kickoff comparisons always use the
  provider's explicit UTC offset or unix timestamp when offered.

## 1.4 Database write hardening (kills "database update errors")

- **One transaction per logical pull-transform-upsert unit.** A fixture
  sweep is one transaction per fixture batch (≤500 rows), not per row (dead
  slow) and not one giant transaction (lock bloat + total rollback on one bad
  row after quarantine handling).
- **Explicit conflict targets, always.** Every upsert names its natural key:
  `ON CONFLICT (provider, provider_id)`, `ON CONFLICT (player_uid,
  fixture_uid)`, etc. A bare `ON CONFLICT DO NOTHING` without a target is
  banned by lint rule — it hides constraint mismatches.
- **Upserts update only the columns the source owns** (per the precedence
  matrix, engines plan §3.4), and only when the incoming `as_of` is newer
  than the stored one (`WHERE excluded.as_of > t.as_of`) — this makes
  re-delivery, out-of-order jobs, and replays all safe (idempotence by
  construction).
- **Partial-unique-index trap** (from `howupgradeshouldwork-1.md` §10):
  `ON CONFLICT` cannot target partial unique indexes — where we need one
  (e.g. one active injury per player+kind), use check-then-insert inside the
  transaction and swallow the duplicate-key race explicitly.
- **Type safety at the boundary:** staging tables use `text` for everything
  the provider sends; coercion happens in the transform step with per-field
  error capture. Canonical tables use strict types (`numeric(6,2)` for xG,
  never `float` for money/price). Postgres 18 `uuidv7()` for surrogate ids
  where ordering matters.
- **Deferred FK ordering:** transforms insert parents before children within
  the transaction (teams → fixtures → player rows); the resolver guarantees
  `player_uid` exists before any stats row (law #5). No `ON DELETE CASCADE`
  anywhere in canonical tables — deletes don't happen (append-only doctrine).
- **Batch upserts** use `INSERT ... SELECT FROM unnest(...)` (single
  round-trip per batch) — never row-at-a-time loops from Node.
- **Advisory locks per (provider, capability)** so two overlapping cron
  ticks of the same job cannot interleave writes.
- **Post-write invariant checks** (cheap, same transaction): row counts
  within expected bounds (a "full EPL squad sweep" that writes 3 players
  rolls back and alerts — truncated payloads must not shrink our world),
  no duplicate (player_uid, fixture_uid), all probabilities in [0,1].

## 1.5 UID mapping hardening (kills mismatches AND kills unnecessary manual review)

The resolution cascade (engines plan §3.2) stands; these additions target the
two failure modes the user called out — wrong merges, and too much manual
review:

1. **Pre-season mapping sprint (the big one).** Before GW1, a one-time job
   walks every provider's EPL squads and resolves all ~600 players in bulk
   while context is richest (squads are settled, both providers list team +
   shirt number + birthdate). Expected outcome, based on the signals
   available per provider: **> 97% auto-resolved** (exact/deterministic
   tiers), leaving a one-screen review queue (~10–20 names), not hundreds.
   Mid-season the resolver then only ever faces *deltas* (transfers, youth
   debuts) — a handful per week.
2. **Pre-seeding from open datasets:** import the community FPL↔Understat
   id mapping maintained in the vaastav dataset (per-season id lists +
   Understat linkage files) and FPL-Core-Insights' FPL-ID-aligned tables as
   `matched_by='seed'` identities (confidence 0.95, still overridable).
   This zeroes the Understat mapping workload. **VERIFY-AT-BUILD:** exact
   file paths/columns in those repos (they reorganise between seasons).
3. **Multi-signal deterministic tier before any fuzzy tier:** a candidate
   pair auto-accepts iff `normalised_name` matches AND team matches AND
   (birthdate matches OR shirt number matches OR position compatible).
   Two-of-four secondary signals beats any string-similarity threshold and
   is immune to the classic traps (see §1.5.1). Fuzzy similarity is only a
   *ranking* for the review queue, never an auto-accept criterion by itself.
4. **Blocking:** candidates are generated within (team × position-group)
   first, then team-only, then league-wide — 99% of matches resolve in the
   first block, and league-wide fuzzy scans (the source of absurd
   suggestions) run only for the residue.
5. **Alias learning:** every manual resolution writes the provider's spelling
   into `player_aliases`, so the same player never returns to the queue —
   including next season.
6. **Never auto-merge on name alone**, whatever the similarity. This is the
   wrong-merge killer, and it costs nothing given signal-rich football data.
7. **Reversibility drill:** the un-map tombstone + replay path (engines plan
   §3.2) gets a test that wrong-merges a player deliberately, un-maps, and
   asserts canonical stats self-heal from raw snapshots.

### 1.5.1 The name traps the resolver's normaliser must pass (unit-test fixtures)

- Diacritics: Ødegaard/Odegaard, Sávio/Savio, Mbeumo, Kudus, Šeško.
- Token order: Son Heung-min ↔ Heung-Min Son (sort tokens before compare).
- Mononyms & registered names: Richarlison, Casemiro; multiple *Emerson*s
  have coexisted in the PL — mononym matches REQUIRE a secondary signal.
- Hyphens/apostrophes: Calvert-Lewin, N'Golo Kanté, O'Brien
  (strip punctuation, don't split identity).
- FPL `web_name` ≠ legal name ("Gabriel", "Bruno G.", "J.Timber") — web_name
  is an alias, `first_name + second_name` is the resolution name.
- Brothers/same-surname same-club (Wan-Bissaka/…, historical Neville-class
  cases): surname+team collides — birthdate or shirt number decides, queue
  otherwise.
- Mid-window club mismatch: during transfer windows a provider may show the
  new club while FPL still shows the old one — the resolver treats team
  mismatch as *soft* (downgrades to review, never hard-rejects) during
  window months (Jun–Aug, Jan).
- Loanees & U21 call-ups: providers list players FPL doesn't have; these go
  to `ignore_permanently` after one review — never repeatedly re-queued
  (the queue deduplicates by (provider, provider_id) forever).

## 1.6 What "well-integrated" means, verifiably

Adapter Definition of Done (every provider, enforced in CI):
- [ ] Contract tests against recorded fixtures for: happy path, each error
      class in §1.2, empty-OK, schema-drift sample, pagination walk.
- [ ] `assertOk` catches the dossier's in-200 error shapes.
- [ ] Every dossier field-type trap has a coercion test.
- [ ] Chaos test: kill the network mid-pull → no partial canonical writes.
- [ ] Replay test: re-run the same snapshot twice → byte-identical canonical
      state (idempotence).
- [ ] Probe script (Part 4) passes against the live API with the real key.
- [ ] `docs/api-analysis/<provider>.md` filled in with probe results.

---
---

# Part 2 — Provider dossiers

## 2.1 FPL official API (anchor — always on)

Base `https://fantasy.premierleague.com/api/` · no auth for public
endpoints · full endpoint/field reference lives in `fpl-engines-plan.md`
§1.2. This dossier covers only reliability behaviour.

**Known failure modes (community-reported; all VERIFY-AT-BUILD in the probe):**
- **User-Agent filtering:** default library UAs (python-requests, curl) have
  been intermittently 403'd. Rule: send a realistic desktop-browser UA
  string from config; probe verifies from our deployment host.
- **Datacenter-IP blocking:** cloud-hosted IPs (AWS/GCP ranges) have been
  intermittently challenged/403'd by the CDN. This is the **top deployment
  risk** for a self-hosted server: the probe MUST run from the production
  host early (Phase 1), and the fallback plan (route FPL pulls through a
  household/VPS egress or a lightweight proxy the admin controls) is a
  documented config option (`FPL_EGRESS_PROXY`), not an emergency hack.
- **Maintenance window:** during GW rollover the API serves an updating
  message/5xx for minutes-to-hours; classify as `MAINTENANCE` (§1.2), retry
  at 15-min intervals, suppress alerts during the expected window (the night
  after `data_checked`).
- **CDN staleness:** consecutive pulls can briefly disagree (edge caches).
  The `as_of`-guarded upserts (§1.4) make this harmless; never diff two
  bootstrap pulls seconds apart to derive "changes".
- **Season rollover (June–July):** `elements[].id` and team ids are
  reissued; bootstrap may serve the *new* season with zeroed stats while
  history endpoints briefly disagree. The importer refuses to attach rows to
  a new season until `events[]` for it exists, and player continuity runs on
  `code` only (already law).
- **Price changes** land overnight (community consensus ~01:30–02:30 UK;
  VERIFY-AT-BUILD by observing a week of pulls) — schedule the nightly
  micro-run after 03:00 UK.
- **Schema drift is real and seasonal** (xG family added 22/23; DEFCON
  family added 25/26; AM element_type appeared and vanished 24/25). The zod
  schemas use `.passthrough()` for unknown *additions* (log new keys,
  don't fail) but hard-fail on missing/retyped *known* fields.
- **No documented rate limit**, but be polite: bootstrap ≤ every 15 min,
  element-summary lazy + cached, and **never fan out element-summary ×700
  in parallel** — sequential with pacing (≤5 rps) on the post-GW sweep.

## 2.2 API-Football v3 (api-sports.io) — injuries, lineups, odds, stats

**Verified against a live-probe dossier (Aug 2026) + OpenAPI spec + typed
community SDKs.** The highest-confidence dossier in this document.

**Access.** Base `https://v3.football.api-sports.io`, header
`x-apisports-key` when bought direct from `dashboard.api-football.com`.
The **RapidAPI resale is a different host and different auth header**
(`x-rapidapi-key` / `...rapidapi.com` host) — the adapter supports one mode,
direct, and the docs say so; mixing the two is a classic misconfiguration.
EPL is `league=39`; **league names are globally non-unique** ("Premier
League" exists in 35 countries) — league id is config, never looked up by
name.

**Tiers & limits (verified):**
| | Free | Pro (~$29/mo class) |
|---|---|---|
| Daily | 100 req | 7,500 req |
| Per-minute | ~10 (enforced as 429; headers may be absent) | 300 (headers present) |
| Seasons | **rolling ~3-season window (2022–2024 as of mid-2026) — the CURRENT season is NOT accessible** | all listed seasons (2010–2026 verified) |
| `date` param | restricted to ~[today−1, today+1] UTC | unrestricted |
| Odds/predictions | restricted | included |

⚠ **The free tier cannot serve this app's core need (current-season data).**
This changes the pairing strategy — see Part 3. Free is still useful for
development against past seasons.

**Quota headers (persist all four):** `x-ratelimit-limit` /
`x-ratelimit-remaining` (per-minute) and `x-ratelimit-requests-limit` /
`x-ratelimit-requests-remaining` (per-day). The daily counter is **not
monotonic** — treat as advisory (§1.3).

**THE trap — errors inside HTTP 200.** Failed calls return 200 with the
body's `errors` object populated and `response: []`:
`{"errors": {"plan": "Free plans do not have access to this season, try from 2022 to 2024."}}`,
`{"errors": {"rateLimit": ...}}` (this one also as HTTP 429). And an
*absent* resource (lineups before publication) is ALSO 200 with
`response: []` but `errors: {}` — so the adapter's `assertOk` is:
**error iff `errors` is non-empty; empty `response` with empty `errors` is
`EMPTY_OK`**. A client that checks only status codes will read plan refusals
as "no data" and silently starve the models — the exact bug class this
document exists to prevent.

**Coverage flags ≠ entitlement (verified both directions).**
`/leagues?id=39` advertises per-season `coverage` flags; seasons flagged
`true` can be plan-denied, and an unstarted season flagged all-`false`
fetches perfectly (fixture calendars publish months ahead). **Never branch
on coverage flags; learn entitlement by probing (Part 4) and from
`PLAN_DENIED` responses.** Entitlement varies per league AND per season.

**Endpoints & shapes (verified):**
- `GET /fixtures?league=39&season=YYYY` — whole season in ONE response
  (380 fixtures, ~633 KB, not paginated). `fixture.date` is ISO-8601 with
  explicit UTC offset + unix `timestamp` (no tz guessing).
  `status.short` ∈ NS/1H/HT/2H/FT/AET/PEN/PST/CANC… — map to our fixture
  state enum; a live season is all-`NS` with null scores.
- `GET /fixtures/lineups?fixture={id}` — array of 2 team objects:
  `formation`, `coach`, `startXI[]`/`substitutes[]` of
  `{player: {id, name ("A. Onana" — ABBREVIATED), number, pos: G|D|M|F,
  grid: "row:col"|null}}` + kit colours. **Measured timing: the sheet lands
  complete (both teams, XI + bench + formation at once) between T−29 and
  T−18 min before kickoff** (docs claim 20–40 min). Before that: EMPTY_OK.
  Nothing in `/fixtures` signals availability — poll on a time window
  (start T−45, every 5 min, stop at kickoff or on arrival).
  **`player.id` can be NULL on a team sheet** (young/late-registered
  players) — type it nullable, drop the slot from resolution, pick the
  player up post-match when an id exists. Never invent an id.
- `GET /fixtures/players?fixture={id}` — post-match per-player stats
  (~69 KB): FULL names + photos + `games.minutes` etc. **Empty until after
  kickoff** (still empty at T−18) — never call it pre-match, it's a
  guaranteed wasted request. `rating` is a **string** ("7.2");
  **`penalty.commited` is misspelled in the API** — map to a correctly
  spelled column at the boundary. Most stat fields are null for most
  players: all stat columns nullable, null ≠ 0.
- `GET /injuries?league=39&season=YYYY` (or `&fixture=`) — fixture-scoped
  absences `{player:{id,name}, team:{id}, fixture:{id,date}, type:
  "Missing Fixture"|"Questionable", reason}`. Community-reported staleness
  (entries lag reality by hours; no return dates) — treated as one signal in
  the availability resolver, never sole truth.
- `GET /odds?fixture={id}` — bookmaker array; values as strings; huge
  payloads → request specific `bookmaker` id(s) from config.
- Pagination: `paging: {current, total}` + `page=` param exists on large
  collections (players search); per-fixture endpoints don't paginate.

**ID mapping:** stable integer ids on every entity (player 526, team 33,
fixture 1208021 …) → `player_identities(provider='api_football',
provider_id)`. Full names from `/fixtures/players` are the resolution names;
lineup names are abbreviated — resolve lineup slots via id, never via the
abbreviated name (except the null-id case, which parks for post-match).

**Request budget (measured):** season backfill = 1 + 2/fixture ≈ 761 req;
steady state trivial on Pro (fits our 10%-headroom rule easily); on free,
impossible for live use (see Part 3).

## 2.3 Sportmonks Football API v3 — sidelined, lineups, xG, predictions

**Verified against the official docs (fetched as raw .md — append `.md` to
any docs URL; index at `docs.sportmonks.com/football/llms.txt`) + live path
test.**

**Access.** Base **`https://api.sportmonks.com/v3/football`** — verified
live; the auth docs page's `/api/v3/football` **404s** (docs bug — trust
this dossier). Auth: `api_token` query param or `Authorization` header.
EPL league id **8** (Scottish Premiership 501, Danish Superliga 271).

**Plans (from official error-codes doc):** **free = Danish + Scottish
leagues ONLY.** Premier League requires **Standard+**; xG requires
Standard+; Predictions is a separate add-on; live odds a separate package.
⚠ So for this app Sportmonks is a **paid-only** option (see Part 3);
the free plan is only good for exercising the adapter's plumbing.

**Rate limit model:** 3,000 requests **per entity** per hour — the counter
is per entity type (League, Fixture, Player…), and every response tells you
where you stand in `rate_limit: {resets_in_seconds, remaining,
requested_entity}`. Persist per-entity counters (one bucket per entity, not
one global). On 429 honour `Retry-After` if present, else back off to the
bucket's `resets_in_seconds`.

**Envelope (every response):** `data` + `subscription[]` (plan metadata) +
`rate_limit` + `timezone` (+ `pagination` when applicable). The adapter
reads `subscription` once per day to auto-populate `provider_entitlements`
— Sportmonks literally tells us our plan in-band; use it instead of
discovering by 403.

**Request options:**
- Includes: `&include=participants;lineups.player;sidelined` —
  **semicolon-separated**, dot-nested, no spaces (a space is a 400).
  `select=` trims fields to shrink payloads. Include-depth and complexity
  limits exist (per the filtering/complexity exceptions doc) — the adapter
  caps nesting at 2 and splits requests rather than composing mega-includes.
- Filters: `&filters=...` typed syntax per docs; invalid filter = 400 with
  explanatory message (surface it verbatim in logs).
- Pagination: **cursor-based** — `pagination: {count, per_page,
  current_page, next_cursor, has_more}`; `per_page` 1–50 (default 25);
  pass `cursor=` until `has_more=false`. Legacy `page=` exists but new
  integrations must use cursors (dataset can shift between pages
  mid-season — cursors are the correctness fix). **The pagination object has
  NO total count** — never build progress bars on totals.
- Timezone: `&timezone=Europe/London` supported per their tz tutorial, but
  we always request default UTC and convert at the boundary (§1.3).

**Entities we consume:**
- `sidelined` include (on players/teams): `{id, player_id, type_id,
  category (injury|suspension…), team_id, season_id, start_date, end_date,
  games_missed, completed}` — period-based; maps 1:1 onto our canonical
  injuries table (engines plan §2.2).
- Lineups via fixture includes (`lineups`, `formations`, `events`) —
  their lineups tutorial is exhaustive (saved to research archive);
  confirmed-lineup timing comparable to API-Football's; VERIFY-AT-BUILD
  measured timing in the probe.
- `expected` entity (xG per fixture/player) — Standard+.
- Predictions endpoints (`/predictions/probabilities/fixtures/{id}`) —
  add-on; ingested (if subscribed) as benchmark only.
- **Odds values arrive as strings** — coerce (law #3).

**Trap — include row ids:** in `players`/`teams` include lists, **the
item's `id` is the RELATION row id, not the player/team id** — always read
`player_id`/`team_id`, or use the nested `players.player` include. This is
the #1 documented mis-mapping mistake for v3 newcomers and would poison UID
resolution if missed; contract test required.

**Error codes:** clean semantics — 400 syntax, 401 token, **403 plan/
resource**, 404 missing id (also used for *removed* fixtures — placeholder
matches get deleted upstream; treat as `NOT_FOUND` reconciliation), 429
rate, 500 server. No in-200 errors observed — but `assertOk` still checks
`data` presence.

## 2.4 football-data.org v4 — fixtures/standings fallback

(Not covered by the salvaged research agents — dossier from prior knowledge;
**every line VERIFY-AT-BUILD via the probe**, which is cheap since the
surface is small.)

- Auth: `X-Auth-Token` header. Free tier: **10 requests/minute**, PL
  included in the free competition set. Quota headers:
  `X-Requests-Available-Minute` + `X-RequestCounter-Reset`; 429 past the
  limit.
- Endpoints: `/v4/competitions/PL/matches?dateFrom&dateTo&matchday&status`,
  `/v4/competitions/PL/standings`, `/v4/competitions/PL/teams`,
  `/v4/matches/{id}`, `/v4/teams/{id}`.
- Match object: `utcDate` (UTC ISO), `status` ∈ SCHEDULED|TIMED|IN_PLAY|
  PAUSED|FINISHED|POSTPONED|SUSPENDED|CANCELLED, nested `score`
  (winner/duration/fullTime/halfTime), `matchday` int.
- **Trap:** `matchday` ≠ FPL gameweek after postponements (a rearranged
  match keeps its original matchday) — never map matchday→GW directly;
  fixtures map to FPL events via kickoff-window + team pair matching only.
- Kickoffs can be `TIMED` (date known, time TBD) — treat time as provisional
  until status flips.
- Free-tier data latency can be minutes after full-time; person/lineup
  detail is limited on free. Role stays what fpl-project §4 says: fixture/
  results *fallback*, no player-level dependency.
- IDs stable (team ids, person ids); map team ids once (20 rows, seeded
  manually in the pre-season sprint).

## 2.5 News APIs — NewsData.io (primary), NewsAPI.org (alternate), GNews (reserve)

(Dossier from prior knowledge — **tier numbers drift constantly; ALL
VERIFY-AT-BUILD**, and the adapter treats every limit as config.)

- **NewsData.io:** `GET /api/1/latest?apikey=...&q=...&language=en&category=sports`.
  Credit-based free tier (order of ~200 credits/day, ~10 articles/credit);
  `nextPage` token pagination; response `{status, totalResults,
  results[{title, link, description, content, pubDate, source_id, ...}],
  nextPage}`. Free tier truncates `content`; query length is capped
  (~100 chars) → **per-club query packs must be short**: rotate through
  clubs across the day's 4 pulls rather than one mega-query.
- **NewsAPI.org:** free/developer tier is **development-only** (no
  production/commercial use per ToS), ~100 req/day, **articles delayed 24 h**,
  ~1-month history, page depth capped (426 Upgrade Required beyond it).
  A 24 h delay is useless for injury news → NewsAPI is the *alternate* for
  paid deployments only; the default alive news provider is NewsData.io.
- **GNews.io:** small free tier, near-realtime; reserve slot behind the same
  adapter interface.
- Shared adapter behaviour: articles are UNTRUSTED CONTENT (AI input only);
  dedupe by URL canonicalisation + title trigram similarity ≥0.9 within
  72 h window; store `source_domain` reputation tier from config (BBC, Sky,
  Athletic, club sites > aggregators); entity linking via the alias table
  with club-context disambiguation (engines plan news_player_map) — a
  surname alone never links without club co-mention.

## 2.6 TheSportsDB — metadata & media assets

(Rate limits verified via official docs/forum; field inventory
VERIFY-AT-BUILD.)

- v1: key-in-URL `https://www.thesportsdb.com/api/v1/json/{KEY}/...`;
  free/test key exists but is throttled and not for production. Patreon
  ($9/mo) key: production use, ~**100 req/min advised (hard limit 2 req/s)**;
  free/demo ~30 req/min. **v2 API** (`X-API-KEY` header, JSON-only) is
  premium-only and is the forward-developed surface — adapter targets v2
  where possible, falls back to v1 shapes.
- Use: team badges, player photos + `strCutout` renders for the pitch view;
  EPL id 4328 (v1 league endpoints); `lookup_all_players.php` needs the paid
  key.
- **Everything is strings** (numbers, dates) and community-edited (accuracy
  varies) — metadata/media ONLY; never a stats or availability source.
- Player objects carry cross-reference id fields to other databases
  (VERIFY-AT-BUILD which of e.g. Transfermarkt/Wikidata/API-Football ids are
  present and how complete for PL players) — if present and populated, they
  seed `player_identities` as `matched_by='seed'` and further shrink manual
  review.
- Error behaviour: prefers `{"players": null}` / empty objects over HTTP
  errors; may serve HTML on rate-limit — `assertOk` = valid JSON AND
  expected top-level key present; treat HTML as `RATE_LIMITED`.
- Images: hotlink the documented `/preview`-suffixed thumbnails or cache
  full images into `shared/data/media/` (preferred — survives provider
  outages and respects their bandwidth guidance).

## 2.7 Understat — scraping adapter (stretch, ships disabled)

(Mechanics well-established across community scrapers; brittle by nature —
probe re-verifies every season.)

- Pages: `understat.com/league/EPL/{startYear}` (vars `teamsData`,
  `playersData`, `datesData`), `understat.com/match/{id}` (`shotsData`),
  `understat.com/player/{id}`. Data sits in `<script>` tags as
  `JSON.parse('...')` with `\xNN` hex escapes → extract via regex on the
  var name, decode escapes, `JSON.parse`.
- Player fields: `id, player_name, games, time(minutes), goals, xG, assists,
  xA, shots, key_passes, npg, npxG, xGChain, xGBuildup, position(s),
  team_title`. All numerics as strings (law #3). Team names are long-form
  ("Manchester United") — team mapping table seeded once (20 rows).
- Shot fields: `minute, result (Goal|MissedShots|SavedShot|BlockedShot|
  ShotOnPost|OwnGoal), X, Y (0–1 coords), xG, player_id, situation
  (OpenPlay|FromCorner|SetPiece|DirectFreekick|Penalty), shotType,
  lastAction, h_a`.
- Understat player ids are stable across seasons → identities pre-seeded
  from the vaastav linkage (§1.5.2).
- Cadence: one league-page pull per match day+1 (that's ONE request), match
  pages only for fixtures we track — total load is trivial; sleep ≥3 s
  between requests, honest UA, obey robots.txt at build-time review; any
  layout change → `SCHEMA_DRIFT` quarantine and automatic fallback to FPL's
  own xG fields (already specified, engines plan §4.16).

---
---

# Part 3 — Provider pairing strategy (what to actually enable)

The verified tier realities reshape the default recommendation in
`fpl-project.md` §4.2:

| Deployment | Enabled pair (max 2) | Rationale |
|---|---|---|
| **Free-only** | football-data.org + NewsData.io | API-Football free **cannot see the current season**; Sportmonks free has no EPL. On a £0 budget: FPL official (always-on anchor) carries players/prices/injury flags/xG; football-data.org adds fixture/results redundancy; NewsData feeds the AI. **No lineup provider** → minutes model runs statistical-only (engines plan §4.16 degraded mode, already designed). |
| **Recommended (~$29/mo)** | **API-Football Pro + NewsData.io** | Pro unlocks current season, injuries, measured-timing lineups, odds — the full engine feature set — inside one subscription; 7,500/day dwarfs our budget. |
| **Premium** | API-Football Pro + Sportmonks Standard | Adds sidelined periods w/ return dates, second lineup source, xG redundancy; news then rides the always-on slot? No — news must occupy an enabled slot, so this pairing sacrifices the news feed: **only choose it if the AI layer is disabled** or news moves to a paid NewsAPI slot via a config that swaps pairs on Run vs. background (admin decision, UI explains the trade-off). |

The admin UI's provider-switch screen must display this table (tier, cost,
what each pairing enables/disables) so the max-2 choice is informed, and the
capability router already handles any pairing gracefully (engines plan
§4.16 degraded modes).

Update to `fpl-project.md` §4.2 table applied alongside this document:
API-Football noted "free tier excludes current season"; Sportmonks noted
"EPL requires Standard+ (paid)"; NewsAPI.org noted "dev-only free tier,
24 h delay — alternate, not default".

---
---

# Part 4 — The verification probe protocol (build-time, per provider)

`scripts/probe/<provider>.ts` — runs before an adapter is enabled with a
real key, re-runs on demand from the admin panel, and its output fills
`docs/api-analysis/<provider>.md` + seeds `provider_entitlements` and
`pull_jobs`. Modeled on the probe discipline that produced the API-Football
findings (probe cost: a handful of requests).

Every probe MUST:
1. **Auth check** — one cheap call; verify quota headers present/absent and
   record their names.
2. **Entitlement walk** — for each endpoint the adapter uses: probe the
   current season, then walk backwards until success; record allowed
   (endpoint × season × league) into `provider_entitlements`. Never trust
   coverage/plan metadata (2.2).
3. **Shape capture** — save one real payload per endpoint into the contract-
   test fixtures directory (these become the recorded fixtures of §1.6).
4. **Error-shape capture** — deliberately trigger one 4xx (bad param) and,
   where safe, one plan denial; assert `assertOk` classifies both.
5. **Timing measurement** (lineup-capable providers) — around one real
   fixture, poll from T−120 to kickoff and record when lineups landed
   (validates/updates `LINEUP_LEAD_MINUTES`-style constants, which live in
   `model_config`).
6. **Volume check** — record payload sizes and per-sweep request counts;
   assert steady-state daily usage ≤ 60% of the tier's quota.
7. **VERIFY-AT-BUILD sweep** — each dossier item flagged above is asserted
   or corrected, and this document gets a dated addendum with the probe's
   findings.

Probe results are data (`provider_entitlements`, `pull_jobs`, fixtures,
constants) — so when a provider changes its plans or shapes, the response is
re-running a script, not re-reading memory.

---

*End of integration plan. Companion: `fpl-ai-engine-plan.md` for the AI
provider integrations.*
