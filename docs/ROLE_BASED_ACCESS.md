# Role-based access matrix

All restrictions below are enforced by the API. Navigation capability flags only
control which links are shown in the browser.

| View / action | Employee | Supervisor | HOD | PM | Admin | COO |
|---|---:|---:|---:|---:|---:|---:|
| My Hours (own linked Employee only) | Yes | Yes | Yes | Yes | Yes | — |
| Own final-approved Summary | Yes | — | — | — | Yes | — |
| Select contract labour by Department Section | — | Any Section in own Department | — | — | Any Supervisor | — |
| Fill assigned-labour timesheet | — | Own daily team | — | — | Any Supervisor | — |
| Timesheet decision Summary | Own approved | Own HOD decisions | Own decisions and PM returns for mapped Department/Section | Own decisions, all Departments | All | — |
| Approval queue | — | — | Submitted sheets **routed to his Sections** (see below) | HOD-approved, all Departments | Both stages, **read only** | — |
| Can decide (approve / reject / send back) | — | — | Submitted sheets routed to his Sections | HOD-approved, all Departments | **No** - Admin observes only; the API refuses with 403 | — |
| Add payroll Employee | — | — | Mapped Department/Section | Any Department/Section | Any Department/Section | — |
| Organisation and supervisor administration | — | — | — | — | Yes | — (the API refuses: 403) |
| Operations dashboard (`viewPortfolioDashboard`) | — | — | Own Department (whole, every Section) | Own Department (whole) | Yes | Yes (whole organisation, read only) |
| Job Order conversations (`viewConversations`) | — | — | Own Department, narrowed to his Section set | Own Department | All | All (read/write on the trail; no `DECISION`) |
| Project review — view (`viewProjectReview`) | — | — | Own Department's Job Orders **inside** a project | Own Department | All | All (read only) |
| Project review — run (`runProjectReview`): freeze a snapshot | — | — | — | Yes | Yes | Yes |
| Project-manager dashboard (`PROJECT_MANAGER`) | — | — | — | — | — | — (separate role, see below) |

Each HOD must have an explicit `User.departmentId + User.sectionId` scope. HOD
approval and creation permissions fail closed when either mapping is absent. HOD and
PM accounts must be linked to their canonical payroll `Employee` record to use My Hours. Admin user creation accepts `employeeId` for this purpose. Linked
HOD/PM users may log in with their ecNo or administrative email.

**A submitted timesheet is routed by the SECTION OF THE SUPERVISOR WHO TAGGED IT**, not by
the Section of the person whose hours are on it. A Supervisor may build his team from any
Section of his own Department, so his whole team's sheets go to **his** Section Head: a
Supervisor tagged to `Steel` who draws labour from `Hull and Outfitting` submits to the
Steel Section Head. The Supervisor's Section is his Employee mapping (the Section the app
shows him as his own, and the one the team picker defaults to). A sheet tagged by an
account with no Section of its own — an Admin editing a sheet — keeps the previous
behaviour and follows the EMPLOYEE's Section, so no sheet can fall out of every queue.
The rule has ONE implementation, `services/approvalRouting.ts`, and it is the same filter
behind the approval queue, the Planning-returned list, the approve/reject/send-back
checks, the Job Order consumption lens and the Admin panel's `pendingApprovals` blocker.
Sheets already submitted re-route on read, so nothing has to be migrated.

Payroll My Hours and contract-labour timesheets use separate data structures but
appear together in Approvals and Summary. Approval decisions are immutable. This
allows reports to retain the HOD decision after a later PM decision.

Legacy HR and Finance permissions remain for their existing operational screens;
they are outside this matrix. CSV upload remains Admin/HR-only.

## The Review menu (project review)

The review is its own menu (`/review`), not a tab under Reports. It answers a different question: Reports
measure what happened, the review freezes what happened, points at the Job Orders that need a decision, and
keeps that decision for next month.

| Property | Behaviour |
|---|---|
| View (`viewProjectReview`) | PM, ADMIN, COO: whole organisation. HOD, DEPT_HEAD: their own Department's Job Orders **inside** each project. PROJECT_MANAGER: exactly the assigned projects. SUPERVISOR, EMPLOYEE: refused at the door. |
| Run (`runProjectReview`) | PM, COO, ADMIN only — it writes a frozen snapshot, nothing else. An HOD gets 403 `REVIEW_RUN_REQUIRED`. |
| Out-of-scope project id | **404 `PROJECT_NOT_IN_SCOPE`**, not 403: an id the actor cannot see does not exist for them. |
| HOD scope inside a project | A project with none of the Department's Job Orders is not listed, and its address answers 404. The screen also states how much of the project's budget the visible Job Orders carry, so a narrow scope cannot be mistaken for a small project. |
| Frozen snapshots | Readable by anyone who can view the project; captured only by the run roles. A snapshot the actor cannot see answers 404 `SNAPSHOT_NOT_FOUND`. |
| WBS weights | Read: any authenticated reader. Written: ADMIN and PM only (`PUT /api/master-data/projects/:id/wbs-weights`), audited as `ADMIN_SET_WBS_WEIGHTS`. |
| Scope resolution | Server-side, once per request, through `reportScopeFor`. The client never receives a row it may not show. |

Full definitions, endpoints and the freeze contract: [PROJECT_REVIEW.md](PROJECT_REVIEW.md).

## The PROJECT_MANAGER role (assigned projects)

`PROJECT_MANAGER` is a **read-only, project-scoped** role. It exists so the person running one or
more Projects can see everything UNDER those projects — every WBS element, Network and Job Order,
across every Department — without being given a Department scope (a project legitimately spans
Departments) and without the organisation-wide reach of `PM`.

| Property | PROJECT_MANAGER behaviour |
|---|---|
| Login identifier | EC No once a payroll Employee is linked (`usesEcNoLogin(employeeId)`, and `EC_NO_LOGIN_ROLES` for the reset screen); an unlinked account falls back to e-mail like `PM`. |
| Landing page | `/portfolio` (`landingPathFor`). |
| Read scope | **Exactly the Projects assigned to the account**, server-side, via `reportScopeFor` → `{ kind: "PROJECTS" }`. Cross-department by construction: a Project is not a Department. |
| Unassigned | `NONE` — **zero rows**, with the sentence "No project is in this scope…" on screen. Never the organisation, never a Department fallback. |
| Assignment | Set by an Admin on **Project Managers** (`GET/POST/DELETE /api/admin/project-managers`). The role is granted separately on **Role Assignment**; an assignment on an account that does not hold the role is refused (`ROLE_NOT_PROJECT_MANAGER`), because it would read as access and grant none. |
| Scope reach | Dashboard (`/portfolio`), Reports (`/reports`) and both downloads. The request's `projectIds` is **intersected** with the assignment, never trusted; a disjoint request returns zero rows and the export states that it was narrowed. |
| Not granted | Approvals, timesheet editing, My Hours for others, master data, employee registration, role assignment, the Job Order Summary, and the **Timesheet coverage** report (its row set is the employee roster, which a project scope cannot define — its routes carry their own narrower gate). |
| My Hours (own hours) | Yes while the account is a PAYROLL employee, exactly like `PM` (`canUseMyHours` keys off employment type). |
| One role per account | Promoting an `EMPLOYEE` to `PROJECT_MANAGER` replaces their Employee landing page, as promoting to `HOD`/`PM` does. |

The register on both screens lists each project's WBS elements and Networks. **A Network has no
lifecycle status of its own** — the master stores only `active` — so every band shown against a
Network is derived from its Job Orders and labelled as derived.

## The COO role (operations dashboard)

`COO` (Chief Operating Officer) is an **organisation-wide, read-only** role added for the
portfolio operations dashboard. It is deliberately the narrowest role in the system: it
oversees every Department but acts on nothing.

| Property | COO behaviour |
|---|---|
| Login identifier | **E-mail, or its EC No when the account is linked to an Employee.** The designed COO holds no Employee and signs in by e-mail; a payroll employee promoted to COO keeps his link and therefore keeps his EC No (`usesEcNoLogin(employeeId)`, which no longer consults the role). Both doors stay open: an EC No never matches the e-mail lookup, so neither closes the other. |
| Landing page | `/portfolio` (`landingPathFor("COO")`), the operations dashboard. |
| Approval work | **None, ever.** The COO is absent from `APPROVER_ROLES` (cannot read `/approvals/*` or `/allocations/pending`: 403) and from `DECIDER_ROLES` (cannot approve, reject, send back or batch). `capabilitiesFor("COO").approveTimesheets` is false and the web gates `/approvals` on that capability, so the menu item never appears. Proven end-to-end: a COO session gets `403 FORBIDDEN` from all seven approval endpoints. |
| Approval workload blocker | A COO is never counted as owning a queue, so a role change to or from COO is never blocked by a pending-approval count. |
| Read scope | **Whole organisation.** `departmentScope("COO", …)` returns `undefined`, so no Department filter is ever applied. |
| Capabilities | `viewSummary: true`, `viewPortfolioDashboard: true`. **Every** mutating capability is `false` — no approvals, no allocation, no registration, no employee management, no master data, no timesheet editing, no role assignment. |
| Router access | Present on the read-only `summary` router (`/api/summary/*`) and the portfolio router; **absent from every mutating `requireRoles(...)` list**, so the COO reaches only the reads its `viewSummary` / `viewPortfolioDashboard` capabilities advertise. |
| Role assignment | Assignable in `ASSIGNABLE_ROLES`, takes **no** Employee linkage and **no** Section scope (like ADMIN/HR/FINANCE). It is never *created* from an Employee record. |
| Self-approval / work | Holds no approval queue, captures no team and fills no timesheet. |

**`viewConversations`** admits the six roles that may take part in a Job Order conversation and is
enforced twice: the capability hides the nav item, and every conversation route re-derives the reader's
scope from the database and intersects it with the Job Order. A `PROJECT_MANAGER` therefore reads only
the Projects assigned to it on **Project managers**; an HOD its Department narrowed to its Section set;
`PM`, `COO` and `ADMIN` everything. `DECISION` messages — the only kind that carries a change to a Job
Order — are refused to everyone except `PM` and `ADMIN`, who already hold Project Master. An account
outside those six roles gets **no screen, no nav item and no thread**. The full operator manual is
`docs/CONVERSATIONS.md`.

The new **`viewPortfolioDashboard`** capability gates the operations dashboard and its
exports. It is granted to **COO, PM and Admin** (whole organisation) and to **HOD (either
scope shape) and Department Head**, who are **scoped server-side to their own whole
Department** — every Section of it, whether their account is narrowed to one Section (a
Section Head) or not, so the two HOD shapes read identically. The Department filter a
request carries is **intersected** with the actor's own scope and never trusted, so an HOD
asking for another Department receives his own (and an unmapped head receives **zero rows**,
never the portfolio). SUPERVISOR and EMPLOYEE remain refused. The scope actually applied is
recorded in the report's provenance, so a forwarded export states its own limits. The
capability is a flag of its own rather than a widening of `viewSummary`, which many
Department-scoped roles hold; the `summary.ts` route list is deliberately unchanged.

HOD scope is therefore two different things and both are correct:

| Context | HOD visibility |
|---|---|
| Approvals and timesheet decisions | Sheets **routed to his Sections** — the Section of the Supervisor who submitted the sheet decides |
| My Hours approvals | Own Department **+ Section** (a Section Head) or the whole Department (a Department HOD) — a My Hours day is the employee's own booking, so its Section decides |
| Employee listing and the operations report | Whole **Department**, for every HOD shape |


`usesEcNoLogin` in `services/defaultLoginCredentials.ts` decides whether an account signs in by EC No, and it
asks ONE question: is an Employee linked? The role is not consulted — the identifier belongs to the person, not
to the job he holds. It used to be a list of six yard roles, and that list bricked up a real account: a payroll
employee promoted to COO kept his `employeeId`, had no usable e-mail (payroll employees carry only a
`<ecNo>@employee.local` placeholder), and was refused by BOTH doors. `roleAccess.test.ts` and
`defaultLoginCredentials.test.ts` now assert the opposite of what they used to: any linked account, whatever its
role, signs in with its EC No, and an unlinked one falls back to e-mail.

## Register an HOD

An HOD is **not** created from a blank form: it is an existing active **payroll**
Employee (white-collar) promoted to a Department/Section scope. HOD login uses the
employee's `ecNo`.

1. Register the person on **Employees → Register Payroll Employee** if they are not
   in the system yet.
2. On **Employees → HOD Registration & Department / Section Mapping**, pick the
   Department, then the Employee (the list only offers active payroll employees in
   that Department who have no account yet, plus existing HODs for re-mapping), then
   the Section, and press **Register HOD**.

`POST /api/admin/hods` (PM/Admin only) does the work atomically: it creates the
`EMPLOYEE`-linked `HOD` user, links the Employee's Section assignment when missing,
and queues a one-time credential. Re-posting the same employee updates the scope in
place and revokes the account's sessions (`tokenVersion`) so the new scope applies
immediately. `GET /api/admin/hod-candidates[?department_id=]` lists the eligible
employees.

Validation is fail-closed:

| Condition | Result |
|---|---|
| CLMS contract worker (or any non-payroll Employee) | `400 INVALID_EMPLOYEE` — CLMS logins are not ecNo-based |
| Employee already has a SUPERVISOR/EMPLOYEE/... account | `409 ROLE_CONFLICT` |
| Employee's Department ≠ selected Department | `400 WRONG_DEPARTMENT` |
| Employee's Section ≠ selected Section | `400 WRONG_SECTION` |
| Section not active / not in that Department | `400 INVALID_SCOPE` |
| Employee inactive | `409 INACTIVE_EMPLOYEE` |

Scope changes elsewhere: `PUT /api/admin/users/{id}/hod-scope` re-maps the scope of
an existing HOD (including accounts with no linked Employee), and
`PUT /api/admin/users/{id}/employee-link` links an existing HOD/PM account to its
payroll Employee for My Hours. Both are API-only today.

**Dev-box credentials.** While the application is still being built, every account
created from the web UI (Employee Registration, Supervisor Registration, HOD
registration/promotion, admin `POST /api/admin/users`, and re-activation) is
provisioned with the one bootstrap password `password@SDHI` and no forced password
change, so a new registration can log in immediately without a credential e-mail.
To give a single existing account a known password instead, use
`node apps/api/set-dev-password.cjs <ecNo>`. The bootstrap password is local-only:
`apps/api/scripts/check-no-dev-bootstrap-password.mjs` fails the production build
while it exists, and `assertDevBootstrapAllowed()` refuses to boot a PostgreSQL
instance while it is enabled. See `docs/DEV_SQLITE_TESTING.md`.

## Reset a payroll employee's password

**Path:** `/supervisors` → tab **Employees (Payroll)** (Admin and HR only —
`manageSupervisors`, the same gate as Supervisor Registration).

The tab lists every **payroll** (white-collar) Employee that already has a login,
one row per person, with the identifier they actually sign in with: the `ecNo` for
Employee/Supervisor, the e-mail for an account holding an administrative role. Search
matches ecNo, name, designation, category, department, section, role and login id; the
Department and Section dropdowns narrow the same list, and the count reads
`n of m payroll employees`.

**Reset password** applies the deployment's shared first password — the same value
`initialCredentialState()` provisions a newly registered account with
(`BOOTSTRAP_PASSWORD`; `password@SDHI` on the dev box) — sets
`mustChangePassword = true`, revokes live sessions (`tokenVersion` bump) and reuses any
pending `credential_deliveries` row instead of adding a second one. The API returns the
password it applied, so the confirmation dialogue and the on-screen notice name it and
the operator can read it back to the person; nothing else is e-mailed. Because the
change is forced, the person replaces it at the next login.

`POST /api/supervisors/payroll-employees/{employeeId}/credential-reset` is the endpoint;
the list comes from `GET /api/supervisors/payroll-employees` (both Admin/HR, both on the
Supervisor Registration router so the auth behaviour cannot drift from the Supervisor
row's own **Reset password**). It accepts no password from the caller, stores none, and
audits `PAYROLL_EMPLOYEE_CREDENTIAL_RESET`.

Rows that cannot be reset are shown, not hidden, and say why:

| Row | Response | Why |
|---|---|---|
| Employee has no login yet | `404 ACCOUNT_NOT_FOUND` | register them from Employee Registration first |
| Not a payroll employee (CLMS) | `400 NOT_PAYROLL_EMPLOYEE` | contract labour has no ecNo login |
| Employee or account inactive | `409 ACCOUNT_INACTIVE` | there is no one to hand the password to |
| Account is HOD / Dept Head / PM | `409 ROLE_NOT_RESETTABLE` | an approver login is re-provisioned by Role Assignment |

Supervisors appear on both tabs on purpose: a Supervisor **is** a payroll Employee, and
both buttons run the same reset against the same account.

## HOD approval cover (delegation)

An HOD who is away can have another HOD of the **same Section** named as approval
cover. Delegation does not change approval authorization — a second HOD of the same
Section could already approve (`hodScopeMatches` is Department+Section based). The
record makes the cover explicit, date-bounded and auditable.

| Rule | Behaviour |
|---|---|
| Who may create | ADMIN and PM for **any** Department/Section; an HOD only for its **own** (`403 WRONG_SCOPE` otherwise) |
| Who may be the delegate | An active `HOD` already mapped to that same Department/Section (`400 INVALID_DELEGATE` otherwise) |
| Delegator | The HOD caller itself, or (for ADMIN/PM) the Section's HOD; a Section with no HOD returns `400 NO_DELEGATOR` |
| Period | `fromDate`/`toDate` required and ordered (`400 INVALID_RANGE`); overlap for the same delegate+Section rejected (`409 OVERLAPPING_DELEGATION`) |
| Reason | Mandatory (`400 REASON_REQUIRED`) |
| Delegator rights | Unchanged — the HOD keeps approving its own Section |
| Revoke | Delegator, ADMIN or PM (`DELETE /api/delegations/{id}`); already revoked → `409` |

Endpoints: `GET /api/delegations` (HOD sees its Section plus its own records; ADMIN/PM
see all, optionally filtered by `department_id`/`section_id`),
`GET /api/delegations/coverage` (drives the "acting as deputy" banner),
`GET /api/delegations/candidates?departmentId&sectionId`, `POST /api/delegations`,
`DELETE /api/delegations/{id}`. Every create/revoke writes
`HOD_DELEGATION_CREATE` / `HOD_DELEGATION_REVOKE` to the audit log.

UI: **HOD Approval Cover (delegation)** panel at the bottom of the Approvals screen,
shown to HOD, PM and Admin. An HOD sees its own Department/Section locked; ADMIN/PM
choose both. A deputy sees a banner naming the Section it is covering.

Deliberately unchanged: timesheet entry, slot tagging, OT, submit, the approval state
machine and `Approval` rows — `Approval.approverId` already records whoever acted.
There is no DB unique constraint on (delegate, section, fromDate) so that a revoked
delegation can be re-created for the same start date; the overlap guard rejects real
duplicates.

## Link an existing HOD or PM account for My Hours

An Admin can link an existing role account to an active payroll Employee:

```http
PUT /api/admin/users/{userId}/employee-link
Authorization: Bearer {adminToken}
Content-Type: application/json

{"employeeId": 123}
```

The API enforces matching Departments for HOD accounts.

## Organisation transfers

PM and Admin can transfer payroll Employees, CLMS contract Employees, and linked
Supervisors from the Employees screen. The operation validates the target
Department/Section, updates the canonical Employee and Section assignment in one
transaction, updates a linked Supervisor's Department, revokes affected sessions,
and records the before/after mapping in the audit log.

A transfer is blocked while the Employee has a submitted approval workflow. Current
and future daily-team links are removed. CLMS transfers create a durable manual
organisation override so the next LabourWorks sync does not undo the PM/Admin
mapping. Supervisor authorization remains Department-wide after the transfer.
