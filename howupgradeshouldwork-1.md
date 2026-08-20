# How the upgrade system works — and how to build it into any Node/TS project

This document explains the release/upgrade architecture used by this
repository so you can replicate it in another established Node.js +
TypeScript project. It has upgraded this system through 16+ releases
(including schema changes, feature additions, and full rollbacks) without
ever losing user data. Everything here is deliberately boring technology:
directories, symlinks, SQL dumps, and a strict set of rules.

---

## 1. The mental model

An upgrade is only safe when these four things are true at the same time:

1. **You can always get back to the state before the upgrade** (verified
   backup taken first, old code still on disk).
2. **The new code and the new schema arrive together, atomically** (never
   run new code against an old schema or old code against a new schema for
   longer than a few seconds — and never serve requests in that window).
3. **User data is append-only across releases** (migrations may add and
   transform, never drop).
4. **The system refuses to run when code and schema disagree** (guards, not
   hope).

Everything below is machinery to enforce those four statements.

---

## 2. On-disk layout: releases are directories, "current" is a symlink

```
/opt/your-app/
├── current -> releases/1.16.0        # atomic pointer to the live release
├── releases/
│   ├── 1.15.0/                       # previous release, kept for rollback
│   │   ├── backend/  (dist/, node_modules/, package.json)
│   │   ├── frontend/dist/
│   │   └── version.json
│   └── 1.16.0/                       # the live release
├── shared/                           # SURVIVES every upgrade
│   ├── .env                          # DB credentials, secrets key, port
│   └── data/                         # uploads, generated files, branding
└── backups/
    └── 20260725-215813/dump.sqlc     # pg_dump taken before each upgrade
```

Rules that make this work:

- **A release directory is immutable once deployed.** You never edit files
  inside `releases/x.y.z`; a fix is a new release.
- **`current` is a symlink and flipping it is the deploy.** `ln -sfn` +
  `mv -T` is atomic on POSIX filesystems: at no instant does a process see
  half a release.
- **Everything mutable lives in `shared/`** and is referenced via the
  environment (e.g. `DATA_DIR=/opt/your-app/shared/data`). Each release
  symlinks or reads `shared/.env`; nothing user-generated is ever inside a
  release directory. This is the single most important separation — get it
  wrong and upgrades delete uploads.
- The service (systemd unit / PM2 config) points at
  `/opt/your-app/current/backend/dist/server.js`, so restarting after the
  flip starts the new code with the old paths unchanged.

Pitfall: if your app writes anything relative to its own directory
(`./uploads`, `./logs`, SQLite files…), hunt those down FIRST and move them
behind a `DATA_DIR` env var. This migration of paths is the main cost of
adopting the structure in an existing project.

## 3. version.json: one file, two numbers

```json
{ "version": "1.16.0", "schema": 12 }
```

- `version` — the human semver, bumped **every** release, even for a
  one-line fix. It names the release directory and the zip.
- `schema` — a monotonically increasing integer, bumped **only when the
  release adds migrations**. It exists so shell scripts and the server can
  compare "how new is this database" against "how new is this code" with an
  integer comparison, without parsing migration filenames.

The backend exposes both (here: `/api/system/info` returns
`{app: {version, schema}, migration: {applied, available, dbAhead}}`),
which makes upgrade verification scriptable.

## 4. Migrations: sequential, forward-only, immutable

```
backend/migrations/
├── 0001_core.ts
├── 0002_identity.ts
├── ...
└── 0019_submission_documents.ts
```

The rules, in order of importance:

1. **Never edit a released migration.** Once `0017_*.ts` has shipped in a
   zip, its content is frozen forever. Fixing a mistake means writing
   `0018_fix_*.ts`. If you edit a released file, installations that already
   ran it and installations that run the edited version now have silently
   different schemas — the worst bug class there is, because nothing errors.
2. **Migrations never delete user data.** No `DROP TABLE` of anything a user
   filled, no `DELETE` of rows, no `ALTER ... DROP COLUMN` of user content.
   When a feature is reshaped, **copy forward**: create the new table,
   `INSERT INTO new SELECT ... FROM old`, and leave the old columns in place
   (they cost nothing). Example from this repo: when single response
   documents became multiple, migration 0019 created `submission_documents`
   and copied every legacy `response_document_path` row into it — the old
   columns still exist and still work.
3. **Sequential numbering with a zero-padded prefix** so lexical order ==
   execution order. Knex (or node-pg-migrate, or Prisma migrate) records
   applied filenames in a `migrations` table; the runner applies whatever is
   pending, in order, inside a transaction per file.
4. **`down()` throws.** Do not maintain down-migrations; you will never test
   them against real data and they violate rule 2 by construction. The
   rollback story is the database backup (section 6), which is exact.
5. **Idempotent SQL where cheap** (`CREATE TABLE IF NOT EXISTS`,
   `ADD COLUMN IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` before
   `ADD CONSTRAINT`). It makes a half-applied migration after a crash
   re-runnable instead of fatal.

A migration template:

```ts
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS widgets (
      id bigserial PRIMARY KEY,
      user_id bigint NOT NULL REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

export async function down(): Promise<void> {
  throw new Error('Downward migrations are not supported; restore from backup instead.');
}
```

Because the runner simply applies every pending file in order, **version
jumps need no special handling**: upgrading 1.0 → 1.16 runs migrations
0009…0019 exactly like 1.15 → 1.16 runs 0019. Do not build "upgrade paths";
the ordered list IS the upgrade path.

## 5. upgrade.sh: the exact sequence and why the order matters

```
1. Preflight        - find the install, read old + new version.json,
                      refuse to "upgrade" to an older schema
2. BACKUP           - pg_dump -Fc into backups/<timestamp>/; then
                      pg_restore --list it to VERIFY the dump is readable.
                      An unverified backup is a wish, not a backup.
3. Stage            - unpack the new release into releases/<newver>/
                      SIDE BY SIDE (old release untouched, service still up)
4. npm ci           - install production deps inside the staged release
                      (still zero downtime if this fails - old release runs)
5. Stop service     - downtime starts here, after everything failure-prone
                      that could be done offline is already done
6. MIGRATE          - run the migration runner FROM THE STAGED RELEASE
                      (new code's migrations, old symlink still in place)
7. Flip symlink     - ln -sfn releases/<newver> current  (atomic)
8. Start service
9. Health check     - poll /api/health; require version == new version
```

**Any failure in 6–9 triggers automatic restore**: stop service, restore the
database from the just-taken dump, keep `current` pointing at (or flip it
back to) the old release, start, health check. The operator ends where they
began, with one log file explaining what failed.

Why migrate **before** the flip (step 6 before 7)?

- The new code understands both old and new schema *of its own migrations*
  (it wrote them); the old code does not understand the new schema. If you
  flip first and migrate second, a crash between the two leaves new code
  running against an old schema in production.
- Running migrations from the staged directory means the migration files
  and the code that will use them are from the same commit — no drift.

Why stop the service before migrating? Because "online migrations" are a
discipline of their own (dual-write phases, backfills). For a system that
can afford ~30 seconds of downtime, stop-migrate-start is dramatically
simpler and eliminates an entire class of race conditions. Choose one
posture deliberately; don't mix.

### restore_db must nuke before it restores

A subtle bug we hit and fixed: `pg_restore` into a database that still
contains the NEW schema fails on dependency order (e.g. the new release
added a table with a foreign key; plain restore can't drop things in the
right order). The fix: the restore function first drops **all** tables,
sequences, and views in the schema (`DROP ... CASCADE` generated from
`pg_catalog`), then runs a plain `pg_restore`. Restoring into a truly empty
schema is the only restore that always works.

### --rollback

`upgrade.sh --rollback` = flip `current` back to the previous release
directory + restore the latest backup dump + start + health check. Keep at
least one previous release on disk at all times. Test this path with every
release that contains a migration — an untested rollback does not exist.

## 6. The mismatch guards (exit code 78)

Two guards, both comparing the `migrations` table against the migration
files on disk:

1. **CLI guard** — `cli.js migrate` refuses when the database contains
   applied migrations that do not exist in the installed files ("database is
   ahead"), with exit code 78 (EX_CONFIG) and the message *"install the
   matching or newer release"*. This is what fires when someone unpacks an
   OLD zip over a NEW database.
2. **Server boot guard** — the server performs the same check on startup and
   refuses to boot, so even bypassing the scripts cannot run old code
   against a newer schema.

```ts
const applied = await db('migrations').pluck('name');       // whatever your runner records
const available = new Set(fs.readdirSync(migrationsDir));
const missing = applied.filter((m) => !available.has(m));
if (missing.length > 0) {
  log.fatal({ missing }, 'database is ahead of the installed code');
  process.exit(78);
}
```

The pairing matters: `dbAhead` (old code, new DB) is always fatal;
`pending` (new code, old DB) is normal and simply means "run migrations".

## 7. Installer discipline: idempotency

`install.sh`, `reinstall.sh`, and `upgrade.sh` share a common library
(logging, spinners, error handling) and one non-negotiable property: **an
existing database, existing credentials, or an already-created service user
must never make them fail.** Concretely:

- `CREATE ROLE`/`CREATE DATABASE` are wrapped in existence checks; an
  existing database is *parked* (renamed) or reused, never dropped silently.
- Generated credentials are written once and re-read afterwards.
- Service files, nginx configs, and directories are written with
  "create or overwrite" semantics that don't care about previous runs.
- Console output is quiet (steps + ok/fail); the full transcript goes to a
  per-run timestamped log file (`/var/log/your-app/upgrade-<ts>.log`), and
  the summary box prints that path on failure.

Idempotency is what turns a failed install at 2 AM from an archaeology
session into "fix the cause, run it again".

## 8. Ship procedure (the human part)

Every release, no exceptions — the machinery only protects you if the
process feeds it correctly:

1. Make the change. Schema change? Add a numbered migration AND bump
   `schema` in version.json.
2. Bump `version` in version.json.
3. Typecheck + unit tests green.
4. Build the release artifact (zip with payload + the three scripts).
5. **Rehearse the upgrade in an isolated prefix**: install the PREVIOUS
   version's zip with overridden paths/db (`APP_DIR=/opt/app-test
   DB_NAME_OVERRIDE=app_test ...`), run the NEW zip's upgrade.sh against
   it, verify: migrations applied, symlink flipped, service boots, the
   version endpoint reports the new version with `dbAhead: false`, and the
   new endpoints actually respond. If the release has a migration, also
   rehearse `--rollback`. Then delete the test prefix + database.
6. Record the release in a changelog the next maintainer will actually read
   (date, version, schema, migrations added, what changed).
7. Commit, tag/push, archive the previous zip.

The rehearsal (step 5) is the step people skip and the step that catches
almost everything: missing files in the payload, migrations that work on a
dev database but not a fresh one, env keys the new code needs but the old
`.env` lacks.

## 9. Feature modularity (optional but pairs beautifully)

New functionality ships as self-registering modules with a manifest:

```
backend/src/features/<name>/
├── manifest.json    { "name": "...", "toggleable": true, "defaultEnabled": true }
└── index.ts         export const feature = { manifest, register(kernel) {...} }
```

On boot, the kernel loads every feature, upserts a row into a
`feature_states` table (`ON CONFLICT DO NOTHING`, so existing toggles
survive upgrades), and routes check `isEnabled()` per request. The result:
a new feature arrives through the same upgrade pipe as everything else,
defaults on/off as declared, and an admin can turn it off without a deploy.
Add-ons follow the identical contract from a separate directory.

This matters for upgrades because it removes the temptation to fork
"editions" — every installation runs the same code with different toggles,
so there is exactly one upgrade path to test.

## 10. Pitfalls checklist (each of these bit us or nearly did)

- **Editing a released migration** — see rule 4.1. Add a new one instead.
- **User files inside the release directory** — they vanish at the next
  flip. Everything mutable goes to `shared/`.
- **Unverified backups** — always `pg_restore --list` (or equivalent) the
  dump before proceeding; a truncated dump discovered during a rollback is
  a disaster.
- **Restoring over a newer schema** — empty the schema first (section 5).
- **Flipping before migrating** — new schema must exist before new code
  serves traffic; migrate from the staged release, then flip.
- **`ON CONFLICT` against partial unique indexes** — plain conflict targets
  can't address them; check-then-insert and swallow the duplicate-key race.
- **Down migrations** — don't write them; restore from backup instead.
- **In-place upgrades** (`git pull && npm i && migrate` on the live dir) —
  there is no rollback and a failed `npm i` leaves you with neither old nor
  new. Side-by-side staging costs one directory.
- **Forgetting the schema int** — if only filenames define schema state,
  shell scripts can't do a cheap "is this DB newer than this code" check.
- **Non-idempotent installers** — the second run must never be scarier than
  the first.
- **Deleting "obsolete" columns/tables during refactors** — copy forward,
  keep the old shape; disk is cheaper than a restore.
- **Node version drift** — pin the runtime (engines field + install check):
  a release built for Node 22 must not silently start under Node 16.

## 11. Minimal adoption plan for an existing project

1. Introduce `version.json` (semver + schema int) and a `/health` +
   `/version` endpoint that reads it.
2. Move every mutable path behind env vars pointing into `shared/`.
3. Adopt a migration runner (Knex/node-pg-migrate) with the numbered-file
   convention; write migration 0001 as `CREATE TABLE IF NOT EXISTS ...` for
   your current schema so fresh installs and existing databases converge.
4. Add the two mismatch guards (CLI + server boot, exit 78).
5. Write `install.sh` (creates layout, db, service, first release) and
   `upgrade.sh` (the 9-step sequence above with auto-restore), sharing a
   common shell library. Make both idempotent.
6. Build a release script that produces `your-app-<version>.zip` containing
   the compiled payload + the scripts.
7. Rehearse: install v(current), upgrade to v(current+1) in an isolated
   prefix, roll back, upgrade again. Only then use it on a real machine.

Total machinery is roughly: three shell scripts sharing one library, a
migrations directory, one JSON file, and two guards — none of it clever,
all of it in the right order.
