# CLAUDE.md — Standing build rules for fpl-algorithm

Every build session (human or AI) follows this file. It is the contract that
keeps upgrades safe, the theme consistent, and the architecture invariants
intact. Read it before writing a line of code.

---

## RULE #1 (HARD-CODED, READ FIRST) — Write code to meet `upgrade.sh` demands, and how to repack the release zip

`scripts/upgrade.sh` implements the 9-step sequence from
`howupgradeshouldwork-1.md`. **Any code you write must survive that upgrade
path.** Concretely, every change MUST obey ALL of the following, or the next
upgrade will break or destroy data:

### 1a. Schema changes
- **Never edit a released migration.** `backend/migrations/NNNN_*.ts` files
  are frozen the moment they ship in a zip. To fix or reshape, write a NEW
  migration with the next number (`0008_fix_....ts`).
- Migrations are **forward-only**: `down()` must `throw`. Rollback is a DB
  restore, never a down-migration.
- Migrations are **never destructive**: no `DROP TABLE` / `DELETE` /
  `DROP COLUMN` of anything a user filled. Reshapes copy forward
  (`CREATE new` + `INSERT INTO new SELECT ... FROM old`), old columns stay.
- Use idempotent SQL where cheap (`CREATE TABLE IF NOT EXISTS`,
  `ADD COLUMN IF NOT EXISTS`).
- Migration filenames are zero-padded and sequential; lexical order ==
  execution order. Knex records them in `knex_migrations`.

### 1b. version.json
- **Every release bumps `version`** in `/version.json` (semver), even a
  one-line fix.
- **Adding any migration bumps `schema`** (monotonic integer) in the same
  commit. `upgrade.sh` refuses to "upgrade" to a lower schema; the server
  boot guard and `cli.js migrate` exit **78** when the DB is ahead of the
  code. Never remove or weaken those guards.

### 1c. Mutable state location
- Nothing user-generated or mutable is ever written inside the release
  directory. All uploads/logs/generated files go behind `DATA_DIR`
  (`shared/data/`), secrets in `shared/.env`. If you add a code path that
  writes a file, it MUST resolve its path from `config.dataDir` — a relative
  `./uploads`-style path is a data-loss bug at the next symlink flip.
- New env keys must get a default or be added by `upgrade.sh`'s env-merge
  step; the old `shared/.env` will not have them.
- **Site + credentials are install-owned, never upgrade-owned.** The site
  domain (`SITE_DOMAIN` in `shared/.env`, default `fpl.minthantthaw.me`,
  prompted by install.sh/reinstall.sh), the nginx server block, and
  `shared/credentials.txt` (admin sign-in, written when the admin is
  created, chmod 600) are NEVER written by `upgrade.sh` — it only detects
  and displays them, and its final step
  (`verify site + credentials unchanged`) fails the upgrade if they moved.
  All three scripts end by displaying the admin email/password (SIGN-IN
  block) from `shared/credentials.txt`. Keep it that way.

### 1d. How to repack the release zip (i.zip)
The release artifact is built by `scripts/build-release.sh`. To repack:

```bash
# from the repo root, after tests are green and version.json is bumped:
bash scripts/build-release.sh          # builds backend+frontend, produces dist-release/i.zip
```

The zip layout is FIXED — `install.sh`/`upgrade.sh`/`reinstall.sh` at the
zip root, payload under `payload/`:

```
i.zip
├── install.sh            # auto-detects: fresh box → install
├── upgrade.sh            # existing install → 9-step upgrade
├── reinstall.sh          # explicit fresh-over-existing
├── lib.sh                # shared shell library
└── payload/
    ├── version.json
    ├── backend/          # dist/ + package.json + package-lock.json + migrations/ (compiled)
    ├── frontend/dist/    # built SPA
    └── scripts/          # cli.js and helpers the scripts call
```

Rules for the zip:
- The scripts at the zip root must run with `bash <script>` from any cwd
  (they locate `payload/` relative to themselves).
- `payload/backend` must contain **compiled JS** (`dist/`), the compiled
  `migrations/` directory, `package.json` + lockfile for `npm ci --omit=dev`.
  Never ship TypeScript sources as the runtime payload.
- After changing ANY runtime file, rebuild the zip with the script — never
  hand-edit an existing zip.
- Unzipping `i.zip` and running `bash install.sh` on a clean machine must
  bring up the full app; running `bash upgrade.sh` on a machine with an older
  release must perform the 9-step upgrade. Both idempotent. Test this before
  shipping (`scripts/rehearse-upgrade.sh` does it in an isolated prefix).

### 1e. Ship checklist (per release, no exceptions)
1. Change made; migration added if schema changed (+ `schema` bump).
2. `version` bumped in version.json.
3. `npm run typecheck && npm test` green in backend; frontend builds.
4. `bash scripts/build-release.sh` → new i.zip.
5. `bash scripts/rehearse-upgrade.sh` — install(prev zip) → upgrade(new zip)
   → verify version endpoint + dbAhead:false → rollback rehearsal if the
   release has a migration.
6. Changelog entry in `docs/changelog.md` (date, version, schema, what).
7. Commit, tag, push.

---

## 2. Theme contract (from `theme.html` — "The Gridiron Weekly")

All UI — **including the admin panel** — follows the editorial-sports-journal
+ glassmorphism design language of `theme.html`. Explicitly NOT
generic-AI-dark-gradient styling.

- **Palette (CSS custom properties, `frontend/src/styles/tokens.css`):**
  paper `#F6F4EF`, paper-shade `#ECE8DF`, ink `#1B1D1A`, ink-2 `#5B5D52`,
  navy `#1C2B4A`, navy-2 `#2A3D63`, brick `#B23A2E`, brass `#B8892F`,
  line `#D9D4C7`.
- **Type:** Source Serif 4 (display/headlines), Public Sans (body),
  JetBrains Mono (kickers, stats, numbers). Mono uppercase kickers with
  `.12em` letter-spacing introduce every section (theme.html lines 38–39).
- **Glass recipes** (copy from theme.html, do not re-invent):
  `btn-glass` (lines 42–53), `btn-glass-dark` (55–66), `chip-glass` (68–76),
  `glass-input-group` (176–203), `.menu-toggle` (96–104). Layered gradients,
  `backdrop-filter: blur`, inset top highlight, soft double shadow.
- **Signature components:** power-rankings list (rank-num/rank-body/
  rank-change, lines 131–145) for player rankings; navy `stat-panel`
  (124–129) for GW-at-a-glance and admin stats; `matchup-feature` card
  (148–159) for the match engine; striped `table-wrap` tables (162–169) for
  data tables — wide tables scroll inside `.table-wrap`, never the page.
- **Pitch view:** FPL-style green pitch, glass player chips, brass captain
  badge, price + xPts chips — same palette.
- **Responsive discipline:** breakpoints at 900/760/640/560/480 as in
  theme.html; mobile drawer nav; **no horizontal page scroll and no text
  overflow at any width 360px–4K**. Playwright asserts
  `scrollWidth <= clientWidth` at 360/480/768/1024/1440 on every page.
- Accessibility: `:focus-visible` outline 2px brick, semantic headings,
  WCAG AA contrast.

## 3. Upgrade contract

Read `howupgradeshouldwork-1.md` before touching migrations or the scripts.
Summary of the non-negotiables (details in Rule #1): immutable forward-only
migrations, verified `pg_dump` backups before migrating, migrate-then-flip,
auto-restore on failure, `--rollback`, idempotent installers, release dirs
immutable, everything mutable in `shared/`, mismatch guards exit 78.

## 4. Architecture invariants

- **Player UID rules** (`fpl-project.md` §3): every player exists once under
  `plr_<ulid>`; external IDs only in `player_identities`; FPL `element.code`
  is the anchor key (never per-season `id`); no auto-merge below the
  deterministic tier; unmatched rows park in the review queue, never create
  players.
- **Max-2 API providers / max-1 AI provider** — enforced server-side with a
  transactional check (`SELECT ... FOR UPDATE`), never trust the UI.
- **AI adjustment bounds:** `ai_adjustment ∈ [−20, +20]`, clamped in the
  engine; `overall_score = clamp(stat_score + ai_adjustment, 0, 100)`.
- **AI IS NEVER INVOKED AUTOMATICALLY.** Only explicit human actions (Run
  button, image parse, admin action) reach the AI gateway. Every AI call
  carries `AIInvocation{triggered_by_user_id, ...}`; the scheduler container
  is constructed WITHOUT the AI gateway dependency (architectural test
  enforces it); `ai_calls.user_id` is NOT NULL. Scheduled jobs are
  statistical only. Fast paths (lineup mini-run, nightly micro-run) never
  touch AI.
- **Token ledger atomicity:** debits inside `SELECT ... FOR UPDATE`
  transactions; balance never negative; every ledger row has a reason and
  actor; admins unlimited but usage recorded.
- **No secrets to the frontend:** API keys live in `shared/.env`; the admin
  UI sees status only, never values.
- **Runs are append-only snapshots:** a Run writes `derived.*` tables keyed
  by `run_id`, never mutates canonical facts; the frontend reads the latest
  COMPLETED run; a failed run stays invisible.

## 5. Engines contract

Any work on ingestion, the statistical engine, or the match engine follows
`fpl-engines-plan.md` — layer boundaries (L0–L12), snapshot isolation,
leakage rules (features computed strictly as-of kickoff), and Part 7
acceptance gates are non-negotiable. Every constant marked ⚙ in that plan
lives in `model_config` (versioned), never in code. The composer must
reproduce FPL's official points arithmetic exactly (property-tested).

## 6. Integration contract

Any provider-adapter work (football AND AI) follows
`fpl-api-integration-plan.md`: the five laws of the ingest layer (never
trust transport/shape/types; transactional writes with explicit conflict
targets; identity resolved only in the resolver), the §1.2 error taxonomy,
DB write hardening (§1.4), UID-mapping hardening (§1.5), and the adapter
Definition of Done (§1.6). No adapter ships without recorded-fixture
contract tests; probe scripts (`scripts/probe/`) verify live behaviour
before an adapter is enabled with a real key. API-Football returns errors
inside HTTP 200 — `assertOk` checks the body, not the status.

## 7. AI engine contract

Any AI-layer work follows `fpl-ai-engine-plan.md`: human-only invocation
(§1), the cache-aware prompt layout (byte-stable prefix / volatile suffix,
§6), single-repair-retry validation (§7), and exact per-provider usage
normalisation (§8.1) are non-negotiable. Pricing lives in
`model_config.ai_pricing` (data, not code).

## 8. Version policy

Latest stable majors at build time, then pinned. **This build:** Node 22 LTS
(`engines: {"node": ">=22"}` + install-time runtime check), PostgreSQL 16
(pinned in install.sh with existence checks), Fastify 5, React 18, Vite 7,
Knex migrations. A major-version upgrade of anything ships as a normal
release through `upgrade.sh`, never in-place drift. The plan documents
mention Node 26/PG 18 as aspirational-latest; the pinned truth is this file
and `package.json` — bump majors deliberately, as a release.

## 9. Definition of done

- `npm run typecheck` clean, `npm test` green (backend unit + integration).
- Frontend builds; Playwright E2E green including responsive/overflow
  assertions at 360/480/768/1024/1440 — no page with horizontal overflow.
- New features land WITH tests and land responsive — not "responsive later".
- Migrations follow Rule #1 from day one.
