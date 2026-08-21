# Changelog

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
