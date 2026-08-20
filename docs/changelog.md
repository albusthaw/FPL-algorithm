# Changelog

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
