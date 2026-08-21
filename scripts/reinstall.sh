#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# reinstall.sh — fresh-install semantics over an existing box with EXPLICIT,
# loudly-confirmed handling of existing data (fpl-project.md §13):
#   default   : PARK the database (rename), keep shared/ — nothing destroyed
#   --purge   : destroy DB + shared/ — requires typing a confirmation phrase
# Never silently destroys anything.
# ═══════════════════════════════════════════════════════════════════════════
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

PURGE=false
[ "${1:-}" = "--purge" ] && PURGE=true

# prerequisites first — reinstall touches the database (park/purge) before
# delegating to install.sh, so psql must exist even on a stripped box
run_step "prerequisites (install if missing)" ensure_prerequisites install

console ""
if [ "${PURGE}" = "true" ]; then
  console "  ${C_RED}REINSTALL --purge will PERMANENTLY DESTROY:${C_OFF}"
  console "    · database ${DB_NAME} (all users, teams, runs, history)"
  console "    · ${APP_DIR}/shared (uploads, .env, secrets)"
  console ""
  PHRASE="destroy ${APP_NAME} data"
  printf '  Type exactly "%s" to continue: ' "${PHRASE}" >&3
  read -r answer <&0 || answer=""
  if [ "${answer}" != "${PHRASE}" ]; then
    console "  phrase mismatch — nothing was touched."
    exit 1
  fi
  purge_all() {
    service_stop
    if psql_super -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1; then
      psql_super -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${DB_NAME}' AND pid <> pg_backend_pid()" >/dev/null
      psql_super -c "DROP DATABASE \"${DB_NAME}\""
    fi
    rm -rf "${APP_DIR}/shared"
  }
  run_step "purge database + shared/" purge_all
else
  console "  Reinstall (safe mode): the existing database will be PARKED"
  console "  (renamed ${DB_NAME}_parked_${TIMESTAMP}) and shared/ kept."
  console "  A NEW admin + credentials file will be created for the fresh"
  console "  database and shown at the end. The site domain keeps its"
  console "  configured value by default (you'll be asked)."
  console "  Use --purge for a destructive wipe (typed confirmation required)."
  run_step "stop service" service_stop
fi

# park-or-fresh is handled by install.sh through FRESH_DB
export FRESH_DB=true
export DB_PASSWORD="${DB_PASSWORD:-}"
console ""
[ "${1:-}" = "--purge" ] && shift
bash "${SCRIPT_DIR}/install.sh" "$@" >&3 2>&3
