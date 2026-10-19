# Project Manager scoping for the Dashboard and Reports — Implementation Plan

> **For Hermes:** implement with the `subagent-driven-development` skill, task by task. Every task
> carries its own verification step; do not batch them.

**Goal:** give a `PROJECT_MANAGER` account a full, read-only view of the Projects it is assigned to —
every WBS element, Network and Job Order underneath, with hours burn, schedule state, quantity
progress and readiness exceptions — on the existing `/portfolio` dashboard and `/reports` screen,
and in their XLSX/PDF downloads, without widening or narrowing what any other role sees today.

**Architecture:** one new join table (`project_manager_assignments`), one new role
(`PROJECT_MANAGER`), and one new *kind* of report scope (`{ kind: "PROJECTS" }`) alongside the
existing `ORGANISATION | DEPARTMENT | NONE`. The scope is resolved server-side, once, in the report
loader; the request's `projectIds` can only narrow it. The dashboard gains a seventh section
("Project structure") that renders the Project → WBS → Network → Job Order tree already in the
database. No existing role's scope changes.

**Tech stack:** Prisma (SQLite dev / PostgreSQL prod) · Express + TypeScript · React + Vite ·
`node --test` (services only — there is no HTTP test harness in this repo).

---

## Confirmed with the user

1. **Role identity:** a **new `PROJECT_MANAGER` role** alongside the existing `PM`. `PM` keeps its
   organisation-wide dashboard, its cross-department timesheet approvals and its master-data writes.
   The new role is project-scoped. (Chosen over narrowing `PM`, because `PM` currently reads the
   whole organisation and one role per account means a real PM could not hold both.)
2. **Assignment maintenance:** a new **Project Managers panel**, Admin-only, that binds an existing
   account to one or more Projects and keeps the history of every assignment.
3. **Landing:** reuse `/portfolio` and `/reports`, scoped to the assigned Projects, **plus one new
   "Project structure" section** listing Project → WBS → Network → Job Orders with status.

## One decision left open (defaulted, flagged)

The second question ("how far should the scope reach?") was skipped. **This plan defaults to
READ-ONLY: dashboard + reports + their exports only.** Phase 2 (§10) lists exactly what changes if
you also want quantity-progress approvals, the Job Order Summary, or master-data edits scoped to the
projects — each is a separate, small, additive change, and none of them is required for the view.

---

## 1. What exists today (verified in this working tree)

| Fact | Where |
|---|---|
| `PM` is the *widest* report role: `reportScopeFor("PM", …)` returns `ORGANISATION` | `apps/api/src/services/roleAccess.ts:170` |
| Report scope is exactly three kinds: `ORGANISATION`, `DEPARTMENT`, `NONE`, and `NONE` is a real zero-row scope | `roleAccess.ts:165-185` |
| The request's `departmentIds` is **intersected** with the actor's scope, never trusted | `intersectDepartmentFilter`, `roleAccess.ts:207` |
| The dashboard, both downloads and the coverage report sit behind **one router-level gate** | `apps/api/src/routes/reports.ts:49` |
| The loader makes **exactly seven** Prisma calls regardless of scope size (a test asserts it) | `apps/api/src/services/portfolioReport.ts:731-751` |
| The Job Order query `include` carries project, WBS, UoM, department, section — **not `network`** | `portfolioReport.ts:779-789` |
| The report already returns `projectRollUps` (per project) but **no WBS/Network register** | `portfolioReport.ts:245` |
| A report filter for `projectIds` and `wbsIds` already exists and is parsed | `apps/api/src/services/portfolioFilters.ts:38-50` |
| `Project` / `ProjectWbs` / `Network` / `JobOrder` / `JobOrderProgress` / `JobOrderBudgetRevision` all exist | `apps/api/prisma/schema.prisma:371-482`, `724-746`, `752-824` |
| **There is no project manager anywhere**: no `Project.managerId`, no assignment table, no code that writes one | `grep -rn "managerId\|projectManager" apps` → 0 hits |
| `Network` has **no lifecycle status** — only `active` plus its Job Orders | `schema.prisma:724-746` |
| Job Orders have only two states: `active`, `inactive` (`closed`/`on_hold` are gone) | `masterData.ts:691` |
| Role Assignment: one active role per account; `EMPLOYEE_LINKED_ROLES` gates employee linkage | `apps/api/src/services/roleAssignment.ts:14,22` |
| ecNo sign-in is a fixed role list that **must** be kept in step with the password-reset list | `defaultLoginCredentials.ts:128`, `payrollPasswordReset.ts:13` |
| The coverage report also consumes `reportScopeFor` — adding a scope kind breaks its `scopeLabel` at compile time | `timesheetCoverageReport.ts:176,382` |
| Nav is capability-driven, so a new role needs capabilities, not menu edits | `AppLayout.tsx:109-110`, `App.tsx:124` |
| Dev fixtures: 4 projects (2 commercial, 2 non-project), 63 Job Orders, 25 WBS, 26 Networks, 1 `PM` user, **0 assignments** | `dev.db` (read-only query) |

## 2. Target model

### 2.1 One new scope kind

```ts
export type ReportScope =
  | { kind: "ORGANISATION" }
  | { kind: "DEPARTMENT"; departmentId: number }
  | { kind: "PROJECTS"; projectIds: readonly number[] }   // NEW — never empty
  | { kind: "NONE" };
```

`PROJECTS` is produced **only** for `PROJECT_MANAGER`, and only from rows read out of the database —
never from the request. `projectIds` is non-empty by construction: "assigned to nothing" is `NONE`,
not `PROJECTS: []`, so an empty array can never be confused with "all".

### 2.2 Role capability matrix (the whole point of the role)

| Capability | PROJECT_MANAGER | why |
|---|---:|---|
| `viewPortfolioDashboard` | **true** | the role exists for this screen |
| `allocateHours` | via `canUseMyHours` (PAYROLL only) | a project manager is a payroll employee who books his own hours, exactly like `PM`. Add `PROJECT_MANAGER` to `ALLOCATION_ROLES`. |
| `viewSummary` | false (Phase 2) | the Summary router does not admit the role; leaving it true would render a nav link to a 403 |
| `approveTimesheets`, `selectTeam`, `editTimesheet`, `manageSupervisors`, `manageMasterData`, `manageEmployees`, `uploadEmployees`, `transferEmployees`, `assignRoles`, `viewDepartmentSummary`, `manageJobOrderMaster`, `manageJobOrderProgress`, `manageAttendanceHours`, `viewEmployees` | **false** | read-only |
| new `manageProjectManagers` | false (ADMIN only) | assignments are an admin act |
| new `viewTimesheetCoverage` | false | see §3.4 — a project scope cannot define an employee roster |
| `landingPathFor("PROJECT_MANAGER")` | `/portfolio` | his own projects |

### 2.3 Surfaces touched in Phase 1

| Surface | Phase 1 behaviour for `PROJECT_MANAGER` |
|---|---|
| `GET /api/reports/portfolio` (+ `.xlsx`, `.pdf`) | admitted, rows = his assigned projects only |
| `/portfolio`, `/reports` (web) | same screens, scoped; Project picker lists only his projects |
| new "Project structure" section | Project → WBS → Network → Job Orders, with derived status |
| `GET /api/reports/timesheet-coverage` (+ `.xlsx`) | **refused (403)** and its tab hidden |
| everything else | unchanged, and refused by the existing gates |

## 3. Rules the implementation must not break

1. **Fail closed.** `PROJECT_MANAGER` with zero active assignments resolves to `NONE` → zero rows,
   with an explicit sentence on screen ("No projects are assigned to you yet — ask an Admin").
   Never fall back to the organisation, and never fall back to the actor's Department.
2. **The request narrows, never widens.** `?projectIds=9` from a manager assigned `[1]` yields the
   **empty intersection** → zero rows and a provenance note. It must not be replaced by `[1]` — a
   report that silently ignores the filter it was handed is worse than an empty one.
3. **One scoping path.** The scope is computed once in `buildPortfolioReport`; every section and both
   exports derive from the same scoped fetch. No second filter, no post-filtering in JS (the report
   pages in SQL; a JS filter would change what a page means).
4. **Do not leak the picker.** The Project/WBS dropdowns are fed by `GET /projects` and
   `GET /project-wbs`; for a `PROJECT_MANAGER` those endpoints must return only his projects. A
   clamped report behind a dropdown listing every project still discloses the portfolio's structure.
5. **The coverage report stays out.** It is an employee × date roster of contract labour; a project
   scope cannot define "who is in the population". Its two routes get their **own** role gate so the
   broader portfolio gate cannot admit the new role (§5, Task 12).
6. **Revoked assignments are kept.** `status = "revoked"` + `revokedAt`, never a hard delete:
   "who managed this project last quarter" has to stay answerable. Re-assignment **reuses** the row
   (status back to `active`, `revokedAt` cleared) so the unique pair holds one history line, not two.
7. **No `tokenVersion` bump on assignment.** The scope is read per request from the database; bumping
   would log a manager out every time an Admin edits the panel. (Role *changes* still bump, as today.)
8. **One role per account — state the consequence.** Promoting a payroll `EMPLOYEE` to
   `PROJECT_MANAGER` gives him the dashboard and removes his `EMPLOYEE` landing page, exactly as
   promoting to `HOD`/`PM` does today. The Role Assignment panel already shows this; the docs must
   say it too.
9. **No N+1.** Two new queries (§5 Task 9) are added to the loader; the count becomes **nine**,
   still invariant to scope size, and the existing test is updated deliberately, not loosened.
10. **Networks have no status of their own.** The "status" column is *derived* from the node's Job
    Orders and the section says so, in the UI and in the definitions block. Presenting a derived
    figure as a stored SAP status would be the exact kind of confident-looking lie this report's
    provenance block exists to prevent.

## 4. Data model

Add to `apps/api/prisma/schema.prisma` (after `Network`, before `JobOrderBudgetRevision`):

```prisma
/// A Project Manager's assignment to a Project.
///
/// A JOIN TABLE, not `Project.managerId`: one manager holds several projects and one
/// project may hold several managers (cover, handover), and a scalar would make the
/// second manager a migration. Projects and managers are both sides of the same fact.
///
/// ROWS ARE NEVER DELETED. Ending an assignment sets `status = "revoked"` and stamps
/// `revokedAt`, so "who managed this project last quarter" stays answerable; a
/// re-assignment REUSES the row (`@@unique([projectId, userId])`) rather than adding a
/// second history line for the same pair.
model ProjectManagerAssignment {
  id           Int       @id @default(autoincrement())
  projectId    Int       @map("project_id")
  project      Project   @relation(fields: [projectId], references: [id], onDelete: Cascade)
  userId       Int       @map("user_id")
  user         User      @relation("ProjectManagerAssignments", fields: [userId], references: [id], onDelete: Cascade)
  /// active | revoked
  status       String    @default("active")
  assignedById Int?      @map("assigned_by")
  assignedBy   User?     @relation("ProjectManagerAssignmentCreator", fields: [assignedById], references: [id])
  assignedAt   DateTime  @default(now()) @map("assigned_at")
  revokedAt    DateTime? @map("revoked_at")
  note         String?

  @@unique([projectId, userId])
  @@index([userId, status])
  @@index([projectId, status])
  @@map("project_manager_assignments")
}
```

Back-relations Prisma requires (both models currently declare none for this):

```prisma
// model Project
  managerAssignments ProjectManagerAssignment[]

// model User — TWO named relations, because User is both the manager and the assigner
  projectManagerAssignments        ProjectManagerAssignment[] @relation("ProjectManagerAssignments")
  projectManagerAssignmentsCreated ProjectManagerAssignment[] @relation("ProjectManagerAssignmentCreator")
```

(The two names must match the `@relation(...)` names on the model above exactly, or
`prisma generate` refuses the schema with "missing an opposite relation field".)

Migration: `20261019000000_project_manager_scope` (additive only — one table + two indexes; no column
changed, no data rewritten). Dev: `npm run db:migrate:dev -w @workforce/api -- --name
project_manager_scope`. Prod: `npx prisma migrate deploy` (already the `migrate` service's command).

## 5. Tasks

### Phase A — the pure scope vocabulary (no database)

#### Task 1: `ReportScope` gains `PROJECTS`

**Files:** `apps/api/src/services/roleAccess.ts`, `apps/api/src/services/roleAccess.test.ts`

**Step 1 — write the failing tests** in `roleAccess.test.ts`:

```ts
test("a PROJECT_MANAGER reads exactly its assigned projects, and nothing when unassigned", () => {
  assert.deepEqual(reportScopeFor("PROJECT_MANAGER", 4, [7, 3]), { kind: "PROJECTS", projectIds: [3, 7] });
  assert.deepEqual(reportScopeFor("PROJECT_MANAGER", 4, []), { kind: "NONE" }, "no assignment -> nothing");
  assert.deepEqual(reportScopeFor("PROJECT_MANAGER", 4, null), { kind: "NONE" });
  assert.deepEqual(reportScopeFor("PROJECT_MANAGER", null, [7]), { kind: "PROJECTS", projectIds: [7] },
    "a project scope needs no Department");
});

test("project ids are intersected with the assigned set, never widened by the request", () => {
  const scoped = { kind: "PROJECTS", projectIds: [3, 7] } as const;
  assert.deepEqual(intersectProjectFilter(scoped, null), [3, 7], "no request -> the assignment");
  assert.deepEqual(intersectProjectFilter(scoped, [7]), [7], "a request narrows");
  assert.deepEqual(intersectProjectFilter(scoped, [9]), [], "a foreign request -> the EMPTY set, zero rows");
  assert.deepEqual(intersectProjectFilter({ kind: "ORGANISATION" }, [9]), [9]);
  assert.deepEqual(intersectProjectFilter({ kind: "DEPARTMENT", departmentId: 4 }, null), null,
    "a Department scope says nothing about projects");
  assert.deepEqual(intersectProjectFilter({ kind: "NONE" }, null), []);
});
```

**Step 2 — run:** `npm test -w @workforce/api` → FAIL (type error / undefined function).

**Step 3 — implement** in `roleAccess.ts`:

```ts
export type ReportScope =
  | { kind: "ORGANISATION" }
  | { kind: "DEPARTMENT"; departmentId: number }
  | { kind: "PROJECTS"; projectIds: readonly number[] }
  | { kind: "NONE" };

export function reportScopeFor(
  role: string,
  departmentId: number | null,
  /**
   * The projects the actor MANAGES, read from `project_manager_assignments` by the caller.
   * Consulted ONLY for PROJECT_MANAGER: an assignment row accidentally attached to another
   * role must never narrow — or widen — that role's report.
   *
   * `null`/`[]` = no assignment = `NONE` (fail closed). It is NEVER the whole organisation
   * and never a Department fallback.
   */
  assignedProjectIds?: readonly number[] | null
): ReportScope {
  if (role === "PM" || role === "ADMIN" || role === "COO") return { kind: "ORGANISATION" };
  if (role === "PROJECT_MANAGER") {
    const ids = [...new Set(assignedProjectIds ?? [])].filter((id) => Number.isInteger(id) && id > 0).sort((a, b) => a - b);
    return ids.length ? { kind: "PROJECTS", projectIds: ids } : { kind: "NONE" };
  }
  if (isDepartmentViewRole(role)) {
    return departmentId == null ? { kind: "NONE" } : { kind: "DEPARTMENT", departmentId };
  }
  return { kind: "NONE" };
}

/**
 * The Project filter to apply, given the actor's scope and the ids the REQUEST asked for.
 *
 *   null -> no Project predicate        [] -> match nothing (an honest empty answer)
 *
 * Same contract as `intersectDepartmentFilter`, for the same reason: a request may narrow the
 * actor's scope but can never add to it, and a disjoint request returns the EMPTY set rather
 * than silently substituting the assignment.
 */
export function intersectProjectFilter(
  scope: ReportScope,
  requested: number[] | null
): number[] | null {
  if (scope.kind === "NONE") return [];
  if (scope.kind === "PROJECTS") {
    if (requested == null) return [...scope.projectIds];
    return requested.filter((id) => scope.projectIds.includes(id));
  }
  // ORGANISATION and DEPARTMENT: the project request is a plain filter; the Department
  // predicate is what enforces a Department actor's own bound.
  return requested;
}
```

**Step 4 — run** `npm test -w @workforce/api` → PASS.

**Step 5 — commit** `feat(reports): add a PROJECTS report scope narrowed by assignment`.

#### Task 2: capabilities and landing path

**Files:** `roleAccess.ts`, `roleAccess.test.ts`

- `viewPortfolioDashboard: … || role === "PROJECT_MANAGER"`.
- `viewSummary`: leave the array untouched (role absent → false).
- `landingPathFor`: `if (role === "PROJECT_MANAGER") return "/portfolio";` **before** the
  `["HOD","PM","ADMIN"]` branch.
- `departmentScope`: leave the role OUT (project scope is not a Department scalar; `undefined` means
  "no Department filter", which is what its other callers want).
- `ALLOCATION_ROLES`: add `"PROJECT_MANAGER"` so a payroll manager keeps My Hours, matching `PM`.
- New capability flags: `manageProjectManagers` (admin only) and `viewTimesheetCoverage`
  (`PM, ADMIN, COO, HOD, DEPT_HEAD`).

**Test:** extend the exact-shape assertions — the mutating-capability loop that already exists
(`roleAccess.test.ts:41`) must include `PROJECT_MANAGER`, every mutating flag false, and
`assert.equal(landingPathFor("PROJECT_MANAGER"), "/portfolio")`.

**Verify:** `npm test -w @workforce/api`.

#### Task 3: role wiring audit (do not skip a line — a missed list locks the account out)

| File | Change |
|---|---|
| `apps/api/src/services/defaultLoginCredentials.ts:128` | add `"PROJECT_MANAGER"` to `usesEcNoLogin` (he is an employee-linked role) |
| `apps/api/src/services/payrollPasswordReset.ts:13` | add to `EC_NO_LOGIN_ROLES` — the two lists must agree |
| `apps/api/src/routes/auth.ts:127` | add to the **email** fallback allow-list, exactly as `PM` is (an unlinked account signs in by e-mail) |
| `apps/api/src/services/roleAssignment.ts:14` | `ASSIGNABLE_ROLES` += `PROJECT_MANAGER` |
| same, `:22` | `EMPLOYEE_LINKED_ROLES` += `PROJECT_MANAGER` (needs an active linked Employee) |
| same, `:132` | `creatableRolesFor` → PAYROLL branch gains `PROJECT_MANAGER` (it is an Employee role, unlike `PM`) |
| same, `:309` | add `PROJECT_MANAGER` to the branch that forces `sectionId = null`; it must **not** inherit the Employee's Section |
| same, `:307` | do **not** add it to `ORGANISATION_WIDE_ROLES` — that list also decides Department inheritance |
| same, `:163` refusal text | mention `PROJECT_MANAGER` in the payroll-only sentence if it is added to the `HO`-style refusal branch |
| `apps/web/src/pages/RoleAssignmentPage.tsx:23,56,89` | `Role` union, `ROLE_LABELS`, `SELECTABLE_ROLES` |
| `apps/web/src/api/client.ts` (`AuthCapabilities`) | the two new capability flags |
| `docs/ROLE_BASED_ACCESS.md` | new column + a `PROJECT_MANAGER` section |

**Verify:** `npm test -w @workforce/api && npm run build` → both clean. The capability test is
exact-shape, so a missed flag is a compile/test failure rather than a silent `undefined`.

### Phase B — assignment data and its panel

#### Task 4: schema + migration

Per §4. Steps: edit `schema.prisma` → `npm run db:generate -w @workforce/api` →
`npm run db:migrate:dev -w @workforce/api -- --name project_manager_scope` → confirm the migration
contains **only** `CREATE TABLE` + two `CREATE INDEX` statements (no `DROP`, no `ALTER` of an
existing table). **Verify:** `git status` shows exactly one new migration dir.

#### Task 5: the pure decision rules

**Files:** `apps/api/src/services/projectManagerAssignment.ts` (new),
`apps/api/src/services/projectManagerAssignment.test.ts` (new)

The repo's house rule: route logic is untestable, so the decision lives in `services/` as a pure
function.

```ts
export type AssignmentTarget = { id: number; active: boolean };
export type ExistingAssignment = { id: number; projectId: number; userId: number; status: string } | null;

export type AssignmentPlan =
  | { ok: true; action: "create" | "reactivate"; projectId: number; userId: number }
  | { ok: false; code: string; error: string };

export function planAssignment(input: {
  project: AssignmentTarget | null;
  user: { id: number; role: string; active: boolean } | null;
  existing: ExistingAssignment;
}): AssignmentPlan
```

Rules, each with its own test:
- project missing → `PROJECT_NOT_FOUND`; `!project.active` → `PROJECT_INACTIVE` ("an assignment to an
  inactive project would be a scope nobody can see").
- user missing → `USER_NOT_FOUND`; `!user.active` → `ACCOUNT_INACTIVE`.
- `user.role !== "PROJECT_MANAGER"` → `ROLE_NOT_PROJECT_MANAGER`, message naming the next step:
  "Give the account the Project Manager role on Role Assignment first."
- `existing?.status === "active"` → `ALREADY_ASSIGNED` (409, names the project).
- `existing?.status === "revoked"` → `{ action: "reactivate" }` (reuse the row).
- otherwise `{ action: "create" }`.
- `planRevocation(status)` → `ALREADY_REVOKED` / revoke.

#### Task 6: the admin API

**Files:** `apps/api/src/routes/admin.ts` (or a new `apps/api/src/routes/projectManagers.ts` mounted at
`/api/admin/project-managers` — prefer the new file, `admin.ts` is already large)

```
GET    /api/admin/project-managers
POST   /api/admin/project-managers        { projectId, userId, note? }
DELETE /api/admin/project-managers/:id
```

- Gate: `requireAuth, requireRoles("ADMIN")`.
- `GET` returns, in one payload: `projects[]` (id, code, name, active, **managers[] with status**),
  `assignments[]` (project, manager name/ecNo, assignedBy, assignedAt, revokedAt, status), and
  `eligibleUsers[]` — active `PROJECT_MANAGER` accounts **plus** a count of employees with no
  account, with `eligibleTruncated`. Never hide a row: a project with no manager must appear with
  an explicit "No manager assigned" state, not be absent.
- `POST` runs `planAssignment`, then `create` or `update` (reactivate), writes
  `PROJECT_MANAGER_ASSIGN` to the audit log with `{ projectId, userId, reassignedFrom? }`, and
  returns the assignment.
- `DELETE` runs `planRevocation`, sets `status: "revoked"`, `revokedAt: now`, audits
  `PROJECT_MANAGER_REVOKE`. **No `tokenVersion` bump** (rule 7).
- Status codes: 409 for `ALREADY_ASSIGNED`/`ALREADY_REVOKED`, 400 for the rest — a state conflict
  is 409, a rejected request is not (the house rule from the role-assignment work).

**Verify:** live probe with an Admin JWT (§6); assert the audit row exists.

#### Task 7: the panel

**Files:** `apps/web/src/pages/ProjectManagersPage.tsx` (new),
`apps/web/src/pages/ProjectManagersPage.css` (new, optional — reuse `supervisors.css` patterns),
`apps/web/src/App.tsx`, `apps/web/src/components/AppLayout.tsx`

- Route gated on `capability="manageProjectManagers"`.
- Layout: project list (left or top) with its managers and an "Assign manager" picker; a second
  block for history (revoked rows, greyed, with revoke date and who revoked).
- Empty states are explicit and name the next step: no `PROJECT_MANAGER` accounts → "No account
  holds the Project Manager role yet — assign it on Role Assignment." A failed fetch must say it
  failed, never render as "none exist".
- Nav entry appears only for Admins (capability-driven, so `AppLayout.tsx` needs one line).

### Phase C — the report

#### Task 8: resolve the actor's projects, server-side

**Files:** `apps/api/src/services/projectScope.ts` (new),
`apps/api/src/services/projectScope.test.ts` (new)

```ts
/** The projects this account MANAGES. `null` for every role that is not PROJECT_MANAGER. */
export async function assignedProjectIdsFor(actor: { id: number; role: string }): Promise<number[] | null>;

/** The Prisma predicate that narrows a Project/WBS/Network picker to the actor's scope. */
export function projectPickerWhere(projectIds: number[] | null): { id?: { in: number[] } };
```

- Exactly **one** query, and **only** when `actor.role === "PROJECT_MANAGER"`: every other role gets
  `null` with no query at all (an assignment row attached to another role must be inert — test it).
- `where: { userId, status: "active" }`, `select: { projectId: true }`.
- Pure half (`projectPickerWhere`) tested: `null` → `{}` (no narrowing); `[]` → `{ id: { in: [] } }`
  (matches nothing — Prisma treats an empty `in` as no match, which is the fail-closed shape).

#### Task 9: the loader applies one Project predicate

**Files:** `apps/api/src/services/portfolioReport.ts`, `portfolioReport.test.ts`

1. In `buildPortfolioReport`:
   ```ts
   const assignedProjectIds = await assignedProjectIdsFor(actor);
   const scope = reportScopeFor(actor.role, actor.departmentId ?? null, assignedProjectIds);
   const effectiveDepartmentIds = intersectDepartmentFilter(scope, filters.departmentIds);
   const effectiveProjectIds = intersectProjectFilter(scope, filters.projectIds);
   ```
2. `jobOrderWhere(filters, departmentFilter, projectFilter)` — the third parameter replaces the
   current `filters.projectIds` line at `:718` with `if (projectFilter !== null) where.projectId =
   { in: projectFilter }`. Keep the null/empty distinction; do **not** collapse them.
3. Add `network: { select: { id: true, code: true, name: true, active: true } }` to the Job Order
   `include` (`:781`) — the register needs it and it costs no extra round-trip.
4. Extend `ReportActor` with nothing: the projects are read from the database **inside** the loader,
   so a route cannot pass a forged list.

**Tests to update/extend:**
- the call-count assertion becomes **nine** and still doubles the scope without changing;
- a `PROJECT_MANAGER` actor with assignments `[1]` receives only project 1's Job Orders;
- `filters.projectIds = [9]` (foreign) → **zero** rows, and the provenance says why;
- an unassigned `PROJECT_MANAGER` → zero rows, `scope.kind === "NONE"`;
- `PM`/`ADMIN`/`COO`/`HOD`/`DEPT_HEAD` results are byte-identical to before (golden fixtures).

#### Task 10: provenance and scope sentences

**Files:** `portfolioReport.ts` (`describeScope`, `scope` block), `portfolioReport.test.ts`

```ts
if (scope.kind === "PROJECTS") return `Assigned projects (${scope.projectIds.length})`;
```

Add to the scope block `projectIds: number[] | null` (null for every other kind) so a forwarded file
states the exact ids, and extend the "request was clamped" note to cover a project request that the
scope intersected away. **Test:** the note appears when `requested ∩ assigned` ≠ `requested`, and
never otherwise.

#### Task 11: the "Project structure" dataset (pure)

**Files:** `apps/api/src/services/projectStructure.ts` (new),
`apps/api/src/services/projectStructure.test.ts` (new)

```ts
export type StructureNode = {
  id: number; code: string; name: string | null; active: boolean;
  jobOrders: number; budgetHours: number; actualHours: number;
  burnPct: number | null;
  hoursBand: Band;                       // worst of its children
  scheduleBand: ScheduleBand | "not_scheduled";
  noActivity: number;
  unapprovedHours: number;
  jobOrderIds: number[];
};

export type ProjectStructureRow = {
  project: { id: number; code: string; name: string };
  totals: StructureNode;                 // the project itself, same shape
  wbs: Array<StructureNode & { networks: StructureNode[] }>;
};

export function buildProjectStructure(input: {
  facts: readonly JobOrderFacts[];                 // already scoped
  wbsRows: Array<{ id: number; projectId: number; wbsCode: string; name: string | null; active: boolean }>;
  networkRows: Array<{ id: number; projectId: number; wbsId: number; code: string; name: string | null; active: boolean }>;
}): ProjectStructureRow[];
```

Rules, each tested:
- **Which nodes appear:** a WBS/Network appears if it has ≥1 Job Order **in scope**, or if it has
  **zero** Job Orders at all (an empty WBS is a real gap). A node whose Job Orders are all outside
  the scope is omitted — otherwise a Department Head would see nodes he cannot attribute.
- **Worst-child rollup:** `hoursBand` = RED if any child is RED, else AMBER if any, else GREEN if any,
  else NOT_MEASURABLE. Same for `scheduleBand`, with the precedence
  `delayed > at_risk > due_soon > on_plan > not_scheduled`. Write the precedence as a named constant
  and test the exact order — it is the one judgement in the module.
- **`not_scheduled` is a real answer, not a gap to be filled:** a project whose JOs carry no planned
  window must never render as "on plan".
- **No Network status invention.** The node's `active` flag is the stored fact; the bands are labelled
  derived.

#### Task 12: give the coverage report its own gate

**Files:** `apps/api/src/routes/reports.ts`, `timesheetCoverageReport.ts`

Today a single `reportsRouter.use(requireAuth, requireRoles(…))` (`:49`) covers **every** route, so
admitting `PROJECT_MANAGER` there would also admit the coverage report, whose scope has no meaning
for a project manager.

- Move the coverage pair (`/timesheet-coverage`, `/timesheet-coverage.xlsx`) onto
  `requireRoles("PM", "ADMIN", "COO", "HOD", "DEPT_HEAD")` — the exact list it has today, applied per
  route instead of inherited.
- The portfolio routes keep their own gate, which gains `"PROJECT_MANAGER"`.
- `scopeLabel` (`timesheetCoverageReport.ts:382`) must become total: add a `PROJECTS` branch returning
  an honest sentence rather than falling through to `scope.departmentId` (a TypeScript error today —
  fix it, do not cast it away).
- Web: hide the coverage tab when `capabilities.viewTimesheetCoverage` is false.

**Verify:** a `PROJECT_MANAGER` JWT gets `200` on `/api/reports/portfolio` and `403` on
`/api/reports/timesheet-coverage`; an HOD gets `200` on both.

#### Task 13: the section on both screens

**Files:** `apps/web/src/pages/portfolioTabs.ts` (+ test), `PortfolioDashboardPage.tsx`,
`ReportsPage.tsx`, `apps/web/src/styles/portfolio.css`

- Add `{ id: "project-structure", label: "Project structure", tone: "primary" }` to `PORTFOLIO_TABS`
  after `job-work`; `REPORTS_TABS` inherits it. Update the tab-order/ids test.
- Add `defaultTabFor(role)`: `/portfolio` opens on `project-structure` for `PROJECT_MANAGER`,
  `needs-push` for everyone else. Pure + tested, so the two screens cannot disagree.
- Render: one block per project — a header with the project's totals (Job Orders, budget, actual,
  burn %, bands), then a WBS table, and inside each WBS its Networks with the same columns, then the
  Job Orders of that node. Reuse `BandBadge`, `ScheduleBadge`, `PctQtyCell`, `fmtHours`, `fmtPct`.
  Every derived column is labelled "derived from its Job Orders".
- The empty state for an unassigned manager names the remedy, not just "no data".

#### Task 14: narrow the pickers

**Files:** `apps/api/src/routes/masters.ts` (`/projects` `:82`, `/projects-wbs` `:54`,
`/project-wbs` `:197`), `apps/api/src/routes/masterData.ts` (`/projects` `:106`, `/job-orders` `:631`)

Apply `projectPickerWhere(await assignedProjectIdsFor(req.user!))` to each. For every other role this
is `{}` — no behaviour change, and a test can assert the helper returns `{}` for `PM`/`HOD`/`ADMIN`
so the two paths cannot drift. The report still clamps independently; the picker narrowing is about
not *disclosing*, not about authorising.

### Phase D — documents, verification, release

#### Task 15: documents

- `docs/ROLE_BASED_ACCESS.md`: add a `PROJECT_MANAGER` column/row set — read scope "assigned projects
  only (all Departments)", no approvals, no master data, signs in by EC No, lands on `/portfolio`,
  coverage report refused, one-role-per-account consequence.
- `docs/PROJECT_MANAGER_SCOPE.md` (new): the assignment model, the fail-closed rules, how to assign
  someone (Role Assignment → Project Managers), and what a manager's export states about its scope.
- `docs/plans/…` (this file) is the implementation record; keep the "Decisions" section current.

#### Task 16: `npm run build` and the whole suite

`npm run build && npm test -w @workforce/api`. Expected: `tsc` clean in api and web, all
`src/services/*.test.ts` green. The build gate
(`check-no-dev-bootstrap-password.mjs`) must still pass.

## 6. Verification (real execution, not inspection)

**Snapshot first — anything that writes dev state needs this** (house rule):

```bash
cp apps/api/prisma/dev.db apps/api/prisma/dev.db.bak-$(date +%Y%m%d%H%M)
```

Then, with both servers up (`npm run dev:all`):

1. **Mint two JWTs with the app's own secret** (read `apps/api/.env` by hand; dotenv is hoisted to the
   workspace root): one Admin, one `PROJECT_MANAGER` linked to a payroll Employee.
2. **Assign** the manager to project 1 via `POST /api/admin/project-managers`; assert the audit row and
   that a second identical POST answers `409 ALREADY_ASSIGNED`.
3. **`GET /api/reports/portfolio` as the manager** → every `jobWork[]` row has `projectId === 1`;
   `provenance.scope.kind === "PROJECTS"`; `provenance.scope.projectIds === [1]`.
4. **`?projectIds=2`** → zero rows, and the provenance note says the request was intersected away.
   **`?projectIds=1`** → the same rows as (3).
5. **Unassigned manager** (revoke, re-probe) → zero rows, `scope.kind === "NONE"`, and the screen
   shows the "no projects assigned" sentence — not an error banner and not a blank panel.
6. **Regression:** as `HOD`, `PM`, `ADMIN`, `COO` — `jobWork.length`, `pulse`, the bands and the
   provenance are identical to a probe taken **before** the change (capture it first, diff it).
7. **Coverage:** manager `403`, HOD `200`.
8. **Downloads:** `curl` both `.xlsx` and `.pdf` as the manager; unzip the xlsx and assert the
   "Project structure" sheet's row count equals `projectStructure` totals, and that the Filters sheet
   carries the projects scope sentence.
9. **Browser:** log in as the manager, confirm the nav, the tab strip, the structure tree, and that the
   Project dropdown lists only his projects. Kill the `:5173` pid before trusting any UI change on
   this `/mnt/c` mount (`ss -ltnp | grep :5173`) — and grep the served module for a NEW string.
10. **Restore** `dev.db` from the snapshot when done, and re-check the row counts.

## 7. Release

Additive migration only. Deploy = the existing runbook (`references/production-deploy-runbook.md` in
the `workforce-timesheet-app` skill): `$env:IMAGE_TAG = <HEAD sha>` → `dc build --pull` →
`dc up -d --force-recreate api web`, and the `migrate` one-shot runs `prisma migrate deploy`. Prove
first with `git show --name-only <sha> | grep -c 'prisma/migrations'` → this release carries **1**
migration (not 0), so the runbook must state that step 6 has real work and that it is additive.

Rollback: a second migration that drops `project_manager_assignments` (and a revert of the code);
no existing table or column is touched, so the data path is safe either way. Deleting the role's
assignments is not a rollback — the code refuses the role's dashboard on its own once reverted.

## 8. Out of scope (Phase 1)

- Cost/money anywhere on the manager's view (the report is hours and quantities).
- SAP-sourced Network lifecycle status.
- Per-project notifications, digests or e-mail.
- Any write by a `PROJECT_MANAGER` (including budget revisions and schedule edits).
- Changing what `PM`, `HOD`, `DEPT_HEAD`, `ADMIN` or `COO` see.

## 9. Risks

| Risk | Mitigation |
|---|---|
| An Admin forgets to assign anyone → the new role sees an empty screen and reads it as a bug | explicit empty state naming the remedy; the assignment panel lists unmanaged projects |
| Someone "fixes" the fail-closed rule to fall back to the organisation | the provenance block and two tests assert `NONE`; the docs state why |
| A second scoping path creeps in (JS post-filter, or a route passing `projectIds`) | scope is computed once in the loader; `ReportActor` carries no project list |
| The picker leaks the portfolio even though the report is clamped | Task 14 narrows the pickers, with a test that other roles get `{}` |
| The 7→9 query count is "fixed" by loosening the test | update the number and keep the invariance assertion |
| Role wiring misses a list and the account cannot sign in | Task 3's table + the exact-shape capability test + the ecNo/payroll-list pair |

## 10. Phase 2 (only if you want it) — each is additive

1. **Quantity-progress approvals for his projects:** add `PROJECT_MANAGER` to the
   `/job-order-progress/pending` and `/:id/decision` gates, then narrow both by
   `intersectProjectFilter` on the JO's project. Touches `routes/jobOrderProgress.ts:401,784` and the
   `mine`/`remarks` reads.
2. **Job Order Summary:** add the role to `summary.ts:37` and give `/summary/job-order` the same
   project clamp (its own department-scoped shape must learn the `PROJECTS` kind).
3. **Master-data edits limited to his projects:** `masterData.ts`'s `writeOnly` becomes a per-row
   check (`planAssignment`-style refusal `PROJECT_OUT_OF_SCOPE`) rather than a role list. This is the
   riskiest of the three — it turns a gate into a per-resource decision — and should be its own plan.
