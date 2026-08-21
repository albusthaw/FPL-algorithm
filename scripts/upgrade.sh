#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# upgrade.sh — the EXACT 9-step sequence (howupgradeshouldwork-1.md §5):
#   1 preflight (refuse schema downgrade)   2 VERIFIED pg_dump backup
#   3 stage side-by-side                    4 npm ci in the staged release
#   5 stop service                          6 migrate FROM THE STAGED RELEASE
#   7 atomic symlink flip                   8 start                9 health check
# Any failure in 6–9 auto-restores (drop-all-then-restore into an empty
# schema, symlink back, start, health-check). --rollback flips back + restores
# the latest dump. At least one previous release always kept on disk.
# ═══════════════════════════════════════════════════════════════════════════
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

# fail fast on the wrong box — before any verification chatter
[ -L "${APP_DIR}/current" ] || { console "no existing install at ${APP_DIR} — use install.sh"; exit 2; }

DB_PASSWORD="$(read_env_var DB_PASSWORD "${APP_DIR}/shared/.env")"
export PGPASSWORD="${DB_PASSWORD}"
PGARGS=(-h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}")

# ── prerequisites + firewall: VERIFY only — an upgrade never installs
# packages or changes firewall rules; it fails fast if the box is broken.
run_step "prerequisites (verify: node ${NODE_MIN_MAJOR}+, postgres, tools)" ensure_prerequisites verify
run_step "firewall (verify)" setup_firewall verify

# ── detect the installed site + credentials — upgrades NEVER change either.
# Snapshot both so the end of the run can PROVE they are untouched.
detect_site_domain
SITE_BEFORE="${SITE_DOMAIN}"
cred_hash() { sha256sum "${CRED_FILE}" 2>/dev/null | cut -d' ' -f1 || true; }
CRED_HASH_BEFORE="$(cred_hash)"

assert_site_and_creds_unchanged() {
  local site_after cred_after
  site_after="$(read_env_var SITE_DOMAIN "${APP_DIR}/shared/.env")"
  cred_after="$(cred_hash)"
  if [ "${site_after}" != "${SITE_BEFORE}" ]; then
    echo "GUARD TRIPPED: SITE_DOMAIN changed '${SITE_BEFORE}' → '${site_after}' during upgrade"
    return 1
  fi
  if [ "${cred_after}" != "${CRED_HASH_BEFORE}" ]; then
    echo "GUARD TRIPPED: ${CRED_FILE} changed during upgrade"
    return 1
  fi
  # nginx server block (when present) must still carry the installed domain
  if [ -n "${SITE_BEFORE}" ]; then
    local conf
    for conf in "/etc/nginx/sites-available/${APP_NAME}.conf" "/etc/nginx/conf.d/${APP_NAME}.conf"; do
      if [ -f "${conf}" ] && ! grep -q "server_name ${SITE_BEFORE};" "${conf}"; then
        echo "WARNING: ${conf} no longer names ${SITE_BEFORE} — not touching it (upgrades never modify the site)"
      fi
    done
  fi
  echo "site + credentials verified unchanged (site: ${SITE_BEFORE:-not configured}; creds: ${CRED_HASH_BEFORE:-no file})"
}

restore_db_from() { # restore_db_from DUMP — nuke-then-restore (§5: the only restore that always works)
  local dump="$1"
  echo "restoring database from ${dump} (drop-all first)"
  psql "${PGARGS[@]}" -v ON_ERROR_STOP=1 <<'SQLEOF'
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
    EXECUTE 'DROP TABLE IF EXISTS public.' || quote_ident(r.tablename) || ' CASCADE';
  END LOOP;
  FOR r IN SELECT sequencename FROM pg_sequences WHERE schemaname='public' LOOP
    EXECUTE 'DROP SEQUENCE IF EXISTS public.' || quote_ident(r.sequencename) || ' CASCADE';
  END LOOP;
  FOR r IN SELECT viewname FROM pg_views WHERE schemaname='public' LOOP
    EXECUTE 'DROP VIEW IF EXISTS public.' || quote_ident(r.viewname) || ' CASCADE';
  END LOOP;
END $$;
SQLEOF
  pg_restore --no-owner --role="${DB_USER}" "${PGARGS[@]}" "${dump}"
}

current_version() {
  [ -L "${APP_DIR}/current" ] && json_field "${APP_DIR}/current/version.json" version || echo "none"
}

latest_backup() { ls -1dt "${APP_DIR}/backups"/*/dump.sqlc 2>/dev/null | head -1 || true; }

previous_release_dir() { # newest release dir that is not the current target
  local skip="$1"
  ls -1dt "${APP_DIR}/releases"/*/ 2>/dev/null | sed 's:/$::' | while read -r d; do
    [ "$(basename "$d")" != "${skip}" ] && { echo "$d"; break; }
  done
}

# ── --rollback ───────────────────────────────────────────────────────────────
if [ "${1:-}" = "--rollback" ]; then
  CURR="$(current_version)"
  PREV_DIR="$(previous_release_dir "${CURR}")"
  DUMP="$(latest_backup)"
  [ -z "${PREV_DIR}" ] && { console "no previous release on disk — cannot roll back"; exit 2; }
  [ -z "${DUMP}" ] && { console "no backup dump found — cannot roll back"; exit 2; }
  PREV_VERSION="$(json_field "${PREV_DIR}/version.json" version)"
  console ""
  console "  Rolling back ${CURR} → ${PREV_VERSION} (restore: ${DUMP})"
  run_step "stop service" service_stop
  run_step "restore database" restore_db_from "${DUMP}"
  do_flip() { ln -sfn "${PREV_DIR}" "${APP_DIR}/current.tmp.$$"; mv -T "${APP_DIR}/current.tmp.$$" "${APP_DIR}/current"; }
  run_step "flip current → ${PREV_VERSION}" do_flip
  run_step "start service" service_start
  run_step "health check (v${PREV_VERSION})" health_check "${PREV_VERSION}"
  run_step "verify site + credentials unchanged" assert_site_and_creds_unchanged
  summary_box "ROLLED BACK to v${PREV_VERSION}" \
    "site:  $(site_url) (unchanged)" \
    "database restored from:" \
    "  $(basename "$(dirname "${DUMP}")")/dump.sqlc"
  show_signin_block "Rollback restored the database from the pre-upgrade dump — sign-in unchanged."
  exit 0
fi

# ── 1. preflight ─────────────────────────────────────────────────────────────
PAYLOAD="${1:-}"
[ "${PAYLOAD}" = "--from-payload" ] && PAYLOAD="${2:-}"
[ -z "${PAYLOAD}" ] && PAYLOAD="$(find_payload)"
[ -z "${PAYLOAD}" ] && [ -d "${SCRIPT_DIR}/payload" ] && PAYLOAD="${SCRIPT_DIR}/payload"
if [ -z "${PAYLOAD}" ] || [ ! -f "${PAYLOAD}/version.json" ]; then
  console "no payload found — run from the release zip"
  exit 2
fi

NEW_VERSION="$(json_field "${PAYLOAD}/version.json" version)"
NEW_SCHEMA="$(json_field "${PAYLOAD}/version.json" schema)"
OLD_VERSION="$(current_version)"
OLD_SCHEMA="$(json_field "${APP_DIR}/current/version.json" schema)"

console ""
console "  Upgrading ${APP_NAME}: v${OLD_VERSION} (schema ${OLD_SCHEMA}) → v${NEW_VERSION} (schema ${NEW_SCHEMA})"
console "  Installed site: ${SITE_BEFORE:-not configured} ${C_DIM}(detected — upgrades never change the site)${C_OFF}"
console ""

preflight() {
  require_node
  if [ "${NEW_SCHEMA}" -lt "${OLD_SCHEMA}" ]; then
    echo "REFUSED: new schema ${NEW_SCHEMA} < installed schema ${OLD_SCHEMA} (downgrade)"
    console "  ${C_RED}refusing to 'upgrade' to an older schema (${NEW_SCHEMA} < ${OLD_SCHEMA}) — use --rollback${C_OFF}"
    exit 78
  fi
  if [ "${NEW_VERSION}" = "${OLD_VERSION}" ]; then
    console "  already at v${NEW_VERSION} — nothing to do"
    exit 0
  fi
}
run_step "preflight (schema ${OLD_SCHEMA} → ${NEW_SCHEMA})" preflight

# ── 2. VERIFIED backup — an unverified backup is a wish, not a backup ───────
BACKUP_DIR="${APP_DIR}/backups/${TIMESTAMP}"
DUMP="${BACKUP_DIR}/dump.sqlc"
backup() {
  mkdir -p "${BACKUP_DIR}"
  pg_dump -Fc "${PGARGS[@]}" -f "${DUMP}"
  pg_restore --list "${DUMP}" >/dev/null # verify the dump is readable
  echo "backup verified: $(du -h "${DUMP}" | cut -f1)"
}
run_step "backup + verify (pg_dump -Fc → pg_restore --list)" backup

# ── 3. stage side-by-side (old release untouched, service still up) ─────────
STAGED="${APP_DIR}/releases/${NEW_VERSION}"
stage() {
  rm -rf "${STAGED}"
  mkdir -p "${STAGED}"
  cp -a "${PAYLOAD}/backend" "${STAGED}/backend"
  cp -a "${PAYLOAD}/frontend" "${STAGED}/frontend"
  cp -a "${PAYLOAD}/version.json" "${STAGED}/version.json"
}
run_step "stage releases/${NEW_VERSION} side-by-side" stage

# ── 4. npm ci in the staged release (zero downtime if this fails) ───────────
staged_npm_ci() { cd "${STAGED}/backend" && npm ci --omit=dev --no-audit --no-fund; }
run_step "npm ci in the staged release" staged_npm_ci

# ── failure in 6–9 → automatic restore to where we began ────────────────────
OLD_RELEASE_DIR="$(readlink -f "${APP_DIR}/current")"
on_failure_restore() {
  console "  ${C_YELLOW}auto-restore: returning to v${OLD_VERSION}…${C_OFF}"
  service_stop || true
  restore_db_from "${DUMP}" || return 1
  ln -sfn "${OLD_RELEASE_DIR}" "${APP_DIR}/current.tmp.$$" && mv -T "${APP_DIR}/current.tmp.$$" "${APP_DIR}/current"
  service_start || return 1
  health_check "${OLD_VERSION}" 30 || return 1
  console "  ${C_GREEN}auto-restore complete — you are back on v${OLD_VERSION}${C_OFF}"
}

# ── 5. stop service (downtime starts AFTER everything failure-prone offline) ─
run_step "stop service (downtime begins)" service_stop

# ── 6. migrate FROM THE STAGED RELEASE (new code's migrations, old symlink) ──
migrate_staged() {
  cd "${STAGED}/backend"
  ENV_FILE="${APP_DIR}/shared/.env" node dist/src/cli.js migrate
}
run_step "migrate from the staged release" migrate_staged

# ── 7. atomic symlink flip ───────────────────────────────────────────────────
flip() {
  ln -sfn "${STAGED}" "${APP_DIR}/current.tmp.$$"
  mv -T "${APP_DIR}/current.tmp.$$" "${APP_DIR}/current"
}
run_step "flip current → releases/${NEW_VERSION} (atomic)" flip

# ── 8. start ─────────────────────────────────────────────────────────────────
run_step "start service" service_start

# ── 9. health check requiring the NEW version ────────────────────────────────
run_step "health check (v${NEW_VERSION})" health_check "${NEW_VERSION}"

# keep at least one previous release; prune older ones beyond the last 3
prune() {
  ls -1dt "${APP_DIR}/releases"/*/ 2>/dev/null | tail -n +4 | while read -r d; do
    [ "$(readlink -f "$d")" != "$(readlink -f "${APP_DIR}/current")" ] && rm -rf "$d" && echo "pruned old release $(basename "$d")"
  done || true
}
run_step "prune old releases (keep 3)" prune

# the guard: prove the installed site and sign-in credentials are untouched
run_step "verify site + credentials unchanged" assert_site_and_creds_unchanged

trap - ERR
summary_box "UPGRADED ${APP_NAME} v${OLD_VERSION} → v${NEW_VERSION}" \
  "site:    $(site_url) (unchanged)" \
  "schema:  ${OLD_SCHEMA} → ${NEW_SCHEMA}" \
  "backup:  backups/${TIMESTAMP}/dump.sqlc (verified)" \
  "rollback: bash upgrade.sh --rollback"
show_signin_block "Unchanged by this upgrade — upgrade.sh never modifies users or the site."
console ""
