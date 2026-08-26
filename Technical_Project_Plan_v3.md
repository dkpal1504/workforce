# Manpower & Timesheet App
*Technical Project Plan (v0.3) — Python / Node.js / PostgreSQL — for Cursor-based development*

## 0. Change Log Since v0.2

This version reconciles the plan against four confirmed screen documentation files: Daily Timesheet Entry, HOD Approvals (two open versions), and Project & Job Order Summary. Major shifts:

- **Allocation model changed from hourly (13 slots) to shift-based (4 slots/day)** — 1st Half (9a–11a, 11a–1p), 2nd Half (2p–4p, 4p–6p). This replaces the `hour_slot 0–12` field everywhere.
- **Bulk-first entry workflow** is now the primary interaction on Timesheet Entry (Select All unassigned → Project → Job Order → Assign to Selected), with per-row grid demoted to "Review & Fine-tune." "Select from Previous Day" carries forward both roster *and* allocations, not just roster.
- **HOD Approvals has two competing versions, both still open, decision deferred.** This plan documents both; only one ships.
- **Two new screens formalized**: Project Summary and Job Order Summary, as tabs under one "Summary" area.
- **Job Order → Department mapping simplified to one-to-one** (single department per Job Order) as a working assumption, overriding the earlier many-to-many schema. Flagged in Section 11 as unresolved against real data (Block Transfer needs two departments).
- **Contradiction found and flagged, not silently fixed**: Job Order Summary's documentation still shows a Frequency filter (Daily/Weekly/Monthly), but this was explicitly agreed to be dropped earlier (Job Order consumption is a cumulative position, not a period flow — Frequency didn't have a coherent meaning for it). The uploaded doc hasn't caught up to that decision. **Build without Frequency on Job Order Summary**; flag this line in the doc as stale if it resurfaces.
- **Job Order Master numbering convention resolved as all-numeric** (`1900000xxx`), including Standing/Non-Project Job Orders (`1900000401–405`) — supersedes the earlier `STJ-xxx-nnn` alpha convention used in the first Job Order Master spreadsheet. **The spreadsheet needs updating to match; it currently disagrees with the screens.**
- **Project D added** to the Job Order Master (Deck Furniture Installation) — wasn't in the original three-project example.

---

## 1. Overview

This plan translates the confirmed screen documentation into a buildable technical design — architecture, database schema, API surface, business logic, and delivery plan. As of this version, **five screens are documented and settled enough to build against** (Daily Timesheet Entry, HOD Approvals, Project Summary, Job Order Summary), plus Select Team from earlier in the project (not part of this documentation batch, not superseded — carried forward unchanged). **Admin (master data maintenance) still has no screen design at all** — flagged again, unresolved since v0.2.

**Naming item, still unresolved from v0.2:** "Supervisor" vs. "Sectional Head" — pick one for code/schema.

---

## 2. Roles — Final Definitions

| Role | Responsibility |
|---|---|
| **Supervisor** (a.k.a. Sectional Head) | Selects/confirms daily team, allocates shift slots to Job Orders on Timesheet Entry. Accountable for daily tagging completeness. |
| **HOD** | Approves submissions (at Supervisor level, or Job Order+Supervisor level — see Section 6, undecided), resolves conflicts, handles items sent back by Planning. |
| **Planning** | Issues Job Orders, Production Orders, and Standing Job Orders. Reviews HOD-approved data weekly; sends items back with a comment (data error or over-budget) if something looks wrong. Owns Job Order budgets. |
| **PM** | Not resolved — flagged open in v0.2, still open. |
| **Finance** | Consumes approved, project-wise cost data. No screen yet. |
| **HR** | Owns employee↔department master data. Not accountable for tagging completeness. |
| **IT / Admin** | Maintains master data (Job Order list, departments, cost rates), user/role management. **No screen exists for this yet.** |

---

## 3. Technical Architecture

*(Unchanged from v0.2 — stack, high-level flow, and repo structure remain valid. See v0.2 for full detail; not reproduced here except where affected.)*

### 3.1 Stack (unchanged)

| Layer | Technology |
|---|---|
| Frontend | React.js (mobile-first, responsive) |
| Backend API | Node.js (Express/Fastify) + TypeScript |
| Integration / Batch Jobs | Python (scripts + APScheduler) |
| Database | PostgreSQL 15+ |
| Scheduling | node-cron + Python APScheduler/cron |
| Auth | JWT session auth; AD/SSO if available |

---

## 4. Database Schema (PostgreSQL) — Updated

### 4.1 `projects` (new — was implicit before)

```sql
id              BIGSERIAL PRIMARY KEY
code            TEXT UNIQUE          -- e.g. "P-1001"
name            TEXT                 -- e.g. "Samudra Pavak Repair"
```

### 4.2 `job_orders` (renamed/restructured from `projects_wbs`)

```sql
id              BIGSERIAL PRIMARY KEY
job_order_code  TEXT UNIQUE          -- numeric, e.g. "1900000107" (all-numeric
                                      -- convention, including Standing Job Orders
                                      -- — supersedes earlier STJ-xxx alpha codes)
job_order_name  TEXT                 -- e.g. "Pipe Spool Installation"
project_id      FK -> projects.id NULL   -- NULL for Standing/Non-Project Job Orders
department_id   FK -> departments.id     -- SIMPLIFICATION: one department per Job
                                          -- Order, per current working assumption.
                                          -- KNOWN GAP: Block Transfer (Block 223)
                                          -- genuinely needs 2 departments
                                          -- (Production + Logistics). Deferred —
                                          -- see Section 11.
budgeted_hours  NUMERIC NULL         -- NULL for Standing Job Orders (no budget cap)
status          ENUM('active','closed','on_hold')
                                      -- Job Order Summary excludes 'on_hold' entirely
```

### 4.3 `timesheet_entries` (updated — slot model, not hourly)

```sql
id              BIGSERIAL PRIMARY KEY
employee_id     FK -> employees.id
work_date       DATE
shift_slot      ENUM('am1','am2','pm1','pm2')   -- was hour_slot 0-12; now 4 slots/day
                                                   -- (1st Half: 9-11, 11-1;
                                                    2nd Half: 2-4, 4-6)
job_order_id    FK -> job_orders.id
tagged_by       FK -> users.id       -- supervisor of record
status          ENUM('draft','submitted','hod_approved','planning_returned','rejected')
remarks         TEXT
created_at, updated_at   TIMESTAMP
```

### 4.4 `daily_team_selection` (unchanged from v0.2)

```sql
id              BIGSERIAL PRIMARY KEY
supervisor_id   FK -> users.id
employee_id     FK -> employees.id
work_date       DATE
source          ENUM('carried_over','added','removed')
created_at      TIMESTAMP
removed_at      TIMESTAMP NULL
```

### 4.5 `approvals` — now needs a mode flag, given two competing versions

```sql
id              BIGSERIAL PRIMARY KEY
mode            ENUM('supervisor_batch','job_order_supervisor')  -- which version is live
supervisor_id   FK -> users.id
job_order_id    FK -> job_orders.id NULL   -- NULL if mode = 'supervisor_batch'
work_date       DATE
approved_by     FK -> users.id NULL     -- HOD
status          ENUM('pending','approved','rejected','returned_by_planning')
planning_comment TEXT NULL
planning_reason  ENUM('over_budget','data_error') NULL   -- drives the amber/gray tag
hod_note        TEXT NULL
approved_at     TIMESTAMP NULL
```
**Version 1 (Supervisor-level approval):** one row per (supervisor, date); `job_order_id` NULL.
**Version 2 (Job Order + Supervisor approval):** one row per (supervisor, job_order, date) — a supervisor working 3 Job Orders in a day produces 3 rows, each independently approved. **This is an accepted, deliberate trade-off**, not a bug — see Section 6.

### 4.6 `conflicts`, `exceptions` — unchanged from v0.2

*(See v0.2 for full definitions — duplicate-tagging and missing-tag exception logic is unaffected by the slot-model or approval-mode changes.)*

---

## 5. Key Business Logic — Updated

### 5.1 Timesheet Entry — Bulk-First Allocation (new, replaces old per-row-first logic)

```
Default state: all employees' slots empty (or pre-filled via "Select from
Previous Day" — see 5.2).

Primary flow (Bulk Assignment block):
  1. Supervisor checks "Select All" -> selects all 4 slots for every employee
     NOT already marked "✓ Assigned" (already-assigned rows are skipped
     automatically, untouched)
  2. Supervisor picks Project -> Job Order (scoped to that Project) ->
     Job Order Name auto-fills, read-only
  3. "Assign to Selected" applies Project+Job Order to every selected
     (amber) slot across all rows
     -> rows fully filled (all 4 slots) get tagged "✓ Assigned"
     -> rows partially filled get an "attention" state, surfaced in the
        per-row grid below for manual completion

Exception flow (per-row grid, "Review & Fine-tune"):
  - Full Shift checkbox: toggles all 4 of one employee's slots at once.
    FROZEN (disabled) once that row is fully assigned — cannot be used
    to unassign; unassignment must go through Remove or individual slot
    edits, not this checkbox. This is a deliberate guardrail, not an
    oversight.
  - Individual slot click: toggles empty <-> amber (selected) only.
  - Row-level Assign button: same logic as bulk, scoped to just that
    row's selected slots. Disabled if no Project chosen, no slot
    selected, or row already fully assigned.
```

### 5.2 "Select from Previous Day" (supersedes v0.2's simpler roster-only default)

```
On click: copy BOTH daily_team_selection AND the prior working day's
timesheet_entries (Project + Job Order per slot) forward to today.
Supervisor reviews and adjusts only the exceptions — not just roster,
now the allocations too. This is a bigger convenience than the v0.2
design assumed; also a bigger risk if a Job Order closed overnight —
worth a validation pass: any carried-over Job Order that is no longer
'active' should surface as a flagged exception, not silently carry
forward. (Not yet in the docs — recommend adding before build.)
```

### 5.3 HOD Approval — Two Open Versions (decision deferred, both documented for build)

**Version 1 — Supervisor is the approval surface:**
```
Approve/Reject/Comments exist ONLY on "Group by Supervisor."
"Group by Job Order" and "Group by Employee" are inspection-only.
Approval granularity: (supervisor, date) — one action per supervisor
per day, regardless of how many Job Orders they touched that day.
Sent Back by Planning appears ONLY under "Group by Supervisor" —
flat table: Sr | Supervisor | Employee | Date | Proj A/B/C |
Total Alloc. | Overhead | Planning's Comment | Send back to
Supervisor | HOD Note.
```

**Version 2 — Job Order + Supervisor combination is the approval surface:**
```
Approve/Reject/Comments exist ONLY on "Group by Job Order," on the
nested Supervisor sub-rows underneath each Job Order header row.
"Group by Supervisor" and "Group by Employee" are inspection-only
(read-only Pending/Approved/Rejected status tag instead of buttons).
Approval granularity: (supervisor, job_order, date) — a supervisor
working 3 Job Orders today is approved 3 separate times. ACCEPTED
trade-off, not to be "fixed" without a product decision to revert.
Sent Back by Planning appears ONLY under "Group by Job Order" — same
nested Job Order -> Supervisor structure, same original column set
(Sr | Supervisor | Employee | Date | Proj A/B/C | Total Alloc. |
Overhead | Planning's Comment | Send back to Supervisor | HOD Note),
with the Over Budget / Data Error reason tag shown inline inside the
Planning's Comment cell.
```

**Both versions share:**
```
- Conflict-blocking: unresolved duplicate-tagging conflicts disable
  Approve at whichever level the conflicted employee's data rolls up
  to, auto-expanding to surface the conflict.
- No budget/consumption figures on Supervisor or Employee views in
  either version — those are legitimacy checks only. Budget context
  (Approved hrs, Budgeted hrs, Consumption % bar) appears solely on
  Job Order-grouped rows.
- Job Order-grouped rows show a footnote: "Figures reflect this
  department's submissions only — full cross-department budget status
  is available on Job Order Summary."
```

**Build both, ship one — flagged as the single largest open decision blocking final HOD Approvals sign-off.**

### 5.4 EOD Jobs, Cost Calculation — unchanged from v0.2

*(Duplicate-tagging check and missing-tag exception check are unaffected by the slot-model change beyond checking 4 slots/day instead of 13 hour-blocks. Cost calculation logic — average rate × hours — unchanged.)*

---

## 6. Screens & Component Breakdown — Updated

### 6.1 Select Team
*(Unchanged from v0.2 — not part of this documentation batch, not superseded.)*

### 6.2 Daily Timesheet Entry (updated)
`FilterBar` (Date/Department/Supervisor, "Filled: N/Total" indicator), `BulkAssignmentBlock` (Select All, Project dropdown, Job Order dropdown scoped to Project, Job Order Name read-only, Assign to Selected, live "N slots selected" summary + affected-employee list), `SelectFromPreviousDayButton`, `PerRowGrid` (`FullShiftCheckbox` — frozen once done, 4 `SlotCell`s, `AllocationCell` with row-level Project/Job Order/Assign, `RemarksField`), `EditRemoveLinks`, `AddEmployeeRow`, `SaveDraftButton`, `SubmitButton`

### 6.3 HOD Approvals (two versions — build both)
`TabBar` (Pending/Approved), `GroupByToggle` (3-way, order and which-is-default differs by version), `SupervisorRow`/`JobOrderRow` (expandable, conflict-aware), `EmployeeSubRow` / `SupervisorSubRow` (read-only or actionable depending on version+view), `ConflictBadge`, `ConsumptionBar` (color-coded, Job Order rows only), `PendingSinceTag`, `SentBackByPlanningSection` (structure depends on version — flat or nested), `ReasonTag` (Over Budget / Data Error), `CommentField`, `HODNoteField`

### 6.4 Project Summary (formalized from v0.2's "Summary")
`FrequencyDropdown`, `ProjectMultiSelectFilter`, `GroupByToggle` (Employee/Supervisor/Department/Totals), `ViewToggle` (Hours/Cost), `ActiveProjectsLabel`, `SummaryTable` (dynamic project columns + Total + Overhead), `TotalsRow`

### 6.5 Job Order Summary (new)
`TabBar` (shared with Project Summary — "Project Summary" | "Job Order Summary"), `ProjectFilter`, `StatusToggle` (All/Active/Closed — **no Frequency filter**, see Section 0 change log), `DepartmentFilter` (single-select), `ProjectGroupHeader` (bold section row, name only), `JobOrderRow` (Sr. No. restarts per group, code+name+status superscript, Budgeted/Consumption/Balance in hours, `ConsumptionBar`)

### 6.6 Admin — still not designed
Unchanged gap from v0.2. **This is now more urgent, not less** — the Job Order master (project↔Job Order↔department↔budget) is core to almost every screen documented in this version, and nobody has a screen to maintain it.

---

## 7. API Design (Node.js REST) — Updated

| Area | Endpoints |
|---|---|
| Timesheet Entry | `GET /timesheet?date&supervisor_id` • `POST /timesheet/bulk-assign` (employeeIds[], slots[], projectId, jobOrderId) • `PUT /timesheet/entry/:id` (per-row exception edits) • `GET /timesheet/previous-day?supervisor_id&date` • `POST /timesheet/submit` |
| Job Orders | `GET /job-orders?project_id` (scoped dropdown, Project → Job Order) • `GET /job-orders/:id` |
| HOD Approvals (mode-dependent — see 5.3) | `GET /approvals/pending?groupBy=supervisor\|employee\|job_order` • `POST /approvals/:batchId/approve` (batchId = supervisor-date OR supervisor-jobOrder-date, depending on shipped version) • `POST /approvals/:batchId/reject` • `GET /approvals/returned-by-planning` • `POST /approvals/:id/send-to-supervisor` |
| Conflicts / Exceptions | Unchanged from v0.2 |
| Summary | `GET /summary/project?frequency&projectIds[]&groupBy&view` • `GET /summary/job-order?projectIds[]&status&departmentId` (no frequency param) |
| Admin | Still undesigned — needed for `job_orders`, `departments`, `users`, `cost_rates` CRUD |

---

## 8. Open Decisions — Updated

- **HOD Approvals: Version 1 vs. Version 2** — the single biggest open item. Both are built; pick one before final sign-off.
- **Job Order ↔ Department: one-to-one (current simplification) vs. many-to-many (real requirement per Block Transfer)** — the schema currently reflects the simplification; needs a real decision, since it affects Job Order Summary's Department filter, HOD Approvals' department-scoping, and budget accuracy on any multi-department Job Order.
- **Job Order Master spreadsheet is now stale** — numbering convention and Project D need to be added to match the confirmed screens.
- **"Select from Previous Day" carrying forward closed/inactive Job Orders** — needs a validation rule (Section 5.2), not yet specified anywhere.
- Naming ("Supervisor" vs. "Sectional Head"), Planning's own interface, PM's role/screen, reminder threshold N, hosting/SSO/reminder-channel/device/retention — all unchanged, still open from v0.2.

---

## 9. Risks — Updated

| Risk | Mitigation |
|---|---|
| Shipping the wrong HOD Approvals version late | Both are fully documented and buildable now — decide before Sprint 3, not during it. |
| Department-per-Job-Order simplification breaks on real multi-department Job Orders | Known gap, not hidden — Section 11-equivalent flags it; revisit before this reaches Production/Logistics-shared work in practice. |
| Admin screen absence blocks everything else | This has been flagged in three consecutive plan versions without a screen appearing — treat as a blocker for Sprint 1, not a nice-to-have. |
| Documentation drift (Frequency filter, numbering convention) | Caught this round via cross-checking against the actual docs — worth a periodic doc-reconciliation pass rather than assuming screens and plan stay in sync automatically. |

*(All other risks from v0.2 — CLMS/SAP delay, roster fluidity, HOD overload — unchanged and still mitigated as previously documented.)*
