#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# seed-e2e.sh — prepare an INSTALLED fpl-algorithm for the Playwright suite
# (e2e/): well-known test users, FPL data sync, mock AI provider alive.
# NEVER run against a production install — it creates public test credentials.
#
# Usage: [APP_DIR=/opt/fpl-algorithm] [APP_PORT=3080] bash scripts/seed-e2e.sh
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail
APP_DIR="${APP_DIR:-/opt/fpl-algorithm}"
APP_PORT="${APP_PORT:-3080}"
BASE="http://127.0.0.1:${APP_PORT}"
ADMIN_EMAIL="admin@fpl.test";  ADMIN_PW="admin-password-123"   # e2e/tests/helpers.ts
USER_EMAIL="user@fpl.test";    USER_PW="user-password-1234"

cd "${APP_DIR}/current/backend"

echo "── e2e admin (idempotent)"
ENV_FILE="${APP_DIR}/shared/.env" node dist/src/cli.js create-admin "${ADMIN_EMAIL}" "E2E Admin" "${ADMIN_PW}"

echo "── FPL data sync (players / teams / fixtures)"
ENV_FILE="${APP_DIR}/shared/.env" node dist/src/cli.js sync-fpl

echo "── historical import (engines need per-match stats to predict)"
ENV_FILE="${APP_DIR}/shared/.env" node dist/src/cli.js import-historical 2025-26

echo "── seed mock vision roster from the live player DB (names churn every season)"
ENV_FILE="${APP_DIR}/shared/.env" node --input-type=module -e "
const { db } = await import('${APP_DIR}/current/backend/dist/src/core/db.js');
const rows = await db('players as p')
  .join('teams as t', 't.uid', 'p.team_uid')
  .where('p.status', 'a')
  .select('p.web_name as name', 't.short_name as club', 'p.position', 'p.now_cost')
  .orderBy('p.now_cost', 'desc');
const need = { GK: 2, DEF: 5, MID: 5, FWD: 3 };
const perClub = {};
const picked = [];
for (const r of rows) {
  if ((need[r.position] ?? 0) <= 0) continue;
  if ((perClub[r.club] ?? 0) >= 3) continue;
  need[r.position] -= 1;
  perClub[r.club] = (perClub[r.club] ?? 0) + 1;
  picked.push(r);
}
if (picked.length !== 15) { console.error('could not pick a valid 15:', need); process.exit(1); }
// bench: 2nd GK + the 3 cheapest outfielders; captain/vice = the 2 priciest
const gks = picked.filter((p) => p.position === 'GK');
const outfield = picked.filter((p) => p.position !== 'GK').sort((a, b) => a.now_cost - b.now_cost);
const bench = new Map([[gks[1].name, 1], [outfield[0].name, 2], [outfield[1].name, 3], [outfield[2].name, 4]]);
const byPrice = [...picked].sort((a, b) => b.now_cost - a.now_cost).filter((p) => !bench.has(p.name));
const roster = picked.map((p) => ({
  name: p.name, club: p.club, price: p.now_cost / 10,
  captain: p.name === byPrice[0].name, vice: p.name === byPrice[1].name,
  bench_position: bench.get(p.name) ?? null,
}));
await db('ai_providers').where({ key: 'mock' }).update({ config: JSON.stringify({ roster }) });
console.log('   roster seeded:', roster.length, 'players,', Object.keys(perClub).length, 'clubs');
await db.destroy();
"

echo "── e2e user + tokens + mock AI provider (via admin API)"
JAR="$(mktemp)"
trap 'rm -f "${JAR}"' EXIT
curl -sf -c "${JAR}" -X POST "${BASE}/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PW}\"}" >/dev/null
HDR=(-b "${JAR}" -H 'Content-Type: application/json' -H 'x-requested-with: fpl-frontend')

CODE="$(curl -s -o /dev/null -w '%{http_code}' "${HDR[@]}" -X POST "${BASE}/api/admin/users" \
  -d "{\"email\":\"${USER_EMAIL}\",\"name\":\"E2E User\",\"password\":\"${USER_PW}\",\"role\":\"user\",\"initialTokens\":1000}")"
case "${CODE}" in
  200) echo "   user created" ;;
  409) echo "   user already exists — untouched" ;;
  *)   echo "   create user FAILED (HTTP ${CODE})"; exit 1 ;;
esac

BODY="$(curl -s "${HDR[@]}" -X POST -d '{}' "${BASE}/api/admin/ai-providers/mock/activate")"
case "${BODY}" in
  *'"ok":true'*) echo "   mock AI provider alive" ;;
  *) echo "   mock activation FAILED: ${BODY}"; exit 1 ;;
esac

echo ""
echo "seeded for e2e: ${ADMIN_EMAIL} / ${ADMIN_PW} · ${USER_EMAIL} / ${USER_PW}"
echo "run the suite:  cd e2e && E2E_BASE_URL=${BASE} npx playwright test"
