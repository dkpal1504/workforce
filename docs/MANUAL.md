# Workforce — Application Manual

> **Version:** CR#2 unified Employee + HOD scope + HOD approval cover (`feature/cr2-unified-employee`, `6f3eea4`)
> **Scope:** End-user guide + developer/admin reference for the Workforce timesheet, approvals, OT, summary, CR#2 unified-Employee + slot-based payroll allocations, HOD registration/scope and HOD approval cover (delegation).
> **Databases:** local development/testing runs on **SQLite**; production runs on **PostgreSQL** (`prisma migrate deploy`). See [14](#14-database--migrations) and [docs/DEV_SQLITE_TESTING.md](DEV_SQLITE_TESTING.md).

---

## Table of Contents

**Part I — End-User Guide**
1. [Quick start (logins)](#1-quick-start)
2. [Daily Timesheet (Supervisor)](#2-supervisor-daily-timesheet)
3. [Approvals (HOD / PM)](#3-approvals-hod--pm)
4. [My Hours / Allocations (Payroll employees)](#4-my-hours--allocations-payroll)
5. [Employee Registration (Admin/PM/HOD)](#5-employee-registration)
6. [HOD Registration &amp; Department/Section Mapping](#6-hod-registration--departmentsection-mapping)
7. [HOD Approval Cover (delegation)](#7-hod-approval-cover-delegation)
8. [Supervisor Registration](#8-supervisor-registration)
9. [Departments (admin)](#9-departments-admin)
10. [CSV Upload (admin)](#10-csv-upload-admin)
11. [Summary Reports](#11-summary-reports)
12. [BadgeView Sync](#12-badgeview-sync)

**Part II — Developer / Admin Reference**
13. [Architecture & stack](#13-architecture--stack)
14. [Repository layout](#14-repository-layout)
15. [Local setup (WSL Ubuntu)](#15-local-setup-wsl-ubuntu)
16. [Local setup (PowerShell / Windows)](#16-local-setup-powershell--windows)
17. [Database & migrations](#17-database--migrations)
18. [Environment variables](#18-environment-variables)
19. [Ports & proxy](#19-ports--proxy)
20. [Schema overview (Prisma)](#20-schema-overview-prisma)
21. [API endpoints](#21-api-endpoints)
22. [Security model](#22-security-model)
23. [Troubleshooting](#23-troubleshooting)

---

# Part I — End-User Guide

## 1. Quick start

The Workforce app runs at **`http://localhost:<web-port>`** (usually `5174` on Windows hosts where `5173` is OS-occupied, or `5173` elsewhere). The API runs on **`http://localhost:<api-port>`** (usually `4100` on Windows where `4000` is occupied, or `4000` elsewhere).

Seeded test accounts. **The password differs by account type** — this is the most common login problem:

| Password | Applies to |
|---|---|
| `WorkforceDev@2026` | The seeded demo accounts below (ADMIN, HOD, PM, HR, FINANCE, EMPLOYEE, and the seeded supervisors). Override with `DEV_SEED_PASSWORD` before `npm run db:seed`. |
| `password@SDHI` | Accounts provisioned by the LabourWorks sync (log in with the EcNo, e.g. `BAPL0251`) **and, while the app is still pre-production, every account registered from the web UI** — Employee, Supervisor and HOD registration all start on `password@SDHI` with no forced change. On a dev box, set one with `node apps/api/set-dev-password.cjs <ecNo>`. Removed before production: the API build fails while the dev bootstrap password is still in the source. |

| Role | Login | Notes |
|---|---|---|
| Employee | `EC1011` (or `employee@company.com`) | Payroll "My Hours" self-allocation |
| Supervisor (linked to payroll Employee) | `EC1001` (or `r.sharma@company.com`) | Submits team timesheets; can self-allocate via "My Hours" |
| Supervisor | `EC1006`, `EC1007`, `EC1014`, `EC1017`, `EC1018` | `sup.a` … `sup.e@company.com` |
| HOD | `hod@company.com` | Seeded example — mapped to Production - EOU / Hull Production |
| PM (Project Head) | `pm@company.com` | Central authority — sees all departments, final approval after HOD |
| Admin | `admin@company.com` | Global visibility, can act at either stage |
| HR | `hr@company.com` | Legacy screens only (CSV upload, supervisor registration); not a workforce approver |
| Finance | `finance@company.com` | Cost-rates viewer |

> **Security:** these are **dev-only** credentials. Rotate or disable before any environment that is reachable beyond localhost. In `.env`, set `API_HOST=127.0.0.1` so the API does not bind to the LAN.

> **Login throttling:** the API rate-limits `/api/auth/login` to 10 attempts per 15 minutes per IP. For local testing only, set `AUTH_RATE_LIMIT_ENABLED=false` in `.env` (the API refuses to start that way when `NODE_ENV=production`). A `429 RATE_LIMITED` response means the limiter tripped, not a bad password.

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

A supervisor can also assign **OT hours** to a contract workman (CLMS employee) on a given date:

1. Select the **OT** cell on the employee row.
2. Enter whole OT hours (1-12), select the **Project + WBS / Job Order**, and enter mandatory Remarks.
3. Click **Assign**, then submit the timesheet through the normal approval flow.

For holiday attendance, OT may be entered without selecting any regular shift slot. The complete entered time is booked as project OT and overhead is `0`. On a mixed regular-plus-OT day, OT stays additive and unused regular capacity retains its normal overhead calculation. OT entry is disabled and rejected for Payroll Employees.

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

- **HOD** is scoped to a **Department + Section** (`User.departmentId` + `User.sectionId`), matched against the employee's organisation. Each Section has its own HOD; HODs see only submissions for their Section. An HOD with no mapping fails closed (empty queue, `403` on mutation).
- **PM (Project Head)** is the central authority: sees all departments once `HOD_APPROVED`.
- **Admin** is global and can act at either stage.
- **HR** is *not* a workforce approver: `/approvals/*` is gated to HOD/PM/ADMIN. HR keeps the legacy admin screens (CSV upload, supervisor registration) only.
- **Approval cover** — an HOD may name another HOD of the same Section as cover; see [7](#7-hod-approval-cover-delegation). The cover record does not change who is authorized, only who is formally standing in.

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

## 5. Employee Registration

**Path:** `/employees` (roles: HOD, PM, ADMIN — gated by `canCreatePayrollEmployee`).

- **Register Payroll Employee** form: canonical `ecNo`, full name, Department, Section, designation, category, mobile, optional login email.
- Registration creates the **canonical `Employee` row and an `EMPLOYEE` login account in one transaction**, and queues a one-time credential. There is no separate "create login" step.
- **HOD scope is fail-closed**: if the logged-in user is an HOD, Department and Section are locked to their own mapping (server-enforced with `WRONG_SCOPE`), and the form is disabled with a banner when the HOD has no mapping.
- **Active Employees** table (bottom panel) lists every active employee with ecNo, name, type/role, Department, Section and designation, plus two actions per row:
  - **Transfer** (PM/ADMIN only) — moves the employee's Department/Section. HOD-linked rows are refused (`HOD_SCOPE_REQUIRES_COORDINATION`).
  - **Set as HOD** / **Change HOD scope** (PM/ADMIN) — pre-fills the HOD form below with that employee.
- A plain **registration always creates an `EMPLOYEE` account**; that is the normal starting point for promotion to HOD — the person is reused, not duplicated.

---

## 6. HOD Registration &amp; Department/Section Mapping

**Path:** `/employees` → panel **HOD Registration & Department / Section Mapping** (PM/ADMIN).

An HOD is **not created from a blank form**: it is an existing active **payroll** Employee promoted to a Department/Section scope. HODs log in with their **ecNo**.

### 6.1 Registering an HOD

1. Register the person under **Register Payroll Employee** if they are not in the system (or press **Set as HOD** on their row in the Active Employees table).
2. In the HOD panel pick **Department**, optionally **Filter by Section**, then the **Employee** (the picker offers active payroll employees of that Department with an `EMPLOYEE` or `HOD` account), then the **Section (HOD scope)**.
3. Press **Register HOD**.

`POST /api/admin/hods` does this atomically: it promotes the existing `EMPLOYEE` account in place (or creates an `HOD` account when the employee had none), links the Employee's Section assignment when missing, bumps `tokenVersion` so stale sessions die, and queues a one-time credential. Re-posting the same employee updates the scope.

A bulk-CSV-imported employee has **no** account yet; the same panel creates one.

### 6.2 Mapping rules (fail-closed)

| Condition | Result |
|---|---|
| CLMS contract worker, or any non-payroll Employee | `400 INVALID_EMPLOYEE` — CLMS logins are not EcNo-based, so an HOD account for one cannot work |
| Employee already holds a SUPERVISOR/ADMIN/HR/PM/FINANCE account | `409 ROLE_CONFLICT` |
| Employee's Department ≠ selected Department | `400 WRONG_DEPARTMENT` |
| Employee's Section ≠ selected Section | `400 WRONG_SECTION` |
| Section inactive or not in that Department | `400 INVALID_SCOPE` |
| Employee inactive | `409 INACTIVE_EMPLOYEE` |

Each HOD has exactly **one** Department + Section (`User.departmentId` + `User.sectionId`), matched against the employee's organisation by `hodScopeMatches`. To move an HOD, use **Map scope** on the HOD table, or register the same employee again with the new Section.

### 6.3 Credentials

New and re-scoped HOD accounts receive an **unknown random password** plus a queued `credential_deliveries` row. Nothing is e-mailed while `CREDENTIAL_DELIVERY_ENABLED=false`, so on a dev box set a password explicitly:

```bash
node apps/api/set-dev-password.cjs EC1013            # -> password@SDHI
node apps/api/set-dev-password.cjs EC1013 MyPass@1
```

---

## 7. HOD Approval Cover (delegation)

**Path:** `/approvals` → panel **HOD Approval Cover (delegation)** (HOD, PM, ADMIN).

An HOD who is away can name another HOD of the **same Section** as approval cover. Delegation does **not** change approval authorization — `hodScopeMatches` is Department+Section based, so a second HOD of that Section could already approve. The record makes the cover explicit, date-bounded and auditable, and shows who is standing in.

| Rule | Behaviour |
|---|---|
| Who may create | PM and ADMIN for **any** Department/Section; an HOD only for its **own** (`403 WRONG_SCOPE` otherwise) |
| Who may be the delegate | An active `HOD` already mapped to that same Department/Section (`400 INVALID_DELEGATE` otherwise) |
| Period | `fromDate`/`toDate` required and ordered (`400 INVALID_RANGE`); same delegate+Section overlap rejected (`409 OVERLAPPING_DELEGATION`) |
| Reason | Mandatory (`400 REASON_REQUIRED`) |
| Delegator's own rights | Unchanged — the HOD keeps approving its own Section |
| Revoke | Delegator, PM or ADMIN (`DELETE /api/delegations/{id}`); already revoked → `409` |

A deputy sees a banner on Approvals — *"You are acting as deputy HOD for IT until …"* — and the delegator sees who is covering. Every create/revoke writes `HOD_DELEGATION_CREATE` / `HOD_DELEGATION_REVOKE` to the audit log.

> A Section needs **two** HODs for cover to be possible. In a single-HOD Section, register a second payroll employee of that Section as HOD first.

---

## 8. Supervisor Registration

**Path:** `/supervisors` (ADMIN/HR-only).

- Add or edit supervisors with **email, name, role, department**.
- **Source badge** shows `Manual` (this app) vs `Sync` (BadgeView).
- **CSV Upload** entry point for bulk registration (next section).
- **★ Pinned** badge marks supervisors promoted to SYNC visibility (manual override).
- **Convert to manual login** on a sync supervisor row sets their `User` row to a real login account with a password.

---

## 9. Departments (admin)

**Path:** `/departments` (ADMIN/HR-only).

- List of all departments (auto-created from BadgeView's `BuName`, plus any manual additions).
- Each row shows **name, code, source** badge (`Auto-created from BuName` vs `Manual`), and **saved-by**.
- **Add/Edit modal** for manual Department management.
- Auto-created departments can be renamed (the rename flips the row to `MANUAL` so the sync never overwrites it).
- The sync never overwrites manual departments — re-runs of the BadgeView sync leave manual edits intact.

---

## 10. CSV Upload (admin)

**Path:** `/admin/csv-upload` (ADMIN/HR-only).

- Drag-and-drop or select a CSV of employee / supervisor registrations.
- Server-side validation per row with **CSV-injection neutralization** (cells starting with `=`, `+`, `-`, `@` are rejected).
- Per-row error feedback in the UI.
- **Template download** available for the expected column format.
- File-type / size limits enforced server-side.
- Audited via the standard `writeAudit` path.

---

## 11. Summary Reports

**Path:** `/summary` (top nav: **Summary**).

- **Project Summary** — hours by project (A/B/C/D…) for the selected date / week / month.
- **Group by Employee / Supervisor / Department / Totals** — switchable.
- **Project filter** — multi-select dropdown that filters per project column.
- **OT column** — dynamic, auto-hides when no row has OT. Shows **effective OT** (manual or auto-derived) for **approved days only**.
- **Grand total** = sum of hours per row (excluding OT).
- **Mobile parity** — table collapses to cards at the ≤1023 px breakpoint.

### 11.1 Job Order Summary

A complementary view (top of the Summary page) showing each job order's **consumed hours, approved hours, budgeted hours, and % consumption**. Filter by status (`active` / `closed` / `all`) and department.

---

## 12. BadgeView Sync

Source-of-truth for **contract workers and supervisors** is the external **LabourWorks BadgeView** (`10.5.1.106`).

- **Twice-daily** (`0 6,18 * * *`) — controlled by `BADGEVIEW_SYNC_ENABLED` and `BADGEVIEW_SYNC_CRON` in `.env`.
- Re-upserts unified `Employee` rows keyed by the canonical **`ecNo`** (LabourWorks `IDCardNo`). The old `idCardNo` column was retired.
- **Completeness guards** run before any write: a snapshot below `BADGEVIEW_SYNC_MIN_ROWS` or below `BADGEVIEW_SYNC_MIN_RATIO` (default 0.9) of the existing SYNC population aborts the run. Absence from a validated snapshot is a soft-depart (`active = false`) that preserves history, never a delete.
- **Identity is never guessed**: duplicate source EcNo, EcNo collisions with non-CLMS rows, and mobile numbers matching more than one candidate are recorded in `sync_exceptions` (`DUPLICATE_SOURCE_ECNO`, `ECNO_SOURCE_COLLISION`, `MOBILE_IDENTITY_CONFLICT`, …) and skipped for review in **Admin → Sync Exceptions**.
- Surfaces supervisors from `Nature Of Work = Supervisor`; new SUPERVISOR accounts get an unknown random password plus a queued credential e-mail.
- Auto-creates **Departments and Sections** from `BuName - Division` / `Workmen Section` (never overwrites manually-managed ones).
- Only writes to SYNC rows; never overwrites MANUAL / PAYROLL fields (the partial-write guard). A PM/Admin organisation transfer creates a durable override so the next sync does not undo it.
- One-off runs on the dev box: `node apps/api/run-sync-once.cjs` (see `docs/DEV_SQLITE_TESTING.md`) — same service, with a known dev password and no e-mail.

---

# Part II — Developer / Admin Reference

## 13. Architecture & stack

- **Monorepo**: npm workspaces (`apps/api`, `apps/web`, `apps/jobs`, `packages/shared`).
- **Backend**: Node 22 + Express + TypeScript + Prisma. Auth: bcrypt + JWT. Slot-based timesheets + slot-based allocations.
- **Databases**: **SQLite** for local development/testing (`file:./dev.db`), **PostgreSQL** for production. The datasource provider in `schema.prisma` selects one; the production schema is kept in `schema.postgresql.prisma`. The API refuses a `file:` URL when `NODE_ENV=production`.
- **Frontend**: React + Vite + TypeScript. React Router. Mobile-first responsive layout at the ≤1023 px breakpoint. The session is held in `sessionStorage` (`workforce_token`, `workforce_user`).
- **Shared types**: Zod schemas and TS types in `packages/shared` (consumed by both api and web).
- **Sync**: in-process cron (`node-cron` inside the API process) for the BadgeView source.

## 14. Repository layout

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

## 15. Local setup (WSL Ubuntu)

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

## 16. Local setup (PowerShell / Windows)

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

## 17. Database & migrations

**Development / testing runs on SQLite; production runs on PostgreSQL.**

- **Dev DB**: SQLite at `apps/api/prisma/dev.db` (git-ignored). `DATABASE_URL="file:./dev.db"` in **both** the root `.env` and `apps/api/.env` — the API loads the root file first, so change both.
- **`npm run db:migrate` is provider-aware** (`apps/api/scripts/migrate.mjs`): a `file:` URL runs `prisma db push` (the PostgreSQL migrations cannot be applied to SQLite), a `prisma://`/`postgresql://` URL runs `prisma migrate deploy` exactly as production does. No production behaviour is special-cased.
- **Migrations** live under `apps/api/prisma/migrations/` and are **PostgreSQL**; `migration_lock.toml` is `postgresql`. Never regenerate or delete them to make SQLite work.
- **Production schema**: `apps/api/prisma/schema.postgresql.prisma` holds the PostgreSQL datasource variant. Restore with `cp apps/api/prisma/schema.postgresql.prisma apps/api/prisma/schema.prisma` then `npm run db:generate`.
- **Seed** with `npm run db:seed -w @workforce/api`. It is **destructive** (a `deleteMany` chain in FK order) and refuses to run when `NODE_ENV=production`.
- **Reset DB**: `npm run db:seed`, or `npm run db:setup` for the full path (shared build → `prisma generate` → provider-aware schema step → seed).
- **Adding a model on the dev box?** `prisma db push` writes **no** migration, so production would never get the table. Generate the DDL with `prisma migrate diff --from-schema-datamodel <old>.pg --to-schema-datamodel <new>.pg --script` and commit it under `migrations/<timestamp>_<name>/`.

Full dev-on-SQLite recipe, helper scripts and rollback notes: [`docs/DEV_SQLITE_TESTING.md`](DEV_SQLITE_TESTING.md).

### Schema highlights

- **CR#2 unified `Employee`**: `source` (`SYNC` / `MANUAL` / `PAYROLL`), `employmentType` (`CLMS` / `PAYROLL`), canonical `ecNo`, `natureOfWork`, `grade`, `active` (soft-depart). The old `ContractWorker`, `idCardNo`, `section` and `plant` columns were retired.
- **`EmployeeSectionAssignment`** (one Section per employee), **`EmployeeOrganisationOverride`** (durable PM/Admin transfer that the sync will not undo), **`SupervisorOverride`** (audited manual promotion to Supervisor).
- **`User.sectionId` + `User.departmentId`** — the HOD approval scope (`hodScopeMatches`).
- **`EmployeeAllocationDay`** (parent per employee/day) with `status`, and **`EmployeeAllocation`** (child rows) keyed by `(allocationDayId, shiftSlot)`: mandatory `projectId`, optional `jobOrderId`, no OT. **`EmployeeAllocationApproval`** stores the immutable decision history.
- **`HodDelegation`** — dated, reasoned HOD approval cover (delegator, delegate, Department+Section, from/to, revoke). Migration `20260916000000_hod_approval_delegation`.
- **`CredentialDelivery`** — durable queue for one-time credentials (no password is ever stored in it).
- Latest migrations: `20260913000000_postgresql_baseline`, `20260914000000_role_based_access`, `20260915000000_hod_section_and_org_transfer`, `20260916000000_hod_approval_delegation`.

## 18. Environment variables

`.env` (root) and `apps/api/.env`:

| Var | Purpose | Default |
|---|---|---|
| `DATABASE_URL` | Prisma DB connection (`file:./dev.db` for SQLite dev; `postgresql://…` for production) | `file:./dev.db` |
| `API_PORT` | API port | `4000` (use `4100` on Windows) |
| `API_HOST` | Bind interface | `0.0.0.0` (set to `127.0.0.1` for local-only) |
| `JWT_SECRET` | Token signing secret (≥32 chars in production) | dev value; must be replaced in production |
| `CORS_ORIGINS` | Exact allowed origins (required in production) | — |
| `TRUST_PROXY` | Set `true` behind a reverse proxy | `false` |
| `AUTH_RATE_LIMIT_ENABLED` | `false` removes the login brute-force limit (dev only; rejected in production) | `true` |
| `AUTH_RATE_LIMIT_WINDOW_MS` / `AUTH_RATE_LIMIT_MAX` | Login throttle window / attempts | `900000` / `10` |
| `DEV_SEED_PASSWORD` | Password the demo seed gives every seeded account | `WorkforceDev@2026` |
| `DEV_SYNC_PASSWORD` | Password `run-sync-once.cjs` gives synced accounts | `password@SDHI` |
| `MAX_DAILY_HOURS` | Daily cap for over-allocation guard | `8` |
| `MAX_OT_HOURS` | OT validation upper bound | `12` |
| `SHIFTS` | Shift window config | `GENERAL:09:00-17:00` |
| `BADGEVIEW_SYNC_ENABLED` | Enable sync cron | `false` |
| `BADGEVIEW_SYNC_CRON` | Sync schedule | `0 6,18 * * *` |
| `BADGEVIEW_DB_HOST` | Source SQL Server | `10.5.1.106` |
| `BADGEVIEW_DB_USER` / `_PASSWORD` / `_NAME` / `_VIEW` | Source credentials | (set in `.env`, git-ignored) |
| `BADGEVIEW_DB_ENCRYPT` | TLS to source | `false` (internal segment only) |
| `BADGEVIEW_SYNC_MIN_ROWS` / `BADGEVIEW_SYNC_MIN_RATIO` | Snapshot completeness guards | `1` / `0.9` |
| `CREDENTIAL_DELIVERY_ENABLED` | Send one-time credentials by e-mail | `false` (keep false locally) |
| `CREDENTIAL_DELIVERY_RECIPIENT` | Default recipient for queued credentials | IT Support mailbox |
| `SMTP_*` | Mail transport for credential delivery | unset ⇒ delivery stays pending |

## 19. Ports & proxy

- **API**: `API_PORT` (default `4000`; use `4100` if `4000` is OS-occupied).
- **Vite web**: `apps/web/vite.config.ts` `server.port` (default `5173`; Vite auto-falls-back to `5174` if taken).
- **Vite proxy target**: must match `API_PORT`. If you change one, change the other.
- Common Windows issue: `4000` and `5173` may be held by `svchost` — pick free ports (`4100`, `5174`) and update the proxy.

## 20. Schema overview (Prisma)

Key models in `apps/api/prisma/schema.prisma`:

- `Department`, `Project`, `ProjectWbs`, `JobOrder`
- `Employee` (unified, CR#2) + `EmployeeSectionAssignment`, `EmployeeOrganisationOverride`, `SupervisorOverride`
- `User` (login accounts; role-gated; `source` for sync vs manual; `departmentId` + `sectionId` = HOD scope)
- `HodDelegation` (dated HOD approval cover)
- `TimesheetDay` + `TimesheetEntry` (contract-worker timesheets, with OT)
- `EmployeeAllocationDay` + `EmployeeAllocation` + `EmployeeAllocationApproval` (CR#2 slot-based payroll allocations, no OT)
- `Approval`, `AuditLog`, `DailyTeamSelection`, `ManpowerRequest`, `CostRate`, `AttendanceFeed`, `Conflict`
- `CredentialDelivery`, `SyncException`, `Section`, `CostCenter`

## 21. API endpoints

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
| `/employees?department_id=` | GET | auth | Employee list (department- and HOD-section scoped) |
| `/admin/employees` | POST | HOD/PM/ADMIN/HR | Register a payroll Employee **+ EMPLOYEE login account** (atomic) |
| `/admin/hod-candidates?department_id=` | GET | PM/ADMIN | Payroll employees eligible to become HOD |
| `/admin/hods` | POST | PM/ADMIN | Promote an Employee to HOD with a Department/Section scope |
| `/admin/users/:id/hod-scope` | PUT | PM/ADMIN | Re-map an existing HOD's scope |
| `/admin/users/:id/employee-link` | PUT | PM/ADMIN | Link an HOD/PM account to its payroll Employee |
| `/delegations` | GET/POST | HOD/PM/ADMIN | HOD approval cover: list / create (HOD = own Section only) |
| `/delegations/coverage` | GET | HOD/PM/ADMIN | Who covers me today / whom I cover |
| `/delegations/candidates?departmentId=&sectionId=` | GET | HOD/PM/ADMIN | HODs eligible as delegate |
| `/delegations/:id` | DELETE | delegator/PM/ADMIN | Revoke cover |
| `/admin/sync/exceptions` | GET | ADMIN | Open BadgeView sync exceptions |
| `/admin/credentials` / `/admin/credentials/process` | GET/POST | ADMIN | Credential queue / run delivery |
| `/departments` | GET/POST | admin/HR | Master departments (manual CRUD) |
| `/admin/csv-upload` | POST | admin/HR | Bulk CSV registration |
| `/master/supervisors` | GET | auth | (Admin) supervisor master |

All write routes enforce **owner + role + status-lock + audit** via shared middleware.

## 22. Security model

- **Owner enforcement** — supervisors only edit their own timesheets/allocations (`NOT_OWNER` 403 otherwise). HOD/PM/Admin can act on behalf.
- **Status lock** — once `SUBMITTED` / approved, the day is locked from edits except via HOD/PM reject.
- **Department + Section isolation** — an HOD's pending queue is limited to its own Department/Section (`hodScopeMatches`); cross-scope approve attempts return `403 FORBIDDEN`. HOD scope changes and approval-cover revocation bump `tokenVersion`, revoking existing sessions.
- **Stage isolation** — PM cannot approve `SUBMITTED` days directly (returns `403 WRONG_STAGE`); only HOD can.
- **Approver whitelist** — `/approvals/*` is gated to HOD/PM/ADMIN. HR is not a workforce approver.
- **HOD registration is fail-closed** — Department, Section and payroll/`active` checks all run server-side; a CLMS worker or an employee holding another role's account is refused.
- **Audit** — every write goes through `writeAudit` with actor, action, entity, before/after (including `HOD_DELEGATION_CREATE` / `HOD_DELEGATION_REVOKE`).
- **Fail-closed null scope** — an HOD with `departmentId`/`sectionId = null` gets an empty queue and `403` on mutation, never global access.
- **CSV-injection neutralization** — `=`, `+`, `-`, `@`-prefixed cells are rejected on CSV upload.
- **Partial-write guard** — BadgeView sync only writes to SYNC rows; never overwrites MANUAL / PAYROLL fields.
- **Soft-depart** — departed workers are kept in the unified `Employee` with `active = false` (preserves historical OT / allocation / approval history), hidden from pickers.
- **Credentials are never guessed or shown** — new accounts receive an unknown random password plus a queued `CredentialDelivery` row; the password is generated only at delivery time and disclosed solely to the configured SMTP transport. The API never accepts or returns an initial password.
- **Login throttling** — `/api/auth/login` is rate-limited per IP (default 10 per 15 min). `AUTH_RATE_LIMIT_ENABLED=false` disables it for local testing and is **rejected when `NODE_ENV=production`**.
- **Database guard** — a `file:` (SQLite) `DATABASE_URL` is rejected when `NODE_ENV=production`.

### 22.1 Production deployment checklist (mandatory)

Before exposing this app to any network beyond localhost, complete every item below:

- [ ] **`API_HOST=127.0.0.1`** — bind the API to localhost only, OR place it behind a reverse proxy that terminates **TLS/HTTPS** (Caddy / nginx / Cloudflare Tunnel / etc.). Never serve plaintext HTTP on a reachable interface.
- [ ] **Set a real `JWT_SECRET`** (≥32 chars, not a placeholder) and `CORS_ORIGINS` — the API refuses to start in production without them.
- [ ] **Rotate or disable the seeded demo accounts** (`WorkforceDev@2026`) in any environment reachable beyond localhost. Treat them as dev-only fixtures.
- [ ] **Keep `AUTH_RATE_LIMIT_ENABLED` at its default (`true`)** — production refuses to start with it disabled.
- [ ] **`DATABASE_URL` must be a PostgreSQL URL** — a `file:` URL is rejected in production.
- [ ] **`.env` is git-ignored** — verified before every commit. Production credentials (`BADGEVIEW_DB_PASSWORD`, `JWT_SECRET`, `SMTP_PASSWORD`, any DB URL with an embedded password) must **never** be committed or pasted into chat transcripts / logs.
- [ ] **`BADGEVIEW_DB_ENCRYPT`** — set to `true` if the source SQL Server is reachable beyond a trusted internal segment.
- [ ] **Keep `CREDENTIAL_DELIVERY_ENABLED=false`** until SMTP is configured, or queued one-time credentials will never be delivered and new users cannot log in.
- [ ] **Audit logs are rotated and backed up** off-host — `AuditLog` is the only record of who approved what.
- [ ] **Run the latest migration** — production must use a managed PostgreSQL instance with `prisma migrate deploy` (never `db push`). Confirm `20260916000000_hod_approval_delegation` has been applied.

### 22.2 Credential hygiene

- `.env` is in `.gitignore`; do not commit it. Do not paste its contents into chat, screenshots, or issue trackers.
- Rotate the `JWT_SECRET` (if configured) and the seeded admin password before any production deploy.
- Source DB credentials (`BADGEVIEW_DB_PASSWORD`) belong only in the runtime `.env` of the deploy host — never in code, comments, or transcripts.
- If a credential is exposed (e.g. typed into chat), revoke it immediately and rotate.

## 23. Troubleshooting

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

### HR can see the Employees tab but has no approval queue
- HR is intentionally **not** a workforce approver: `/approvals/*` is gated to HOD/PM/ADMIN. HR keeps the legacy admin screens (CSV upload, supervisor registration). If HR needs approver rights that is a deliberate role change, not a bug.

### Added a Prisma model but production has no table
- `prisma db push` (used for SQLite dev) writes **no** migration, so `prisma migrate deploy` on production will never create the table. Generate PostgreSQL DDL with `prisma migrate diff --from-schema-datamodel <old>.pg --to-schema-datamodel <new>.pg --script`, save it under `migrations/<timestamp>_<name>/migration.sql`, and commit it. Passing an SQLite URL to `--from-url` for a PostgreSQL diff panics the schema engine — use two schema files.

### `P3019` — datasource provider does not match `migration_lock.toml`
- You are running `prisma migrate deploy` while `schema.prisma` says `sqlite`. Run the provider-aware `npm run db:migrate` instead (`file:` URL ⇒ `db push`). Never delete `migrations/` to work around it.

### Edits have no effect / the UI shows old code
- `tsx watch` and Vite both miss file changes on a WSL `/mnt/c` mount (9p). **Restart both servers after every change**; a browser hard-refresh (`Ctrl+Shift+R`) is also needed for the web bundle.

### Login returns `429 RATE_LIMITED`
- The IP is throttled: 10 attempts per 15 minutes. Wait out the window, or set `AUTH_RATE_LIMIT_ENABLED=false` in `.env` and restart the API (dev only; refused in production).

### A newly registered HOD/Employee cannot log in
- New accounts carry an unknown random password until the credential worker e-mails one. With `CREDENTIAL_DELIVERY_ENABLED=false` nothing is sent — set a password locally: `node apps/api/set-dev-password.cjs <ecNo>`.

### "No eligible payroll employee in this Department" in the HOD panel
- Only **active payroll** employees appear, and each is filtered to the chosen Department. A CLMS contract worker can never appear (EcNo logins are payroll-only). Employees already holding a SUPERVISOR/ADMIN/HR/PM/FINANCE account are withheld on purpose (`ROLE_CONFLICT`).

### `BADGEVIEW_DB_*` sync fails to connect
- Verify `.env` has `BADGEVIEW_DB_HOST=10.5.1.106`, port `1433`, and the correct user/password. `BADGEVIEW_DB_ENCRYPT=false` is fine for internal segments only.

---

## Appendix A — Glossary

- **HOD** — Head of Department/Section. Owns stage-1 approval for one Department + Section. Logs in with the linked payroll Employee's **ecNo**.
- **PM** — Project Manager / Project Head. Stage-2 approver with a global (cross-department) view.
- **Admin / HR** — Admin = global visibility, can act at either stage and manages HOD mapping. HR = legacy admin screens only (not a workforce approver).
- **Approval cover** — a dated, reasoned delegation naming another HOD of the same Section as a stand-in; it records who is covering, it does not change who is authorized.
- **SUBMITTED / HOD_APPROVED / PM_APPROVED / REJECTED** — stages of the approval lifecycle. `PLANNING_RETURNED` = a PM return awaiting HOD action.
- **Shift slot** — one of `am1`, `am2`, `pm1`, `pm2`; each is 2 hours.
- **Effective OT** — `manual ?? max(0, trueHours − MAX_DAILY_HOURS)`. Manual wins; otherwise auto-calc.
- **Source (`SYNC` / `MANUAL` / `PAYROLL`)** — `SYNC` = LabourWorks-imported CLMS worker; `MANUAL` = admin-registered login; `PAYROLL` = payroll employee with a login.
- **`employmentType` (`CLMS` / `PAYROLL`)** — CLMS = contract labour from the sync (no EcNo login, OT applies); PAYROLL = white-collar (EcNo login, My Hours, no OT).
- **Partial-write guard** — sync only writes identity/source/`active` on SYNC rows; never overwrites MANUAL/PAYROLL fields.
- **Credential delivery** — the durable queue that issues one-time passwords; with delivery disabled the queue just accumulates.

---

## Appendix B — Test accounts cheat sheet

```
ADMIN       admin@company.com
HOD         hod@company.com            (seeded example: Production - EOU / Hull Production)
PM          pm@company.com             (central authority, all departments)
HR          hr@company.com             (legacy admin screens only — not an approver)
Finance     finance@company.com        (cost-rates viewer)
Employee    EC1011   (employee@company.com)
Supervisor  EC1001   (r.sharma@company.com, linked payroll Employee)
Supervisor  EC1006   (sup.a@company.com)
Supervisor  EC1007   (sup.b@company.com)
Supervisor  EC1014   (sup.c@company.com)
Supervisor  EC1017   (sup.d@company.com)
Supervisor  EC1018   (sup.e@company.com)
```

Passwords — **they differ by account type**:

- Seeded demo accounts above: **`WorkforceDev@2026`** (`DEV_SEED_PASSWORD`)
- Accounts created by the LabourWorks sync (EcNo login, e.g. `BAPL0251`): **`password@SDHI`**, set on a dev box with `node apps/api/set-dev-password.cjs <ecNo>`
- Accounts you register in the UI (Employee/HOD): no usable password until the credential is delivered — use `set-dev-password.cjs`

---

_Document version: CR#2 unified Employee + HOD scope + HOD approval cover (`feature/cr2-unified-employee`, `6f3eea4`). Maintained alongside the codebase; update when schema, routes, roles or lifecycle change. Companion documents: [`ROLE_BASED_ACCESS.md`](ROLE_BASED_ACCESS.md) (enforced role matrix), [`DEV_SQLITE_TESTING.md`](DEV_SQLITE_TESTING.md) (local SQLite dev), [`PRODUCTION_DEPLOYMENT.md`](PRODUCTION_DEPLOYMENT.md)._
