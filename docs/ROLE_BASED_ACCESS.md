# Role-based access matrix

All restrictions below are enforced by the API. Navigation capability flags only
control which links are shown in the browser.

| View / action | Employee | Supervisor | HOD | PM | Admin |
|---|---:|---:|---:|---:|---:|
| My Hours (own linked Employee only) | Yes | Yes | Yes | Yes | Yes |
| Own final-approved Summary | Yes | — | — | — | Yes |
| Select contract labour by Department Section | — | Any Section in own Department | — | — | Any Supervisor |
| Fill assigned-labour timesheet | — | Own daily team | — | — | Any Supervisor |
| Timesheet decision Summary | Own approved | Own HOD decisions | Own decisions and PM returns for mapped Department/Section | Own decisions, all Departments | All |
| Approval queue | — | — | Submitted, mapped Department/Section | HOD-approved, all Departments | Both stages |
| Add payroll Employee | — | — | Mapped Department/Section | Any Department/Section | Any Department/Section |
| Organisation and supervisor administration | — | — | — | — | Yes |

Each HOD must have an explicit `User.departmentId + User.sectionId` scope. HOD
approval and creation permissions fail closed when either mapping is absent. HOD and
PM accounts must be linked to their canonical payroll `Employee` record to use My Hours. Admin user creation accepts `employeeId` for this purpose. Linked
HOD/PM users may log in with their ecNo or administrative email.

Payroll My Hours and contract-labour timesheets use separate data structures but
appear together in Approvals and Summary. Approval decisions are immutable. This
allows reports to retain the HOD decision after a later PM decision.

Legacy HR and Finance permissions remain for their existing operational screens;
they are outside this matrix. CSV upload remains Admin/HR-only.

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
