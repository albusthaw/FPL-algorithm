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
# isolated role too — reusing the production role name would let install.sh
# reset the real role's password from inside a rehearsal
export DB_USER_OVERRIDE="fpl_rhrsl_$$"
export APP_PORT="$((3200 + RANDOM % 500))"
export LOG_DIR="${REHEARSAL_ROOT}/logs"
export NO_SYSTEMD=true
export NO_NGINX=true
export PROVISION=false   # rehearsals never install packages
export NO_FIREWALL=true  # …or touch the firewall
# must be a zod-valid email — the rehearsal logs in with it via /api/auth/login
export ADMIN_EMAIL="rehearsal@example.test"

cleanup() {
  echo "── cleaning up rehearsal prefix + database"
  pkill -f "${APP_DIR}/current/backend/dist/src/server.js" 2>/dev/null || true
  sleep 1
  if command -v sudo >/dev/null 2>&1 && sudo -n -u postgres true 2>/dev/null; then
    sudo -u postgres psql -c "DROP DATABASE IF EXISTS ${DB_NAME_OVERRIDE}" >/dev/null 2>&1 || true
    sudo -u postgres psql -c "SELECT format('DROP DATABASE %I', datname) FROM pg_database WHERE datname LIKE '${DB_NAME_OVERRIDE}_parked%'" -tA 2>/dev/null | while read -r stmt; do
      sudo -u postgres psql -c "${stmt}" >/dev/null 2>&1 || true
    done
    sudo -u postgres psql -c "DROP ROLE IF EXISTS ${DB_USER_OVERRIDE}" >/dev/null 2>&1 || true
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
echo "── 2. seed markers (user data + site + credentials must survive the upgrade)"
MARKER="rehearsal-marker-$$"
# X1 (v1.4.1): admin-entered API keys must survive the upgrade env-merge —
# plant a synthetic key and assert it after the flip. Replace the installer's
# empty NEWSDATA_KEY= line in place (appending would create a duplicate key).
KEY_MARKER="rehearsal-key-${$}-abcd"
if grep -q '^NEWSDATA_KEY=' "${APP_DIR}/shared/.env"; then
  sed -i "s|^NEWSDATA_KEY=.*|NEWSDATA_KEY=${KEY_MARKER}|" "${APP_DIR}/shared/.env"
else
  echo "NEWSDATA_KEY=${KEY_MARKER}" >> "${APP_DIR}/shared/.env"
fi
[ "$(grep '^NEWSDATA_KEY=' "${APP_DIR}/shared/.env" | tail -1 | cut -d= -f2)" = "${KEY_MARKER}" ] || { echo "FAIL: could not seed the key marker"; exit 1; }
DB_PASSWORD_VALUE="$(grep '^DB_PASSWORD=' "${APP_DIR}/shared/.env" | cut -d= -f2)"
PGPASSWORD="${DB_PASSWORD_VALUE}" psql -h 127.0.0.1 -U "${DB_USER_OVERRIDE}" -d "${DB_NAME_OVERRIDE}" -c \
  "INSERT INTO feature_states (name, enabled, manifest) VALUES ('${MARKER}', true, '{}') ON CONFLICT DO NOTHING" >/dev/null

CRED_PATH="${APP_DIR}/shared/credentials.txt"

if [ -n "${NEW_ZIP}" ]; then
  # site + credentials markers: a pre-1.0.2 previous release has neither —
  # inject synthetic ones so the preservation guard is exercised for real
  if ! grep -q '^SITE_DOMAIN=' "${APP_DIR}/shared/.env"; then
    echo "SITE_DOMAIN=rehearsal-site.example.test" >> "${APP_DIR}/shared/.env"
    echo "   injected synthetic SITE_DOMAIN (previous release predates it)"
  fi
  if [ ! -f "${CRED_PATH}" ]; then
    printf 'admin email:    rehearsal@localhost\nadmin password: marker-password-%s\n' "$$" > "${CRED_PATH}"
    chmod 600 "${CRED_PATH}"
    echo "   injected synthetic credentials file"
  fi
  SITE_BEFORE_UPGRADE="$(grep '^SITE_DOMAIN=' "${APP_DIR}/shared/.env" | cut -d= -f2)"
  CRED_HASH_BEFORE_UPGRADE="$(sha256sum "${CRED_PATH}" | cut -d' ' -f1)"

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
  MARKER_OK="$(PGPASSWORD="${DB_PASSWORD_VALUE}" psql -h 127.0.0.1 -U "${DB_USER_OVERRIDE}" -d "${DB_NAME_OVERRIDE}" -tAc "SELECT count(*) FROM feature_states WHERE name='${MARKER}'")"
  [ "${MARKER_OK}" = "1" ] || { echo "FAIL: user data lost in upgrade"; exit 1; }
  SITE_AFTER_UPGRADE="$(grep '^SITE_DOMAIN=' "${APP_DIR}/shared/.env" | cut -d= -f2)"
  [ "${SITE_AFTER_UPGRADE}" = "${SITE_BEFORE_UPGRADE}" ] || { echo "FAIL: upgrade changed SITE_DOMAIN ${SITE_BEFORE_UPGRADE} → ${SITE_AFTER_UPGRADE}"; exit 1; }
  CRED_HASH_AFTER_UPGRADE="$(sha256sum "${CRED_PATH}" | cut -d' ' -f1)"
  [ "${CRED_HASH_AFTER_UPGRADE}" = "${CRED_HASH_BEFORE_UPGRADE}" ] || { echo "FAIL: upgrade changed the credentials file"; exit 1; }
  # X1 (v1.4.1): admin-entered keys survive the env-merge
  KEY_AFTER_UPGRADE="$(grep '^NEWSDATA_KEY=' "${APP_DIR}/shared/.env" | tail -1 | cut -d= -f2)"
  [ "${KEY_AFTER_UPGRADE}" = "${KEY_MARKER}" ] || { echo "FAIL: upgrade lost an admin-entered API key (${KEY_MARKER} → ${KEY_AFTER_UPGRADE})"; exit 1; }
  echo "   user data survived ✓ · symlink flipped ✓ · site unchanged (${SITE_AFTER_UPGRADE}) ✓ · credentials file unchanged ✓ · API key survived ✓"

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
  echo "── 3. fresh-install assertions: default domain, credentials file, working login"
  grep -q '^SITE_DOMAIN=fpl.minthantthaw.me$' "${APP_DIR}/shared/.env" || { echo "FAIL: default SITE_DOMAIN not written"; exit 1; }
  [ -f "${CRED_PATH}" ] || { echo "FAIL: credentials file not created"; exit 1; }
  ADMIN_EMAIL_SAVED="$(sed -n 's/^admin email:[[:space:]]*//p' "${CRED_PATH}")"
  ADMIN_PW_SAVED="$(sed -n 's/^admin password:[[:space:]]*//p' "${CRED_PATH}")"
  [ -n "${ADMIN_EMAIL_SAVED}" ] && [ -n "${ADMIN_PW_SAVED}" ] || { echo "FAIL: credentials file missing fields"; exit 1; }
  LOGIN_CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${APP_PORT}/api/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"${ADMIN_EMAIL_SAVED}\",\"password\":\"${ADMIN_PW_SAVED}\"}")"
  [ "${LOGIN_CODE}" = "200" ] || { echo "FAIL: saved credentials do not log in (HTTP ${LOGIN_CODE})"; exit 1; }
  echo "   default domain ✓ · credentials file ✓ · saved credentials log in ✓"

  echo ""
  echo "── 4. idempotency: run install.sh a second time (must not fail, creds unchanged)"
  CRED_HASH_1="$(sha256sum "${CRED_PATH}" | cut -d' ' -f1)"
  bash "${PREV_DIR}/install.sh"
  CRED_HASH_2="$(sha256sum "${CRED_PATH}" | cut -d' ' -f1)"
  [ "${CRED_HASH_1}" = "${CRED_HASH_2}" ] || { echo "FAIL: second install changed the credentials file"; exit 1; }
  echo "   second install ok ✓ · credentials unchanged ✓"
fi

echo ""
echo "═══ REHEARSAL PASSED ═══"
