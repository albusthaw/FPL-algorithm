# API analysis — FPL Official API (anchor, always on)

**Probed at build:** 2026-08-20, from this deployment host. Go/no-go: **GO**.

## 1. Auth & quota
Keyless, no documented limit. Politeness discipline applies: bootstrap ≤ every
15 min, element-summary sequential ≤5 rps, never ×700 fan-out.

## 2. Endpoint map (verified live)
| Endpoint | Size | Notes |
|---|---|---|
| `bootstrap-static/` | 1.58 MB | 599 elements, 20 teams, 38 events, chips[] shows the 26/27 two-set system |
| `fixtures/` | ~400 KB | 380 fixtures, `event:null` = unscheduled |
| `element-summary/{id}/` | ~30 KB | history (current season) + history_past |
| `event/{gw}/live/` | — | points decomposition (used by the truth pass) |

## 3. Data quality probe
- Bootstrap parsed cleanly against our zod schema (`.passthrough()` for
  additions; hard-fail on missing knowns). 109 keys per element observed.
- 2026/27 season live: GW1 deadline 2026-08-21T17:30Z; `defensive_contribution`
  family present; `birth_date` and `squad_number` present (new since the plan
  was written — now consumed by the resolver).
- Points arithmetic: `pointsFromStats()` reproduced official totals on
  **16,923/16,923** historical rows (100.00%).

## 4. ID mapping
`element.code` → `players.fpl_code` (UNIQUE), `element.id` per-season only.
Zero collisions on 599 players. Teams map by stable `team.code`.

## 5. Failure modes seen/handled
- UA filtering & datacenter-IP blocking are the top deployment risks:
  UA string is config (`FPL_USER_AGENT`), `FPL_EGRESS_PROXY` documented.
- GW rollover maintenance → classified `MAINTENANCE`, 15-min retries.
- CDN staleness → harmless under as_of-guarded upserts.

## 6. Cost model
Baseline cadence ≈ 4 bootstrap + 1 fixtures + lazy summaries per day ≈
trivially under any polite ceiling. Post-GW sweep: 599 summaries at ≤5 rps
≈ 2 min, once per GW.

**Polling schedule:** engines-plan §1.5 defaults, encoded in the scheduler.
