# Local dev testing on SQLite

Status: this checkout is currently wired to run the API against the local SQLite
file `apps/api/prisma/dev.db`, so the app can be exercised without PostgreSQL.
Production is unaffected: `docs/PRODUCTION_DEPLOYMENT.md` still deploys
PostgreSQL and the API refuses a SQLite URL when `NODE_ENV=production`.

## Run it

```bash
cd /mnt/c/data/comp/workforce
npm install
npm run db:setup      # build shared | prisma generate | schema push | MINIMAL seed
npm run db:seed:demo  # optional: the demonstration data (see "Demo master data" below)
npm run dev:api       # terminal 1 -> http://localhost:4000
npm run dev:web       # terminal 2 -> http://localhost:5173
```

`bash scripts/dev-sqlite-setup.sh` runs the `db:setup` step (the **minimal** seed) with a URL check first — run `npm run db:seed:demo` yourself when you want the demonstration data.

`npm run db:setup` ends with the **minimal seed** (`npm run db:seed`). It creates four
office accounts and **no business data**:

`admin@company.com` · `pm@company.com` · `hr@company.com` · `finance@company.com`
(password `WorkforceDev@2026`)

That is the production-like starting point: the app has no Project, WBS, UoM, Network,
Job Order, department or employee until you sync from LabourWorks and build the masters
(sections 12 to 15 of `docs/MANUAL.md`). It also seeds **no cost rate**, so the Cost view
of the Summary reads zero until an Admin posts one to `/api/admin/cost-rates`.

`npm run db:seed:demo` adds the demonstration set. Its extra logins, with the same
password: `EC1001` supervisor · `EC1011` employee · `hod@company.com`.

Both commands wipe and reload at any time: `npm run db:seed` gives the four office
accounts again, `npm run db:seed:demo` gives the demonstration data below. **The Playwright
tests need the demo data** — `apps/web/e2e/smoke.spec.ts` logs in as `EC1001` and books
against a seeded Job Order, so it only passes after `npm run db:seed:demo`.

## Rebuilding the dev database

> **After upgrading past the Project / WBS / Job Order change, an existing `dev.db` needs
> one extra flag.** Adding the unique index on `project_wbs (id, project_id)` makes
> `prisma db push` report a possible data loss on an already-populated SQLite file, so
> `npm run db:migrate` stops with *"Use the --accept-data-loss flag"*. The index cannot
> fail here — `id` is already the primary key — so either delete `dev.db` and rebuild, or
> run once:
>
> ```bash
> cd apps/api && npx prisma db push --accept-data-loss && npm run db:seed
> ```
>
> Add `&& npm run db:seed:demo` if you want the demonstration data rather than the four
> office accounts.
>
> The migrations under `prisma/migrations` never run on SQLite, so the dev database is
> built from `schema.prisma` alone. That is why the migration backfills (for example the
> quantity remark history) do not appear there: the dev seed creates equivalent rows
> instead.

Two steps rebuild the dev SQLite database:

```bash
npm run db:migrate     # schema step: a `file:` URL runs `prisma db push`
npm run db:seed        # data step: the deleteMany chain, then the four office accounts
npm run db:seed:demo   # data step: the deleteMany chain, then the demonstration data below
```

- `npm run db:migrate` is provider-aware. On SQLite it runs `prisma db push
  --skip-generate`, so run `npm run db:generate -w @workforce/api` yourself after a
  `schema.prisma` change. It does **not** apply the PostgreSQL migrations.
- `npm run db:setup` runs the whole path: `shared` build, `prisma generate`, the
  provider-aware schema step, then the **minimal** seed. Add `npm run db:seed:demo` when
  you want the demonstration data.

### Demo master data (Project | WBS | Job Order)

`npm run db:seed:demo` loads the hierarchy and both measures that reporting uses. **`npm run db:seed` loads none of it** — it writes the four office accounts only. The master data of the demonstration set is:

| Table | Rows | What it holds |
|---|---|---|
| `projects` | 5 | Project A, B, C, D and the **Non-Project** row; colour keys A, B, C, D, N |
| `project_wbs` | 7 | **two WBS rows belong to Project A**; one each for B and D, two for C, and `GENERAL` for standing work |
| `uom` | 4 | NOS, MT, SQM, MTR (MTR is unused by any seeded Job Order) |
| `networks` | 7 | one or two per project, plus the `DUMMY` network for standing work. Every row carries `wbs_id`: a Network belongs to one WBS element of its project (migration `20260918000003_network_wbs_scope`) |
| `job_orders` | 16 | 14 `active`, 2 `inactive`; the 4 standing rows carry no Section |
| `job_order_budget_revisions` | 16 | revision 1 (`Opening budget`, effective 2026-01-01) for every Job Order |
| `job_order_progress` | 7 | 4 `APPROVED`, 2 `SUBMITTED`, 1 `REJECTED` |

Job Order **`1900000107` is deliberately repeated in Project A and Project C**. That
exercises the rule that a Job Order number is unique **per project only**. It is the
only duplicated number in the seed.

### Dev accounts

Each seed prints the accounts it creates, with the password in use — log in with those
lines.

`npm run db:seed` prints the four office accounts, then the next steps in order (sync from
LabourWorks, create the Project / WBS / UoM / Networks, upload the Job Orders, add cost
rates):

```
ADMIN    admin@company.com / <password>
PM       pm@company.com / <password>
HR       hr@company.com / <password>
FINANCE  finance@company.com / <password>
```

`npm run db:seed:demo` prints the demonstration logins:

```
Employee: EC1011 / <password>
Supervisor: EC1001 / <password>
HOD: hod@company.com / <password>
Project Head: pm@company.com / <password>
Admin: admin@company.com / <password>
```

The password is `WorkforceDev@2026` unless `DEV_SEED_PASSWORD` overrides it, and both
seeds read it the same way. Neither seed imports `dotenv`, so `DEV_SEED_PASSWORD` is only
seen when it is exported in the shell or set in `apps/api/.env`; a value only in the root
`.env` is not read.

## What makes this work

| Piece | Note |
|---|---|
| `apps/api/prisma/schema.prisma` | `provider = "sqlite"` — the only difference from the production schema |
| the committed PostgreSQL schema | there is no second schema file: restore it with `git checkout -- apps/api/prisma/schema.prisma` |
| `apps/api/scripts/migrate.mjs` | `db:migrate` is provider-aware: `file:` URL -> `prisma db push`; PostgreSQL URL -> `prisma migrate deploy` |
| `apps/api/src/index.ts` | accepts a `file:` URL in dev, still throws on SQLite when `NODE_ENV=production` |
| `apps/api/.env`, `.env` | `DATABASE_URL="file:./dev.db"` (both git-ignored) |

No application logic, route, service, shared schema, or Prisma model was
changed — only the datasource provider, the URL guard, and the schema step.

## LabourWorks one-off sync (no e-mail)

Run the production sync service against the local SQLite database, giving every
account it provisions the password `password@SDHI` instead of an unknown random
one, and never sending credential e-mail:

```bash
npm run build -w @workforce/api        # the runner requires dist/services/badgeViewSync
cd apps/api
node run-sync-once.cjs                 # override with DEV_SYNC_PASSWORD=<pw>
```

What it does, in order:

1. refuses to run unless `DATABASE_URL` is a `file:` URL;
2. copies `dev.db` to `dev.db.presync-<timestamp>` (the rollback point);
3. calls `runBadgeViewSync()` — the unmodified production service, so the
   completeness guards, EcNo/mobile identity rules, soft-depart and supervisor
   linking all behave exactly as in production;
4. cancels every queued `credential_deliveries` row, so nothing can be mailed;
5. re-hashes the password of every account carrying `mustChangePassword`
   (the sync still provisions unknown random passwords) to `password@SDHI` and
   clears `mustChangePassword`.

Accounts registered later from the web UI do not need this helper: while
`BOOTSTRAP_PASSWORD` is set in `.env` (this box uses `password@SDHI`), every new
Employee / Supervisor / HOD registration is provisioned with that shared first
password and **must change it at the first login** (the API answers
`403 PASSWORD_CHANGE_REQUIRED` for everything except the change-password
lifecycle until it is changed). The value is configuration, never a literal:
`apps/api/scripts/check-no-dev-bootstrap-password.mjs` fails the production build if
a shared password is ever hardcoded again.

`BADGEVIEW_SYNC_ENABLED` stays `false` in `.env` — the scheduler still does
nothing; this is a one-shot manual call. `SMTP_*` being set does not matter
because credential delivery is never invoked.

Result of the run on 2026-09-13 (source: 521 associates):
employees 20 → 539 (519 now `source='SYNC'`, 31 soft-departed), users 12 → 37,
supervisors 6 → 31, departments 3 → 26 (23 auto-created as `source='SYNC'`),
sections 3 → 41, credential rows 25 all `CANCELLED`.

Log in with the employee's EcNo (`IDCardNo`) from BadgeView, e.g. `BAPL0123` /
`password@SDHI`. The earlier demo accounts still use `WorkforceDev@2026`.

Two rows were left OPEN in `sync_exceptions` as
`MOBILE_IDENTITY_CONFLICT` (BAPL0176, BAPL0253): their mobile number matches a
terminated CLMS employee, so they were deliberately not merged. Review them in
Admin → Sync Exceptions; the sync never auto-merges mobile conflicts.

Rollback: stop the API, then `cp apps/api/prisma/dev.db.presync-<timestamp> apps/api/prisma/dev.db`.


```bash
git checkout -- apps/api/prisma/schema.prisma
# set DATABASE_URL in .env back to postgresql://workforce:workforce@localhost:5433/workforce?schema=public
npm run dev:db:up     # Docker Desktop, port 5433
npm run db:setup
```

A pre-change copy of the PostgreSQL root `.env` is at `.env.local` (git-ignored).
A pre-change copy of the dev database is at
`apps/api/prisma/dev.db.bak-20260913-065451`.

## Verified on SQLite

- API + web start; `/health/ready` returns `{"ok":true}` and Vite proxies `/api`.
- Logins for supervisor, employee, HOD, PM, admin.
- Reads: timesheet, select-team pool, summary (daily/weekly/job-order),
  approvals pending/history/job-order-consumption, allocations, departments,
  sections, cost centers, employees, projects.
- Writes: `PUT /timesheet/entry` (slot tagging), `POST /timesheet/submit`,
  HOD approval (`POST /approvals/:id/approve`), CR#2 allocation
  `POST /allocations/slot` -> `submit` -> HOD approve (all use `$transaction`).
- UI rendered live data on Timesheet, Select Team, Summary, Approvals, My Hours
  and Employees pages.
- `npm run build` passes (api, web, shared).
- Guard: `NODE_ENV=production` + `file:` URL exits with
  "SQLite is not permitted in production."

## Running against a restored copy of production (PostgreSQL 18)

This machine keeps a **restored copy of the production database** so changes can be
exercised against real data without touching production.

| Fact | Value |
|---|---|
| Cluster | `18 main`, port **5433** (`pg_lsclusters`), from the PGDG apt repo |
| Existing dev cluster | `16 main`, port 5432 — untouched, unrelated |
| Role / database | `workforce_app` / `workforce` (the database is OWNED by the role, so every restored object is the app's) |
| Restored from | `C:\data\comp\dbbackup\postgresql-backups\db-prod-01\workforce\workforce_<ts>_<job>.dump` (the backup manager's `pg_dump -Fc`) |
| Data at restore time | 85 users, 651 employees, 42 sections, 924 timesheet days, 3316 entries, 779 approvals, 416 job orders |

**A dump can only be read by a pg_dump/pg_restore of the same major or newer.** The
dumps are produced by **PostgreSQL 18.6** (archive version 1.16), so the 16 client
refuses them with `unsupported version (1.16) in file header` — no file in that folder
is readable by 16. That is why 18 was installed here rather than reusing the 16 cluster.

Restore (re-runnable, installs nothing if 18 is already present):

```bash
sudo bash ~/workforce-restore-backup.sh   # install PG18 + client, create the
                                                          # cluster on 5433, role + database,
                                                          # sha256-check and pg_restore, then
                                                          # print counts to verify
```

Three things must all point at the restored copy, and all three are already set here:

1. `DATABASE_URL` in **both** `.env` (root — this one WINS, dotenv loads it first) and
   `apps/api/.env`:
   `postgresql://workforce_app:<dev password>@127.0.0.1:5433/workforce?schema=public`
2. `apps/api/prisma/schema.prisma` = the **PostgreSQL** variant
   (`git checkout -- apps/api/prisma/schema.prisma`),
   then `npm run db:generate -w @workforce/api`.
3. `CREDENTIAL_DELIVERY_ENABLED=false` — see the warning below.

Back to the SQLite dev database (which is unchanged and still holds its own data):

```bash
git checkout -- apps/api/prisma/schema.prisma          # the committed SQLite variant
# both .env files: DATABASE_URL="file:./dev.db"
npm run db:generate -w @workforce/api
```

**Safety, because the restored copy is real people's data:**

- `CREDENTIAL_DELIVERY_ENABLED` **must stay `false`**. The restored copy carries 83
  `PENDING` rows in `credential_deliveries`, and the `*/5` worker runs inside the API
  process: with it enabled, starting the API on this machine e-mails 83 real staff
  (with `SMTP_*` pointed at the live mail server).
- `BADGEVIEW_SYNC_ENABLED` and `ATTENDANCE_HOURS_ENABLED` must stay `false` too — they
  read the live LabourWorks sources.
- Probe accounts rather than typing passwords: mint a dev JWT
  (`jwt.sign({id, tokenVersion}, JWT_SECRET)`) and seed `workforce_token` /
  `workforce_user` into `sessionStorage` from the app origin. A restored account may
  carry `mustChangePassword = true` in the database (prod HODs do), which makes every
  endpoint answer `403 PASSWORD_CHANGE_REQUIRED` — filter or clear that flag for the
  probe account rather than reading the failure as a broken feature.

Migrations: the restored copy already contains `_prisma_migrations` at production's
state, so `npm run db:migrate` (`prisma migrate deploy`) applies nothing. To author a
change, stop the API and run `npx prisma migrate dev --name <name>` from `apps/api`
against this copy; the generated `migrations/*/migration.sql` is PostgreSQL dialect and
is what production will apply.

## An added column on SQLite needs the migrate step (no reset)

`npm run db:migrate -w @workforce/api` is provider-aware: on a `file:` URL it runs `prisma db push
--skip-generate`, so an existing SQLite file picks up an ADDED column in place. The Job Order planned
window (`planned_start_date`, `planned_end_date`, migration `20261016000000_job_order_planned_dates`)
is such an addition. After pulling a release that adds columns:

```
npm run db:migrate -w @workforce/api      # SQLite: db push, additive
npm run db:generate -w @workforce/api     # then regenerate the client
```

Never `prisma migrate reset` and never `db:seed`: both destroy local data.
