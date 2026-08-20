#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# build-release.sh — builds the release artifact i.zip (CLAUDE.md Rule #1d).
# Layout (FIXED):
#   i.zip
#   ├── install.sh / upgrade.sh / reinstall.sh / lib.sh   (zip root)
#   └── payload/
#       ├── version.json
#       ├── backend/   dist/ + compiled migrations + package.json + lockfile
#       ├── frontend/dist/
#       └── scripts/   (probe helpers)
# Run from the repo root after tests are green and version.json is bumped:
#   bash scripts/build-release.sh
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

VERSION="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('version.json','utf8')).version)")"
OUT="${ROOT}/dist-release"
STAGE="${OUT}/stage"

echo "── building ${VERSION}"
rm -rf "${OUT}"
mkdir -p "${STAGE}/payload"

echo "── backend: typecheck + compile"
(cd backend && npx tsc -p tsconfig.build.json)

echo "── frontend: build"
(cd frontend && npm run build)

echo "── assemble payload"
mkdir -p "${STAGE}/payload/backend"
cp -a backend/dist "${STAGE}/payload/backend/dist"
cp backend/package.json backend/package-lock.json "${STAGE}/payload/backend/"
mkdir -p "${STAGE}/payload/frontend"
cp -a frontend/dist "${STAGE}/payload/frontend/dist"
cp version.json "${STAGE}/payload/version.json"
# server resolves version.json by walking up from dist/src/core → payload root works;
# also drop a copy inside backend for standalone runs
cp version.json "${STAGE}/payload/backend/version.json"

echo "── scripts at the zip root"
cp scripts/lib.sh scripts/install.sh scripts/upgrade.sh scripts/reinstall.sh "${STAGE}/"
chmod +x "${STAGE}"/*.sh

echo "── zip"
(cd "${STAGE}" && zip -qr "${OUT}/i.zip" install.sh upgrade.sh reinstall.sh lib.sh payload)
cp "${OUT}/i.zip" "${OUT}/${VERSION}.zip" 2>/dev/null || true
rm -rf "${STAGE}"

echo ""
echo "  release artifact: dist-release/i.zip  (v${VERSION}, $(du -h "${OUT}/i.zip" | cut -f1))"
echo "  fresh install : unzip i.zip -d fpl && cd fpl && bash install.sh"
echo "  upgrade       : unzip i.zip -d fpl-new && cd fpl-new && bash upgrade.sh"
echo "  rollback      : bash upgrade.sh --rollback"
