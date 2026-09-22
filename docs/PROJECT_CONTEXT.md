# Workforce — project context (read this first)

A handover for a new session or a new engineer. It states what the project is, what is
currently shipped, the rules that must not be broken, how to run it, and the traps.

Everything here was verified on this machine on **2026-09-19**. When this document and the
code disagree, the code wins — and please correct the document.

- Repository: `/mnt/c/data/comp/workforce`
- Branch in use: **`feature/master-data-project-wbs-joborder`** (do NOT assume
  `feature/cr2-unified-employee`, which is the older CR branch)
- Latest pushed commit at the time of writing: **`0229c9a`**
- Authoritative detail lives in: `docs/MANUAL.md` (end-user + reference),
  `docs/PRODUCTION_DEPLOYMENT.md`, `docs/DEV_SQLITE_TESTING.md`,
  `docs/MASTER_DATA_PROJECT_WBS_JOB_ORDER.md` (design record) and
  `docs/MASTER_DATA_BUILD_CONTRACT.md` (the rules the parallel workstreams were built to).

---

## 1. What the application is

A workforce timesheet and approval system for a shipyard.

| Part | Path | Stack |
|---|---|---|
| API | `apps/api` | Express + TypeScript, Prisma 5, JWT auth |
| Web | `apps/web` | React + Vite |
| Shared | `packages/shared` | Zod schemas and shared types |
| Database | dev: SQLite `apps/api/prisma/dev.db` · prod: PostgreSQL | |

Workflow: a Supervisor selects a team, books each person's 2-hour shift slots against a
Job Order, and submits. An HOD approves, then the PM. Employees can self-allocate ("My
Hours"). Summaries roll the approved hours up by Project, WBS, Department and Supervisor,
and quantity progress is punched by the HOD and approved by the PM.

Two external systems matter: **LabourWorks / BadgeView** (SQL Server, the source of truth
for contract workers, departments and sections) and, in phase 2, a **SAP** feed for
networks.

## 2. The data model in one page

```
projects (1) ──► project_wbs (1) ──► job_orders  ──► job_order_progress ──► job_order_progress_remarks
     │                 │                    │                  │
     │                 │                    └── job_order_budget_revisions
     │                 └── networks (one WBS each)
     └── uom (global master)
```

| Rule | Why it matters |
|---|---|
| `projects.color_key` is 1-4 uppercase chars and UNIQUE | it is the short token shown on Timesheet Entry; the Summary groups columns by it |
| `projects.is_non_project` marks the one standing / idle-hours project | idle hours must be bookable without inventing a project |
| `project_wbs.wbs_code` is unique **per project**, never globally | the same WBS number exists in another project |
| `job_orders.code` is unique **per project** only | the PM team reuses one number for the same activity across projects; `1900000107` exists in three projects today |
| `job_orders.status` is `active` or `inactive` only | `closed` and `on_hold` were removed |
| `job_orders.section_id` is NULL only for a standing / Non-Project Job Order | such a Job Order may be booked by ANY section of its department; a project Job Order only by its own section |
| `networks.wbs_id` is required | **one Network number never spans two WBS elements of the same project** (confirmed by the user). The upload validates `Network_ID` against the `WBS_NO` on the same line |
| A composite FK forces a Job Order's `project_id` to be its WBS's own project | declared in Prisma as a second relation (`projectWbsOfProject`), so `migrate dev` will not drop it |
| `job_order_budget_revisions` is effective-dated | consumption is compared against the revision in force ON THE WORK DATE, so a past month keeps the budget it was measured against. No approval: the PM is the custodian |
| `job_order_progress` holds the CUMULATIVE quantity, versioned by `revision_no` | the figure never goes down; an amendment is only allowed after the PM rejects or sends back, and the rejected row stays as history |
| `job_order_progress_remarks` keeps EVERY remark | the row's `remarks` column holds the latest message; this table is the reportable history (stage, author, role, time) |
| `timesheet_entries` / `employee_allocations` carry a FROZEN attribution snapshot (`project_id`, `project_wbs_id`, `department_id`, `section_id`) | reports group by the snapshot, so editing a Job Order's mapping later cannot move already-booked hours. Buckets frozen, labels (name, colour) live |
| A Job Order with booked hours may not move to another WBS | `409 JOB_ORDER_WBS_LOCKED`; the snapshot would be re-pointed |
| Assignability | a Job Order is bookable only when the Job Order, its Project and its Department are all active |
| Budget revisions | the PM revises **Budget hours** and **Budget quantity** on Project Master Data → Job Order → **Edit Job Order**; every save writes an effective-dated revision (revision_no + 1) with the date, time, author and reason, and audits `ADMIN_UPDATE_JOB_ORDER_BUDGET`. The mapping (Project / WBS / Network) is read-only there, so an existing Job Order cannot be re-pointed from the form |
| Booking picker | Department is fixed to the supervisor's own; only the **Project** is chosen, and the Job Order list is that Project's Job Orders inside the department. There is **no Section control** on Timesheet Entry - the Section of the work is read from the chosen Job Order and stored on the booking. My Hours keeps its own Section control on the single-slot picker |
| Approval authority | Supervisor submits -> **HOD** approves -> **PM** approves. **Admin decides nothing.** It sees every queue and all history, and its decision buttons are removed; the API refuses approve/reject/batch/send-back with 403. Quantity progress matches: the HOD punches, the PM decides, the Admin only reads |

## 3. How to run it

```bash
cd /mnt/c/data/comp/workforce
npm run dev:api        # API  http://127.0.0.1:4000   (log: /tmp/wf-api.log if started in background)
npm run dev:web        # Web  http://localhost:5173
```

**Seeds — two commands, and both WIPE every table first:**

| Command | What it creates |
|---|---|
| `npm run db:seed` | the minimal production-like bootstrap: **ADMIN, PM, HR, FINANCE only**, no business data. Use it before a real rehearsal. |
| `npm run db:seed:demo` | the full demonstration set (projects, WBS, UoM, networks, Job Orders, employees, supervisors, bookings, cost rates). **The Playwright suite needs this one.** |
| `npm run db:setup` | first time on a fresh clone: build shared + generate + migrate + the minimal seed |

The seed is a **one-time setup step, not a startup step**. Never re-seed casually: it
deletes the synced departments, sections, employees and supervisor logins, and you must
re-run the sync afterwards.

**The production-like order (this is the intended rehearsal):**

```
npm run db:seed          → 4 office accounts, nothing else
Sync from LabourWorks    → departments, sections, employees, supervisor logins
Project Master Data      → Project, WBS, UoM, Networks   (/master-data, PM or ADMIN)
Job Order CSV upload     → the Job Orders                (/job-order-upload)
```

The sync runs from **Admin → Sync** or `POST /api/admin/sync/badgeview`; it is disabled as a
cron on this box (`BADGEVIEW_SYNC_ENABLED=false`), so nothing writes behind your back.

**Accounts** (password `WorkforceDev@2026` unless noted; override with `DEV_SEED_PASSWORD`):

| Role | Login | Lands on |
|---|---|---|
| ADMIN | `admin@company.com` | Approvals |
| PM (Project Head) | `pm@company.com` | Approvals |
| HR | `hr@company.com` | Employees |
| FINANCE | `finance@company.com` | Summary |
| Supervisor (synced) | any synced EcNo e.g. `BAPL0042` | Select Team — password **`password@SDHI`** |

The last one is deliberate: the sync uses the same credential path as a web registration, so
while the pre-production bootstrap password is in force a synced Supervisor can sign in at
once. That path **refuses to hand out the shared password against PostgreSQL**, and the
production build fails while the literal is in `services/defaultLoginCredentials.ts`. Remove
the literal and everything falls back to the random, e-mailed one-time credential.

**Creating an HOD** is two steps on the **Employees** page (PM or ADMIN): register the person
as a **payroll** employee first, then promote them in the *HOD Registration & Department /
Section Mapping* panel. The candidate list is payroll employees only — synced workers are
CLMS and never appear, because an HOD is payroll staff. The Section chosen for the HOD must
match the employee's own Section.

## 4. Testing

- API unit tests: `cd apps/api && npm test` — **156 pass** (node test runner via tsx).
- Type-checks: `cd apps/api && npx tsc --noEmit`, `cd apps/web && npx tsc -b`.
- Production web build: `cd apps/web && npx vite build`.
- End-to-end: `cd apps/web && npx playwright test` — **12 pass** (smoke, master-data,
  mobile-screens). It reuses an already-running dev server. **It needs the demo data**, so run
  `npm run db:seed:demo` before it, and expect the smoke tests to fail on the minimal seed.
- Migrations: `prisma migrate deploy` against PostgreSQL. There is also a proven recipe for
  verifying a hand-written migration on a throwaway PostgreSQL cluster with a zero-drift diff.

## 5. Traps that have already cost time

1. **`vite` and `tsx watch` do not see file changes under `/mnt/c`.** A stale dev server
   serves old code and makes a working fix look broken. **Restart both servers after editing**
   before debugging anything.
2. **Stale API processes hold port 4000.** Several `tsx src/index.ts` instances can pile up and
   an OLD one keeps the port, so a brand-new endpoint appears to 404. `pkill -f "src/index.ts"`
   before starting one.
3. **Env vars set with `os.environ[...]` in the agent kernel leak into every later `bash()`
   call** and silently retarget project commands (Prisma prefers a process-env `DATABASE_URL`
   over the `.env` file). Pass env inline per command, or pop them afterwards.
4. **CRLF/LF:** the repository has mixed line endings. Agent edits flip a CRLF file to LF, and
   `git diff` then shows a whole-file rewrite. Restore the file's original ending before
   committing so the diff stays reviewable.
5. **The Summary is empty the morning after a seed** because the demo data is dated the day the
   seed ran. Move the date picker, or re-seed.
6. **`window.confirm` is auto-dismissed by Playwright** unless the test accepts the dialog, so a
   "Deactivate" click appears to do nothing.
7. **List screens were invisible below 1024px**: `.sup-table` is `display: none` and the
   `.sup-card` fallback was never rendered by any page. Fixed by making the table scroll
   sideways inside its own box; a page with its OWN card layout must opt its table back out
   (`JobOrderProgressPage` does). `e2e/mobile-screens.spec.ts` guards it.
8. The **Employees page labels are not linked to their inputs** (no `htmlFor`), so clicking a
   label does not focus the field. The master-data screen was fixed; this page was not.
9. **Do the HOD step with an HOD account, not an Admin.** An Admin no longer can approve, and
   it never could do the chain correctly: it used to sit in both stages of its own queue, so
   approving twice completed a sheet as `PM_APPROVED` and the PM never saw it. Every department
   whose supervisors submit needs its own HOD, otherwise those sheets cannot be approved at all.

## 6. Open items

- **`networks.wbs_id` does not enforce that the WBS belongs to the Network's own project** at
  the database level; the application does (screen and upload). The same composite-key trick
  used for the Job Order/WBS pair would close it.
- **Employees page label association** (above).
- **Phase 2:** the automatic SAP network sync (after a two-month trial), and dated employee
  organisation history so a transfer splits department reports from the transfer date.
- The **quantity progress amendment trail** in the demo data leaves one DRAFT booking behind
  after the e2e run; harmless, but tidy it if the demo must be pristine.
- **Clocked hours (in/out) is live, with one dependency to watch.** IT granted SELECT on
  `[LabourWorks].[dbo].[Report_Attendance_Intermediate]` to the read-only login `it` on 2026-09-21, so
  `POST /api/attendance-hours/refresh` and the 09:00 / 21:00 job read the real view. Confirmed against
  it: `IDNo` = the employee ecNo, `ManHours` = the hours, and the DATE column is `Date` (the earlier
  `AttDate` default was a placeholder and is gone). The view holds one row per check-in/out pair, so a
  worker can appear twice on one date and the day's figure is the SUM (see `docs/MANUAL.md` §12.1). If
  the grant is ever revoked the feature fails closed: the refresh answers 502 and names the login.
