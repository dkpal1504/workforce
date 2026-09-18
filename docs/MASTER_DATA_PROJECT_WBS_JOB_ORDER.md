# Project → WBS → Job Order master data

Status: **IMPLEMENTED** (2026-09-18). This document is the design record and the
operating reference for the change. It supersedes the earlier planning draft, which
described a design that was revised several times before it was built.

Pinned evidence: git HEAD `56f0910567c92b825751a65bc7d544067a5ab3a3` plus the working tree.
The tree is edited by other agents, so re-check before acting.

## 1. The hierarchy

```
projects (1) ──► project_wbs (many) ──► job_orders (many)
   code             wbs_code                 code
   colour key       unique per project       unique per project
     │                                            │
     ├── networks (per project)                   ├── job_order_budget_revisions
     └── uom (global master) ─────────────────────┴── job_order_progress
```

- A **Project** is the commercial container. `code` is the ERP project number,
  `name` is its name, and `colorKey` is the 1-4 character display token shown on the
  Timesheet Entry screen (A, B, C, D as before). The colour key is unique across all
  projects, so a column in a report can never be merged or split by accident.
- A **WBS** belongs to exactly one Project and only groups Job Orders. It carries no
  budget. `wbs_code` is unique **per project**, so the same WBS number can exist in
  another project.
- A **Job Order** belongs to one WBS. Its number is generated manually by the PM team
  and **repeats across projects**, so it is unique **per project only**. Never treat a
  Job Order number as a global key.
- **Network** is a SAP-sourced reference, validated against a per-project list. Several
  Job Orders may share one Network. Reporting happens at WBS or Project level.
- **UoM** is a global master (for example NOS, MT, SQM, MTR) with an `example` string
  that the maintenance screen shows as help text.

## 2. Tables

| Table | Key fields | Rules |
|---|---|---|
| `projects` | `code` unique, `name`, `color_key` unique, `is_non_project`, `sort_order`, `active` | `color_key` is uppercase alphanumeric, 1-4 characters. `is_non_project` marks the single row that holds standing / idle-hours work. |
| `project_wbs` | `project_id`, `wbs_code`, `name`, `sort_order`, `active` | `wbs_code` is unique per project. Deleting a Project cascades to its WBS rows. |
| `networks` | `project_id`, `code`, `name`, `source`, `active` | `code` is unique per project. `source` is `MANUAL` until the SAP sync lands. |
| `uom` | `code` unique, `name`, `example`, `active` | `example` is the on-screen help text. |
| `job_orders` | `project_id`, `project_wbs_id`, `network_id`, `code`, `name`, `uom_id`, `budgeted_quantity`, `budgeted_hours`, `department_id`, `section_id`, `status` | `code` is unique per project. `status` is `active` or `inactive` only. `section_id` is required for a project Job Order and null only for a standing one. |
| `job_order_budget_revisions` | `job_order_id`, `revision_no`, `budgeted_hours`, `budgeted_quantity`, `uom_id`, `effective_from`, `reason` | One row per revision, unique on (job order, revision). Revision 1 is the opening budget. |
| `job_order_progress` | `job_order_id`, `progress_date`, `cumulative_quantity`, `revision_no`, `section_id`, `status`, `punched_by`, `approved_by`, `approved_at`, `remarks` | Unique on (job order, date, revision). `status` is `SUBMITTED`, `APPROVED`, `REJECTED` or `SENT_BACK`. `remarks` holds the **latest** message only. |
| `job_order_progress_remarks` | `progress_id`, `kind`, `remark`, `author_id`, `author_role`, `created_at` | **Every** remark is a separate row and is never overwritten, so any report can show the whole exchange. `kind` is `PUNCH`, `AMEND`, `APPROVE`, `REJECT` or `SEND_BACK`. A superseded revision keeps its own rows, so an amendment never loses what was said about the revision it replaced. |

### Attribution snapshot

`timesheet_entries` and `employee_allocations` carry `project_id`, `project_wbs_id`,
`department_id` and `section_id`, captured **when the hours are booked**.

- The **buckets** (those ids) are frozen: every report groups by them, so a later
  master-data change can never move hours that were already booked.
- The **labels** (project name, colour key) stay live, so renaming a project or changing
  its colour relabels a column without moving a single hour.
- There is deliberately **no** foreign key tying the snapshot to the live Job Order: a
  snapshot may legally differ from it after a remap.

**WBS-and-Project consistency is a database guarantee.** A Job Order carries both
`project_wbs_id` and `project_id`, so nothing stops a writer from pointing them at
different Projects. A composite foreign key closes that:

```sql
ALTER TABLE "job_orders"
  ADD CONSTRAINT "job_orders_project_wbs_id_project_id_fkey"
    FOREIGN KEY ("project_wbs_id", "project_id")
    REFERENCES "project_wbs" ("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;
```

It is declared in the Prisma schema as a second relation on `job_orders`
(`projectWbsOfProject`) with the supporting `@@unique([id, projectId])` on `project_wbs`,
so **Prisma owns the constraint** and a later `migrate dev` will not try to drop it.
Never navigate through that relation in code — use `projectWbs` and `project`.
Verified: a row whose Project is not its WBS's Project is refused, a matching row is
accepted, and the drift check stays clean.

## 3. Operating rules

1. **Status.** A Job Order is `active` or `inactive`. `closed` and `on_hold` no longer
   exist. Only an active Job Order on an active Project in an active Department can be
   booked or have progress punched.
2. **Booking.** On the Timesheet Entry and My Hours screens the Department is fixed to
   the supervisor's own department, the Section is chosen from that department's
   sections, and the Project is chosen freely. The Job Order list is then filtered by all
   three and each option reads `Job_Order-Job_Description`. A standing / Non-Project Job
   Order (`section_id` null) is offered for any section of its department; a project Job
   Order only for its own section. The WBS number is returned by the API but hidden in the
   UI.
3. **Quantity progress.** The HOD punches the **cumulative** quantity achieved to date,
   never a daily increment. The figure may never fall below the last approved figure. One
   entry per Job Order per day. The PM approves, rejects or sends back. The HOD may amend
   an entry **only** after it is rejected or sent back; the amendment is a new revision and
   the rejected row stays as history. A Department Head selects the section he is punching
   for.
4. **Remarks are permanent.** Every punch, amendment, approval, rejection and send-back
   writes its own remark row with the author and the author's role. The progress row keeps
   the latest message for the screen, but nothing is overwritten. The remarks are readable
   per entry on the Quantity Progress screen and as a flat chronological report from
   `GET /api/job-order-progress/remarks` (filters: Job Order, project, date range, kind).
5. **Budget revisions.** Effective-dated, no approval step (the PM is the custodian).
   Consumption is compared against the revision in force **on the work date**, so a past
   month keeps the budget it was measured against.
6. **Hours and quantity are independent.** The Job Order Summary shows them side by side
   and never blends them, so a Job Order can be 80% on hours and 40% on quantity at the
   same moment.
7. **Achieved quantity** is the `cumulative_quantity` of the latest **approved** entry. A
   Job Order with no approved progress shows a dash, not a false 0%.

## 4. Job Order CSV upload

Exact header, in order:

```
Project_ID, Project_Name, WBS_NO, Network_ID, Job_Order, Job_Description, UoM, Qty,
Budgeted_hours, Department, Section, Job_Order_Status
```

- `Project_ID` must exist and `Project_Name` must agree with it. `WBS_NO` must exist under
  that project. The upload **never** creates a Project, a WBS, a Network or a UoM.
- `UoM` and `Network_ID` must exist in their masters, and the Network must belong to the
  project on the row.
- `Department` must be the exact organisation-master name `BuName - Workmen Division` that
  the badge sync builds. Matching tolerates case, extra whitespace and a hyphen typed
  without spaces, and the **master** spelling is stored.
- `Section` must exist under that Department. It is required except on a Non-Project row,
  where it is stored as null so any section of the department can book the Job Order.
- `Qty` and `Budgeted_hours` are numbers ≥ 0; blank means 0.
- `Job_Order_Status` is `Active` or `In-Active` and is stored as `active` / `inactive`.
- **Duplicate rule:** a row is rejected when `Project_ID + WBS_NO + Job_Order` already
  exists. The same Job Order number under a **different** WBS of the same project is
  skipped and reported, never overwritten. A number repeated inside one file is rejected
  on the later row.
- Roles: ADMIN or PM. Every run is audited. Every rejected row is reported with its row
  number, the column and the reason; a file is never partially accepted in silence.

## 5. Screens

| Screen | Route | Who | What it does |
|---|---|---|---|
| Project Master Data | `/master-data` | ADMIN, PM | Tabs Project, WBS, UoM, Network. Example help text on every field. Duplicates refused with the conflicting row named. Deactivate instead of delete; a hard delete is offered only when nothing references the row. |
| Job Order Upload | `/job-order-upload` | ADMIN, PM | Template download plus upload, with created / skipped / rejected counts and per-row reasons. |
| Quantity Progress | `/job-order-progress` | HOD, DEPT_HEAD, PM, ADMIN | HOD punch screen with a Section picker for a Department Head, plus the PM approval queue (approve / reject / send back). |
| Job Order Summary | Summary → Job Order | as before | Groups Project → WBS → Job Order. Hours and quantity side by side. Status filter All / Active / In-Active. |
| Project Summary | Summary → Project | as before | Now grouped by the frozen booking snapshot. Column headings are the project colour key. |

## 6. Migrations

| Migration | What it does |
|---|---|
| `20260918000000_project_wbs_job_order_master` | The hierarchy rebuild described below. |
| `20260918000001_job_order_progress_remarks` | Adds `job_order_progress_remarks` and backfills the remarks that already existed (a rejected entry becomes a `REJECT` row authored by the PM; anything else becomes a `PUNCH` row authored by the HOD). |
| `20260918000002_job_order_wbs_project_fk` | Adds the composite foreign key that makes a Job Order's Project match its WBS's Project, with a guard that refuses to add it while the data violates it. |

### The hierarchy rebuild

`apps/api/prisma/migrations/20260918000000_project_wbs_job_order_master/migration.sql`

It **renames** `projects_wbs` to `project_wbs` and gives it its parent `project_id`, so
existing rows and the foreign keys that point at it survive. An auto-generated diff would
have dropped the table and lost the data.

Every new required column is added nullable, backfilled from the data, then made NOT NULL,
with `DO` blocks that raise a readable error instead of a bare constraint failure. It also:

- derives the Non-Project flag and creates the `GENERAL` WBS row from the Job Orders that
  had no WBS, then attaches them;
- creates a placeholder UoM (`NOS`) and one `DUMMY` Network per project so existing rows can
  satisfy the new required columns;
- maps `closed` and `on_hold` to `inactive`;
- writes revision 1 of every existing Job Order from its current budget;
- backfills the attribution snapshot on existing timesheet and allocation rows.

Verified twice on a throwaway PostgreSQL 16 cluster: against a populated database (the four
earlier migrations, then old-style data, then this one) and against an empty database for
the fresh-install path.

The dev SQLite database is rebuilt with `npm run db:migrate` and `npm run db:seed`; the
PostgreSQL migrations are not applied to SQLite.

## 7. Verification performed

| Check | Result |
|---|---|
| `prisma migrate deploy` on a fresh PostgreSQL 16 database | all seven migrations apply cleanly — the real production path |
| Drift check: migrated database vs the Prisma model | **"No difference detected"**, including the composite foreign key |
| Migration on a populated PostgreSQL 16 database | applies clean; rename, backfill, status mapping, revision rows and snapshots all verified row by row |
| Composite foreign key, negative and positive | a Job Order whose Project is not its WBS's Project is refused (`job_orders_project_wbs_id_project_id_fkey`); the same row with a matching Project is accepted |
| Dev SQLite vs `schema.prisma` | no drift |
| API unit tests | 131 pass, 0 fail |
| `tsc --noEmit` (API) and `tsc -b` (web) | clean |
| Quantity remarks | every stage writes its own row; a rejection never replaces the punched remark; an amendment keeps the superseded revision's remarks; the report endpoint is scoped to the caller's department and section |
| Production web build | succeeds |
| End-to-end HTTP run against a copy of the dev database | master-data create plus duplicate refusals; WBS and Network code reuse across projects; Job Order template and upload with created / skipped / rejected; unknown WBS refusal; department hyphen tolerance; booking through the real timesheet write path writing the four snapshot columns; Job Order Summary grouping Project → WBS → Job Order with the same Job Order number in three projects shown separately, hours and quantity as separate figures; quantity punch, duplicate-day refusal, cumulative floor, cross-department refusal, role gates, reject-then-amend keeping revision 1 as history, approval, and the approved figure flowing into the summary |

## 8. Phase 2

- The automatic SAP Network sync replaces manual Network maintenance after the two-month
  trial.
- Dated employee organisation history, so a transfer splits department reports from the
  transfer date while the employee's own summary stays combined. Today the
  employee-to-Section mapping is current-state only, so payroll-side cost attribution can
  still shift on transfer.
