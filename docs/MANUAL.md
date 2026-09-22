# Workforce — Application Manual

> **Version:** Project → WBS → Job Order master data and quantity progress (working tree on `feature/cr2-unified-employee`, HEAD `56f0910`), on top of CR#2 unified Employee + HOD scope + HOD approval cover
> **Scope:** End-user guide + developer/admin reference for the Workforce timesheet, approvals, OT, summary, the Project / WBS / Job Order master data screens and Job Order quantity progress, CR#2 unified-Employee + slot-based payroll allocations, HOD registration/scope and HOD approval cover (delegation).
> **Databases:** local development/testing runs on **SQLite**; production runs on **PostgreSQL** (`prisma migrate deploy`). See [21](#21-database--migrations) and [docs/DEV_SQLITE_TESTING.md](DEV_SQLITE_TESTING.md).

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
13. [Master Data: Project, WBS and Job Order](#13-master-data-project-wbs-and-job-order)
14. [Project Master Data (ADMIN/PM)](#14-project-master-data-adminpm)
15. [Job Order Upload (ADMIN/PM)](#15-job-order-upload-adminpm)
16. [Quantity Progress (HOD / DEPT_HEAD / PM)](#16-quantity-progress-hod--dept_head--pm)

**Part II — Developer / Admin Reference**
17. [Architecture & stack](#17-architecture--stack)
18. [Repository layout](#18-repository-layout)
19. [Local setup (WSL Ubuntu)](#19-local-setup-wsl-ubuntu)
20. [Local setup (PowerShell / Windows)](#20-local-setup-powershell--windows)
21. [Database & migrations](#21-database--migrations)
22. [Environment variables](#22-environment-variables)
23. [Ports & proxy](#23-ports--proxy)
24. [Schema overview (Prisma)](#24-schema-overview-prisma)
25. [API endpoints](#25-api-endpoints)
26. [Security model](#26-security-model)
27. [Troubleshooting](#27-troubleshooting)

---

# Part I — End-User Guide

## 1. Quick start

The Workforce app runs at **`http://localhost:<web-port>`** (usually `5174` on Windows hosts where `5173` is OS-occupied, or `5173` elsewhere). The API runs on **`http://localhost:<api-port>`** (usually `4100` on Windows where `4000` is occupied, or `4000` elsewhere).

There are **two seed commands**, and they create different accounts:

| Command | Accounts it creates |
|---|---|
| `npm run db:seed` | The **four office accounts only** — ADMIN `admin@company.com`, PM `pm@company.com`, HR `hr@company.com`, FINANCE `finance@company.com` — and **no business data at all**. This is the production-like starting point: sync from LabourWorks, then create the Project / WBS / UoM / Networks on Project Master Data, then upload the Job Orders (sections 12 to 15). |
| `npm run db:seed:demo` | The full demonstration set for a local demo and for the Playwright end-to-end tests: the four office accounts plus a HOD, an Employee login, five supervisors, projects, WBS rows, UoM, networks, Job Orders, bookings and cost rates. |

**The password differs by account type** — this is the most common login problem:

| Password | Applies to |
|---|---|
| `WorkforceDev@2026` | Every account that either seed creates. Override it with `DEV_SEED_PASSWORD` before you run the seed. |
| `password@SDHI` | Accounts provisioned by the LabourWorks sync (log in with the EcNo, e.g. `BAPL0251`) **and, while the app is still pre-production, every account registered from the web UI** — Employee, Supervisor and HOD registration all start on `password@SDHI` with no forced change. On a dev box, set one with `node apps/api/set-dev-password.cjs <ecNo>`. Removed before production: the API build fails while the dev bootstrap password is still in the source. |

| Role | Login | Notes |
|---|---|---|
| Admin | `admin@company.com` | Both seeds. Global visibility, can act at either stage |
| PM (Project Head) | `pm@company.com` | Both seeds. Central authority — sees all departments, final approval after HOD |
| HR | `hr@company.com` | Both seeds. Legacy screens only (CSV upload, supervisor registration); not a workforce approver |
| Finance | `finance@company.com` | Both seeds. Cost-rates viewer |
| HOD | `hod@company.com` | **`db:seed:demo` only** — mapped to Production - EOU / Hull Production |
| Employee | `EC1011` (or `employee@company.com`) | **`db:seed:demo` only** — payroll "My Hours" self-allocation |
| Supervisor (linked to payroll Employee) | `EC1001` (or `r.sharma@company.com`) | **`db:seed:demo` only** — submits team timesheets; can self-allocate via "My Hours" |
| Supervisor | `EC1006`, `EC1007`, `EC1014`, `EC1017`, `EC1018` | **`db:seed:demo` only** — `sup.a` … `sup.e@company.com` |

> **After `npm run db:seed` there is no supervisor, HOD or employee login at all.** The minimal seed creates the four office accounts. To get a team, a supervisor login or an employee login you must either run the LabourWorks sync (section 12) or register them (sections 5, 6 and 8).

> **Cost rates are not seeded by `npm run db:seed`.** The **Cost** view of the Summary reads zero until an Admin adds the rates with `POST /api/admin/cost-rates` (`category`, `ratePerHour`, `effectiveFrom`). Only `db:seed:demo` writes example rates.

> **Security:** these are **dev-only** credentials. Rotate or disable before any environment that is reachable beyond localhost. In `.env`, set `API_HOST=127.0.0.1` so the API does not bind to the LAN.

> **Login throttling:** the API rate-limits `/api/auth/login` to 10 attempts per 15 minutes per IP. For local testing only, set `AUTH_RATE_LIMIT_ENABLED=false` in `.env` (the API refuses to start that way when `NODE_ENV=production`). A `429 RATE_LIMITED` response means the limiter tripped, not a bad password.

---

## 2. Supervisor Daily Timesheet

**Path:** `/timesheet` (top nav: **Daily Timesheet**).

A supervisor manages their team's manhour allocation for a single day. The flow mirrors the payroll allocations model (slot-based, 4 shift slots × 2 h = 8 h max) with **OT applicable for contract workers**.

### 2.1 Layout

- **Date + Department filters** at the top.
- **Your name and Section** — or Department, or the role when the account has neither — are shown at the
  top right of the header, in front of the page's own action button. The navigation rail keeps only the
  pin, theme and logout buttons.
  The same block is the top bar below a 1200 px window: on a tablet it sits in the menu row, on a phone
  inside the menu.
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

### 2.3 Booking a Job Order (Department and Project)

The picker is constrained so that the wrong Job Order cannot be booked:

- **Department is fixed to the supervisor's own department.** The department shown at the top of the screen is the supervisor's own, not a selector, and the API derives it from the signed-in supervisor — so another department cannot be booked.
- **Project** is chosen freely among the active projects.
- **Job Order** is filtered by **that Project inside the supervisor's own department**, and each option reads `Job_Order-Job_Description` — for example `1900000107-Pipe Spool Installation`.
  Every Job Order dropdown (**Daily Timesheet Entry** and **My Hours**) caps the option text at
  **34 characters**, the Job Order number included, because a native `<select>` widens both its box
  and its open list to the longest option — a real 77-character description pushed the Job Order
  column, and the **Assign** column after it, out of the row. The full description stays visible in
  the bulk bar's read-only **Job Order Name** field and in **Project Master Data**.
- There is **no Section control** on this screen. A supervisor is mapped to one department, so the Project alone decides what may be booked, and the department's own Job Orders for that project are the list. A **standing / Non-Project** Job Order is included for every project it belongs to. Which **Section** the work belongs to is read from the chosen **Job Order** and stored on the booking — it is never re-stated per row.
- Only an `Active` Job Order on an `Active` Project in an `Active` Department can be booked; anything else does not appear in the list.
- Consumption and quantity do not mix here: this screen books **hours** only. The quantity figure is punched separately on Quantity Progress ([16](#16-quantity-progress-hod--dept_head--pm)).

The Job Order number is unique **per project only** — `1900000107` exists in Project A and in Project C as two different Job Orders — so always read the option together with the Project you selected. The WBS number is returned by the API but is not shown in the dropdown.

### 2.4 Reassign / unassign on editable days

On a `DRAFT` or `REJECTED` day, clicking a colored slot re-selects it. Picking a new Project + Work Order and clicking **Assign** replaces the assignment. Use **Remove** on a row to clear that employee's allocations.

On a `SUBMITTED` / approved day the cells are **locked** — only HOD/PM reject can re-open them.

### 2.5 Over-allocation guard

The 8-hour daily cap is structural (only 4 slots × 2 h). Submitting a day with **total > 8 h** triggers `MAX_DAILY_HOURS_REMARKS_REQUIRED` — a **mandatory Remarks** reason is required before submission can succeed.

### 2.6 OT (Overtime)

A supervisor can also assign **OT hours** to a contract workman (CLMS employee) on a given date:

1. Select the **OT** cell on the employee row.
2. Enter whole OT hours (1-12), select the **Project + WBS / Job Order**, and enter mandatory Remarks.
3. Click **Assign**, then submit the timesheet through the normal approval flow.

For holiday attendance, OT may be entered without selecting any regular shift slot. The complete entered time is booked as project OT and overhead is `0`. On a mixed regular-plus-OT day, OT stays additive and unused regular capacity retains its normal overhead calculation. OT entry is disabled and rejected for Payroll Employees.

### 2.7 Supervisor self-row

Supervisors appear as a **non-removable "You" row** in their own timesheet, so they can allocate their own hours via the same flow. The Remove button is disabled for the self-row.

### 2.8 Submit

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
- **HR** is *not* a workforce approver: `/approvals/*` is gated to HOD/PM/ADMIN for reading, and only HOD/PM may decide. HR keeps the legacy admin screens (CSV upload, supervisor registration) only.
- **ADMIN is read-only on approvals**: it sees every queue and all history, and no action buttons are offered. Approving is the HOD's and the Project Head's job.
- **Approval cover** — an HOD may name another HOD of the same Section as cover; see [7](#7-hod-approval-cover-delegation). The cover record does not change who is authorized, only who is formally standing in.

### 3.2 Two stages

| Stage | From | To | Approver | Effect |
|---|---|---|---|---|
| 1 | `SUBMITTED` | `HOD_APPROVED` | **HOD only** | moves to the PM queue |
| 2 | `HOD_APPROVED` | `PM_APPROVED` | **PM only** | terminal approval |

**Admin does not approve.** It has no part in the chain (Supervisor -> HOD -> Project Head);
an Admin account can *see* every queue and its history, and its decision buttons are
removed on screen. The API refuses `approve`, `reject`, `batch` and `send-back` for an Admin
with `403`. This was tightened after a real case: an Admin sat in BOTH stages of its own
queue, so approving once moved a sheet to `HOD_APPROVED` and left it there, and approving
again completed it as `PM_APPROVED` - the Project Head never saw it. Use an HOD account for
the HOD step.

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
2. Click an empty slot — pick **Project** (mandatory) and an optional **Job Order**.
3. Click **Assign**. Repeat for additional slots with different Project / Job Order combinations.
4. **Submit for HOD Approval** when the day is complete.

The Department, Section, Project and Job Order picker behaves exactly as on Daily Timesheet Entry — see [2.3](#23-booking-a-job-order-department-section-project).

### 4.2 Rules

- **Project is mandatory**, the Job Order is optional.
- Department is fixed to the employee's own department, the Section is chosen from that department, and the Job Order list is filtered by that Section and the Project. (My Hours keeps the Section control because it is a single-slot picker; the supervisor Timesheet Entry screen does not have one — see [2.3](#23-booking-a-job-order-department-and-project).)
- **OT is NOT applicable** for payroll — the daily cap is **strict 8 hours** (4 slots × 2 h); an attempt to exceed is rejected by the API.
- Slots become **locked** once Submitted; only HOD/PM can re-open them via reject.
- Submit triggers the same `SUBMITTED → HOD_APPROVED → PM_APPROVED` lifecycle as the supervisor timesheet.

### 4.3 Multi-project same-day allocations

A single employee can split a day across multiple projects:

| Project | Job Order | Hours |
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

- **Project Summary** — hours by project (A/B/C/D…, the project colour key) for the selected date / week / month. Grouping uses the attribution frozen when the hours were booked ([11.2](#112-project-summary-and-the-frozen-booking-snapshot)).
- **Group by Employee / Supervisor / Department / Totals** — switchable.
- **Project filter** — multi-select dropdown that filters per project column.
- **OT column** — dynamic, auto-hides when no row has OT. Shows **effective OT** (manual or auto-derived) for **approved days only**.
- **Grand total** = sum of hours per row (excluding OT).
- **Mobile parity** — table collapses to cards at the ≤1023 px breakpoint.

### 11.1 Job Order Summary

The Job Order Summary shows **hours and quantity side by side**. The two measures are independent and are never blended, so one Job Order can be 80 % on hours and 40 % on quantity at the same moment.

Rows are grouped **Project → WBS → Job Order**. The same Job Order number in two projects appears twice, once under each project, and the WBS level keeps the row unambiguous.

| Measure | Columns |
|---|---|
| Hours | Budgeted hours · Consumption · Consumption % · Balance |
| Quantity | Budget Qty · Achieved Qty · Balance Qty · Qty % |

- The **status filter** is `All` / `Active` / `In-Active`, plus a department filter. An HOD (department-level or Section) and a Department Head are pinned to their own department server-side; PM, HR, FINANCE, ADMIN and SUPERVISOR may use the department filter.
- **Consumption** counts only hours that reached the **final Project Head approval** — timesheet entries and My Hours allocations with the last approval stage. Hours still waiting for approval are not consumption yet.
- **Consumption** is measured against the budget revision **in force on the work date**. The work date is the Job Order's own last booked work date, or its last progress date; an explicit `asOf` overrides it for a back-dated report. So a past month keeps the budget it was measured against, and the row also carries which revision supplied the budget.
- **Achieved Qty** is the cumulative quantity of the latest **approved** progress entry.
- A Job Order with **no approved progress shows a dash (—)**, not `0 %`. The API returns `0` with a "progress not reported" flag and the screen renders the dash.
- Percentages never fall below 0 when the budget is 0, and a figure above the budget stays above 100 %.

### 11.2 Project Summary and the frozen booking snapshot

Project Summary groups by the attribution **frozen when the hours were booked**: `project_id`, `project_wbs_id`, `department_id` and `section_id` on the timesheet entry or the allocation row. What that means in use:

- Editing a Job Order's mapping later **does not move hours that are already booked**, so a past report does not change under the user.
- Renaming a project or changing its colour key re-labels a column; it does not move a single hour.
- A Job Order that already has booked hours therefore **cannot be moved to another WBS**: the API refuses the move and the answer is to deactivate the Job Order and create a new one.
- Rows booked before the snapshot columns existed have no stored attribution and fall back to the employee's current Department, so that history stays visible.

---

## 12. BadgeView Sync

Source-of-truth for **contract workers and supervisors** is the external **LabourWorks BadgeView** (`10.5.1.106`).

- **Twice-daily** (`0 6,18 * * *`) — controlled by `BADGEVIEW_SYNC_ENABLED` and `BADGEVIEW_SYNC_CRON` in `.env`.
- Re-upserts unified `Employee` rows keyed by the canonical **`ecNo`** (LabourWorks `IDCardNo`). The old `idCardNo` column was retired.
- **Only ACTIVE workers are imported.** Rows carrying `IsTerminated` are dropped from the snapshot before anything is written, so a terminated worker gets no `Employee` row and no login at all. Controlled by `BADGEVIEW_SYNC_ACTIVE_ONLY` (default `true`); set it to `false` to import terminated workers as inactive rows instead. The run logs how many were skipped, for example *"skipped 31 terminated worker(s) out of 523; importing 492 active worker(s)"*.
- **A worker who leaves later is still handled.** The exit path does not depend on the terminated flag: anyone absent from the snapshot is soft-terminated (`active = false`, `terminatedAt` stamped) and any login they had is disabled, with the row and its history kept for the liability trail. So a departure after they have booked hours is recorded, while a worker already terminated before the first sync is never created.
- **Completeness guards** run before any write: a snapshot below `BADGEVIEW_SYNC_MIN_ROWS` or below `BADGEVIEW_SYNC_MIN_RATIO` (default 0.9) of the existing SYNC population aborts the run. Absence from a validated snapshot is a soft-depart (`active = false`) that preserves history, never a delete.
- **Identity is never guessed**: duplicate source EcNo, EcNo collisions with non-CLMS rows, and mobile numbers matching more than one candidate are recorded in `sync_exceptions` (`DUPLICATE_SOURCE_ECNO`, `ECNO_SOURCE_COLLISION`, `MOBILE_IDENTITY_CONFLICT`, …) and skipped for review in **Admin → Sync Exceptions**.
- Surfaces supervisors from `Nature Of Work = Supervisor`; new SUPERVISOR accounts get an unknown random password plus a queued credential e-mail.
- Auto-creates **Departments and Sections** from `BuName - Division` / `Workmen Section` (never overwrites manually-managed ones).
- Only writes to SYNC rows; never overwrites MANUAL / PAYROLL fields (the partial-write guard). A PM/Admin organisation transfer creates a durable override so the next sync does not undo it.
- One-off runs on the dev box: `node apps/api/run-sync-once.cjs` (see `docs/DEV_SQLITE_TESTING.md`) — same service, with a known dev password and no e-mail.

### 12.1 Clocked hours (in/out) for submitted timesheets

**Screen:** `/attendance-hours` (ADMIN).

The supervisor books shift slots; LabourWorks knows how long the worker actually clocked in and
out. This screen puts the two figures side by side so contract attendance can be validated.

- **Every submit resets the column.** `timesheet_days.in_out_hours` is NULL when a sheet is
  submitted — first submit, a re-submit after a send-back, and a resubmitted amendment alike. Nothing
  a supervisor does writes it, and nothing else in the app reads it: it can never change booked hours,
  approvals or reports.
- **The value comes from LabourWorks.** The join key is the employee **`ecNo`**, which the source view
  calls `IDNo`; the hours field is `ManHours`, and the date is `Date` (all three confirmed against the
  live view on 2026-09-21). The screen reads the view named by `ATTENDANCE_DB_VIEW` (default
  `dbo.Report_Attendance_Intermediate`) and stamps every matching non-draft sheet in the chosen date
  range. A sheet whose employee has no attendance row is left untouched and reported, never cleared.
- **A day can hold more than one record.** The view keeps one row per check-in/out pair, so a split day
  or a night shift whose checkout lands the next morning appears twice (observed: 09:03-12:18 = 3.15h
  and 18:04-08:59 = 14.55h for the same worker and date). `in_out_hours` is the **sum** of the day's
  records, which is why a clocked figure above 8h is normal; the row shows `n records` when more than
  one was added up.
- **Preview first.** *Preview (no save)* runs the exact same computation as *Fetch & save hours* with
  `dryRun` on, so what you see before saving is what gets written. The panel shows the booked hours,
  the clocked hours, the difference, and why a row has no clocked figure (`No attendance row` /
  `No ManHours in the row`).
- **Off-peak job.** `ATTENDANCE_HOURS_ENABLED=true` starts the in-process job that runs at **09:00 and
  21:00** daily (`ATTENDANCE_HOURS_CRON=0 9,21 * * *`). Each tick **re-reads** today plus
  `ATTENDANCE_HOURS_LOOKBACK_DAYS` (default 7, sized to the regularization SLA) for non-draft sheets,
  because attendance lands in LabourWorks only after the shift ends. It is idempotent: a second run with
  the same source data writes nothing, so the job, the sweep and the button can run back to back.
- **Regularization takes days, so nothing is final.** A day can answer "no row" or `0.00` on the first
  fetch and be corrected to `8.00` a few days later. Every run re-reads its whole window *including days
  that already have a value*, so the correction lands on the next tick. Do not narrow the job to "only
  fetch days that are still empty": that is exactly what would freeze a pending day forever.
- **A weekly sweep is the safety net.** `ATTENDANCE_HOURS_SWEEP_CRON` (default Sunday 04:00) sweeps the
  whole regularization horizon (`ATTENDANCE_HOURS_MAX_AGE_DAYS`, default 45) but **only** for days that
  still have nothing usable. It reads the database first and asks LabourWorks only about the dates that
  are actually pending (a 45-day sweep usually touches a handful of dates), so it is cheap.
- **"Still pending" is a visible state, not a guess.** Every consulted day records
  `in_out_checked_at` and increments `in_out_attempts`, and the **Still pending** panel lists the days
  that still have no usable figure, with their age and how many times the source has been asked. A day
  that is still 0 after several checks is outstanding regularization work in LabourWorks - chase the
  yard, not the app.
- **How a difference is settled.** `ATTENDANCE_HOURS_OVERWRITE=any` (default) treats the source as the
  truth: a later correction wins, up or down. `improve` only fills a gap (NULL / 0) or raises a figure,
  and never lowers a non-zero value automatically (such a difference is reported as skipped instead).
  Absence from the source never clears a stored figure in either mode.
- **A closed period stops moving.** Days older than `ATTENDANCE_HOURS_MAX_AGE_DAYS` are out of scope for
  every automatic run; an Admin can deliberately override that on the screen. Every write is audited
  (`ATTENDANCE_HOURS_REFRESH`, `ATTENDANCE_HOURS_SWEEP`, `ATTENDANCE_HOURS_MANUAL`) with the day, the old
  value, the new value and the reason.
- **Manual entry for a day the yard will never regularize.** An Admin can set the figure by hand from the
  *Still pending* list. It is flagged `MANUAL` and **no refresh overwrites it** (the screen still shows
  what the source says, for comparison). Clearing it hands the day back to the source.
- **The source is configuration, not code.** `ATTENDANCE_DB_ID_COLUMN`, `ATTENDANCE_DB_HOURS_COLUMN`
  and `ATTENDANCE_DB_DATE_COLUMN` name the columns, and `ATTENDANCE_DB_QUERY` replaces the generated
  SQL entirely (it must bind `@workDate`) when the view already filters the date itself or the DBA
  supplies the exact query. The screen shows the resolved view, columns and connection, and reports the
  source error verbatim — including "the login needs SELECT on the view", which is what an unprivileged
  read-only login answers with.
- **Scope.** Only ADMIN may read it or trigger a refresh (`manageAttendanceHours`), and every refresh
  that writes is audited (`ATTENDANCE_HOURS_REFRESH`).
- **Drafts.** A DRAFT sheet is still being written, so it is skipped unless *Include draft sheets* is
  ticked (the scheduled job never includes drafts).
- **Offline testing.** `ATTENDANCE_HOURS_FIXTURE` points the reader at a local JSON
  (`{"2026-09-21":{"FRNEGJ018":8.58}}`) or CSV (`date,IDNo,ManHours`) file instead of SQL Server. It is
  refused when `NODE_ENV=production`.

---

## 13. Master Data: Project, WBS and Job Order

**Screens:** `/master-data` (maintenance), `/job-order-upload` (bulk create), `/job-order-progress` (quantity achieved), and Summary → **Job Order**.

### 13.1 The hierarchy

```
Project  ──►  WBS  ──►  Job Order
```

- A **Project** is the commercial container. `Project_ID` is the ERP project number, and the **colour key** (A, B, C, D…) is the short token shown on Timesheet Entry and as the Project Summary column heading. A colour key is unique across all projects.
- A **WBS** belongs to exactly one Project and only groups Job Orders. It carries no budget. The WBS number is unique **inside a project**, so the same WBS number may exist in another project.
- A **Job Order** belongs to one WBS. **A Job Order number is unique per project only — it REPEATS across projects.** `1900000107` in Project A is a different Job Order from `1900000107` in Project C. Always read the Job Order together with its project.
- **UoM** is a global master (NOS, MT, SQM, MTR…). Its `example` text is the help string shown on the maintenance screen.
- **Network** is a per-project SAP network reference that **belongs to ONE WBS element** of that project. The link is required (`networks.wbs_id`, migration `20260918000003_network_wbs_scope`). Several Job Orders may share one Network, and a Job Order's Network must be a Network of the WBS the Job Order points at.
- A Network **code is still unique inside the project**, not inside the WBS. The consequence is the rule the Job Order upload enforces: **one Network number never spans two WBS rows of the same project** (section 15).
- One flagged **Non-Project** project holds standing / idle-hours work. Its Job Orders carry no Section, so any Section of their Department may book them.

### 13.2 Job Order status

Job Order status is **`Active`** or **`In-Active`** only. `closed` and `on_hold` no longer exist.

- Only an `Active` Job Order on an `Active` Project in an `Active` Department can be booked or have quantity punched. Anything else does not appear in a picker.
- The status is set when the Job Order is created by the upload (stored as `active` / `inactive`). No screen changes the status of an existing Job Order: an upload **skips** a Job Order that already exists, so it never overwrites the row or its budget.

### 13.3 Two independent measures

| Measure | Where it comes from | Columns on the Job Order Summary |
|---|---|---|
| **Hours** | Timesheet entries and My Hours allocations, counted after the final Project Head approval | Budgeted hours · Consumption · Consumption % · Balance |
| **Quantity** | The cumulative figure the HOD punches and the Project Head approves | Budget Qty · Achieved Qty · Balance Qty · Qty % |

The two are never blended. A Job Order can be 80 % on hours and 40 % on quantity at the same moment.

### 13.4 Budget revisions are effective-dated

A budget change is a new revision with an effective date. The Project Head is the custodian, so a revision needs no approval. Consumption is compared against the revision **in force on the work date** (the latest revision dated on or before the work date), so a past month keeps the budget it was measured against. Creating a Job Order writes revision 1 with its opening budget.

### 13.5 Attribution is frozen at booking time

A booked timesheet entry or allocation row stores `project_id`, `project_wbs_id`, `department_id` and `section_id` as they were **at the moment of booking**. Every report groups by those stored ids.

- Editing a Job Order's mapping later does not move hours that are already booked.
- Renaming a project or changing its colour key re-labels a report column without moving an hour.
- A Job Order that already has booked hours cannot be moved to another WBS: the ADMIN-only `PUT /api/admin/job-orders/:id/remap` refuses the move and names the booked rows. Deactivate the Job Order and create a new one instead.

---

## 14. Project Master Data (ADMIN/PM)

**Path:** `/master-data` (top nav: **Project Master**).

Five tabs: **Project**, **WBS**, **UoM**, **Network** and **Job Order**. Reads are open to any signed-in user; every create, update, activate/deactivate and delete is limited to **ADMIN and PM**, and every write is audited. The **Job Order** tab is read-only apart from one action, **Edit Job Order**, which revises the budget (section 14.4).

### 14.1 Fields and example help text

| Tab | Fields (labels on the form) | Example shown as help text |
|---|---|---|
| **Project** | Project code (ERP project number), Project name, Colour key (display token), Sort order, Standing / non-project row | code `PRJ-A`, name `Project A`, colour key `A` ("shows as A on Timesheet Entry") |
| **WBS** | Project, WBS number, WBS name, Sort order | code `A.HULL.0010.100`, name `Hull structure` |
| **UoM** | UoM code, UoM name, Example (shown as help text) | code `NOS`, name `Numbers`, example `Count of pieces, e.g. 12 spools` |
| **Network** | Project, **WBS number** (required), Network code, Network name, Source | WBS `A.HULL.0010.100`, code `SAP-NW-91001`, name `Hull networks` |

Every field carries its own help line, for example `Unique across all projects. Example: PRJ-A` on the Project code, or `1-4 uppercase characters or digits, unique across all projects` on the Colour key. Each tab lists its rows with a Status column and an Actions column: **Edit** and **Deactivate** / **Activate**.

- Codes are stored in upper case, and allow letters, digits, dot, underscore and hyphen (a Project, UoM or Network code may also contain a slash).
- **Colour key** must be 1–4 characters, upper case letters or digits (for example `A` or `B2`), and is unique across all projects.
- The **UoM example** is the on-screen help string; the screen shows it as `Example: NOS — Count of pieces, e.g. 12 spools`.
- **Non-project** marks the single project that holds standing / idle-hours work. Its Job Orders may omit a Section.
- A **Network** row written from this screen is always stored with source `MANUAL`; SAP-sourced rows will come from the ERP feed.
- The **Network tab requires a WBS.** The select lists only the WBS rows of the selected project, because a Network belongs to one WBS element, and the list carries a **WBS column** so you can read which WBS each Network belongs to. An **inactive** WBS cannot own a new Network: the screen refuses it and asks you to activate the WBS row first, or to store the Network under an active row.
- A project with **no WBS row yet cannot take a Network** — a Network must sit under one. Add the WBS row on the WBS tab first, then add the Network.
- Each tab is scoped per row: a **WBS** or **Network** code is unique **inside one project**, so the same code may be reused in another project. A Network code is unique inside the **project**, not inside the WBS, so the WBS does not loosen the duplicate rule: the same Network code may not be used twice in one project.

### 14.2 A duplicate is refused, and the reason names the row

A duplicate answers `409` with a message that names the row it collided with. The screen shows that message in an inline error banner.

| Tab | Must be unique | Message shown |
|---|---|---|
| Project | code, across all projects | `Project code "PRJ-A" is already used by project "Project A" (project #2). Project codes are unique.` |
| Project | colour key, across all projects | `Colour key "A" is already used by project "Project A" (PRJ-A, project #2). Colour keys are unique across all projects.` |
| WBS | WBS code **inside one project** | `WBS code "A.HULL.0010.100" already exists in project "Project A" (PRJ-A, WBS #4). WBS codes are unique inside one project.` |
| UoM | code, across all projects | `UoM code "NOS" is already used by "Numbers" (uom #1). UoM codes are unique.` |
| Network | Network code **inside one project** | `Network code "SAP-NW-91001" already exists in project "Project A" (PRJ-A, network #2). Network codes are unique inside one project.` |

The same WBS or Network code in a **different** project is accepted, not a duplicate.

The **WBS is not part of the Network duplicate rule**: a Network code is unique inside the project, so a code already used by one WBS row of a project cannot be given to another WBS row of the same project either.

### 14.3 Deactivate instead of delete

- **Deactivate** sets the row inactive and keeps it. The row disappears from the pickers, so it can no longer be booked. **Activate** puts it back.
- **Delete** is refused while any other row points at the master row. The answer is `409` with the reference counts, for example
  `project "Project A" (PRJ-A) is referenced by 7 WBS rows, 2 Networks, 4 Job Orders and 12 timesheet rows. Deactivate it instead of deleting it.`
  Only a row that nothing references can be deleted, and the screen offers Deactivate / Activate rather than Delete.
- Deactivating a **WBS row** that owns Networks leaves those Networks in place, but the WBS can no longer own a new one; a Network row is deactivated on its own tab.

### 14.4 The Job Order tab — revising a Job Order's budget

The CSV upload creates a Job Order and then skips it, so this tab is where an existing Job Order
is looked at and its **budget** is revised. It lists every Job Order of the selected project with
its Project, WBS, Network, booked rows and status, and offers **Edit Job Order**.

The form shows the whole Job Order, but **only the budget is editable**:

| Shown, not editable | Editable |
|---|---|
| Project, WBS number, Network, Unit of measure, Department, Section, Status, booked rows | **Budget hours**, **Budget quantity**, and an optional **Reason** |

- The identifying fields are printed rather than offered as controls: there is **no** select on the
  form, so an existing Job Order can never be re-pointed here. Booked hours keep the attribution
  they were given (section 11.2).
- The API refuses any attempt to change the mapping through this route, and refuses a budget with a
  missing, non-numeric or negative figure. A budget that is **unchanged** is refused with
  `BUDGET_UNCHANGED`, so no revision is written for nothing.
- **Saving writes a new effective-dated revision**, one more than the highest, stamped with the
  **date and time**, the user who made it and the reason if one was given. The form lists the last
  five revisions, so you can see what the budget is and when it last changed, and the audit entry is
  `ADMIN_UPDATE_JOB_ORDER_BUDGET` with the previous and the new figures.
- Because revisions are effective-dated, the **Job Order Summary still measures an earlier month
  against the budget that was in force then** (section 11.1); a revision never rewrites past
  consumption.
- The Project / WBS / Network of an existing Job Order are changed by an **Admin** on the Job Order
  Mapping screen, and a Job Order that already has booked hours cannot move to another WBS (13.5).

---

## 15. Job Order Upload (ADMIN/PM)

**Path:** `/job-order-upload` (top nav: **Job Order Upload**).

The screen downloads the template, uploads a CSV of Job Orders and shows a result panel. Every run is audited (`JOB_ORDER_CSV_UPLOAD`).

### 15.1 Template columns, in this exact order

```
Project_ID, Project_Name, WBS_NO, Network_ID, Job_Order, Job_Description, UoM, Qty,
Budgeted_hours, Department, Section, Job_Order_Status
```

Download it with **Download Template** (`job_order_upload_template.csv`). The template also carries one example row, copied from a real Job Order, so every value in it exists in the masters. Leaving that row in the file is safe: it is reported as a duplicate and no second Job Order is created.

The header must match, in order. Case and surrounding spaces are ignored; a missing, extra, reordered or duplicated column is refused with `400 HEADER_MISMATCH`, the expected column list is returned, and **nothing in the file is imported**. Files are limited to 2 MB.

### 15.2 Row rules

A row is either created, skipped or rejected. A rejected row always names its row number, the column and the reason.

| Column | Rule | What happens when it fails |
|---|---|---|
| `Project_ID` | Must exist in the Project master (matched by code) | Row rejected. An upload **never creates a Project**: a Project needs a name *and* a unique colour key, which the template does not carry. Create it on **Project Master Data** first. |
| `Project_Name` | Must agree with `Project_ID` | Row rejected, and the message shows the master name. |
| `WBS_NO` | Must exist **under that project** — unless auto-creation is on, in which case a missing WBS is **created** and the row imports. This cell also decides which Network the row may use | Row created the WBS, then imported. |
| `Network_ID` | Must exist **under the `WBS_NO` written on the same row** and be active. A Network of **another WBS of the same project** is refused, and the message names the row's Network and both WBS codes, for example `Network "NW-T1-002" belongs to WBS "T1.OUTF.0020.100", not "T1.HULL.0010.100".` **An upload never moves a Network to another WBS.** A Network that does not exist yet is **created under the row's WBS** when auto-creation is on. An INACTIVE Network is never revived by an upload | Row rejected (mismatch). Row created the Network under its WBS, then imported. |
| `Job_Order` | Required | Row rejected. |
| `Job_Description` | Required | Row rejected. |
| `UoM` | Must exist in the UoM master and be active | Row rejected. |
| `Qty` / `Budgeted_hours` | Number 0 or greater; a blank cell means 0 | Row rejected. |
| `Department` | Must be the **full organisation-master name**, for example `BuName - Workmen Division` | Row rejected. Matching ignores case and extra spaces, and accepts a hyphen typed without spaces. The **master** spelling is stored. |
| `Section` | Must exist **under that Department**. **Required**, except on a Non-Project row | Row rejected when it is missing or unknown. On a Non-Project row the Section is stored as **null**, so any Section of the Department may book the Job Order. |
| `Job_Order_Status` | `Active` or `In-Active` | Row rejected. Stored as `active` / `inactive`. |

A cell that starts with `=`, `+`, `-` or `@` (a possible CSV injection) rejects its row.

### 15.3 Creating missing WBS and Network masters from the file

The upload can create the two masters that sit above a Job Order, so you do not have to
create them one by one first:

- A line naming a `WBS_NO` that does **not** exist under its project **creates the WBS row**, then imports the line.
- A line naming a `Network_ID` that does **not** exist **under the WBS that same line names** **creates the Network under that WBS**, then imports the line. The created master belongs to the row's WBS, never to the whole project.
- One new WBS or Network named by several lines is created **once**, in the spelling of the first line that named it. Two lines create one Network only when they name the **same WBS**; the same new Network code under a second WBS of the project is rejected (see below).
- An **existing** Network of another WBS is never re-pointed, and an **inactive** Network is never revived: both rows are rejected instead. A spreadsheet must not move or switch on a master.
- The masters and the Job Orders are written in **one transaction**. If anything fails, the whole file rolls back and every planned row is reported, so a master is never left behind without the Job Orders that needed it.

**"Create a missing WBS or Network automatically"** on the upload screen turns this off. It
is **on by default**. Switch it off for a large first load if you would rather see every
unknown value as an error than have a typo silently become a master row. The result panel
then reports `N WBS created · M Networks created`, each naming the line that introduced it
(and, for a Network, the WBS it was created under).

An unknown **Project**, **UoM**, **Department** or **Section** is still an error and is never
created: a Project needs a colour key the template does not carry, the UoM master carries the
example string shown as on-screen help, and departments and sections come from the badge sync.

### 15.4 The duplicate rule, and why a row is skipped

- A row is **rejected** when the same `Project_ID` + `WBS_NO` + `Job_Order` **already exists**.
  `Row 3: Job_Order — Job Order '1900000107' already exists in Project_ID 'PRJ-A' under WBS_NO 'A.HULL.0010.100'; the Project_ID + WBS_NO + Job_Order combination is a duplicate.`
- A row whose Job Order number already exists in that project **under a different WBS** is **skipped**: the existing Job Order and its budget are left untouched. **An upload never overwrites an existing Job Order or its budget.**
- The same Job Order number repeated **inside one file** for one project is rejected on the later row.
- The same Job Order number in a **different project** is a new Job Order, and it is created.
- A created row receives budget revision 1 in the same transaction, so it has an effective-dated budget from day one.

### 15.5 The result panel

The panel header shows the counts: `N created · M skipped · K rejected · N WBS created · M Networks created`.

- When the file introduced a master, the panel adds one line per created WBS and per created Network. A created Network names the WBS it was created **under**, for example `NW-T1-002 (WBS T1.OUTF.0020.100, PRJ-A, row 7)`.
- When a row was refused over its Network the panel adds: *"K rows rejected over the Network. A Network belongs to ONE WBS of its project, so Network_ID is checked against the WBS_NO on the same row: either correct the WBS_NO / Network_ID on those rows, or add the Network to that WBS first. A Network of another WBS is never moved by an upload."*

| Outcome | Meaning | What the panel shows |
|---|---|---|
| **created** | The Job Order was inserted | `✓ N Job Orders created.` |
| **skipped** | The Job Order already exists in that project under another WBS | `M rows skipped because the Job Order already exists — an existing budget is never overwritten by an upload.` |
| **rejected** | The row was refused | One line per rejected row, for example `Row 7: Section — Section is required for a Job Order on a project; only the non-project Project may omit it.` or `Row 7: Network_ID — Network "NW-T1-002" belongs to WBS "T1.OUTF.0020.100", not "T1.HULL.0010.100".` |

- Row numbers are 1-based and count the header, so they match the file the operator is looking at.
- Good rows are imported and bad rows are reported — a file is never partially accepted in silence, and no row is ever silently dropped.
- The API answers `201` when at least one Job Order was created, `200` when every row already existed, and `400` when at least one row was refused. The body carries `total`, `created`, `skipped`, `rejected`, `createdRows`, `skippedRows` and `errors`.
- If two uploads race for the same Job Order, the losing row is reported as a problem; it is never retried blindly against a budget that already exists.

---

## 16. Quantity Progress (HOD / DEPT_HEAD / PM)

**Path:** `/job-order-progress` (top nav: **Qty Progress**).

This is the **quantity** measure, and it is separate from hours. Nobody moves hours here.

| Who | May do |
|---|---|
| `HOD`, `DEPT_HEAD`, `ADMIN` | Punch the cumulative quantity, amend an entry after a rejection or a send-back, and read the entries they punched (tab **Punch progress**) |
| `PM` | **Only the PM decides** a punched entry: approve, reject or send it back, from the Approval queue |
| `ADMIN` | Reads the queue and the whole remark history; cannot decide (the action is refused with `403`) |
| other roles | The screen is not in their navigation; the API refuses them |

### 16.1 Punch the cumulative quantity

Tab **Punch progress**. Fields: **Section**, **Project**, **Job Order**, **Progress date**, **Cumulative quantity to date (UOM)**, **Remarks**.

- The figure is the **CUMULATIVE quantity achieved to date**, not the day's increment. The helper text under the button states it: *"One entry per Job Order per date. The cumulative figure may never go below the achieved quantity."*
- **The figure may never go down.** The API compares it with the last **approved** cumulative figure (and with an existing entry for the same day) and refuses a lower value: `Cumulative quantity cannot decrease: the last approved figure is 95 NOS. Punch the total achieved to date, not a daily increment.`
- **One entry per Job Order per date.** A second punch for the same day is refused with the reason; the existing entry can be amended only after a rejection or a send-back.
- A Job Order must be `Active` on an `Active` Project in an `Active` Department, and the Section must belong to the HOD's own Department, or the punch is refused (`403 SECTION_OUT_OF_SCOPE`).
- A new punch is saved as `SUBMITTED` and waits for the Project Head. It is **not** part of the achieved quantity until it is approved.

### 16.2 A Department Head selects the Section

- A **Section HOD** punches for his own Section; it is pre-selected.
- A **Department Head** (`DEPT_HEAD`) owns every Section of his Department, so the **Section picker is shown and he chooses the Section he is punching for**. The screen states it: *"As Department Head you own every section of your department: pick the section you are punching for. The Project Head (PM) approves, rejects or sends the figure back."*
- Section choices are limited to the Department, and a Section outside it is refused.

### 16.3 Approve, reject or send back (Project Head)

Tab **Approval queue**. The Project Head sees every `SUBMITTED` entry in scope, with the figure, the previous figure, the revision, the budget in force and the Job Order.

| Button | Result | Requirement |
|---|---|---|
| **Approve** | The entry becomes `APPROVED` and joins the achieved quantity | no remark needed |
| **Send back** | The entry becomes `SENT_BACK`; the HOD may correct it | a remark is **required** |
| **Reject** | The entry becomes `REJECTED`; the HOD must correct it | a remark is **required** |

Only a `SUBMITTED` entry can be decided. The status shows in the list as `Submitted`, `Approved`, `Rejected` or `Sent back`.

### 16.4 Amend only after a rejection or a send-back

- The **Amend** button appears on an entry **only when its status is `REJECTED` or `SENT_BACK`**. A `SUBMITTED` or `APPROVED` entry can only be followed by a new day's punch.
- The modal shows the approved figure to date and the corrected cumulative quantity, and states: *"The refused revision stays in the history. This amendment is saved as revision {n} and goes back to the Project Head for a decision."*
- The amendment is a **new revision** (`revision_no + 1`): **the refused row stays visible as history**, and the list shows `History (N revisions)` with the figure, status, who decided it and the remark of each revision.
- The corrected figure is held to the same floor: it may not fall below the last approved figure.

# Part II — Developer / Admin Reference

## 17. Architecture & stack

- **Monorepo**: npm workspaces (`apps/api`, `apps/web`, `apps/jobs`, `packages/shared`).
- **Backend**: Node 22 + Express + TypeScript + Prisma. Auth: bcrypt + JWT. Slot-based timesheets + slot-based allocations.
- **Databases**: **SQLite** for local development/testing (`file:./dev.db`), **PostgreSQL** for production. The datasource provider in `schema.prisma` selects one; the production schema is kept in `schema.postgresql.prisma`. The API refuses a `file:` URL when `NODE_ENV=production`.
- **Frontend**: React + Vite + TypeScript. React Router. Mobile-first responsive layout at the ≤1023 px breakpoint. The session is held in `sessionStorage` (`workforce_token`, `workforce_user`).
- **Shared types**: Zod schemas and TS types in `packages/shared` (consumed by both api and web).
- **Sync**: in-process cron (`node-cron` inside the API process) for the BadgeView source.

## 18. Repository layout

```
workforce/
├── apps/
│   ├── api/        # Express + Prisma + cron
│   │   ├── prisma/         # schema.prisma, migrations, seed.ts (minimal), seed-demo.ts (demo data)
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
└── package.json    # workspaces, db:setup, db:seed, db:seed:demo, dev:api, dev:web
```

## 19. Local setup (WSL Ubuntu)

```bash
cd /mnt/c/data/comp/workforce

# Install Linux-native node via nvm (recommended; avoids Windows interop issues)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install --lts
nvm use --lts

# Install dependencies + set up DB
npm install
npm run db:setup        # build shared, prisma generate, db push, then the MINIMAL seed:
                        # four office accounts and no business data
npm run db:seed:demo    # optional: add the demo data (projects, WBS, Job Orders, employees,
                        # supervisors, bookings, cost rates) — needed by the Playwright tests

# Terminal 1 — API (use a free port on Windows: 4000 is svchost-owned → use 4100)
$env:API_PORT="4100"
$env:API_HOST="127.0.0.1"
npm run dev:api

# Terminal 2 — Web
npm run dev:web          # Vite picks a free port (5173 → 5174 if 5173 is taken)
```

Open `http://localhost:5174/` (or whichever port Vite reports) and log in as a seeded account: after `npm run db:seed` the four office accounts exist (`admin@company.com`, `pm@company.com`, `hr@company.com`, `finance@company.com`). The HOD, supervisor and employee logins of section 1 need `npm run db:seed:demo`.

## 20. Local setup (PowerShell / Windows)

```powershell
cd C:\data\comp\workforce

npm install
npm run db:setup        # minimal seed: four office accounts, no business data
npm run db:seed:demo    # optional: the demo data set (and what the Playwright tests need)

# Terminal 1 — API. Port 4000 may be OS-occupied by svchost; use 4100 if so.
$env:API_PORT="4100"
$env:API_HOST="127.0.0.1"
npm run dev:api

# Terminal 2 — Web. Vite may pick 5174 if 5173 is svchost-owned.
npm run dev:web

# If Vite picks 5174, also update apps/web/vite.config.ts to point at 4100
# (the proxy target must match the API_PORT).
```

## 21. Database & migrations

**Development / testing runs on SQLite; production runs on PostgreSQL.**

- **Dev DB**: SQLite at `apps/api/prisma/dev.db` (git-ignored). `DATABASE_URL="file:./dev.db"` in **both** the root `.env` and `apps/api/.env` — the API loads the root file first, so change both.
- **`npm run db:migrate` is provider-aware** (`apps/api/scripts/migrate.mjs`): a `file:` URL runs `prisma db push` (the PostgreSQL migrations cannot be applied to SQLite), a `prisma://`/`postgresql://` URL runs `prisma migrate deploy` exactly as production does. No production behaviour is special-cased.
- **Migrations** live under `apps/api/prisma/migrations/` and are **PostgreSQL**; `migration_lock.toml` is `postgresql`. Never regenerate or delete them to make SQLite work.
- **Production schema**: `apps/api/prisma/schema.postgresql.prisma` holds the PostgreSQL datasource variant. Restore with `cp apps/api/prisma/schema.postgresql.prisma apps/api/prisma/schema.prisma` then `npm run db:generate`.
- **Seed (minimal, production-like)** — `npm run db:seed` (`npm run db:seed -w @workforce/api`). It creates the **four office accounts only** — ADMIN `admin@company.com`, PM `pm@company.com`, HR `hr@company.com`, FINANCE `finance@company.com` — and **no business data at all**. It prints those accounts and then the next steps: sync from LabourWorks, create the Project / WBS / UoM / Networks on **Project Master Data**, upload the Job Orders from the CSV template, and add cost rates with `POST /api/admin/cost-rates` if you want the **Cost** view. **No cost rate is seeded, so the Cost view reads zero until one is added.**
- **Seed (demo)** — `npm run db:seed:demo` (`npm run db:seed:demo -w @workforce/api`) loads the full demonstration set on top of the four accounts: projects, WBS rows, UoM, networks, Job Orders, employees, supervisors, bookings and example cost rates. The **Playwright end-to-end tests need this data**: `apps/web/e2e/smoke.spec.ts` logs in as `EC1001` and books against seeded Job Orders, so it only passes on demo data.
- Both seeds are **destructive** (a `deleteMany` chain in FK order), both refuse to run when `NODE_ENV=production`, and both give every account they create the `DEV_SEED_PASSWORD` (default `WorkforceDev@2026`).
- **Reset DB**: `npm run db:seed` (four accounts, no business data) or `npm run db:seed:demo` (the demonstration set). `npm run db:setup` runs the whole path — shared build → `prisma generate` → provider-aware schema step → the **minimal** seed — so add `npm run db:seed:demo` after it when you want the demo data.
- **Dev SQLite rebuild**: `npm run db:migrate` (a `file:` URL runs `prisma db push --skip-generate`) plus the seed you want. `npm run db:seed:demo` creates the full master-data hierarchy — 5 projects, 7 WBS rows (two of them in Project A), 4 UoMs, 7 Networks (each one linked to a WBS row), 16 Job Orders with `1900000107` deliberately repeated in Projects A and C, 16 budget revisions and 7 quantity-progress rows — and prints the dev logins it created. Recipe: [`docs/DEV_SQLITE_TESTING.md`](DEV_SQLITE_TESTING.md).
- **Adding a model on the dev box?** `prisma db push` writes **no** migration, so production would never get the table. Generate the DDL with `prisma migrate diff --from-schema-datamodel <old>.pg --to-schema-datamodel <new>.pg --script` and commit it under `migrations/<timestamp>_<name>/`.

Full dev-on-SQLite recipe, helper scripts and rollback notes: [`docs/DEV_SQLITE_TESTING.md`](DEV_SQLITE_TESTING.md).

### Schema highlights

- **CR#2 unified `Employee`**: `source` (`SYNC` / `MANUAL` / `PAYROLL`), `employmentType` (`CLMS` / `PAYROLL`), canonical `ecNo`, `natureOfWork`, `grade`, `active` (soft-depart). The old `ContractWorker`, `idCardNo`, `section` and `plant` columns were retired.
- **`EmployeeSectionAssignment`** (one Section per employee), **`EmployeeOrganisationOverride`** (durable PM/Admin transfer that the sync will not undo), **`SupervisorOverride`** (audited manual promotion to Supervisor).
- **`User.sectionId` + `User.departmentId`** — the HOD approval scope (`hodScopeMatches`).
- **`EmployeeAllocationDay`** (parent per employee/day) with `status`, and **`EmployeeAllocation`** (child rows) keyed by `(allocationDayId, shiftSlot)`: mandatory `projectId`, optional `jobOrderId`, no OT. **`EmployeeAllocationApproval`** stores the immutable decision history.
- **`HodDelegation`** — dated, reasoned HOD approval cover (delegator, delegate, Department+Section, from/to, revoke). Migration `20260916000000_hod_approval_delegation`.
- **`CredentialDelivery`** — durable queue for one-time credentials (no password is ever stored in it).
- Latest migrations: `20260913000000_postgresql_baseline`, `20260914000000_role_based_access`, `20260915000000_hod_section_and_org_transfer`, `20260916000000_hod_approval_delegation`, `20260918000000_project_wbs_job_order_master` (renames `projects_wbs` to `project_wbs`, adds `uom`, `networks`, `job_order_budget_revisions`, `job_order_progress` and the attribution snapshot columns, maps `closed`/`on_hold` to `inactive`, and writes revision 1 of every existing Job Order), `20260918000001_job_order_progress_remarks` (one row per quantity remark), `20260918000002_job_order_wbs_project_fk` (composite key so a Job Order's Project must own its WBS), `20260918000003_network_wbs_scope` (adds the required `networks.wbs_id`: each existing Network is backfilled onto its project's first WBS row — lowest sort order, then lowest WBS code, **not** limited to active rows — and the migration stops with the offending Network codes when a Network's project has no WBS row at all).

## 22. Environment variables

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
| `DEV_SEED_PASSWORD` | Password that both seeds (`db:seed`, `db:seed:demo`) give every account they create | `WorkforceDev@2026` |
| `DEV_SYNC_PASSWORD` | Password `run-sync-once.cjs` gives synced accounts | `password@SDHI` |
| `MAX_DAILY_HOURS` | Daily cap for over-allocation guard | `8` |
| `MAX_OT_HOURS` | OT validation upper bound | `12` |
| `SHIFTS` | Shift window config | `GENERAL:09:00-17:00` |
| `BADGEVIEW_SYNC_ENABLED` | Enable sync cron | `false` |
| `BADGEVIEW_SYNC_ACTIVE_ONLY` | Import active workers only; a terminated worker is never fetched and never gets a row or a login. The absence sweep still retires anyone who leaves | `true` |
| `BADGEVIEW_SYNC_CRON` | Sync schedule | `0 6,18 * * *` |
| `BADGEVIEW_DB_HOST` | Source SQL Server | `10.5.1.106` |
| `BADGEVIEW_DB_USER` / `_PASSWORD` / `_NAME` / `_VIEW` | Source credentials | (set in `.env`, git-ignored) |
| `BADGEVIEW_DB_ENCRYPT` | TLS to source | `false` (internal segment only) |
| `BADGEVIEW_SYNC_MIN_ROWS` / `BADGEVIEW_SYNC_MIN_RATIO` | Snapshot completeness guards | `1` / `0.9` |
| `CREDENTIAL_DELIVERY_ENABLED` | Send one-time credentials by e-mail | `false` (keep false locally) |
| `CREDENTIAL_DELIVERY_RECIPIENT` | Default recipient for queued credentials | IT Support mailbox |
| `SMTP_*` | Mail transport for credential delivery | unset ⇒ delivery stays pending |

## 23. Ports & proxy

- **API**: `API_PORT` (default `4000`; use `4100` if `4000` is OS-occupied).
- **Vite web**: `apps/web/vite.config.ts` `server.port` (default `5173`; Vite auto-falls-back to `5174` if taken).
- **Vite proxy target**: must match `API_PORT`. If you change one, change the other.
- Common Windows issue: `4000` and `5173` may be held by `svchost` — pick free ports (`4100`, `5174`) and update the proxy.

## 24. Schema overview (Prisma)

Key models in `apps/api/prisma/schema.prisma`:

- `Department`, `Project`, `ProjectWbs`, `JobOrder`, `Uom`, `Network` (Project → WBS → Job Order master data; a Job Order number is unique **per project** only). `Network` carries a required **`wbsId`**: a Network belongs to one WBS element of its project, and its `code` is still unique on `(projectId, code)`.
- `JobOrderBudgetRevision` (effective-dated budget per Job Order), `JobOrderProgress` (cumulative quantity to date, `SUBMITTED` / `APPROVED` / `REJECTED` / `SENT_BACK`)
- `Employee` (unified, CR#2) + `EmployeeSectionAssignment`, `EmployeeOrganisationOverride`, `SupervisorOverride`
- `User` (login accounts; role-gated; `source` for sync vs manual; `departmentId` + `sectionId` = HOD scope)
- `HodDelegation` (dated HOD approval cover)
- `TimesheetDay` + `TimesheetEntry` (contract-worker timesheets, with OT)
- `EmployeeAllocationDay` + `EmployeeAllocation` + `EmployeeAllocationApproval` (CR#2 slot-based payroll allocations, no OT)
- `Approval`, `AuditLog`, `DailyTeamSelection`, `ManpowerRequest`, `CostRate`, `AttendanceFeed`, `Conflict`
- `CredentialDelivery`, `SyncException`, `Section`, `CostCenter`

## 25. API endpoints

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
| `/approvals/:id/approve` | POST | HOD/PM | Stage-scoped approve (Admin is refused) |
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
| `/summary/job-order?status=all\|active\|inactive&departmentId=&asOf=` | GET | auth (not EMPLOYEE) | Job Order Summary: Project → WBS → Job Order, hours and quantity; HOD / DEPT_HEAD pinned to their own department |
| `/projects` | GET | auth | Project master list |
| `/job-order` | GET | auth | Job-order list (filter by project / status / department) |
| `/master-data/projects`, `/projects/:id/wbs`, `/projects/:id/networks`, `/uom` | GET | auth | Master-data lists (Project, WBS, Network per project, UoM). Each Network carries its `wbsId` and the `wbsCode` of the WBS it belongs to |
| `/master-data/projects`, `/projects/:projectId/wbs`, `/projects/:projectId/networks`, `/uom` | POST | ADMIN/PM | Create a master row; a duplicate answers `409` and names the conflicting row. A Network create **requires `wbsId`** — an active WBS row of that project |
| `/master-data/projects/:id`, `/wbs/:id`, `/networks/:id`, `/uom/:id` | PUT | ADMIN/PM | Update a master row. A Network update takes `wbsId`, so a Network can be moved to another WBS row of its own project |
| `/master-data/job-orders?projectId=&status=&q=` | GET | auth | Job Order maintenance list (Project, WBS, Network, booked hours). Each row carries its project's WBS rows and, inside each WBS row, that WBS's Networks |
| `/master-data/job-orders/:id/mapping` | PUT | ADMIN/PM | Correct a Job Order's WBS and Network without a screen of its own (the Job Order tab has no mapping controls); refused with `NETWORK_WBS_MISMATCH` when the Network is not of the chosen WBS, and with `JOB_ORDER_WBS_LOCKED` once hours are booked |
| `/master-data/job-orders/:id/budget` | PUT | ADMIN/PM | **Edit Job Order** on the Job Order tab: revises Budget hours and Budget quantity and writes a new effective-dated revision with the date, time and author. Refused with `BUDGET_UNCHANGED` when nothing changed |
| `/master-data/.../:id/deactivate`, `/activate` | POST | ADMIN/PM | Retire or restore a master row (`active = false` / `true`) |
| `/master-data/projects/:id`, `/wbs/:id`, `/networks/:id`, `/uom/:id` | DELETE | ADMIN/PM | Hard delete; refused with the reference counts while another row points at it |
| `/job-order-upload/template` | GET | ADMIN/PM | Job Order CSV template (fixed header + one real example row) |
| `/job-order-upload` | POST | ADMIN/PM | Import Job Orders; per-row `created` / `skipped` / `rejected` report |
| `/job-order-progress/mine` | GET | HOD/DEPT_HEAD/ADMIN | Own quantity-progress entries, achieved-to-date figures and history |
| `/job-order-progress` | POST | HOD/DEPT_HEAD/ADMIN | Punch the CUMULATIVE quantity for a Job Order and date |
| `/job-order-progress/:id/amend` | POST | HOD/DEPT_HEAD/ADMIN | Amend an entry that is `REJECTED` or `SENT_BACK` (new revision, old row kept) |
| `/job-order-progress/pending` | GET | PM/ADMIN | Quantity entries awaiting a decision |
| `/job-order-progress/:id/decision` | POST | PM/ADMIN | `action`: `APPROVE` / `REJECT` / `SEND_BACK` (a remark is required for the last two) |
| `/admin/job-orders/:id/remap` | PUT | ADMIN | Re-map a Job Order's WBS / Department / Section; refused once it has booked hours |
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

## 26. Security model

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

### 26.1 Production deployment checklist (mandatory)

Before exposing this app to any network beyond localhost, complete every item below:

- [ ] **`API_HOST=127.0.0.1`** — bind the API to localhost only, OR place it behind a reverse proxy that terminates **TLS/HTTPS** (Caddy / nginx / Cloudflare Tunnel / etc.). Never serve plaintext HTTP on a reachable interface.
- [ ] **Set a real `JWT_SECRET`** (≥32 chars, not a placeholder) and `CORS_ORIGINS` — the API refuses to start in production without them.
- [ ] **Rotate or disable the accounts the seeds create** (`WorkforceDev@2026`) in any environment reachable beyond localhost. Treat them as dev-only fixtures: `npm run db:seed` alone leaves four **office accounts with a known password** and nothing else.
- [ ] **Keep `AUTH_RATE_LIMIT_ENABLED` at its default (`true`)** — production refuses to start with it disabled.
- [ ] **`DATABASE_URL` must be a PostgreSQL URL** — a `file:` URL is rejected in production.
- [ ] **`.env` is git-ignored** — verified before every commit. Production credentials (`BADGEVIEW_DB_PASSWORD`, `JWT_SECRET`, `SMTP_PASSWORD`, any DB URL with an embedded password) must **never** be committed or pasted into chat transcripts / logs.
- [ ] **`BADGEVIEW_DB_ENCRYPT`** — set to `true` if the source SQL Server is reachable beyond a trusted internal segment.
- [ ] **Keep `CREDENTIAL_DELIVERY_ENABLED=false`** until SMTP is configured, or queued one-time credentials will never be delivered and new users cannot log in.
- [ ] **Audit logs are rotated and backed up** off-host — `AuditLog` is the only record of who approved what.
- [ ] **Run the latest migration** — production must use a managed PostgreSQL instance with `prisma migrate deploy` (never `db push`). Confirm `20260916000000_hod_approval_delegation` has been applied.

### 26.2 Credential hygiene

- `.env` is in `.gitignore`; do not commit it. Do not paste its contents into chat, screenshots, or issue trackers.
- Rotate the `JWT_SECRET` (if configured) and the seeded admin password before any production deploy.
- Source DB credentials (`BADGEVIEW_DB_PASSWORD`) belong only in the runtime `.env` of the deploy host — never in code, comments, or transcripts.
- If a credential is exposed (e.g. typed into chat), revoke it immediately and rotate.

## 27. Troubleshooting

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

### Upload refused over the Network — *"belongs to WBS …"*
- A Network belongs to **one WBS element** of its project, so `Network_ID` is checked against the `WBS_NO` written **on the same row**. The row is rejected when the Network is already a master of another WBS of that project, for example `Row 7: Network_ID — Network "NW-T1-002" belongs to WBS "T1.OUTF.0020.100", not "T1.HULL.0010.100".` **An upload never moves a Network.** Correct the row's `WBS_NO` or `Network_ID`, or add the Network to that WBS on **Project Master Data → Network** first. A Network that does not exist yet is created **under the row's WBS** while *"Create a missing WBS or Network automatically"* is on.

### `npm run db:seed` left no supervisor, HOD or employee login
- That is the minimal bootstrap on purpose: four office accounts and no business data, so the app starts the way production does. Run `npm run db:seed:demo` for the demonstration set (it is also what the Playwright tests need), or build the real data in order: LabourWorks sync (section 12) → Project / WBS / UoM / Networks (section 14) → Job Orders by CSV (section 15).

### A Job Order is missing from the booking picker
- The picker offers only an `Active` Job Order on an `Active` Project in an `Active` Department, filtered by the supervisor's fixed Department, the chosen Section and the chosen Project. A project Job Order appears only for its own Section; a standing / Non-Project Job Order appears for any Section of its Department. Check the Job Order's status and Section in the Job Order Summary or in the master data.

### Quantity punch refused — "Cumulative quantity cannot decrease"
- The figure is the total achieved **to date**, not the day's increment. The API compares it with the last **approved** cumulative figure (or with an existing entry for the same day) and refuses anything lower. Punch the corrected total, or wait for the Project Head to reject or send back the entry and then amend it.

### No **Amend** button on a quantity entry
- An HOD may amend only after the Project Head **rejects** or **sends back** the entry. A `SUBMITTED` or `APPROVED` entry can only be followed by a new day's punch. The API answers `AMENDMENT_NOT_ALLOWED` otherwise.

### The Job Order Summary shows a dash instead of a percentage
- That Job Order has **no approved quantity progress** yet, so there is no achieved figure to compare with the budget. The API returns `0` with `progressReported: false`; the screen deliberately renders a dash rather than a false `0 %`. It is not a rendering fault — punch and approve a quantity entry, or check with the responsible HOD.

### A Job Order cannot be moved to another WBS
- The Job Order already has booked hours, and every booked row keeps the attribution frozen at booking time, so the move would re-point live work. The API answers `JOB_ORDER_WBS_LOCKED` with the booked counts. Deactivate the Job Order and create a new one under the correct WBS.

---

## Appendix A — Glossary

- **HOD** — Head of Department/Section. Owns stage-1 approval for one Department + Section. Logs in with the linked payroll Employee's **ecNo**.
- **PM** — Project Manager / Project Head. Stage-2 approver with a global (cross-department) view, and the approver of Job Order quantity progress.
- **DEPT_HEAD** — Department Head. Owns every Section of one Department; punches Job Order quantity progress with an explicitly selected Section. He never approves the figure he punched.
- **Project / WBS / Job Order** — the master-data hierarchy. A Job Order number is unique **per project only**, so it repeats across projects, and each Job Order points at one WBS row.
- **Network** — a per-project SAP network reference that **belongs to one WBS element** of that project. Several Job Orders may share one Network. A Network code is unique inside the project, and one code never spans two WBS rows of the same project, so the Job Order upload checks `Network_ID` against the `WBS_NO` on the same row.
- **Seed (minimal) / seed (demo)** — `npm run db:seed` creates four office accounts and no business data; `npm run db:seed:demo` adds the full demonstration set (and is what the Playwright tests need).
- **Non-Project (standing) Job Order** — a Job Order of the Non-Project project with no Section; any Section of its Department may book it.
- **Budget revision** — an effective-dated budget for a Job Order. Consumption is measured against the revision in force on the work date, not the current one.
- **Cumulative quantity** — the total quantity achieved to date as punched by the HOD, never a daily increment.
- **Achieved quantity** — the cumulative quantity of the latest **approved** progress entry. No approved entry means no achieved figure (shown as a dash).
- **Attribution snapshot** — the `project_id`, `project_wbs_id`, `department_id` and `section_id` stored on a booking row when the hours are booked; the grouping keys of every report.
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

`npm run db:seed` — the minimal, production-like bootstrap. **No business data**, and no supervisor, HOD or employee login:

```
ADMIN       admin@company.com
PM          pm@company.com             (central authority, all departments)
HR          hr@company.com             (legacy admin screens only — not an approver)
Finance     finance@company.com        (cost-rates viewer)
```

`npm run db:seed:demo` — the demonstration set. It creates the four rows above **plus** these logins and the data the screens need:

```
HOD         hod@company.com            (example: Production - EOU / Hull Production)
Employee    EC1011   (employee@company.com)
Supervisor  EC1001   (r.sharma@company.com, linked payroll Employee)
Supervisor  EC1006   (sup.a@company.com)
Supervisor  EC1007   (sup.b@company.com)
Supervisor  EC1014   (sup.c@company.com)
Supervisor  EC1017   (sup.d@company.com)
Supervisor  EC1018   (sup.e@company.com)
```

The demo seed also writes the Job Orders the Playwright tests book against, for example `1900000107-Pipe Spool Installation` in Project A / Hull Production.

Passwords — **they differ by account type**:

- Accounts created by **either** seed (both tables above): **`WorkforceDev@2026`** (`DEV_SEED_PASSWORD`)
- Accounts created by the LabourWorks sync (EcNo login, e.g. `BAPL0251`): **`password@SDHI`**, set on a dev box with `node apps/api/set-dev-password.cjs <ecNo>`
- Accounts you register in the UI (Employee/HOD): no usable password until the credential is delivered — use `set-dev-password.cjs`

---

_Document version: Project → WBS → Job Order master data and quantity progress (working tree on `feature/cr2-unified-employee`, HEAD `56f0910`), including CR#2 unified Employee + HOD scope + HOD approval cover, the two seed commands (`db:seed` minimal / `db:seed:demo`) and the Network → WBS scope (`20260918000003_network_wbs_scope`). Maintained alongside the codebase; update when schema, routes, roles or lifecycle change. Companion documents: [`MASTER_DATA_PROJECT_WBS_JOB_ORDER.md`](MASTER_DATA_PROJECT_WBS_JOB_ORDER.md) (hierarchy design and operating reference), [`MASTER_DATA_BUILD_CONTRACT.md`](MASTER_DATA_BUILD_CONTRACT.md) (build contract), [`ROLE_BASED_ACCESS.md`](ROLE_BASED_ACCESS.md) (enforced role matrix), [`DEV_SQLITE_TESTING.md`](DEV_SQLITE_TESTING.md) (local SQLite dev), [`PRODUCTION_DEPLOYMENT.md`](PRODUCTION_DEPLOYMENT.md)._
