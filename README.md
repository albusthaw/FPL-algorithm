# FPL Algorithm

A self-hosted Fantasy Premier League decision engine: statistical engine
built from scratch (Dixon-Coles, minutes model, xPts composer), match
engine, squad optimiser, and a human-gated AI news layer — behind a
login-gated, token-metered, fully responsive web app.

## Install (from the release zip)

```bash
unzip i.zip -d fpl && cd fpl
sudo bash install.sh          # idempotent; prints the one-time admin credential
```

Upgrade an existing install: `sudo bash upgrade.sh` (9-step, verified backup,
auto-restore on failure; `--rollback` to revert). Reinstall: `reinstall.sh`
(parks the DB by default; `--purge` requires a typed confirmation).

## Development

```bash
cd backend && npm install && npx tsx src/cli.ts migrate
npx tsx src/cli.ts sync-fpl && npx tsx src/cli.ts import-historical 2025-26
npx tsx src/cli.ts create-admin you@example.com Admin your-password
npm run dev                    # backend on :3080
cd ../frontend && npm install && npm run dev   # Vite on :5173, proxied
```

Tests: `cd backend && npm test` · E2E: `cd e2e && npx playwright test`
Release: `bash scripts/build-release.sh` → `dist-release/i.zip`

Read `CLAUDE.md` before contributing — Rule #1 (upgrade discipline and zip
repacking) is load-bearing.
