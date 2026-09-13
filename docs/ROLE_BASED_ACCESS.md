# Role-based access matrix

All restrictions below are enforced by the API. Navigation capability flags only
control which links are shown in the browser.

| View / action | Employee | Supervisor | HOD | PM | Admin |
|---|---:|---:|---:|---:|---:|
| My Hours (own linked Employee only) | Yes | Yes | Yes | Yes | Yes |
| Own final-approved Summary | Yes | — | — | — | Yes |
| Select contract labour by Department Section | — | Own Department | — | — | Any Supervisor |
| Fill assigned-labour timesheet | — | Own daily team | — | — | Any Supervisor |
| Timesheet decision Summary | Own approved | Own HOD decisions | Own decisions and PM returns in Department | Own decisions, all Departments | All |
| Approval queue | — | — | Submitted, own Department | HOD-approved, all Departments | Both stages |
| Add payroll Employee | — | — | Own Department | Any Department | Any Department |
| Organisation and supervisor administration | — | — | — | — | Yes |

HOD and PM accounts must be linked to their canonical payroll `Employee` record
to use My Hours. Admin user creation accepts `employeeId` for this purpose. Linked
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
