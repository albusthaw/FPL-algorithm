#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# install.sh — idempotent fresh install (fpl-project.md §13, upgrade doc §7).
# Creates the release layout, postgres role/db (existence-checked; an
# existing DB is PARKED, never dropped), generates shared/.env once, installs
# deps, runs migrations, installs the systemd unit, creates the first admin,
# health-checks, prints the summary box. Second runs must never be scarier
# than the first.
#
# On a FRESH server it also provisions: installs missing prerequisites
# (Node ${NODE_MIN_MAJOR}, PostgreSQL, nginx, curl/unzip — root + apt) and
# configures the ufw firewall (allow SSH/80/443, deny the rest).
#
# Usage: bash install.sh [--from-payload DIR]
# Env overrides: APP_DIR, DB_NAME_OVERRIDE, APP_PORT, ADMIN_EMAIL, NO_SYSTEMD,
#                SITE_DOMAIN, PROVISION=auto|true|false, NO_FIREWALL, NO_NGINX
# ═══════════════════════════════════════════════════════════════════════════
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

PAYLOAD="${1:-}"
[ "${PAYLOAD}" = "--from-payload" ] && PAYLOAD="${2:-}"
[ -z "${PAYLOAD}" ] && PAYLOAD="$(find_payload)"
[ -z "${PAYLOAD}" ] && [ -d "${SCRIPT_DIR}/payload" ] && PAYLOAD="${SCRIPT_DIR}/payload"
if [ -z "${PAYLOAD}" ] || [ ! -f "${PAYLOAD}/version.json" ]; then
  console "no payload found — run from the release zip (payload/ beside this script)"
  exit 2
fi

console ""
console "  Installing ${APP_NAME} → ${APP_DIR}"
console ""

# prerequisites FIRST — on a fresh server nothing below (including reading
# version.json, which needs node) works until they exist
run_step "prerequisites (node ${NODE_MIN_MAJOR}+, postgres ${PG_PIN_MAJOR}, nginx, tools — install if missing)" \
  ensure_prerequisites install

VERSION="$(json_field "${PAYLOAD}/version.json" version)"
SCHEMA="$(json_field "${PAYLOAD}/version.json" schema)"
console "  ${C_DIM}·${C_OFF} release: ${C_GREEN}v${VERSION}${C_OFF} (schema ${SCHEMA})"

run_step "runtime checks (node >= ${NODE_MIN_MAJOR}, psql)" bash -c 'true'
require_node
require_postgres

# ── site domain: fpl.minthantthaw.me by default, keep-or-change prompt ──────
CURRENT_STEP="site domain"
prompt_site_domain
console "  ${C_DIM}·${C_OFF} site domain: ${C_GREEN}${SITE_DOMAIN}${C_OFF}"
CURRENT_STEP=""

# ── firewall: allow SSH first (lockout guard), then 80/443; app loopback-only
run_step "firewall (ufw: allow 22/80/443, deny the rest)" setup_firewall install

# ── layout ──────────────────────────────────────────────────────────────────
make_layout() {
  mkdir -p "${APP_DIR}/releases" "${APP_DIR}/backups" \
    "${APP_DIR}/shared/data/uploads" "${APP_DIR}/shared/data/logs" "${APP_DIR}/shared/data/media"
}
run_step "create layout under ${APP_DIR}" make_layout

# ── database: existence-checked; existing DB parked, never dropped ─────────
setup_database() {
  if ! psql_super -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1; then
    DB_PASSWORD="${DB_PASSWORD:-$(generate_secret)}"
    psql_super -c "CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASSWORD}'"
    echo "created role ${DB_USER}"
  else
    # role exists: reuse the password from an existing .env or reset it
    if [ -f "${APP_DIR}/shared/.env" ]; then
      DB_PASSWORD="$(read_env_var DB_PASSWORD "${APP_DIR}/shared/.env")"
    fi
    if [ -z "${DB_PASSWORD:-}" ]; then
      DB_PASSWORD="$(generate_secret)"
      psql_super -c "ALTER ROLE ${DB_USER} PASSWORD '${DB_PASSWORD}'"
      echo "role existed without a known password — reset"
    fi
  fi

  if psql_super -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1; then
    if [ "${FRESH_DB:-false}" = "true" ]; then
      local parked="${DB_NAME}_parked_${TIMESTAMP}"
      # identifiers must be quoted (the timestamp contains '-') and the DB
      # must have no live connections or the rename fails
      psql_super -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${DB_NAME}' AND pid <> pg_backend_pid()" >/dev/null
      psql_super -c "ALTER DATABASE \"${DB_NAME}\" RENAME TO \"${parked}\""
      echo "existing database ${DB_NAME} PARKED as ${parked} (never dropped)"
      psql_super -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER}"
    else
      echo "database ${DB_NAME} exists — reusing (idempotent install)"
    fi
  else
    psql_super -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER}"
  fi
}
run_step "postgres role + database (${DB_NAME})" setup_database

# ── shared/.env — generated ONCE, then only re-read ─────────────────────────
# (exception: SITE_DOMAIN — install/reinstall own the site choice, so the
#  prompted value is written/updated here; upgrade.sh never touches it)
write_env() {
  if [ -f "${APP_DIR}/shared/.env" ]; then
    DB_PASSWORD="$(read_env_var DB_PASSWORD "${APP_DIR}/shared/.env")"
    local existing_domain
    existing_domain="$(read_env_var SITE_DOMAIN "${APP_DIR}/shared/.env")"
    if [ -z "${existing_domain}" ]; then
      printf 'SITE_DOMAIN=%s\n' "${SITE_DOMAIN}" >> "${APP_DIR}/shared/.env"
      echo ".env exists — appended SITE_DOMAIN=${SITE_DOMAIN}, rest untouched"
    elif [ "${existing_domain}" != "${SITE_DOMAIN}" ]; then
      sed -i "s|^SITE_DOMAIN=.*|SITE_DOMAIN=${SITE_DOMAIN}|" "${APP_DIR}/shared/.env"
      echo ".env exists — SITE_DOMAIN changed ${existing_domain} → ${SITE_DOMAIN}, rest untouched"
    else
      echo ".env exists — left untouched"
    fi
    return 0
  fi
  cat > "${APP_DIR}/shared/.env" <<ENVEOF
# ${APP_NAME} — generated $(date -Iseconds). Secrets live here, never in the DB.
NODE_ENV=production
PORT=${APP_PORT}
HOST=127.0.0.1
SITE_DOMAIN=${SITE_DOMAIN}
DB_PASSWORD=${DB_PASSWORD}
DATABASE_URL=postgres://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}
DATA_DIR=${APP_DIR}/shared/data
SESSION_SECRET=$(generate_secret)
COOKIE_SECURE=false
# ── provider keys (fill in, then restart) ──
API_FOOTBALL_KEY=
SPORTMONKS_TOKEN=
FOOTBALL_DATA_TOKEN=
NEWSDATA_KEY=
THESPORTSDB_KEY=
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
GEMINI_API_KEY=
DEEPSEEK_API_KEY=
KIMI_API_KEY=
OLLAMA_URL=http://127.0.0.1:11434
MODAL_ENDPOINT_URL=
FPL_EGRESS_PROXY=
ENVEOF
  chmod 600 "${APP_DIR}/shared/.env"
}
run_step "generate shared/.env (once)" write_env

# ── stage the release ───────────────────────────────────────────────────────
stage_release() {
  local dest="${APP_DIR}/releases/${VERSION}"
  if [ -d "${dest}" ] && [ -f "${dest}/.install-complete" ]; then
    echo "release ${VERSION} already staged"
    return 0
  fi
  rm -rf "${dest}"
  mkdir -p "${dest}"
  cp -a "${PAYLOAD}/backend" "${dest}/backend"
  cp -a "${PAYLOAD}/frontend" "${dest}/frontend"
  cp -a "${PAYLOAD}/version.json" "${dest}/version.json"
}
run_step "stage release ${VERSION}" stage_release

npm_ci() {
  cd "${APP_DIR}/releases/${VERSION}/backend"
  npm ci --omit=dev --no-audit --no-fund
}
run_step "npm ci (production deps)" npm_ci

# ── migrate (CLI guard exits 78 if the DB is ahead) ─────────────────────────
migrate() {
  cd "${APP_DIR}/releases/${VERSION}/backend"
  ENV_FILE="${APP_DIR}/shared/.env" node dist/src/cli.js migrate
}
run_step "run migrations" migrate

flip_symlink() {
  ln -sfn "${APP_DIR}/releases/${VERSION}" "${APP_DIR}/current.tmp.$$"
  mv -T "${APP_DIR}/current.tmp.$$" "${APP_DIR}/current"
  touch "${APP_DIR}/releases/${VERSION}/.install-complete"
}
run_step "point current → releases/${VERSION}" flip_symlink

# ── systemd unit ────────────────────────────────────────────────────────────
install_service() {
  if ! have_systemd; then
    echo "systemd unavailable — starting directly (rehearsal/container mode)"
    return 0
  fi
  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<UNITEOF
[Unit]
Description=${APP_NAME} backend
After=network.target postgresql.service

[Service]
Type=simple
Environment=ENV_FILE=${APP_DIR}/shared/.env
WorkingDirectory=${APP_DIR}/current/backend
ExecStart=$(command -v node) ${APP_DIR}/current/backend/dist/src/server.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNITEOF
  systemctl daemon-reload
  systemctl enable "${SERVICE_NAME}" >/dev/null 2>&1 || true
}
run_step "install service" install_service

# ── nginx server block for the site domain (create-or-overwrite; skipped
#    gracefully when nginx is absent or in rehearsal/container mode) ─────────
install_nginx() {
  if ! have_nginx; then
    echo "nginx skipped (not installed, or NO_NGINX/container mode) — app on 127.0.0.1:${APP_PORT}"
    return 0
  fi
  local conf="/etc/nginx/conf.d/${APP_NAME}.conf"
  if [ -d /etc/nginx/sites-available ]; then conf="/etc/nginx/sites-available/${APP_NAME}.conf"; fi
  cat > "${conf}" <<NGINXEOF
# ${APP_NAME} — generated by install.sh; upgrades never modify this file.
server {
    listen 80;
    listen [::]:80;
    server_name ${SITE_DOMAIN};
    client_max_body_size 10m;

    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        # SSE (run progress stream)
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
NGINXEOF
  if [ -d /etc/nginx/sites-enabled ]; then
    ln -sfn "${conf}" "/etc/nginx/sites-enabled/${APP_NAME}.conf"
  fi
  if nginx -t; then
    systemctl reload nginx 2>/dev/null || nginx -s reload 2>/dev/null || true
    echo "nginx serving ${SITE_DOMAIN} → 127.0.0.1:${APP_PORT} (${conf})"
  else
    echo "nginx config test FAILED — wrote ${conf} but did not reload; fix and reload manually"
  fi
}
run_step "nginx server block (${SITE_DOMAIN})" install_nginx

run_step "start service" bash -c 'true'
service_stop
service_start

run_step "health check (v${VERSION})" health_check "${VERSION}"

# ── first-run admin bootstrap: prints the credential + saves it to a file ───
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@${SITE_DOMAIN}}"
ADMIN_LINE=""
create_admin() {
  cd "${APP_DIR}/current/backend"
  local existing
  existing="$(ENV_FILE="${APP_DIR}/shared/.env" node -e "
    import('./dist/src/core/db.js').then(async ({db}) => {
      const row = await db('users').where('role','admin').first('email');
      process.stdout.write(row ? row.email : '');
      await db.destroy();
    })" 2>/dev/null || true)"
  if [ -n "${existing}" ]; then
    # idempotent rerun: the admin (and password) are UNCHANGED — display
    # from the credentials file saved when it was created
    if [ -f "${CRED_FILE}" ]; then
      ADMIN_LINE="admin: $(cred_field 'admin email') / $(cred_field 'admin password')"
    else
      ADMIN_LINE="admin: ${existing} (existing — password unchanged)"
    fi
    echo "admin already exists: ${existing} — untouched"
    return 0
  fi
  local password
  password="$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  ENV_FILE="${APP_DIR}/shared/.env" node dist/src/cli.js create-admin "${ADMIN_EMAIL}" "Administrator" "${password}"
  save_credentials "${ADMIN_EMAIL}" "${password}"
  ADMIN_LINE="admin: ${ADMIN_EMAIL} / ${password}"
}
run_step "create first admin" create_admin

summary_box "INSTALLED ${APP_NAME} v${VERSION}" \
  "site:  $(site_url)" \
  "${ADMIN_LINE}" \
  "creds: ${CRED_FILE}" \
  "env:   ${APP_DIR}/shared/.env (add provider keys)" \
  "data:  ${APP_DIR}/shared/data"
show_signin_block "These credentials survive every upgrade (upgrade.sh never touches users)."
console ""
