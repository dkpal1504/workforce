# Master-data build contract (Project / WBS / Job Order)

> **Historical document.** This is the contract the parallel workstreams were built to.
> The change is now implemented; `docs/MASTER_DATA_PROJECT_WBS_JOB_ORDER.md` is the
> design record and operating reference. Kept because it states the agreed rules
> precisely and the tests still assert them.

Read this before changing any file for this change request. It is the interface the
workstreams share. Nothing here is optional.

## 0. Process

- Planning is finished; this is the build. Implement, then test.
- The database schema is ALREADY migrated. Do not edit:
  `apps/api/prisma/schema.prisma`, `schema.postgresql.prisma`, `prisma/migrations/**`,
  `database/01-schema.sql`, `apps/api/prisma/seed.ts`, `apps/api/src/index.ts`,
  `apps/web/src/App.tsx`, `apps/web/src/components/AppLayout.tsx`.
  Those are owned by the integration lead. To make your router or page reachable, put
  the exact lines to add in your final report instead of editing those files.
- Stay inside your assigned files. Another agent is editing other files at the same time.
- Run from `apps/api`: `npx tsc --noEmit` and `npm test` (node test runner via tsx).
  From `apps/web`: `npx tsc -b`. Both must be clean before you report.
- The dev database is SQLite (`DATABASE_URL=file:./dev.db`). The seed is being rewritten
  in parallel, so do not depend on seeded rows. Put testable rules in a service module
  and unit-test that, with no database.

## 1. Hierarchy and identity

```
projects (1) -> project_wbs (many) -> job_orders (many)
                     ^                     |
                uom, networks          job_order_budget_revisions
              (networks are per project) job_order_progress
```

- `projects.code` = ERP Project number (CSV `Project_ID`). `projects.color_key` = the 1-4
  character display token shown on Timesheet Entry (A, B, C, D). Unique across projects.
- `projects.is_non_project` - the single flagged row that holds standing / idle-hours work.
- `project_wbs.wbs_code` = the WBS number (CSV `WBS_NO`). Unique **per project**.
- `job_orders.code` = the Job Order number. It REPEATS across projects, so it is unique
  **per project only**: `@@unique([projectId, code])`. Never treat it as global.
- `networks.code` is unique per project. `uom.code` is unique globally.
- `job_orders.sectionId` is NULL only for standing / Non-Project Job Orders; those are
  matched on department alone so any section of the department may book them.
- `job_orders.status` is exactly `active` or `inactive`. `closed` and `on_hold` are gone.

## 2. New tables (exact fields)

```
uom(id, code unique, name, example, active, created_at, updated_at)
networks(id, project_id, wbs_id, code, name, source['MANUAL'|'SAP'], active, created_at, updated_at,
         UNIQUE(project_id, code))
         -- AMENDED LATER: a Network belongs to ONE WBS element (one Network number never
         -- spans two WBS rows of a project), so wbs_id is required and the upload checks
         -- Network_ID against the WBS_NO on the same line. See docs/MANUAL.md section 15.
job_order_budget_revisions(id, job_order_id, revision_no, budgeted_hours, budgeted_quantity,
         uom_id, effective_from, reason, created_by, created_at, UNIQUE(job_order_id, revision_no))
job_order_progress(id, job_order_id, progress_date, cumulative_quantity, revision_no,
         section_id, status, punched_by, approved_by, approved_at, remarks, created_at, updated_at,
         UNIQUE(job_order_id, progress_date, revision_no))
```

`job_order_progress.status`: `SUBMITTED` | `APPROVED` | `REJECTED` | `SENT_BACK`.

Rules that must be implemented and unit-tested:

1. **Budget is effective-dated.** Consumption is compared against the revision in force on
   the WORK DATE (latest `effective_from <= workDate`), not the current revision. The PM is
   the custodian, so a revision needs no approval.
2. **Quantity progress is cumulative and non-decreasing.** `cumulative_quantity` is the
   total to date as punched, never a daily increment.
3. **An HOD may amend a progress entry ONLY after the PM rejects or sends it back.**
   Otherwise the HOD may only add a new day's entry. An amendment keeps the old row as
   history and adds `revision_no + 1`.
4. **Achieved quantity** = the `cumulative_quantity` of the latest `APPROVED` entry.
   `Balance = budget (revision in force) - achieved`. Percentages clamp at 0 when the budget
   is 0.
5. Hours and quantity are INDEPENDENT measures. Show them side by side; never blend them.

## 3. Attribution snapshot (frozen at booking time)

`timesheet_entries` and `employee_allocations` carry `project_id`, `project_wbs_id`,
`department_id`, `section_id`. These are captured when hours are booked and are the
grouping keys for every report. A later master-data change must NOT move approved history.

- Do NOT add a composite key tying the snapshot to the live Job Order: it may legally differ.
- Buckets (the ids above) are frozen. Labels (project name, `color_key`) stay live.

## 4. Booking / picker rules

- The supervisor's **department is fixed** to his own. **Section is freely chosen** among
  that department's active sections. Project is freely chosen.
- The Job Order list is filtered by department + project (an optional section filter is kept for
  the My Hours picker). AMENDED: the supervisor Timesheet Entry screen has no Section control —
  a supervisor belongs to one department, so the Project alone decides, and the section of the
  work is read from the chosen Job Order. The list displays
  as `Job_Order-Job_Description` (for example `1900000107-Pipe Spool Installation`),
  and the Timesheet Entry picker caps the option text at 34 characters (Job Order number
  included) because a native `<select>` widens its list to the longest option; a real
  77-character description pushed the list past the row. The Job Order master keeps the
  full `Job_Description`, and the bulk bar shows it in the read-only Job Order Name field.
- A standing / Non-Project Job Order (`section_id IS NULL`) is included for any section of
  the department. A project Job Order is included only when its `section_id` matches.
- Assignability also requires `status = 'active'` on the Job Order, on the Project, and on
  the Department.
- `wbs_no` must be RETURNED by the API (so the frontend can disambiguate) but not shown in
  the UI by default.

## 5. CSV upload (Job Orders)

Header order is fixed:

```
Project_ID, Project_Name, WBS_NO, Network_ID, Job_Order, Job_Description, UoM, Qty,
Budgeted_hours, Department, Section, Job_Order_Status
```

- `Job_Order_Status` is `Active` or `In-Active` -> stored `active` / `inactive`.
- `Department` carries the FULL master name `BuName - Workmen Division` (the badge sync
  builds it with spaces around the hyphen). Match case-insensitively after trimming and
  collapsing whitespace, and accept a hyphen typed without spaces.
- `Section` must exist under that Department (`@@unique([departmentId, name])`).
  Section is REQUIRED except when the row's Project is the non-project row.
- `UoM` and `Network_ID` must exist in their masters (Network is scoped to the project).
- **Duplicate rule:** reject the row when `Project_ID + WBS_NO + Job_Order` already exists.
  The same Job Order number may appear in another project, never twice in one project.
- Unknown Project or WBS -> reject the row and list the missing values. Never auto-create
  a Project or a WBS from the upload.
  AMENDED LATER: a missing WBS and a missing Network ARE now created, behind the
  `createMissingMasters` flag (default true, with an on/off switch on the screen and the
  created rows reported per line). An unknown Project, UoM, Department or Section is still
  rejected. See `docs/MANUAL.md` section 15.3.
- Roles: ADMIN or PM. Every run is audited. Report per-row errors; never partially accept
  a file silently.

## 6. Conventions in this codebase

- Routers: `apps/api/src/routes/<name>.ts`, `export const xRouter = Router()`,
  `xRouter.use(requireAuth)`, per-route `requireRoles("ADMIN", "PM")`.
- Validation with `zod`. Auditing with `writeAudit(userId, action, entityType, entityId, meta)`
  from `../audit`. Prisma client from `../db` as `prisma`.
- Decimal-ish numbers are `Float`/`DOUBLE PRECISION` in this schema, not money types.
- Web pages live in `apps/web/src/pages/`, call `api<T>(path, init)` from `../api/client`,
  and follow the visual pattern of `DepartmentsPage.tsx`.
