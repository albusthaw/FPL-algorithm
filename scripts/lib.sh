#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# lib.sh — shared shell library for install.sh / upgrade.sh / reinstall.sh
# (howupgradeshouldwork-1.md §7): logging, spinner, error trap, summary box.
# Quiet console (steps + ok/fail); full transcript to a timestamped log.
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

# ── configuration (overridable for isolated-prefix rehearsals) ─────────────
APP_NAME="${APP_NAME:-fpl-algorithm}"
APP_DIR="${APP_DIR:-/opt/${APP_NAME}}"
DB_NAME="${DB_NAME_OVERRIDE:-${DB_NAME:-fpl_algorithm}}"
DB_USER="${DB_USER_OVERRIDE:-${DB_USER:-fpl}}"
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-5432}"
SERVICE_NAME="${SERVICE_NAME:-${APP_NAME}}"
APP_PORT="${APP_PORT:-3080}"
LOG_DIR="${LOG_DIR:-/var/log/${APP_NAME}}"
NODE_MIN_MAJOR=22
PG_PIN_MAJOR="${PG_PIN_MAJOR:-16}"
NO_SYSTEMD="${NO_SYSTEMD:-auto}"   # auto|true|false — rehearsals run without systemd

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "${LOG_DIR}" 2>/dev/null || LOG_DIR="${TMPDIR:-/tmp}/${APP_NAME}-logs" && mkdir -p "${LOG_DIR}"
LOG_FILE="${LOG_DIR}/$(basename "${0%.sh}")-${TIMESTAMP}.log"

# every command's full output goes to the log; the console stays quiet
exec 3>&1 # fd3 = the real console
exec >>"${LOG_FILE}" 2>&1

C_GREEN='\033[0;32m'; C_RED='\033[0;31m'; C_YELLOW='\033[0;33m'; C_DIM='\033[2m'; C_OFF='\033[0m'

console() { printf '%b\n' "$*" >&3; }
step()    { printf '%b' "  ${C_DIM}·${C_OFF} $*… " >&3; echo "── STEP: $*"; }
ok()      { printf '%b\n' "${C_GREEN}ok${C_OFF}" >&3; }
skip()    { printf '%b\n' "${C_YELLOW}skipped${C_OFF} ${1:+($1)}" >&3; }
fail()    { printf '%b\n' "${C_RED}FAILED${C_OFF}" >&3; }
warn_c()  { console "  ${C_YELLOW}⚠${C_OFF} $*"; echo "WARN: $*"; }

CURRENT_STEP=""
on_error() {
  local exit_code=$?
  fail || true
  console ""
  console "${C_RED}════════════════════════════════════════════════════════${C_OFF}"
  console "${C_RED}  $(basename "$0") FAILED${C_OFF} (exit ${exit_code})"
  [ -n "${CURRENT_STEP}" ] && console "  during: ${CURRENT_STEP}"
  console "  full transcript: ${LOG_FILE}"
  console "${C_RED}════════════════════════════════════════════════════════${C_OFF}"
  if declare -F on_failure_restore >/dev/null; then
    on_failure_restore || console "  ${C_RED}auto-restore ALSO failed — see the log${C_OFF}"
  fi
  exit "${exit_code}"
}
trap on_error ERR

run_step() { # run_step "label" cmd args...
  CURRENT_STEP="$1"; step "$1"; shift
  "$@"
  ok
  CURRENT_STEP=""
}

summary_box() { # summary_box "title" "line1" "line2"...
  local title="$1"; shift
  console ""
  console "  ┌──────────────────────────────────────────────────────────┐"
  printf '  │ %-56s │\n' "${title}" >&3
  console "  ├──────────────────────────────────────────────────────────┤"
  local line
  for line in "$@"; do printf '  │ %-56s │\n' "${line}" >&3; done
  printf '  │ %-56s │\n' "log: $(echo "${LOG_FILE}" | cut -c1-51)" >&3
  console "  └──────────────────────────────────────────────────────────┘"
}

# ── helpers ────────────────────────────────────────────────────────────────
have_systemd() {
  case "${NO_SYSTEMD}" in
    true) return 1 ;;
    false) return 0 ;;
    *) [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1 ;;
  esac
}

require_node() {
  command -v node >/dev/null 2>&1 || { console "${C_RED}node not found — install Node.js ${NODE_MIN_MAJOR}+${C_OFF}"; exit 1; }
  local major
  major="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
  if [ "${major}" -lt "${NODE_MIN_MAJOR}" ]; then
    console "${C_RED}Node ${major} found but this release requires >= ${NODE_MIN_MAJOR} (version drift guard)${C_OFF}"
    exit 1
  fi
}

require_postgres() {
  command -v psql >/dev/null 2>&1 || { console "${C_RED}psql not found — install PostgreSQL ${PG_PIN_MAJOR}${C_OFF}"; exit 1; }
}

# psql as the postgres superuser (peer auth via sudo when available)
psql_super() {
  if [ "$(id -un)" = "postgres" ]; then psql -v ON_ERROR_STOP=1 "$@"
  elif command -v sudo >/dev/null 2>&1 && sudo -n -u postgres true 2>/dev/null; then sudo -u postgres psql -v ON_ERROR_STOP=1 "$@"
  else PGPASSWORD="${SUPER_PGPASSWORD:-}" psql -v ON_ERROR_STOP=1 -h "${DB_HOST}" -p "${DB_PORT}" -U "${SUPER_PGUSER:-postgres}" "$@"
  fi
}

db_url() { echo "postgres://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"; }

read_env_var() { # read_env_var KEY FILE
  grep -E "^$1=" "$2" 2>/dev/null | head -1 | cut -d= -f2- || true
}

generate_secret() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

json_field() { # json_field FILE FIELD  — tiny extractor for version.json
  node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('$1','utf8'))['$2']))"
}

service_stop() {
  if have_systemd; then systemctl stop "${SERVICE_NAME}" 2>/dev/null || true
  else pkill -f "${APP_DIR}/current/backend/dist/src/server.js" 2>/dev/null || true; sleep 1
  fi
}

service_start() {
  if have_systemd; then
    systemctl start "${SERVICE_NAME}"
  else
    # absolute path: service_stop's pkill matches on it — a relative path
    # would leave the old server holding the port across an upgrade flip
    (ENV_FILE="${APP_DIR}/shared/.env" nohup node "${APP_DIR}/current/backend/dist/src/server.js" \
      >>"${APP_DIR}/shared/data/logs/server.log" 2>&1 &)
  fi
}

health_check() { # health_check EXPECTED_VERSION [TIMEOUT_S]
  local expected="$1" timeout="${2:-45}" waited=0 body=""
  while [ "${waited}" -lt "${timeout}" ]; do
    body="$(curl -sf --max-time 3 "http://127.0.0.1:${APP_PORT}/api/health" 2>/dev/null || true)"
    if [ -n "${body}" ]; then
      if echo "${body}" | grep -q "\"version\":\"${expected}\""; then return 0; fi
      echo "health responded but wrong version: ${body} (want ${expected})"
    fi
    sleep 2; waited=$((waited + 2))
  done
  echo "health check failed after ${timeout}s: ${body:-no response}"
  return 1
}

find_payload() { # locates payload/ next to the running script
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[1]}")" && pwd)"
  if [ -d "${script_dir}/payload" ]; then echo "${script_dir}/payload"
  elif [ -f "${script_dir}/../version.json" ] && [ -d "${script_dir}/../backend" ]; then
    echo "" # running from a source checkout — caller handles a build
  else echo ""
  fi
}
