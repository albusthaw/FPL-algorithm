# API analysis — API-Football v3 (api-sports.io)

**Status:** adapter + probe shipped; awaiting a real key on the target
deployment (this build environment has none). Dossier facts inherited from
`fpl-api-integration-plan.md` §2.2 (live-probed Aug 2026 upstream).
Go/no-go: **GO on Pro tier only** — free tier cannot see the current season.

## 1. Auth & quota
Direct mode only: `x-apisports-key` @ `v3.football.api-sports.io`.
Free: 100/day, ~10/min, past-seasons window. Pro: 7,500/day, 300/min.
Quota headers persisted (all four); daily counter treated as advisory
(observed non-monotonic upstream).

## 2. Endpoint map
`/fixtures?league=39&season=Y` (one response, unpaginated),
`/fixtures/lineups` (lands T−29…T−18; EMPTY_OK before), `/injuries`
(fixture-scoped), `/odds` (strings!), `/teams` (id seed).

## 3. THE trap (encoded in assertOk, contract-tested)
Errors arrive INSIDE HTTP 200. Error iff `errors` non-empty; empty
`response` + empty `errors` = EMPTY_OK. Coverage flags ≠ entitlement —
entitlement is learned from PLAN_DENIED into `provider_entitlements`.

## 4. ID mapping
Stable integer ids → `player_identities(provider='api_football')`. Lineup
slots resolve via id, never abbreviated names; null-id slots dropped.
Team ids seeded by `seedTeamMap()` (20 rows, name-verified).

## 5. Cost model
Season backfill ≈ 761 req; steady state (2 injury pulls + lineup bursts +
odds) ≈ 60–120/day — trivial on Pro, impossible on free for live use.

**Probe:** `scripts/probe/api-football.ts` — run before enabling with a key.
