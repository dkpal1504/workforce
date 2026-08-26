# HOD Approvals — Feature Documentation

## Overview
Screen for a Head of Department to review and approve timesheet submissions from their supervisors, handle records Planning sent back, and review already-approved records. Two tabs: **Pending** and **Approved**. Navy header, same fonts/colors as the rest of the app.

File: `HOD Approvals.dc.html`

## Tabs

### Pending
Two stacked sections:

**1. Received from Supervisors**
A "Group by" segmented toggle with three views — **By Supervisor** (default, where approval happens), **By Employee** (inspection only), **Group by Job Order** (inspection only).

- **By Supervisor** — one row per supervisor: expand arrow (▸ reveals employee-level breakdown), Supervisor name + "Pending N day(s)" age tag + "⚠ Conflict" badge when any of their employees are flagged, Date, Project A/B/C hour columns, Total Alloc., Overhead, **Approve** button (disabled with a tooltip when the supervisor has a conflict — conflicted rows auto-expand), **Reject**, and a free-text **Comments** field. A "Select All" bulk bar + "Approve Selected (N)" button sits above the table; Select All only targets these top-level rows.
- **By Employee** — same data flattened to one row per employee, grouped under a supervisor sub-header shown once. Inspection only — no Approve/Reject controls; a banner reads "Inspection view — approve from 'By Supervisor.'"
- **Group by Job Order** — a flat table of Job Orders (code + name), each row showing its Consumption-Today value in the one matching Project column (dash in the others), Total Consumption (Unapproved), Consumption (Approved till now), Budgeted, and a color-coded Consumption % bar (green <85%, amber 85–99%, red ≥100%). A footnote reads: "Figures reflect this department's submissions only — full cross-department budget status is available on Job Order Summary" (links to that screen).

**2. Sent Back by Planning**
A flat table of records Planning rejected back to the department: Sr., Supervisor, Employee, Date, Project A/B/C, Total Alloc., Overhead, Planning's Comment (italic), a **Send back to Supervisor** button, and an **HOD Note** free-text field.

### Approved
Read-only historical view, pre-filtered to "Approved records only" (badge shown). Filters: Frequency (Daily/Weekly/Monthly) and a multi-select "Select Projects" panel (checkbox list + Select All + Apply). Below that, two more segmented toggles: Group by (Employee/Supervisor/Department/Totals) and Value Type (Hours View/Cost View). Table: Sr., Supervisor, Department, Project A/B/C, and a highlighted **Total** column, with a grand-total footer row.

## Interaction rules
- Approve is disabled per-supervisor when any of their employees carries a conflict; the row auto-expands so the conflict is visible before it can be resolved.
- "By Employee" and "Group by Job Order" are inspection-only lenses on the same underlying data as "By Supervisor" — approval only ever happens from that one view.
- Zero-value hour cells render in muted gray; non-zero in dark text, keeping dense tables scannable.
- Overhead > 0 is highlighted amber; conflict/flagged badges use the same amber treatment app-wide.

## Explicit decisions / non-goals
- No budget/consumption data in "By Supervisor" or "By Employee" — this is a legitimacy/hours check, not a budget check; budget context lives in "Group by Job Order" and on the separate Job Order Summary screen.
- No approve/reject actions anywhere except the top-level supervisor row in "By Supervisor."
