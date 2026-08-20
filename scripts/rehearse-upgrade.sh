#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# rehearse-upgrade.sh — the ship-procedure rehearsal (upgrade doc §8 step 5):
# install the PREVIOUS zip into an isolated prefix + test database, run the
# NEW zip's upgrade.sh against it, verify (migrations applied, symlink
# flipped, version endpoint reports the new version with dbAhead:false),
# rehearse --rollback when the release has a migration, then clean up.
#
# Usage: bash scripts/rehearse-upgrade.sh <prev.zip> <new.zip>
#        (with one argument, rehearses install+reinstall of that zip only)
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail
PREV_ZIP="${1:?usage: rehearse-upgrade.sh <prev.zip> [new.zip]}"
NEW_ZIP="${2:-}"

REHEARSAL_ROOT="$(mktemp -d /tmp/fpl-rehearsal-XXXXXX)"
export APP_DIR="${REHEARSAL_ROOT}/opt"
export DB_NAME_OVERRIDE="fpl_rehearsal_$$"
export APP_PORT="$((3200 + RANDOM % 500))"
export LOG_DIR="${REHEARSAL_ROOT}/logs"
export NO_SYSTEMD=true
export ADMIN_EMAIL="rehearsal@localhost"

cleanup() {
  echo "── cleaning up rehearsal prefix + database"
  pkill -f "${APP_DIR}/current/backend/dist/src/server.js" 2>/dev/null || true
  sleep 1
  if command -v sudo >/dev/null 2>&1 && sudo -n -u postgres true 2>/dev/null; then
    sudo -u postgres psql -c "DROP DATABASE IF EXISTS ${DB_NAME_OVERRIDE}" >/dev/null 2>&1 || true
    sudo -u postgres psql -c "SELECT format('DROP DATABASE %I', datname) FROM pg_database WHERE datname LIKE '${DB_NAME_OVERRIDE}_parked%'" -tA 2>/dev/null | while read -r stmt; do
      sudo -u postgres psql -c "${stmt}" >/dev/null 2>&1 || true
    done
  fi
  rm -rf "${REHEARSAL_ROOT}"
}
trap cleanup EXIT

api() { curl -sf --max-time 5 "http://127.0.0.1:${APP_PORT}$1"; }

echo "═══ REHEARSAL in ${REHEARSAL_ROOT} (db ${DB_NAME_OVERRIDE}, port ${APP_PORT}) ═══"

echo ""
echo "── 1. install previous zip"
PREV_DIR="${REHEARSAL_ROOT}/prev"
mkdir -p "${PREV_DIR}"
unzip -q "${PREV_ZIP}" -d "${PREV_DIR}"
bash "${PREV_DIR}/install.sh"
PREV_VERSION="$(api /api/health | grep -o '"version":"[^"]*"' | cut -d'"' -f4)"
echo "   installed: v${PREV_VERSION}"

echo ""
echo "── 2. seed a marker row (user data must survive the upgrade)"
MARKER="rehearsal-marker-$$"
DB_PASSWORD_VALUE="$(grep '^DB_PASSWORD=' "${APP_DIR}/shared/.env" | cut -d= -f2)"
PGPASSWORD="${DB_PASSWORD_VALUE}" psql -h 127.0.0.1 -U fpl -d "${DB_NAME_OVERRIDE}" -c \
  "INSERT INTO feature_states (name, enabled, manifest) VALUES ('${MARKER}', true, '{}') ON CONFLICT DO NOTHING" >/dev/null

if [ -n "${NEW_ZIP}" ]; then
  echo ""
  echo "── 3. upgrade with the new zip"
  NEW_DIR="${REHEARSAL_ROOT}/new"
  mkdir -p "${NEW_DIR}"
  unzip -q "${NEW_ZIP}" -d "${NEW_DIR}"
  bash "${NEW_DIR}/upgrade.sh"

  echo ""
  echo "── 4. verify"
  INFO="$(api /api/system/info)"
  NEW_VERSION="$(node -e "process.stdout.write(JSON.parse(process.argv[1]).app.version)" "${INFO}")"
  DB_AHEAD="$(node -e "process.stdout.write(String(JSON.parse(process.argv[1]).migration.dbAhead))" "${INFO}")"
  PENDING="$(node -e "process.stdout.write(String(JSON.parse(process.argv[1]).migration.pending))" "${INFO}")"
  echo "   version: ${NEW_VERSION} · dbAhead: ${DB_AHEAD} · pending: ${PENDING}"
  [ "${DB_AHEAD}" = "false" ] || { echo "FAIL: dbAhead"; exit 1; }
  [ "${PENDING}" = "0" ] || { echo "FAIL: pending migrations"; exit 1; }
  [ "$(readlink -f "${APP_DIR}/current")" = "$(readlink -f "${APP_DIR}/releases/${NEW_VERSION}")" ] || { echo "FAIL: symlink"; exit 1; }
  MARKER_OK="$(PGPASSWORD="${DB_PASSWORD_VALUE}" psql -h 127.0.0.1 -U fpl -d "${DB_NAME_OVERRIDE}" -tAc "SELECT count(*) FROM feature_states WHERE name='${MARKER}'")"
  [ "${MARKER_OK}" = "1" ] || { echo "FAIL: user data lost in upgrade"; exit 1; }
  echo "   user data survived ✓ · symlink flipped ✓"

  PREV_SCHEMA="$(node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('${PREV_DIR}/payload/version.json','utf8')).schema))")"
  NEW_SCHEMA="$(node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('${NEW_DIR}/payload/version.json','utf8')).schema))")"
  if [ "${NEW_SCHEMA}" -gt "${PREV_SCHEMA}" ]; then
    echo ""
    echo "── 5. release contains a migration → rehearse --rollback"
    bash "${NEW_DIR}/upgrade.sh" --rollback
    ROLLED="$(api /api/health | grep -o '"version":"[^"]*"' | cut -d'"' -f4)"
    [ "${ROLLED}" = "${PREV_VERSION}" ] || { echo "FAIL: rollback version ${ROLLED} != ${PREV_VERSION}"; exit 1; }
    echo "   rolled back to v${ROLLED} ✓"
    echo ""
    echo "── 6. upgrade again (post-rollback re-upgrade must work)"
    bash "${NEW_DIR}/upgrade.sh"
    FINAL="$(api /api/health | grep -o '"version":"[^"]*"' | cut -d'"' -f4)"
    [ "${FINAL}" = "${NEW_VERSION}" ] || { echo "FAIL: re-upgrade"; exit 1; }
    echo "   re-upgraded to v${FINAL} ✓"
  else
    echo "── 5. no migration in this release — rollback rehearsal not required"
  fi
else
  echo ""
  echo "── 3. idempotency: run install.sh a second time (must not fail)"
  bash "${PREV_DIR}/install.sh"
  echo "   second install ok ✓"
fi

echo ""
echo "═══ REHEARSAL PASSED ═══"
