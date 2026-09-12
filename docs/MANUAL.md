# Workforce — Application Manual

> **Version:** CR#2 (`feature/cr2-unified-employee`, `666f35b`)
> **Scope:** End-user guide + developer/admin reference for the Workforce timesheet, approvals, OT, summary, and CR#2 unified-Employee + slot-based payroll allocations.

---

## Table of Contents

**Part I — End-User Guide**
1. [Quick start (logins)](#1-quick-start)
2. [Daily Timesheet (Supervisor)](#2-supervisor-daily-timesheet)
3. [Approvals (HOD / PM)](#3-approvals-hod--pm)
4. [My Hours / Allocations (Payroll employees)](#4-my-hours--allocations-payroll)
5. [Supervisor Registration](#5-supervisor-registration)
6. [Departments (admin)](#6-departments-admin)
7. [CSV Upload (admin)](#7-csv-upload-admin)
8. [Summary Reports](#8-summary-reports)
9. [BadgeView Sync](#9-badgeview-sync)

**Part II — Developer / Admin Reference**
10. [Architecture & stack](#10-architecture--stack)
11. [Repository layout](#11-repository-layout)
12. [Local setup (WSL Ubuntu)](#12-local-setup-wsl-ubuntu)
13. [Local setup (PowerShell / Windows)](#13-local-setup-powershell--windows)
14. [Database & migrations](#14-database--migrations)
15. [Environment variables](#15-environment-variables)
16. [Ports & proxy](#16-ports--proxy)
17. [Schema overview (Prisma)](#17-schema-overview-prisma)
18. [API endpoints](#18-api-endpoints)
19. [Security model](#19-security-model)
20. [Troubleshooting](#20-troubleshooting)

---

# Part I — End-User Guide

## 1. Quick start

The Workforce app runs at **`http://localhost:<web-port>`** (usually `5174` on Windows hosts where `5173` is OS-occupied, or `5173` elsewhere). The API runs on **`http://localhost:<api-port>`** (usually `4100` on Windows where `4000` is occupied, or `4000` elsewhere).

Seeded test accounts (password is the same for all: `password@SDHI`):

| Role | Login | Notes |
|---|---|---|
| Supervisor (linked to payroll Employee) | `EC1001` | Submits team timesheets; can self-allocate via "My Hours" |
| Supervisor | `EC1006` | V. Kulkarni |
| Supervisor | `EC1007` | S. Menon |
| Supervisor | `EC1014`, `EC1017`, `EC1018` | Additional supervisors across departments |
| HOD | `hod@company.com` | Dept 56 (Hull Production) — sees only their department's submissions |
| PM (Project Head) | `pm@company.com` | Central authority — sees all departments, final approval after HOD |
| Admin | `admin@company.com` | Global visibility, can act at either stage |
| HR | `hr@company.com` | Read-only on lifecycle (read-only on approval queues) |
| Finance | `finance@company.com` | Cost-rates viewer |

> **Security:** these are **dev-only** credentials. Rotate or disable before any environment that is reachable beyond localhost. In `.env`, set `API_HOST=127.0.0.1` so the API does not bind to the LAN.

---

## 2. Supervisor Daily Timesheet

**Path:** `/timesheet` (top nav: **Daily Timesheet**).

A supervisor manages their team's manhour allocation for a single day. The flow mirrors the payroll allocations model (slot-based, 4 shift slots × 2 h = 8 h max) with **OT applicable for contract workers**.

### 2.1 Layout

- **Date + Department filters** at the top.
- **Per-employee rows** with 4 shift-slot cells (`am1`, `am2`, `pm1`, `pm2`, each 2 h).
- **Project / Work Order dropdowns** below the slot grid (per row).
- **Bulk Assignment block** for selecting multiple slots across employees and applying a single Project + WO.
- **Send Back by Planning** banner (if any previous day was returned).
- **Feedback from HOD** expanded inline per employee.
- **Save Draft / Submit for Approval** footer.

### 2.2 Assigning hours

1. Click an empty slot — it becomes **amber/selected**.
2. Pick **Project** and optional **Work Order** in the dropdowns.
3. Click **Assign** (or use **Bulk Assignment**: select slots → pick project/WO → **Assign to Selected**).
4. The slot fills with the project color.

### 2.3 Reassign / unassign on editable days

On a `DRAFT` or `REJECTED` day, clicking a colored slot re-selects it. Picking a new Project + Work Order and clicking **Assign** replaces the assignment. Use **Remove** on a row to clear that employee's allocations.

On a `SUBMITTED` / approved day the cells are **locked** — only HOD/PM reject can re-open them.

### 2.4 Over-allocation guard

The 8-hour daily cap is structural (only 4 slots × 2 h). Submitting a day with **total > 8 h** triggers `MAX_DAILY_HOURS_REMARKS_REQUIRED` — a **mandatory Remarks** reason is required before submission can succeed.

### 2.5 OT (Overtime)

A supervisor can also assign **OT hours** to a contract-worker (sync employee) on a given date:

1. Click the **OTHRS** cell on an employee row.
2. Modal opens: pick **Project + Work Order** and enter **hours** (1-12, numeric only).
3. **Save OT** — confirm the dialog. OT is **additive** and **separate** from the 8-hour allocation.

### 2.6 Supervisor self-row

Supervisors appear as a **non-removable "You" row** in their own timesheet, so they can allocate their own hours via the same flow. The Remove button is disabled for the self-row.

### 2.7 Submit

Click **Submit for Approval**. If any day exceeds the configured daily cap, a mandatory Remarks reason is required first. After successful submit:

- The day moves to `SUBMITTED` and lands on the **HOD's pending queue** for the supervisor's department.
- The HOD approves → `HOD_APPROVED` → **PM's pending queue** for final approval.
- The PM approves → `PM_APPROVED` (terminal state).

---

## 3. Approvals (HOD / PM)

**Path:** `/approvals` (top nav: **Approvals**).

### 3.1 Routing rules

- **HOD** is **department-scoped**: each Department has its own HOD; HODs see only submissions from supervisors/employees in their department.
- **PM (Project Head)** is a **single central authority**: sees all departments after `HOD_APPROVED`.
- **Admin** is global, can act at either stage.
- **HR** is read-only on the lifecycle (browses the queue but cannot approve/reject).

### 3.2 Two stages

| Stage | From | To | Approver | Effect |
|---|---|---|---|---|
| 1 | `SUBMITTED` | `HOD_APPROVED` | HOD/Admin | moves to PM queue |
| 2 | `HOD_APPROVED` | `PM_APPROVED` | PM/Admin | terminal approval |

Rejection at either stage moves the day to `REJECTED` (supervisor can re-edit and resubmit).

### 3.3 Conflict flag

A day is **flagged** when two or more supervisors have tagged the same employee on the same date. The flag shows the supervisors involved: *"Tagged by S. Menon & R. Sharma — resolve before approving."* Conflict-flagged days cannot be approved until the conflict is resolved at the timesheet level.

### 3.4 Auto-calculated OT in the column

The HOD/PM **OT column** appears dynamically only when at least one employee row has OT. It shows **effective OT** per row:

- **Manual OT wins** if entered via the supervisor's OT modal.
- **Otherwise auto-calculated** as `max(0, trueHours − MAX_DAILY_HOURS)` from multi-supervisor over-allocation.

The OT column is **light-red** with an `auto` tag on derived values so the approver knows what they're approving.

---

## 4. My Hours / Allocations (Payroll)

**Path:** `/allocations` (top nav: **My Hours**).

Payroll employees allocate their own manhours in a slot-based grid (same 4-slot model as the supervisor timesheet).

### 4.1 Flow

1. Pick a **date**.
2. Click an empty slot — pick **Project** (mandatory) and optional **Work Order**.
3. Click **Assign**. Repeat for additional slots with different Project/WO combinations.
4. **Submit for HOD Approval** when the day is complete.

### 4.2 Rules

- **Project is mandatory**, Work Order is optional.
- **OT is NOT applicable** for payroll — the daily cap is **strict 8 hours** (4 slots × 2 h); an attempt to exceed is rejected by the API.
- Slots become **locked** once Submitted; only HOD/PM can re-open them via reject.
- Submit triggers the same `SUBMITTED → HOD_APPROVED → PM_APPROVED` lifecycle as the supervisor timesheet.

### 4.3 Multi-project same-day allocations

A single employee can split a day across multiple projects:

| Project | Work Order | Hours |
|---|---|---:|
| Project A | (optional) | 2 |
| Project C | (optional) | 4 |
| Project D | (optional) | 2 |
| **Total** | | **8** |

The UI renders a per-day breakdown similar to the supervisor's timesheet, and the cap is enforced per the 4-slot model.

### 4.4 HOD/PM allocation-for-others

HOD/PM/Admin/HR can allocate hours **on behalf of any employee** via the same endpoint (role-gated). The dropdown becomes available; self-service users see only their own slots (the server derives the employee from the authenticated user).

---

## 5. Supervisor Registration

**Path:** `/supervisors` (ADMIN/HR-only).

- Add or edit supervisors with **email, name, role, department**.
- **Source badge** shows `Manual` (this app) vs `Sync` (BadgeView).
- **CSV Upload** entry point for bulk registration (next section).
- **★ Pinned** badge marks supervisors promoted to SYNC visibility (manual override).
- **Convert to manual login** on a sync supervisor row sets their `User` row to a real login account with a password.

---

## 6. Departments (admin)

**Path:** `/departments` (ADMIN/HR-only).

- List of all departments (auto-created from BadgeView's `BuName`, plus any manual additions).
- Each row shows **name, code, source** badge (`Auto-created from BuName` vs `Manual`), and **saved-by**.
- **Add/Edit modal** for manual Department management.
- Auto-created departments can be renamed (the rename flips the row to `MANUAL` so the sync never overwrites it).
- The sync never overwrites manual departments — re-runs of the BadgeView sync leave manual edits intact.

---

## 7. CSV Upload (admin)

**Path:** `/admin/csv-upload` (ADMIN/HR-only).

- Drag-and-drop or select a CSV of employee / supervisor registrations.
- Server-side validation per row with **CSV-injection neutralization** (cells starting with `=`, `+`, `-`, `@` are rejected).
- Per-row error feedback in the UI.
- **Template download** available for the expected column format.
- File-type / size limits enforced server-side.
- Audited via the standard `writeAudit` path.

---

## 8. Summary Reports

**Path:** `/summary` (top nav: **Summary**).

- **Project Summary** — hours by project (A/B/C/D…) for the selected date / week / month.
- **Group by Employee / Supervisor / Department / Totals** — switchable.
- **Project filter** — multi-select dropdown that filters per project column.
- **OT column** — dynamic, auto-hides when no row has OT. Shows **effective OT** (manual or auto-derived) for **approved days only**.
- **Grand total** = sum of hours per row (excluding OT).
- **Mobile parity** — table collapses to cards at the ≤1023 px breakpoint.

### 8.1 Job Order Summary

A complementary view (top of the Summary page) showing each job order's **consumed hours, approved hours, budgeted hours, and % consumption**. Filter by status (`active` / `closed` / `all`) and department.

---

## 9. BadgeView Sync

Source-of-truth for **contract workers and supervisors** is the external **LabourWorks BadgeView** (`10.5.1.106`).

- **Twice-daily** (`0 6,18 * * *`) — controlled by `BADGEVIEW_SYNC_ENABLED` and `BADGEVIEW_SYNC_CRON` in `.env`.
- Re-upserts unified `Employee` rows keyed by `idCardNo`. Soft-departs rows absent from the latest snapshot (`active = false`) rather than deleting (preserves historical OT / allocation history).
- Surfaces supervisors via the `User` table (read-only `source='SYNC'` accounts).
- Auto-creates **Departments** from distinct `BuName` values (never overwrites manually-managed ones).
- Only writes to SYNC rows; never overwrites MANUAL / PAYROLL fields (the partial-write guard).
- Cardinalities preserved on re-runs: 555 associates / 27 supervisors baseline.

---

# Part II — Developer / Admin Reference

## 10. Architecture & stack

- **Monorepo**: npm workspaces (`apps/api`, `apps/web`, `apps/jobs`, `packages/shared`).
- **Backend**: Node 22 + Express + TypeScript + Prisma + SQLite (dev). Auth: bcrypt + JWT. Slot-based timesheets + slot-based allocations.
- **Frontend**: React + Vite + TypeScript. React Router. Mobile-first responsive layout at the ≤1023 px breakpoint.
- **Shared types**: Zod schemas and TS types in `packages/shared` (consumed by both api and web).
- **Sync**: in-process cron (`node-cron` inside the API process) for the BadgeView source.

## 11. Repository layout

```
workforce/
├── apps/
│   ├── api/        # Express + Prisma + cron
│   │   ├── prisma/         # schema.prisma, migrations, seed.ts
│   │   ├── src/
│   │   │   ├── routes/     # auth, timesheet, approvals, employeeAllocation, etc.
│   │   │   ├── services/   # badgeViewSync, hours, editLock, audit
│   │   │   └── db.ts
│   ├── web/        # React + Vite
│   │   ├── src/
│   │   │   ├── pages/      # TimesheetPage, ApprovalsPage, AllocationsPage, ...
│   │   │   ├── hooks/      # useWorkContext, useAuth
│   │   │   ├── styles/     # timesheet.css, approvals.css, ...
│   │   │   └── api/        # fetch client + ApiError
│   ├── jobs/       # placeholder for future standalone jobs
├── packages/
│   └── shared/     # Zod schemas, TS types (bulkAssignSchema, ShiftSlot, ...)
├── docs/
│   └── MANUAL.md   # this file
├── .env            # API_PORT, API_HOST, DATABASE_URL, BADGEVIEW_DB_*, ...
└── package.json    # workspaces, db:setup, db:seed, dev:api, dev:web
```

## 12. Local setup (WSL Ubuntu)

```bash
cd /mnt/c/data/comp/workforce

# Install Linux-native node via nvm (recommended; avoids Windows interop issues)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install --lts
nvm use --lts

# Install dependencies + set up DB
npm install
npm run db:setup        # build shared, generate Prisma client, db push, seed

# Terminal 1 — API (use a free port on Windows: 4000 is svchost-owned → use 4100)
$env:API_PORT="4100"
$env:API_HOST="127.0.0.1"
npm run dev:api

# Terminal 2 — Web
npm run dev:web          # Vite picks a free port (5173 → 5174 if 5173 is taken)
```

Open `http://localhost:5174/` (or whichever port Vite reports) and log in as one of the seeded accounts.

## 13. Local setup (PowerShell / Windows)

```powershell
cd C:\data\comp\workforce

npm install
npm run db:setup

# Terminal 1 — API. Port 4000 may be OS-occupied by svchost; use 4100 if so.
$env:API_PORT="4100"
$env:API_HOST="127.0.0.1"
npm run dev:api

# Terminal 2 — Web. Vite may pick 5174 if 5173 is svchost-owned.
npm run dev:web

# If Vite picks 5174, also update apps/web/vite.config.ts to point at 4100
# (the proxy target must match the API_PORT).
```

## 14. Database & migrations

- **Dev DB**: SQLite at `apps/api/prisma/dev.db`.
- **Migrations** live under `apps/api/prisma/migrations/`. Apply with `npm run db:migrate -w @workforce/api` (alias for `prisma db push`).
- **Seed** with `npm run db:seed -w @workforce/api` (alias for `tsx prisma/seed.ts`). Wipes all tables first, then re-creates departments, projects (incl. Project D), job orders, employees, supervisors, ADMIN/HOD/PM/HR/FINANCE accounts, and timesheet/OT/approval data.
- **Reset DB**: `npm run db:seed` (or `npm run db:setup` for full setup). The seed's `deleteMany` chain runs in the correct FK order so child tables are removed before parents (including CR#2's `EmployeeAllocation` and `SupervisorPin`).

### Schema highlights

- **CR#2 unified `Employee`** (`apps/api/prisma/schema.prisma`): absorbs the old `ContractWorker` table, with `source` (`SYNC` / `MANUAL` / `PAYROLL`), `idCardNo`, `section`, `plant`, `grade`, `active`. Sync writes only to SYNC rows (partial-write guard); never overwrites MANUAL/PAYROLL fields.
- **`EmployeeAllocationDay`** (parent per employee/day) with `status` and audit timestamps.
- **`EmployeeAllocation`** (child rows) keyed by `(allocationDayId, shiftSlot)`, mandatory `projectId`, optional `jobOrderId`, no OT field. `allocatedById` is server-derived from `req.user`.
- **`SupervisorPin`** tracks manual supervisor promotions.
- Migration `20260905000000_employee_allocation_slot_model` introduced the slot model.

## 15. Environment variables

`.env` (root) and `apps/api/.env`:

| Var | Purpose | Default |
|---|---|---|
| `DATABASE_URL` | Prisma DB connection | `file:./dev.db` |
| `API_PORT` | API port | `4000` (use `4100` on Windows) |
| `API_HOST` | Bind interface | `0.0.0.0` (set to `127.0.0.1` for local-only) |
| `MAX_DAILY_HOURS` | Daily cap for over-allocation guard | `8` |
| `MAX_OT_HOURS` | OT validation upper bound | `12` |
| `SHIFTS` | Shift window config | `GENERAL:09:00-17:00` |
| `BADGEVIEW_SYNC_ENABLED` | Enable sync cron | `true` |
| `BADGEVIEW_SYNC_CRON` | Sync schedule | `0 6,18 * * *` |
| `BADGEVIEW_DB_HOST` | Source SQL Server | `10.5.1.106` |
| `BADGEVIEW_DB_USER` / `_PASSWORD` / `_NAME` / `_VIEW` | Source credentials | (set in `.env`, git-ignored) |
| `BADGEVIEW_DB_ENCRYPT` | TLS to source | `false` (internal segment only) |

## 16. Ports & proxy

- **API**: `API_PORT` (default `4000`; use `4100` if `4000` is OS-occupied).
- **Vite web**: `apps/web/vite.config.ts` `server.port` (default `5173`; Vite auto-falls-back to `5174` if taken).
- **Vite proxy target**: must match `API_PORT`. If you change one, change the other.
- Common Windows issue: `4000` and `5173` may be held by `svchost` — pick free ports (`4100`, `5174`) and update the proxy.

## 17. Schema overview (Prisma)

Key models in `apps/api/prisma/schema.prisma`:

- `Department`, `Project`, `ProjectWbs`, `JobOrder`
- `Employee` (unified, CR#2)
- `User` (login accounts; role-gated; `source` for sync vs manual)
- `SupervisorPin` (CR#2 manual supervisor promotion)
- `TimesheetDay` + `TimesheetEntry` (contract-worker timesheets, with OT)
- `EmployeeAllocationDay` + `EmployeeAllocation` (CR#2 slot-based payroll allocations, no OT)
- `Approval`, `AuditLog`, `DailyTeamSelection`, `ManpowerRequest`, `CostRate`, `AttendanceFeed`, `Conflict`

## 18. API endpoints

Selected routes (all under `/api/`):

| Path | Method | Roles | Purpose |
|---|---|---|---|
| `/auth/login` | POST | (public) | JWT login |
| `/auth/me` | GET | auth | Current user |
| `/timesheet?supervisor_id=&date=` | GET | owner | Timesheet rows for a date |
| `/timesheet/day` | PUT | owner / editable | Save draft |
| `/timesheet/ot` | PUT | owner / editable | Add or clear OT |
| `/timesheet/submit` | POST | owner / editable | DRAFT → SUBMITTED |
| `/timesheet/bulk-assign` | POST | owner / editable | Bulk slot assignment |
| `/timesheet/entry` | PUT | owner / editable | Per-slot assignment |
| `/approvals/pending` | GET | HOD/PM/ADMIN/HR | Role-aware, department-scoped queue |
| `/approvals/:id/approve` | POST | HOD/PM/ADMIN | Stage-scoped approve |
| `/approvals/:id/reject` | POST | HOD/PM/ADMIN | Stage-scoped reject |
| `/approvals/job-order-consumption` | GET | approver | Grouped by Project → JobOrder |
| `/allocations` | GET | auth | List allocations (server-derives `employeeId` for self-service) |
| `/allocations/slot` | POST | owner | Atomic per-slot assign (server-validates ≤8 h, status-lock) |
| `/allocations/slot/:id` | DELETE | owner | Remove slot |
| `/allocations/submit` | POST | owner | DRAFT → SUBMITTED; rejects over-cap |
| `/allocations/:dayId/approve` | POST | HOD/PM/ADMIN | Stage-scoped approve |
| `/allocations/:dayId/reject` | POST | HOD/PM/ADMIN | Stage-scoped reject |
| `/allocations/pending` | GET | HOD/PM/ADMIN/HR | Role-aware, department-scoped queue |
| `/summary` | GET | auth | Hours by project/employee/supervisor/department; effective OT |
| `/summary/job-order` | GET | auth | Job-order consumption |
| `/projects` | GET | auth | Project master list |
| `/job-order` | GET | auth | Job-order list (filter by project / status / department) |
| `/supervisors?department_id=` | GET | auth | Supervisor list |
| `/employees?department_id=` | GET | auth | Employee list (department-scoped) |
| `/departments` | GET/POST | admin/HR | Master departments (manual CRUD) |
| `/admin/csv-upload` | POST | admin/HR | Bulk CSV registration |
| `/master/supervisors` | GET | auth | (Admin) supervisor master |

All write routes enforce **owner + role + status-lock + audit** via shared middleware.

## 19. Security model

- **Owner enforcement** — supervisors only edit their own timesheets/allocations (`NOT_OWNER` 403 otherwise). HOD/PM/Admin can act on behalf.
- **Status lock** — once `SUBMITTED` / approved, the day is locked from edits except via HOD/PM reject.
- **Department isolation** — HODs see only their own department's pending queue; cross-department approve attempts return `403 FORBIDDEN`.
- **Stage isolation** — PM cannot approve `SUBMITTED` days directly (returns `403 WRONG_STAGE`); only HOD can.
- **HR read-only** — HR can browse queues but cannot approve/reject (any attempt returns `403 WRONG_STAGE`).
- **Audit** — every write goes through `writeAudit` with actor, action, entity, before/after.
- **Fail-closed null department** — HOD/HR with `departmentId = null` get empty queues and `403` on mutation, never global access.
- **CSV-injection neutralization** — `=`, `+`, `-`, `@`-prefixed cells are rejected on CSV upload.
- **Partial-write guard** — BadgeView sync only writes to SYNC rows; never overwrites MANUAL / PAYROLL fields.
- **Soft-depart** — departed workers are kept in the unified `Employee` with `active = false` (preserves historical OT / allocation / approval history), hidden from pickers.

### 19.1 Production deployment checklist (mandatory)

Before exposing this app to any network beyond localhost, complete every item below:

- [ ] **`API_HOST=127.0.0.1`** — bind the API to localhost only, OR place it behind a reverse proxy that terminates **TLS/HTTPS** (Caddy / nginx / Cloudflare Tunnel / etc.). Never serve plaintext HTTP on a reachable interface.
- [ ] **Rotate or disable seeded `password@SDHI` accounts** in any environment that's reachable beyond localhost. Treat them as dev-only fixtures.
- [ ] **`.env` is git-ignored** — verified before every commit. Production credentials (`BADGEVIEW_DB_PASSWORD`, `JWT_SECRET`, any DB URL with embedded passwords, any third-party API keys) must **never** be committed or pasted into chat transcripts / logs.
- [ ] **`BADGEVIEW_DB_ENCRYPT`** — set to `true` if the source SQL Server is reachable beyond a trusted internal segment.
- [ ] **Audit logs are rotated and backed up** off-host — `AuditLog` is the only record of who approved what.
- [ ] **Run the latest migration** — the SQLite `dev.db` is dev-only; production must use a managed DB (Postgres recommended) with `prisma migrate deploy` rather than `db push`.

### 19.2 Credential hygiene

- `.env` is in `.gitignore`; do not commit it. Do not paste its contents into chat, screenshots, or issue trackers.
- Rotate the `JWT_SECRET` (if configured) and the seeded admin password before any production deploy.
- Source DB credentials (`BADGEVIEW_DB_PASSWORD`) belong only in the runtime `.env` of the deploy host — never in code, comments, or transcripts.
- If a credential is exposed (e.g. typed into chat), revoke it immediately and rotate.

## 20. Troubleshooting

### App won't start — `EADDRINUSE` on 4000 or 5173
- On Windows, `svchost` often holds 4000 and 5173. Use `API_PORT=4100` and let Vite auto-fallback to `5174`. Update `apps/web/vite.config.ts` proxy target to match.

### `Cannot find module '@rollup/rollup-win32-x64-msvc'`
- npm 12 optional-deps bug. Fix:
  ```bash
  rm -rf node_modules package-lock.json
  npm install
  npm install --save-optional @rollup/rollup-win32-x64-msvc
  ```

### Prisma `Cannot find module '@prisma/client'`
- After `rm -rf node_modules`, regenerate:
  ```bash
  npm run db:generate -w @workforce/api
  ```

### Migration asks to reset the DB
- Don't accept `y` unless intentional. The fix is to backfill required columns on existing rows:
  ```bash
  node -e "/* one-time backfill script — see docs/MANUAL.md#migrations */"
  npm run db:push -w @workforce/api
  ```

### Vite proxy `ECONNRESET`
- Proxy target mismatch. `apps/web/vite.config.ts` `target:` must equal `API_PORT`. Restart Vite after editing.

### Self-allocation fails with "employeeId required"
- Server-derive fix is on `feature/cr2-unified-employee` (commit `ef723a7` and later). Ensure you're on that branch and have rebuilt the API dist.

### OT not showing in Summary
- Summary OT is approved-days-only and uses effective OT (manual OR `max(0, trueHours − 8)`). Check that the day is in `PM_APPROVED` status (final stage) and that the employee actually had 8+ hours (or manual OT) that day.

### HR can see approvals but cannot approve
- HR is intentionally read-only on the lifecycle. This matches the user's spec that HR is not an approver.

### `BADGEVIEW_DB_*` sync fails to connect
- Verify `.env` has `BADGEVIEW_DB_HOST=10.5.1.106`, port `1433`, and the correct user/password. `BADGEVIEW_DB_ENCRYPT=false` is fine for internal segments only.

---

## Appendix A — Glossary

- **HOD** — Head of Department. Owns stage-1 approval for their department.
- **PM** — Project Manager / Project Head. Stage-2 approver, global (cross-department) view.
- **Admin / HR** — Admin = global visibility, can act at either stage. HR = read-only.
- **SUBMITTED / HOD_APPROVED / PM_APPROVED / REJECTED** — stages of the approval lifecycle.
- **Shift slot** — one of `am1`, `am2`, `pm1`, `pm2`; each is 2 hours.
- **Effective OT** — `manual ?? max(0, trueHours − MAX_DAILY_HOURS)`. Manual wins; otherwise auto-calc.
- **Source (`SYNC` / `MANUAL` / `PAYROLL`)** — `SYNC` = BadgeView-imported (no login); `MANUAL` = admin-registered login; `PAYROLL` = payroll employee with login.
- **Partial-write guard** — sync only writes identity/source/`active` on SYNC rows; never overwrites MANUAL/PAYROLL fields.

---

## Appendix B — Test accounts cheat sheet

```
ADMIN       admin@company.com
HOD         hod@company.com            (dept 56 Hull Production)
PM          pm@company.com             (single central authority)
HR          hr@company.com             (read-only on lifecycle)
Finance     finance@company.com         (cost-rates viewer)
Supervisor  EC1001       (linked payroll Employee)
Supervisor  EC1006                     (V. Kulkarni)
Supervisor  EC1007                     (S. Menon)
Supervisor  EC1014
Supervisor  EC1017
Supervisor  EC1018
```

Password (all): `password@SDHI`

---

_Document version: CR#2 (`feature/cr2-unified-employee`, `666f35b`). Maintained alongside the codebase; update when schema, routes, or lifecycle change._
