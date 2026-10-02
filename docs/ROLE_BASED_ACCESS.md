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
| Approval queue | — | — | Submitted, mapped Department/Section | HOD-approved, all Departments | Both stages, **read only** | — |
| Can decide (approve / reject / send back) | — | — | Submitted, own Department+Section | HOD-approved, all Departments | **No** - Admin observes only; the API refuses with 403 | — |
| Add payroll Employee | — | — | Mapped Department/Section | Any Department/Section | Any Department/Section | — |
| Organisation and supervisor administration | — | — | — | — | Yes | — (the API refuses: 403) |
| Operations dashboard (`viewPortfolioDashboard`) | — | — | — | Yes | Yes | Yes (whole organisation, read only) |

Each HOD must have an explicit `User.departmentId + User.sectionId` scope. HOD
approval and creation permissions fail closed when either mapping is absent. HOD and
PM accounts must be linked to their canonical payroll `Employee` record to use My Hours. Admin user creation accepts `employeeId` for this purpose. Linked
HOD/PM users may log in with their ecNo or administrative email.

Payroll My Hours and contract-labour timesheets use separate data structures but
appear together in Approvals and Summary. Approval decisions are immutable. This
allows reports to retain the HOD decision after a later PM decision.

Legacy HR and Finance permissions remain for their existing operational screens;
they are outside this matrix. CSV upload remains Admin/HR-only.

## The COO role (operations dashboard)

`COO` (Chief Operating Officer) is an **organisation-wide, read-only** role added for the
portfolio operations dashboard. It is deliberately the narrowest role in the system: it
oversees every Department but acts on nothing.

| Property | COO behaviour |
|---|---|
| Login identifier | **E-mail address only.** The COO holds no payroll Employee, so it is NOT an `usesEcNoLogin` role and is listed on the e-mail allow-list in `routes/auth.ts`. |
| Landing page | `/portfolio` (`landingPathFor("COO")`), the operations dashboard. |
| Read scope | **Whole organisation.** `departmentScope("COO", …)` returns `undefined`, so no Department filter is ever applied. |
| Capabilities | `viewSummary: true`, `viewPortfolioDashboard: true`. **Every** mutating capability is `false` — no approvals, no allocation, no registration, no employee management, no master data, no timesheet editing, no role assignment. |
| Router access | Present on the read-only `summary` router (`/api/summary/*`) and the portfolio router; **absent from every mutating `requireRoles(...)` list**, so the COO reaches only the reads its `viewSummary` / `viewPortfolioDashboard` capabilities advertise. |
| Role assignment | Assignable in `ASSIGNABLE_ROLES`, takes **no** Employee linkage and **no** Section scope (like ADMIN/HR/FINANCE). It is never *created* from an Employee record. |
| Self-approval / work | Holds no approval queue, captures no team and fills no timesheet. |

The new **`viewPortfolioDashboard`** capability gates the operations dashboard and its
exports. It is granted to **COO, PM and Admin** — the three roles that are already
organisation-wide — and to no Department-scoped role (an HOD or Department Head must never
see another Department's portfolio). The capability is a flag of its own rather than a
widening of `viewSummary`, which many Department-scoped roles hold.

`usesEcNoLogin` in `services/defaultLoginCredentials.ts` is the single switch that decides
whether an account signs in by EC No; because the COO is not on that list, an e-mail sign-in
reaches the e-mail branch of `POST /api/auth/login`. `roleAccess.test.ts` and
`defaultLoginCredentials.test.ts` assert this, because adding a new role to `usesEcNoLogin`
by mistake locks the account out entirely.

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
