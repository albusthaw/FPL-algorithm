#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# lib.sh — shared shell library for install.sh / upgrade.sh / reinstall.sh
# (howupgradeshouldwork-1.md §7): logging, spinner, error trap, summary box.
# Quiet console (steps + ok/fail); full transcript to a timestamped log.
# ═══════════════════════════════════════════════════════════════════════════
# -E (errtrace) is load-bearing: without it the ERR trap is NOT inherited by
# functions, so every run_step failure would exit silently and upgrade.sh's
# auto-restore would never fire.
set -Eeuo pipefail

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
NO_NGINX="${NO_NGINX:-auto}"       # auto|true|false — auto skips nginx when systemd is absent
PROVISION="${PROVISION:-auto}"     # auto|true|false — auto installs missing prerequisites
                                   # only on a real server (root + apt + systemd)
NO_FIREWALL="${NO_FIREWALL:-auto}" # auto|true|false — auto skips ufw when systemd is absent
SITE_DOMAIN_DEFAULT="fpl.minthantthaw.me"
SITE_DOMAIN="${SITE_DOMAIN:-}"     # resolved by prompt_site_domain / read from shared/.env
CRED_FILE="${APP_DIR}/shared/credentials.txt"

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

# psql as the postgres superuser (peer auth via sudo/runuser when available)
psql_super() {
  if [ "$(id -un)" = "postgres" ]; then psql -v ON_ERROR_STOP=1 "$@"
  elif command -v sudo >/dev/null 2>&1 && sudo -n -u postgres true 2>/dev/null; then sudo -u postgres psql -v ON_ERROR_STOP=1 "$@"
  elif [ "$(id -u)" = "0" ] && command -v runuser >/dev/null 2>&1; then runuser -u postgres -- psql -v ON_ERROR_STOP=1 "$@"
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
    # 3>&- + </dev/null: the daemon must NOT inherit the console fd or stdin —
    # a held fd 3 keeps pipelines reading install/upgrade output open forever
    (ENV_FILE="${APP_DIR}/shared/.env" nohup node "${APP_DIR}/current/backend/dist/src/server.js" \
      >>"${APP_DIR}/shared/data/logs/server.log" 2>&1 3>&- </dev/null &)
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

# ── fresh-server provisioning: prerequisites + firewall ────────────────────
# install.sh/reinstall.sh INSTALL what is missing (ensure_prerequisites install);
# upgrade.sh only VERIFIES (ensure_prerequisites verify) — an upgrade must
# never surprise an existing box with new packages. Both degrade to
# check-only in containers/rehearsals (no systemd) or without root/apt.

can_provision() {
  case "${PROVISION}" in
    false) return 1 ;;
    true)  [ "$(id -u)" = "0" ] && command -v apt-get >/dev/null 2>&1 ;;
    *)     [ "$(id -u)" = "0" ] && command -v apt-get >/dev/null 2>&1 && have_systemd ;;
  esac
}

# DPkg::Lock::Timeout: a freshly booted server often has unattended-upgrades
# holding the dpkg lock — wait for it instead of failing on first contact
APT_LOCK_WAIT="-o DPkg::Lock::Timeout=300"
APT_UPDATED=false
apt_update_once() {
  export DEBIAN_FRONTEND=noninteractive
  if [ "${APT_UPDATED}" != "true" ]; then
    apt-get ${APT_LOCK_WAIT} update -qq
    APT_UPDATED=true
  fi
}
apt_install() { # apt_install pkg… — quiet, non-interactive, update once
  apt_update_once
  apt-get install -y -qq ${APT_LOCK_WAIT} -o Dpkg::Options::=--force-confold "$@"
}
pkg_available() { apt-cache policy "$1" 2>/dev/null | grep -q 'Candidate: [0-9]'; }

node_major() {
  command -v node >/dev/null 2>&1 || { echo 0; return; }
  node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null || echo 0
}

install_node() { # NodeSource — the supported path to Node ${NODE_MIN_MAJOR} on Debian/Ubuntu
  echo "installing Node.js ${NODE_MIN_MAJOR}.x (NodeSource)…"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MIN_MAJOR}.x" | bash - >/dev/null
  APT_UPDATED=true   # the NodeSource script runs apt-get update itself
  apt_install nodejs
}

install_postgres() {
  echo "installing PostgreSQL ${PG_PIN_MAJOR}…"
  apt_update_once
  # probe availability EXPLICITLY — never treat a transient apt failure as
  # "not in the archive", and never discard apt's stderr
  if ! pkg_available "postgresql-${PG_PIN_MAJOR}"; then
    echo "postgresql-${PG_PIN_MAJOR} not in the distro archive — adding apt.postgresql.org (PGDG)"
    install -d /usr/share/postgresql-common/pgdg
    curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
      https://www.postgresql.org/media/keys/ACCC4CF8.asc
    local codename
    codename="$(. /etc/os-release && echo "${VERSION_CODENAME}")"
    echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${codename}-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list
    APT_UPDATED=false
  fi
  apt_install "postgresql-${PG_PIN_MAJOR}" "postgresql-client-${PG_PIN_MAJOR}"
  if have_systemd; then systemctl enable --now postgresql >/dev/null 2>&1 || true; fi
}

# The psql binary is NOT proof of a server (postgresql-client-common ships a
# pg_wrapper psql on client-only boxes). The server matters only when the DB
# is local; a remote DB_HOST is legitimate and only needs the client.
db_is_local() { [ "${DB_HOST}" = "127.0.0.1" ] || [ "${DB_HOST}" = "localhost" ] || [ "${DB_HOST}" = "::1" ]; }
postgres_client_ok() { psql --version >/dev/null 2>&1; }   # pg_wrapper fails here without a real client
postgres_server_installed() {
  [ -x "/usr/lib/postgresql/${PG_PIN_MAJOR}/bin/postgres" ] && return 0
  command -v postgres >/dev/null 2>&1 && return 0
  ls /usr/lib/postgresql/*/bin/postgres >/dev/null 2>&1
}

postgres_server_ready() {
  command -v pg_isready >/dev/null 2>&1 || return 0   # can't probe: let psql_super surface it
  pg_isready -q -h "${DB_HOST}" -p "${DB_PORT}" 2>/dev/null
}

# ensure_prerequisites install|verify
#  install: put missing pieces in place (apt) — install.sh / reinstall.sh
#  verify:  never touch packages, fail with an exact list — upgrade.sh
ensure_prerequisites() {
  local mode="${1:-install}"
  local missing=()

  command -v curl  >/dev/null 2>&1 || missing+=("curl")
  command -v unzip >/dev/null 2>&1 || missing+=("unzip")
  [ "$(node_major)" -ge "${NODE_MIN_MAJOR}" ] || missing+=("nodejs>=${NODE_MIN_MAJOR}")
  postgres_client_ok || missing+=("postgresql-client-${PG_PIN_MAJOR}")
  if db_is_local && ! postgres_server_installed; then
    missing+=("postgresql-${PG_PIN_MAJOR} (server)")
  fi

  if [ "${#missing[@]}" -gt 0 ]; then
    if [ "${mode}" = "install" ] && can_provision; then
      echo "installing missing prerequisites: ${missing[*]}"
      # ca-certificates + gnupg unconditionally: the NodeSource/PGDG fetches
      # are https and minimal images ship curl WITHOUT a CA bundle
      apt_install ca-certificates gnupg curl unzip
      [ "$(node_major)" -ge "${NODE_MIN_MAJOR}" ] || install_node
      if { db_is_local && ! postgres_server_installed; } || ! postgres_client_ok; then
        install_postgres
      fi
      # re-verify — a failed install must stop here, not five steps later
      [ "$(node_major)" -ge "${NODE_MIN_MAJOR}" ] || { console "  ${C_RED}Node ${NODE_MIN_MAJOR}+ still not first on PATH after install (nvm/snap shadowing apt?)${C_OFF}"; exit 1; }
      postgres_client_ok || { console "  ${C_RED}psql still not working after install${C_OFF}"; exit 1; }
      if db_is_local && ! postgres_server_installed; then
        console "  ${C_RED}PostgreSQL server still missing after install${C_OFF}"; exit 1
      fi
    else
      console "  ${C_RED}missing prerequisites: ${missing[*]}${C_OFF}"
      if [ "${mode}" = "install" ]; then
        console "  auto-install needs root + apt (Debian/Ubuntu). Either rerun as root,"
        console "  or install manually:"
        console "    Node ${NODE_MIN_MAJOR}:      curl -fsSL https://deb.nodesource.com/setup_${NODE_MIN_MAJOR}.x | sudo bash - && sudo apt-get install -y nodejs"
        console "    PostgreSQL:   sudo apt-get install -y postgresql-${PG_PIN_MAJOR} postgresql-client-${PG_PIN_MAJOR}"
        console "    tools:        sudo apt-get install -y curl unzip"
      else
        console "  an upgrade never installs packages — fix the box first (see install.sh)"
      fi
      exit 1
    fi
  fi

  # nginx: wanted on a real server (serves SITE_DOMAIN); optional elsewhere
  if [ "${mode}" = "install" ] && [ "${NO_NGINX}" != "true" ] && have_systemd \
     && ! command -v nginx >/dev/null 2>&1 && can_provision; then
    echo "installing nginx…"
    apt_install nginx
  fi

  # the database SERVER must be reachable, not merely installed
  if ! postgres_server_ready; then
    if [ "${mode}" = "install" ] && can_provision && have_systemd; then
      systemctl enable --now postgresql >/dev/null 2>&1 || true
      local i
      for i in $(seq 1 15); do postgres_server_ready && break; sleep 1; done
    fi
    if ! postgres_server_ready; then
      console "  ${C_RED}PostgreSQL server not reachable on ${DB_HOST}:${DB_PORT}${C_OFF}"
      if db_is_local && ! postgres_server_installed; then
        console "  the server package is not installed — apt-get install -y postgresql-${PG_PIN_MAJOR}"
      else
        console "  start it: systemctl start postgresql · or pg_ctlcluster ${PG_PIN_MAJOR} main start"
      fi
      exit 1
    fi
  fi
  echo "prerequisites ok: node $(node --version 2>/dev/null), $(psql --version 2>/dev/null | head -1), postgres server reachable"
}

# The ports sshd ACTUALLY listens on — never assume 22 (provider images move
# it): live sockets first, sshd_config second, 22 as the last resort.
ssh_ports() {
  local ports=""
  if command -v ss >/dev/null 2>&1; then
    ports="$(ss -tlnp 2>/dev/null | grep '"sshd"' | awk '{print $4}' | grep -oE '[0-9]+$' | sort -un | tr '\n' ' ')"
  fi
  if [ -z "${ports// /}" ] && [ -f /etc/ssh/sshd_config ]; then
    ports="$(grep -iE '^[[:space:]]*Port[[:space:]]+[0-9]+' /etc/ssh/sshd_config | awk '{print $2}' | sort -un | tr '\n' ' ')"
  fi
  [ -z "${ports// /}" ] && ports="22"
  echo "${ports}"
}

# setup_firewall install|verify — ufw: allow SSH (FIRST — never lock the
# operator out, on whatever port sshd really uses), 80, 443; the app itself
# binds 127.0.0.1 and is only reachable through nginx. verify mode reports,
# never changes.
setup_firewall() {
  local mode="${1:-install}"
  case "${NO_FIREWALL}" in
    true) echo "firewall step skipped (NO_FIREWALL=true)"; return 0 ;;
    auto) have_systemd || { echo "firewall skipped (container/rehearsal — no systemd)"; return 0; } ;;
  esac

  if ! command -v ufw >/dev/null 2>&1; then
    if [ "${mode}" = "install" ] && can_provision; then
      apt_install ufw
    else
      echo "ufw not installed — configure your firewall manually: allow 22/tcp, 80/tcp, 443/tcp"
      return 0
    fi
  fi

  if [ "${mode}" = "verify" ]; then
    if ufw status 2>/dev/null | grep -q "Status: active"; then
      echo "firewall: ufw active (unchanged — upgrades never modify it)"
    else
      echo "firewall: ufw NOT active — run install.sh (it allows the real SSH port before enabling)"
    fi
    return 0
  fi

  # SSH first — enabling ufw without it locks the operator out of the server.
  # Allow the port(s) sshd REALLY listens on, not an assumed 22.
  local sshp
  sshp="$(ssh_ports)"
  local p
  for p in ${sshp}; do ufw allow "${p}/tcp" >/dev/null; done
  ufw allow 80/tcp  >/dev/null
  ufw allow 443/tcp >/dev/null
  if ! ufw status | grep -q "Status: active"; then
    ufw default deny incoming >/dev/null
    ufw default allow outgoing >/dev/null
    if ufw --force enable >/dev/null 2>&1; then
      echo "ufw enabled: deny incoming by default; allow SSH(${sshp% }), 80, 443"
      console "  ${C_DIM}·${C_OFF} ufw enabled — allowed: SSH port(s) ${C_GREEN}${sshp% }${C_OFF}, 80, 443; everything else denied"
    else
      echo "WARNING: ufw enable failed (kernel/permissions?) — configure the firewall manually"
      console "  ${C_YELLOW}ufw enable failed — configure the firewall manually (allow ${sshp% }, 80, 443)${C_OFF}"
      return 0
    fi
  else
    echo "ufw already active — ensured allows for SSH(${sshp% }), 80, 443"
    console "  ${C_DIM}·${C_OFF} ufw already active — ensured allows: SSH port(s) ${sshp% }, 80, 443"
  fi
  echo "app port ${APP_PORT} stays loopback-only (nginx proxies ${SITE_DOMAIN:-the site} → 127.0.0.1:${APP_PORT})"
}

# ── site domain ────────────────────────────────────────────────────────────
have_nginx() {
  case "${NO_NGINX}" in
    true) return 1 ;;
    false) command -v nginx >/dev/null 2>&1 ;;
    *) have_systemd && command -v nginx >/dev/null 2>&1 ;;
  esac
}

# Resolve SITE_DOMAIN: an already-configured domain (shared/.env) is the
# default; otherwise fpl.minthantthaw.me. On a TTY the user is asked whether
# to keep it or type another; non-interactive runs take the default silently.
valid_domain() { # hostname chars only — also keeps sed/nginx interpolation safe
  [[ "$1" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]
}

prompt_site_domain() {
  local current=""
  [ -f "${APP_DIR}/shared/.env" ] && current="$(read_env_var SITE_DOMAIN "${APP_DIR}/shared/.env")"
  local default="${SITE_DOMAIN:-${current:-${SITE_DOMAIN_DEFAULT}}}"
  valid_domain "${default}" || default="${SITE_DOMAIN_DEFAULT}"
  if [ -t 0 ] && [ "${NONINTERACTIVE:-false}" != "true" ]; then
    while true; do
      printf '%b' "  Site domain [${C_GREEN}${default}${C_OFF}] — press Enter to keep, or type another: " >&3
      local answer=""
      read -r answer || answer=""
      SITE_DOMAIN="${answer:-${default}}"
      valid_domain "${SITE_DOMAIN}" && break
      console "  ${C_RED}'${SITE_DOMAIN}' is not a valid domain (letters, digits, dots, hyphens)${C_OFF}"
    done
  else
    SITE_DOMAIN="${default}"
    if ! valid_domain "${SITE_DOMAIN}"; then
      console "  ${C_RED}SITE_DOMAIN '${SITE_DOMAIN}' is not a valid domain${C_OFF}"
      exit 1
    fi
  fi
  echo "site domain resolved: ${SITE_DOMAIN}"
}

# Read the domain of an EXISTING install without prompting (upgrade.sh —
# upgrades detect the installed site and never change it).
detect_site_domain() {
  SITE_DOMAIN="$(read_env_var SITE_DOMAIN "${APP_DIR}/shared/.env")"
}

site_url() {
  if [ -n "${SITE_DOMAIN}" ]; then echo "http://${SITE_DOMAIN}"; else echo "http://127.0.0.1:${APP_PORT}"; fi
}

# ── credentials file: written when an admin is CREATED; upgrades never touch ─
save_credentials() { # save_credentials EMAIL PASSWORD
  (
  umask 077
  cat > "${CRED_FILE}" <<CREDEOF
# ${APP_NAME} sign-in credentials — created $(date -Iseconds) by $(basename "$0")
# Keep this file private (chmod 600). If you change the password in the
# admin panel later, this file is NOT updated — delete it once memorised.
site url:       $(site_url)
local url:      http://127.0.0.1:${APP_PORT}
admin email:    $1
admin password: $2
db name:        ${DB_NAME}
db user:        ${DB_USER}
db password:    see DB_PASSWORD in ${APP_DIR}/shared/.env
CREDEOF
  )
  chmod 600 "${CRED_FILE}"
  echo "credentials saved to ${CRED_FILE}"
}

cred_field() { # cred_field "admin email" → value from the credentials file
  # `|| true`: a missing file must not trip set -e/pipefail — callers handle ""
  sed -n "s/^$1:[[:space:]]*//p" "${CRED_FILE}" 2>/dev/null | head -1 || true
}

# Print the sign-in block to the console AND note the file location — used
# by all three scripts so credentials are always shown at the end.
show_signin_block() { # show_signin_block [note]
  local email password
  email="$(cred_field 'admin email')"
  password="$(cred_field 'admin password')"
  console ""
  console "  ${C_GREEN}── SIGN-IN ─────────────────────────────────────────${C_OFF}"
  console "  URL:      $(site_url)  (local: http://127.0.0.1:${APP_PORT})"
  if [ -n "${email}" ]; then
    console "  Email:    ${email}"
    console "  Password: ${password}"
    console "  Saved in: ${CRED_FILE}"
  else
    console "  Email/password: unchanged — ${CRED_FILE} not found"
    console "  (created before v1.0.2, or deleted after memorising)"
  fi
  [ -n "${1:-}" ] && console "  ${C_DIM}$1${C_OFF}"
  console "  ${C_GREEN}────────────────────────────────────────────────────${C_OFF}"
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
