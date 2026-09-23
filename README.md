# Workforce — Manpower & Timesheet

React + Node.js (Express/TypeScript) + PostgreSQL app for manpower allocation, timesheets, approvals, and reporting. Production Docker assets and PostgreSQL creation SQL are included.

## Prerequisites

- Node.js 20+
- npm 10+

## Quick start

Local development testing can run against SQLite — no database server, no Docker. The API rejects SQLite outright when `NODE_ENV=production`, so this cannot leak into a deployment.

```powershell
# 1. Point the app at the local SQLite file (both files: the API loads the root .env first)
#    .env                         -> DATABASE_URL="file:./dev.db"
# 2. Build, generate the Prisma client, create/update the SQLite schema, seed the
#    minimal bootstrap: four office accounts and NO business data
npm install
npm run db:setup
```

```powershell
# Optional: add the demonstration data (projects, WBS, UoM, networks, Job Orders,
# employees, supervisors, bookings, cost rates). Needed by the Playwright tests.
npm run db:seed:demo
```

Then start the two application processes in separate terminals:

```powershell
npm run dev:api
```

```powershell
npm run dev:web
```

`npm run db:setup` is provider-aware: with a `file:` URL it runs `prisma db push` against SQLite, with a PostgreSQL URL it runs `prisma migrate deploy` exactly as production does. The database file is `apps/api/prisma/dev.db`. It ends with `npm run db:seed`, the **minimal seed**: four office accounts (`admin@company.com`, `pm@company.com`, `hr@company.com`, `finance@company.com`) and **no business data**, so the app starts the way production does. Add `npm run db:seed:demo` for the demonstration data below.

### Setting a password for a new account

Newly created accounts follow `BOOTSTRAP_PASSWORD` (`.env`): with it set, every account
provisioned by a registration path starts with that shared first password and **must change it at
its first login** — which is how contract workers and supervisors get in without an e-mail
address. Leave it empty and accounts instead get an unknown random password plus a queued
credential-e-mail row (nothing is mailed while `CREDENTIAL_DELIVERY_ENABLED=false`), so set one
locally:

```bash
node apps/api/set-dev-password.cjs EC1013                 # -> password@SDHI
node apps/api/set-dev-password.cjs EC1013 MyPassword@1
```

### LabourWorks sync (optional)

`apps/api/run-sync-once.cjs` pulls the real BadgeView data into the SQLite dev
database and gives every provisioned account the password `password@SDHI`, with
no credential e-mail. See [`docs/DEV_SQLITE_TESTING.md`](docs/DEV_SQLITE_TESTING.md).
The twice-daily scheduler stays off (`BADGEVIEW_SYNC_ENABLED=false`).

### Switching back to PostgreSQL for development

`apps/api/prisma/schema.postgresql.prisma` holds the production (PostgreSQL) schema that `prisma/migrations` were generated from. To go back:

```powershell
Copy-Item apps/api/prisma/schema.postgresql.prisma apps/api/prisma/schema.prisma
# set DATABASE_URL to the PostgreSQL URL in .env, then:
npm run db:generate
npm run dev:db:up     # Docker Desktop on port 5433
npm run db:setup
```

The local PostgreSQL container avoids a conflict with an existing PostgreSQL service on port `5432` by publishing `5433`.

Keep `BADGEVIEW_SYNC_ENABLED=false` and `CREDENTIAL_DELIVERY_ENABLED=false` until you intentionally test those external integrations. See [`docs/PRODUCTION_DEPLOYMENT.md`](docs/PRODUCTION_DEPLOYMENT.md) for the production path - **section 0** covers this deployment specifically: PostgreSQL on the Linux host `10.5.1.178` (port **5439**) and the Docker stack on Windows `10.5.1.193` (web UI on port **8099**, API and database not published), including the PowerShell steps, the TLS choice and the preflight checks. The enforced role matrix is documented in [`docs/ROLE_BASED_ACCESS.md`](docs/ROLE_BASED_ACCESS.md).

- Web: http://localhost:5173
- API: http://localhost:4000

### Seeded accounts

Both seeds are for local use only and are blocked when `NODE_ENV=production`. The default development password is `WorkforceDev@2026` and can be changed with `DEV_SEED_PASSWORD` before you run the seed. **A production database therefore starts with no accounts at all** and its first Admin is created once inside the api container: `docker compose --env-file infra/docker/.env.production -f infra/docker/compose.production.yml run --rm api node apps/api/scripts/create-first-admin.mjs` (see `docs/PRODUCTION_DEPLOYMENT.md` 1b, which also covers onboarding the PM team and the HODs).

`npm run db:seed` — the **minimal, production-like bootstrap**: no business data, and no supervisor, HOD or employee login.

| Role | Login |
|---|---|
| Admin | `admin@company.com` |
| Project Head | `pm@company.com` |
| HR | `hr@company.com` |
| Finance | `finance@company.com` |

`npm run db:seed:demo` — the **demonstration set**, which adds the rows above plus these logins and the data the screens and the Playwright tests need:

| Role | Login |
|---|---|
| Employee | `EC1011` |
| Supervisor | `EC1001` |
| HOD | `hod@company.com` |

**Cost rates are not seeded by `db:seed`.** The Cost view of the Summary reads zero until an Admin adds rates with `POST /api/admin/cost-rates`.

Daily hour limit is controlled by `MAX_DAILY_HOURS` in `.env` (default `8`). Overtime requires Remarks, shown to HOD on Approvals.

Default bulk-fill shift windows are set with `SHIFTS` in `.env` (e.g. `GENERAL:09:00-17:00`). Times must fall inside the fixed 8a–8p hour grid; supervisors can Apply that shift to all team employees on the Timesheet screen.

**Approval flow:** Supervisor submit → **HOD** (approve/reject full or partial employees) → **Project Head** (same screen, title changes). Project Head reject returns sheets to HOD “Sent Back by Planning”; HOD can send them back to the supervisor.

Default date filters use **today’s local date**. The demo seed places yesterday’s team for the carry-over demo.

## Master data and reporting

**Project → WBS → Job Order** is the master-data hierarchy. A WBS belongs to one project, and **a Job Order number is unique per project only** — it repeats across projects, so `1900000107` in Project A and in Project C are two different Job Orders. Job Order status is **`Active`** or **`In-Active`** only. A **Network belongs to ONE WBS** of its project: one Network number never spans two WBS rows of the same project, so the Job Order upload checks `Network_ID` against the `WBS_NO` on the same row.

| Capability | Screen | Roles |
|---|---|---|
| **Project Master Data** — tabs Project, WBS, UoM, Network and Job Order; every field carries example help text; a duplicate is refused with a message that names the conflicting row; rows are deactivated instead of deleted. A **Project is deactivated in two steps**: every Job Order of it must be set to **In-Active** first (the API answers `409 PROJECT_HAS_ACTIVE_JOB_ORDERS` and names them, and the screen disables Deactivate while any remains) - ADMIN and PM only. A **Network row needs a WBS** (the tab lists a WBS column), and the **Job Order** tab corrects a Job Order's WBS / Network, offering only the Networks of the chosen WBS | `/master-data` | ADMIN, PM |
| **Job Order Upload** — fixed 12-column CSV template (`Project_ID … Job_Order_Status`); per-row `created` / `skipped` / `rejected` report with the reason; an existing Job Order is **skipped, never overwritten**; it can also **create a missing WBS or Network** from the file (switch on by default, a created Network goes under the WBS on its own row, each creation reported against the line that introduced it). `Network_ID` is checked against the `WBS_NO` **on the same row**: a Network of another WBS of the same project is rejected, and the message names the Network and both WBS codes | `/job-order-upload` | ADMIN, PM |
| **Quantity Progress** — the HOD punches the **cumulative** quantity achieved to date (never a daily increment, and the figure may never go down); the Project Head approves, rejects or sends back; the HOD amends only after a rejection or a send-back, and the refused revision stays as history | `/job-order-progress` | punch: HOD, DEPT_HEAD, ADMIN — decide: PM, ADMIN |
| **Clocked Hours (In/Out)** — ADMIN reads the hours each contract worker actually clocked in and out from LabourWorks (`IDNo` = the employee code the timesheet carries, `ManHours`) and fills `timesheet_days.in_out_hours` next to the booked hours, for submitted sheet only; *Preview (no save)* shows the comparison first. Every submit resets the column to empty, and the job runs at 09:00 and 21:00 (`ATTENDANCE_HOURS_ENABLED`). The view, columns and query are configuration (`ATTENDANCE_DB_*`) | `/attendance-hours` | ADMIN |
| **Booking** — on Daily Timesheet Entry the Department is fixed to the supervisor's own department, the Section is chosen from that department, the Project is chosen, and each Job Order option reads `Job_Order-Job_Description`, capped at 34 characters in every Job Order dropdown (Daily Timesheet Entry and My Hours) so a long description cannot stretch the list. A standing / Non-Project Job Order can be booked by any section of its department | `/timesheet`, `/allocations` | Timesheet: SUPERVISOR, ADMIN — My Hours: EMPLOYEE and SUPERVISOR for themselves, HOD / DEPT_HEAD / PM / HR / ADMIN for others |
| **Job Order Summary** — grouped Project → WBS → Job Order with **both measures side by side**: Budgeted hours / Consumption / Consumption % / Balance and Budget Qty / Achieved Qty / Balance Qty / Qty %. Status filter `All` / `Active` / `In-Active`. A Job Order with no approved progress shows a dash, not `0 %` | Summary → Job Order | every signed-in role except EMPLOYEE |

Reports group by the attribution **frozen when the hours were booked**, so editing a Job Order's mapping later does not move hours that are already in a past report. Full detail, field by field: [`docs/MANUAL.md`](docs/MANUAL.md).

## Monorepo layout

```
apps/api          Express + Prisma API
apps/web          Vite React UI
apps/jobs         Placeholder for Python CLMS/SAP/EOD jobs
database          PostgreSQL database and complete schema SQL
infra/docker      Production Compose and Nginx configuration
packages/shared   Shared Zod schemas & constants
```

## Scripts

| Command | Description |
|---|---|
| `npm run dev:api` | API with hot reload |
| `npm run dev:web` | Vite dev server (proxies API) |
| `npm run db:migrate` | Provider-aware schema step: `prisma db push` on a `file:` URL, `prisma migrate deploy` on PostgreSQL |
| `npm run db:migrate:deploy` | Apply reviewed PostgreSQL migrations |
| `npm run db:seed` | Minimal bootstrap: four office accounts (ADMIN, PM, HR, FINANCE) and no business data; never use in production |
| `npm run db:seed:demo` | Full demo data set (projects, WBS, UoM, networks, Job Orders, employees, supervisors, bookings, cost rates) for local demos and the Playwright tests |
| `npm run test:e2e -w @workforce/web` | Playwright smoke tests |

## Access on your LAN (e.g. Windows IP `10.5.18.209`)

Others on the same network open: **http://10.5.18.209:5173/**

### Recommended: run from Windows PowerShell (not WSL)

WSL2 has its own virtual network; LAN clients usually cannot reach WSL ports via your Windows IP unless you set up port forwarding. Running on Windows binds directly to `10.5.18.209`.

```powershell
cd c:\data\comp\workforce
# If node_modules was installed in WSL, reinstall once on Windows:
# Remove-Item -Recurse -Force node_modules; npm install

# Start Docker Desktop first.
Copy-Item .env.development.example .env
npm run dev:db:up
npm run db:setup      # first time only; applies migrations, then the minimal seed (4 accounts)
npm run db:seed:demo  # optional: the demonstration data
npm run dev:api    # terminal 1 — listens on 0.0.0.0:4000
npm run dev:web    # terminal 2 — listens on 0.0.0.0:5173
```

### Allow Windows Firewall (Admin PowerShell)

```powershell
New-NetFirewallRule -DisplayName "Workforce Web 5173" -Direction Inbound -Protocol TCP -LocalPort 5173 -Action Allow
New-NetFirewallRule -DisplayName "Workforce API 4000" -Direction Inbound -Protocol TCP -LocalPort 4000 -Action Allow
```

(You mainly need **5173**; the UI proxies `/api` to the API on the same PC.)

### If you keep running inside WSL

1. Get WSL IP: `hostname -I` (first address)
2. In **Admin** PowerShell, forward Windows → WSL:

```powershell
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=5173 connectaddress=<WSL_IP> connectport=5173
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=4000 connectaddress=<WSL_IP> connectport=4000
```

3. Add the firewall rules above.
4. Share **http://10.5.18.209:5173/**

### Deferred

Approvals UI, EOD conflict job, CLMS/SAP sync — see `Technical_Project_Plan.md` and `apps/jobs/README.md`.
