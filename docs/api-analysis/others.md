# API analysis — Sportmonks · football-data.org · TheSportsDB · Understat

## Sportmonks v3 (paid-only for EPL)
Base `api.sportmonks.com/v3/football` (verified upstream; the docs page's
`/api/v3` 404s). Free plan has NO EPL → adapter ships disabled; plumbing
exercised via recorded fixtures. THE trap (contract-tested): in include
lists the row `id` is the RELATION id — always read `player_id`/`team_id`.
Rate model: 3,000/entity/hour, per-entity buckets from the in-band
`rate_limit` object. `sidelined` maps 1:1 onto our period-based injuries.

## football-data.org v4 (free fixtures fallback)
`X-Auth-Token`, 10 req/min. Role: fixtures/results cross-check ONLY — the
adapter flags score disagreements, never overwrites S1. Trap encoded:
`matchday` ≠ FPL gameweek after postponements; fixtures map by
kickoff-window + team pair.

## TheSportsDB (media only)
Badges/photos; everything strings; may serve HTML on rate-limit (treated
RATE_LIMITED). Never a stats or availability source. Free demo key '3' for
dev; Patreon key for production (~100/min advised, hard 2 req/s).

## Understat (scraper — ships disabled)
Hex-escaped `JSON.parse` extraction verified in unit tests; any layout
change → SCHEMA_DRIFT quarantine + automatic fallback to FPL xG fields.
Enable only after robots/ToS review on the target deployment.
