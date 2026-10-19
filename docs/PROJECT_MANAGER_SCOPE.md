# Project Manager scope — the dashboard a Project Manager sees

**Audience:** whoever operates or supports the Project Manager screen.
**Code:** `services/projectScope.ts`, `services/projectStructure.ts`, `services/roleAccess.ts`
(`reportScopeFor`, `intersectProjectFilter`), `routes/projectManagers.ts`,
`routes/reports.ts`, `pages/ProjectManagersPage.tsx`, `pages/PortfolioDashboardPage.tsx`.
**Role matrix:** `docs/ROLE_BASED_ACCESS.md`.

---

## 1. What the role can and cannot do

| | PROJECT_MANAGER |
|---|---|
| `/portfolio` dashboard | **Yes**, scoped to the assigned projects |
| `/reports` + XLSX / PDF downloads | **Yes**, same scope, same numbers |
| Project → WBS → Network register | **Yes** (the "Project structure" section) |
| Timesheet coverage report | **No** (403; its tab is hidden) |
| Approvals, timesheet editing, master data, employee registration, role assignment | **No** |
| My Hours (his own hours, PAYROLL only) | Yes — the same rule as `PM` |

The role is granted on **Role Assignment** (it is in `ASSIGNABLE_ROLES`, and a payroll Employee can
also be *created* with it). Which projects it reads is granted separately on **Project Managers**.

## 2. Assigning a manager

1. **Role Assignment** → give the person `PROJECT_MANAGER`. (If they have no login yet, use the
   payroll-employee path; the account is created with the usual first credential.)
2. **Project Managers** → pick a project, pick the account, **Assign manager**.
3. The manager's dashboard reflects it on the next load. **No session is revoked** — the scope is
   read from the database per request, so an Admin tidying the panel never logs a manager out.

Rules the API enforces, each with its own sentence:

| Attempt | Result |
|---|---|
| Project missing / inactive | `PROJECT_NOT_FOUND` / `PROJECT_INACTIVE` (400) |
| Account missing / inactive | `USER_NOT_FOUND` / `ACCOUNT_INACTIVE` (400) |
| Account does not hold `PROJECT_MANAGER` | `ROLE_NOT_PROJECT_MANAGER` (400) — names Role Assignment as the next step |
| Pair already assigned | `ALREADY_ASSIGNED` (409) |
| Pair previously revoked | **re-activated** (200) — the row is reused, never duplicated |
| Revoke an already-revoked row | `ALREADY_REVOKED` (409) |

Assignments are **never deleted**. A revoke sets `status = "revoked"` and `revoked_at`, so "who
managed this project last quarter" stays answerable; the panel's history block shows both states.

## 3. What the report states about its own scope

Every report (screen and both downloads) carries a provenance block. For a manager it says:

```
Scope applied: Assigned projects only (2).
Project: <the applied project ids, named by the filter list>
```

When the request asked for a project outside the assignment, the rows are **zero** and the notes
block adds:

```
Requested Project filter: 9 — intersected with the acting scope and narrowed to the applied scope
above; the request never widened it.
```

That is deliberate: the report must never quietly substitute the assignment back in, and an export
must never claim a project it did not read.

## 4. The "Project structure" section

Project → WBS → Network, with each node's job orders, budget/actual hours, burn, worst hours band,
worst schedule band, quantity completion, stalled count and unapproved hours.

- **Worst child wins.** One RED job order colours its WBS and its project — the bands are never an
  average, because a fire is not diluted by the green jobs beside it.
- **Empty nodes are kept.** A WBS element with no Job Orders is a plan gap and is exactly what a
  manager is looking for. A node whose Job Orders are ALL outside the reader's scope is omitted (a
  Department Head must not read nodes he cannot attribute); the `in scope / total` cell is how the
  difference is stated when a node is shown.
- **A Network has no status.** The master stores only `active`; every band on a network row is
  derived from its job orders and the UI, the workbook header and the PDF title all say so.

## 5. Why the coverage report is excluded

`GET /api/reports/timesheet-coverage` lists the **employee roster × dates** — its rows are people,
not job orders. A project scope cannot define who is in that population, so admitting the role would
produce a report whose scope is undefined. The portfolio routes and the coverage routes therefore
carry **separate role lists** (`PORTFOLIO_ROLES` / `COVERAGE_ROLES` in `routes/reports.ts`), and the
tab is hidden from a role without `viewTimesheetCoverage`.

## 6. Operating notes

- **A manager with nothing assigned sees an empty dashboard with an explanation** — that is the
  fail-closed state, not a bug. Assign a project on Project Managers.
- **The Project and WBS pickers are narrowed too.** The dropdowns are fed by `/projects`,
  `/projects-wbs` and `/project-wbs`, which filter by the same assignment resolver, so the portfolio
  structure is not disclosed even to a reader whose report is already clamped.
- **Adding a project** — the register follows the effective project filter: with no filter it is the
  assignment (so an assigned project with no work still appears); with a filter it is that filter.
- **Deactivating a project** does not revoke its assignments; the manager keeps the row and sees it
  marked inactive. Deactivate/reactivate assignments deliberately.

## Shipping this in production

The release carries **one migration**, `20261019000000_project_manager_scope`, and it is
**additive only**: `CREATE TABLE project_manager_assignments`, three indexes and three foreign keys.
It contains no `DROP`, no `ALTER` of an existing table and no `DELETE` / `TRUNCATE` / `UPDATE`, so no
existing row is read or rewritten and there is nothing to backfill.

The one-shot `migrate` container in `infra/docker/compose.production.yml` runs
`npx prisma migrate deploy --schema apps/api/prisma/schema.prisma`. That applies the pending
migration and nothing else — it never touches a table the migration does not name.

**Commands that must never be run against production** (none of them appears in the release
sequence): `prisma migrate reset`, `prisma db push`, `npm run db:seed`, `npm run db:setup`,
`docker compose down -v`. The production stack has **no database service** — `DATABASE_URL` points at
the PostgreSQL server outside the stack — so recreating `api` and `web` cannot reach the data at all.

The production image build also requires the committed schema to declare PostgreSQL (the Dockerfile
refuses a SQLite datasource), which `apps/api/prisma/schema.prisma` now does.

Rollback: drop the single table and revert the code. No other object is touched, so there is no data
to restore.
