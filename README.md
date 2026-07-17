# Workforce — Manpower & Timesheet

React + Node.js (Express/TypeScript) + SQLite (local) app that replicates the Select Team, Daily Timesheet Entry, and Summary screens. Docker Compose is included for optional PostgreSQL when Docker is available.

## Prerequisites

- Node.js 20+
- npm 10+

## Quick start

```bash
npm install
npm run build -w @workforce/shared
npm run db:generate -w @workforce/api
npm run db:migrate -w @workforce/api
npm run db:seed -w @workforce/api

npm run dev:api
npm run dev:web
```

- Web: http://localhost:5173
- API: http://localhost:4000

### Demo login

- Supervisor: `r.sharma@company.com` / `password123`
- HOD (approvals): `hod@company.com` / `password123`
- Project Head: `pm@company.com` / `password123`
- Admin: `admin@company.com` / `password123`

Daily hour limit is controlled by `MAX_DAILY_HOURS` in `.env` (default `8`). Overtime requires Remarks, shown to HOD on Approvals.

Default bulk-fill shift windows are set with `SHIFTS` in `.env` (e.g. `GENERAL:09:00-17:00`). Times must fall inside the fixed 8a–8p hour grid; supervisors can Apply that shift to all team employees on the Timesheet screen.

**Approval flow:** Supervisor submit → **HOD** (approve/reject full or partial employees) → **Project Head** (same screen, title changes). Project Head reject returns sheets to HOD “Sent Back by Planning”; HOD can send them back to the supervisor.

Default date filters use **today’s local date**. Seed data uses yesterday’s team for carry-over demo.

## Monorepo layout

```
apps/api          Express + Prisma API
apps/web          Vite React UI
apps/jobs         Placeholder for Python CLMS/SAP/EOD jobs
packages/shared   Shared Zod schemas & constants
infra/docker      Postgres compose file (optional)
```

## Scripts

| Command | Description |
|---|---|
| `npm run dev:api` | API with hot reload |
| `npm run dev:web` | Vite dev server (proxies API) |
| `npm run db:setup` | Push schema + seed |
| `npm run test:e2e -w @workforce/web` | Playwright smoke tests |

## Access on your LAN (e.g. Windows IP `10.5.18.209`)

Others on the same network open: **http://10.5.18.209:5173/**

### Recommended: run from Windows PowerShell (not WSL)

WSL2 has its own virtual network; LAN clients usually cannot reach WSL ports via your Windows IP unless you set up port forwarding. Running on Windows binds directly to `10.5.18.209`.

```powershell
cd c:\data\comp\workforce
# If node_modules was installed in WSL, reinstall once on Windows:
# Remove-Item -Recurse -Force node_modules; npm install

npm run db:setup   # first time only
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
