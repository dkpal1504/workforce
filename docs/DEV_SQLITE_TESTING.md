# Local dev testing on SQLite

Status: this checkout is currently wired to run the API against the local SQLite
file `apps/api/prisma/dev.db`, so the app can be exercised without PostgreSQL.
Production is unaffected: `docs/PRODUCTION_DEPLOYMENT.md` still deploys
PostgreSQL and the API refuses a SQLite URL when `NODE_ENV=production`.

## Run it

```bash
cd /mnt/c/data/comp/workforce
npm install
npm run db:setup      # build shared | prisma generate | schema push | demo seed
npm run dev:api       # terminal 1 -> http://localhost:4000
npm run dev:web       # terminal 2 -> http://localhost:5173
```

`bash scripts/dev-sqlite-setup.sh` runs the same steps with a URL check first.

Demo logins (seeded, password `WorkforceDev@2026`):
`EC1001` supervisor · `EC1011` employee · `hod@company.com` · `pm@company.com` · `admin@company.com`

`npm run db:seed` wipes and reloads the demo data at any time.

## What makes this work

| Piece | Note |
|---|---|
| `apps/api/prisma/schema.prisma` | `provider = "sqlite"` — the only difference from the production schema |
| `apps/api/prisma/schema.postgresql.prisma` | the production schema the reviewed migrations were generated from (kept verbatim) |
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
`DEV_BOOTSTRAP_PASSWORD` is present in
`apps/api/src/services/defaultLoginCredentials.ts`, every new Employee / Supervisor
/ HOD registration is provisioned with `password@SDHI` and no forced password
change. That constant cannot reach production — the API build fails while it
exists (`scripts/check-no-dev-bootstrap-password.mjs`) and the server refuses to
boot against PostgreSQL while it is enabled.

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
cp apps/api/prisma/schema.postgresql.prisma apps/api/prisma/schema.prisma
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
