# HOD Approvals — Version 2 (Job Order Grouping) — Feature Documentation

## Overview
A variant of the HOD Approvals screen built around **Job Order** as the primary lens, alongside the original Supervisor/Employee views. Same navy header, fonts, and colors as the rest of the app.

File: `HOD Approvals Ver 2.dc.html`

## Top toggle — three views
Segmented control: **Group by Job Order** (default), **Group by Supervisor**, **Group by Employee**.

### Group by Job Order (inspection only)
One continuous table, grouped by Job Order, with a single shared column header row: expand-arrow | Name | Date | Proj A | Proj B | Proj C | Total Hours | Status/Action.

- **Job Order row** (bold, tinted background): code + name in the Name column; Proj A/B/C show that Job Order's unapproved hours in its one matching column (dash elsewhere); Total Hours; Status/Action column shows **Approved** hrs and **Budgeted** hrs stacked, plus a color-coded Consumption % bar (green <85%, amber 85–99%, red ≥100%).
- **Supervisor sub-rows** (indented, same columns): Supervisor name (▸ expands to individual employees and their hours), Date, Proj A/B/C (this supervisor's hours in the matching column), Total Hours, and a read-only **Pending/Approved/Rejected** status tag in Status/Action — reflecting the approval already given (or not) from "Group by Supervisor," where approval actually happens.
- A label at top reads: "Inspection view — approve from 'Group by Supervisor.'"
- All Job Orders share one table/header (no repeated per-group tables).

**Sent Back by Planning** (below the Job Order table, same nested structure): bold tinted Job Order header rows, each followed by flat supervisor+employee rows using the **original column set** — Sr. | Supervisor | Employee | Date | Project A | Project B | Project C | Total Alloc. | Overhead | Planning's Comment | Action | HOD Note. Sr. restarts per Job Order group. The reason tag ("⚠ Over Budget" amber / "✎ Data Error" gray) sits inline inside the Planning's Comment cell rather than replacing any column. Action = "Send back to Supervisor" button only; HOD Note is a separate free-text field.

### Group by Supervisor (approval happens here)
Unchanged from the original design: Select All + "Approve Selected (N)" bulk bar, then one row per supervisor — expand arrow, Supervisor name + "Pending N day(s)" tag + "⚠ Conflict" badge, Date, Project A/B/C, Total Alloc., Overhead. Approve is disabled (with tooltip) when the supervisor has a conflicted employee; conflicted rows auto-expand to reveal the flagged employee.

### Group by Employee (inspection only)
Flattened to one row per employee grouped under a supervisor sub-header, same columns as Supervisor view minus actions. Banner: "Inspection view — approve from 'Group by Supervisor.'"

## Explicit decisions / non-goals
- Approval only ever happens from "Group by Supervisor" — both "Group by Job Order" and "Group by Employee" are read-only inspection lenses on the same underlying data.
- "Group by Job Order" and its Sent Back section use CSS subgrid so header, Job Order rows, and data rows all share exact column widths — one continuous table, not separate per-group tables.
- Zero/dash project values render in muted gray; non-zero in dark text, consistent with the rest of the app.
