# Project → WBS → Job Order master data

Status: **IMPLEMENTED** (2026-09-18). This document is the design record and the
operating reference for the change. It supersedes the earlier planning draft, which
described a design that was revised several times before it was built.

Pinned evidence: git HEAD `56f0910567c92b825751a65bc7d544067a5ab3a3` plus the working tree.
The tree is edited by other agents, so re-check before acting. The Network → WBS scope
(`20260918000003_network_wbs_scope`) and the two seed commands (`npm run db:seed` for the
four office accounts, `npm run db:seed:demo` for the demonstration data) sit in the working
tree on top of that HEAD.

## 1. The hierarchy

```
projects (1) ──► project_wbs (many) ──► job_orders (many)
   code             wbs_code                 code
   colour key       unique per project       unique per project
     │                  │                         │
     │                  └── networks             ├── job_order_budget_revisions
     └── uom (global master) ────────────────────┴── job_order_progress
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
- **Network** is a SAP-sourced reference that **belongs to ONE WBS element** of its
  project: `networks.wbs_id` is required. Several Job Orders may share one Network.
  Reporting happens at WBS or Project level.

  One Network number never spans two WBS rows of the same project (confirmed by the
  user), so the Job Order CSV upload validates `Network_ID` against the `WBS_NO`
  **on the same row**. The Network code stays unique on `(project_id, code)`: the WBS
  narrows which WBS element owns the code, it does not split the code's uniqueness.
- **UoM** is a global master (for example NOS, MT, SQM, MTR) with an `example` string
  that the maintenance screen shows as help text.

## 2. Tables

| Table | Key fields | Rules |
|---|---|---|
| `projects` | `code` unique, `name`, `color_key` unique, `is_non_project`, `sort_order`, `active` | `color_key` is uppercase alphanumeric, 1-4 characters. `is_non_project` marks the single row that holds standing / idle-hours work. |
| `project_wbs` | `project_id`, `wbs_code`, `name`, `sort_order`, `active` | `wbs_code` is unique per project. Deleting a Project cascades to its WBS rows. |
| `networks` | `project_id`, **`wbs_id`**, `code`, `name`, `source`, `active` | `wbs_id` is required and names one WBS element; one Network number never spans two WBS rows. The **same-project** rule is enforced by the application, not by the database: the foreign key only requires an existing `project_wbs` row, so a `wbs_id` belonging to another project is accepted by PostgreSQL alone. `code` is unique per project (`(project_id, code)`), so the WBS does not loosen the duplicate rule. `source` is `MANUAL` until the SAP sync lands, and the phase-2 sync fills the WBS link. |
| `uom` | `code` unique, `name`, `example`, `active` | `example` is the on-screen help text. |
| `job_orders` | `project_id`, `project_wbs_id`, `network_id`, `code`, `name`, `uom_id`, `budgeted_quantity`, `budgeted_hours`, `department_id`, `section_id`, `status` | `code` is unique per project. `status` is `active` or `inactive` only. `section_id` is required for a project Job Order and null only for a standing one. `network_id` must be a Network of the Job Order's own `project_wbs_id`; that rule is enforced by the upload, the mapping route and the Job Order Mapping screen, not by a foreign key. |
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
8. **A Network belongs to one WBS.** `networks.wbs_id` is required, the Network tab asks for
   the WBS of the Network and shows it in a WBS column, the Job Order mapping form offers
   only the Networks of the selected WBS (changing the WBS reloads the list), and the CSV
   upload validates `Network_ID` against the `WBS_NO` **on the same row**. A Network of
   another WBS of the same project is **rejected**, never moved, so one Network number never
   spans two WBS rows. `(project_id, code)` uniqueness is unchanged.

## 4. Job Order CSV upload

Exact header, in order:

```
Project_ID, Project_Name, WBS_NO, Network_ID, Job_Order, Job_Description, UoM, Qty,
Budgeted_hours, Department, Section, Job_Order_Status
```

- `Project_ID` must exist and `Project_Name` must agree with it. The upload **never** creates
  a Project (a Project needs a colour key the template does not carry), nor a UoM, Department
  or Section.
- A **missing `WBS_NO`** under that project, and a **missing `Network_ID`** under the WBS
  that line names, are **created** and the line then imports. A created Network carries the
  row's `wbs_id`. One new master named by several lines is created once, in the first line's
  spelling; two lines share one new Network only when they name the **same WBS**, and the
  same new code under a second WBS of the project is rejected. An inactive Network is never
  revived. The switch **"Create a missing WBS or Network automatically"** on the upload
  screen (default on) turns this off. The response reports `wbsCreated` / `networksCreated`
  with the line that introduced each (and the WBS a created Network sits under), and the
  audit entry carries the same.
- `UoM` must exist in its master. `Network_ID` must exist **under the `WBS_NO` on the same
  row**: a Network that is a master of another WBS of the same project is rejected, and the
  message names the Network and both WBS codes, for example
  `Network "NW-T1-002" belongs to WBS "T1.OUTF.0020.100", not "T1.HULL.0010.100".`
  An upload never moves a Network to another WBS, so one Network number never spans two WBS
  rows of a project.
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
| Project Master Data | `/master-data` | ADMIN, PM | Tabs Project, WBS, UoM, Network, Job Order. Example help text on every field. Duplicates refused with the conflicting row named. A **Network row requires a WBS** (a select limited to the chosen project's WBS rows, and the list shows a WBS column); the **Job Order** tab corrects a Job Order's WBS / Network, offering **only the Networks of the selected WBS**, and changing the WBS reloads that list. Deactivate instead of delete; a hard delete is offered only when nothing references the row. |
| Job Order Upload | `/job-order-upload` | ADMIN, PM | Template download plus upload, with created / skipped / rejected counts and per-row reasons. `Network_ID` is checked against the `WBS_NO` on its own row, so a Network of another WBS of the same project is rejected with both WBS codes in the message. |
| Quantity Progress | `/job-order-progress` | HOD, DEPT_HEAD, PM, ADMIN | HOD punch screen with a Section picker for a Department Head, plus the PM approval queue (approve / reject / send back). |
| Job Order Summary | Summary → Job Order | as before | Groups Project → WBS → Job Order. Hours and quantity side by side. Status filter All / Active / In-Active. |
| Project Summary | Summary → Project | as before | Now grouped by the frozen booking snapshot. Column headings are the project colour key. |

## 6. Migrations

| Migration | What it does |
|---|---|
| `20260918000000_project_wbs_job_order_master` | The hierarchy rebuild described below. |
| `20260918000001_job_order_progress_remarks` | Adds `job_order_progress_remarks` and backfills the remarks that already existed (a rejected entry becomes a `REJECT` row authored by the PM; anything else becomes a `PUNCH` row authored by the HOD). |
| `20260918000002_job_order_wbs_project_fk` | Adds the composite foreign key that makes a Job Order's Project match its WBS's Project, with a guard that refuses to add it while the data violates it. |
| `20260918000003_network_wbs_scope` | Adds the required `networks.wbs_id` and backfills every existing Network onto its project's first WBS row, with a guard that refuses to run while a Network's project has no WBS row. |

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

### The Network → WBS scope

`apps/api/prisma/migrations/20260918000003_network_wbs_scope/migration.sql`

Until this migration a Network was scoped to the project, so a Job Order could point at a
Network of a different WBS of the same project. The migration makes the WBS part of the
Network:

- it adds `networks.wbs_id` as a nullable column and **backfills** each existing Network
  onto its project's **first** WBS row — `DISTINCT ON (project_id)` ordered by
  `sort_order`, then `wbs_code`. The pick is **not** limited to active WBS rows, so an
  inactive lowest-`sort_order` row can be chosen; the file's header comment says "FIRST
  active WBS row", which is not what the SQL does;
- a `DO` block **stops the migration and names the Network codes** whose project has no
  WBS row at all, instead of inventing a WBS: add a WBS row to that project, or delete the
  Network, and re-run;
- only then does it set `wbs_id` NOT NULL, add the foreign key to `project_wbs(id)`
  (`ON DELETE RESTRICT`) and the index on `(wbs_id, active)`.

`(project_id, code)` uniqueness is unchanged, so a Network code may not be reused for a
second WBS row of the same project. The foreign key keeps `wbs_id` pointing at a real
`project_wbs` row only: **the database alone accepts a WBS row of another project**, so the
same-project rule stays an application rule (`resolveNetworkWbs` in
`masterDataRules.ts`, used by the Network routes; `jobOrderNetworkWbsError` on the mapping
route; and the upload's WBS-first resolution).
Unlike the Job Order → WBS pair, no composite foreign key closes it.

The dev SQLite database is rebuilt with `npm run db:migrate` and `npm run db:seed:demo`;
the PostgreSQL migrations are not applied to SQLite.

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
| Network → WBS rule (unit tests) | `apps/api/src/services/jobOrderCsv.test.ts` pins `resolveNetworkForRow`: a Network of the row's own WBS is accepted, a Network of **another WBS of the same project** is rejected with `Network "NET-A3" belongs to WBS "A.HULL.0011.100", not "A.HULL.0010.100".`, a missing Network is created under the row's WBS carrying its `wbsId`, two rows create one new Network only under one WBS, and one new code named by two WBS of one file creates one master and rejects the second. `npm run test -w @workforce/api` (2026-09-19): **156 tests, 0 fail**. |
| Migration `20260918000003_network_wbs_scope` (throwaway PostgreSQL 16 cluster, md5 `35b534fca4e463a15a2f8a195b0fb87e`) | **Backfill:** lowest `sort_order` wins (PASS), a tie on `sort_order` broken by the lowest `wbs_code` (PASS), a project with no Network left untouched (PASS), 0 rows left NULL (PASS). Then `wbs_id` NOT NULL (PASS), FK RESTRICT/CASCADE (PASS), index `(wbs_id, active)` (PASS), the old per-project unique index and indexes kept (PASS). **Guard:** stops with a non-zero exit and names every offending Network code and its project (PASS), and under Prisma's transactional apply (`BEGIN; … COMMIT;`) nothing is left half-applied — no column, no FK, no index (PASS); adding the missing `project_wbs` row and re-running succeeds (PASS). **Negative tests:** `wbs_id` NULL rejected (PASS), a `wbs_id` with no `project_wbs` row rejected (PASS), duplicate `(project_id, code)` rejected (PASS), the same code in a different project allowed (PASS), deleting a WBS that owns a Network refused (PASS). **Two findings:** the pick ignores `active`, so an inactive lowest-sort WBS row is chosen (the file's comment claims "first active"), and the FK does **not** enforce the same-project rule — a `wbs_id` of another project is accepted by the database, so only the application closes that gap. Not verified: an actual `prisma migrate deploy` against a project database (no `_prisma_migrations` bookkeeping), and the application paths through the new columns. |
| End-to-end HTTP run against a copy of the dev database | master-data create plus duplicate refusals; WBS and Network code reuse across projects; Job Order template and upload with created / skipped / rejected; unknown WBS refusal; department hyphen tolerance; booking through the real timesheet write path writing the four snapshot columns; Job Order Summary grouping Project → WBS → Job Order with the same Job Order number in three projects shown separately, hours and quantity as separate figures; quantity punch, duplicate-day refusal, cumulative floor, cross-department refusal, role gates, reject-then-amend keeping revision 1 as history, approval, and the approved figure flowing into the summary |

## 8. Phase 2

- The automatic SAP Network sync replaces manual Network maintenance after the two-month
  trial, and it will fill the WBS link (`networks.wbs_id`) of every Network it maintains,
  so the first-WBS backfill of `20260918000003_network_wbs_scope` is a one-off for the
  existing rows rather than an ongoing rule.
- Dated employee organisation history, so a transfer splits department reports from the
  transfer date while the employee's own summary stays combined. Today the
  employee-to-Section mapping is current-state only, so payroll-side cost attribution can
  still shift on transfer.
