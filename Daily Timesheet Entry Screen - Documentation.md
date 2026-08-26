# Daily Timesheet Entry Screen — Feature Documentation

## Overview
Daily timesheet entry screen for supervisors to allocate employees' working hours (1st Half / 2nd Half shift slots) to Job Orders under Projects, with bulk and per-row assignment workflows.

## Layout
1. **Header** — screen title.
2. **Filter row** — Date, Department, Supervisor selectors; "Filled: N / Total" indicator on the right.
3. **Bulk Assignment block** — primary action area, directly below filters.
4. **Select from Previous Day** button — fallback to copy prior working day's allocations.
5. **Per-employee grid** — "Review & Fine-tune" section, fully editable, secondary to bulk actions.
6. **Legend** — project color key + usage hint.
7. **Footer** — Save Draft / Submit.

## Slot model
- Each employee has 4 shift slots: 1st Half (9a–11a, 11a–1p), 2nd Half (2p–4p, 4p–6p).
- A slot is **empty** (unselected), **amber/selected** (marked but not yet assigned), or **colored by project letter** (assigned to a Project's Job Order).
- **Full Shift** checkbox per row: selects/deselects all 4 slots at once. Disabled (greyed out, frozen) once the row is fully assigned (`assign === 'done'`) — cannot be used to unassign.
- Clicking an individual slot cell toggles it between empty and amber (selected).

## Bulk Assignment block
- **Select All** checkbox (no per-row checkboxes) — selects all slots for every *unassigned* employee (rows already marked "✓ Assigned" are skipped and untouched). Unchecking clears the selection back to empty for those same rows.
- Below Select All: **"N slots selected"** — live count of individual amber (selected) slot boxes across all rows, not a count of employees or full-shift rows.
- **Project** dropdown — Select…, Project A, B, C, D, Non Project.
- **Job Order** dropdown — scoped to the chosen Project only (each project maps to its own Job Order list; changing Project resets Job Order). Shows "Select a project first" hint until a project is chosen. Options formatted as `<code> - <name>`.
- **Job Order Name** — read-only, auto-fills from the selected Job Order.
- **Assign to Selected** button — enabled only when slots-selected count > 0. Applies the chosen Project + Job Order to every amber slot across all rows, marking those rows "✓ Assigned" once fully filled (partial fills get an "attention" state instead).
- Bottom summary line: "N slots selected" (left) and the list of affected employee short names (right, truncated with ellipsis if long).

## Per-row grid (Review & Fine-tune)
- Each row: employee name + "✓ Assigned" tag (if fully assigned) + Edit/Remove links (Remove opens an inline confirm popover).
- Full Shift checkbox (see slot model above).
- 4 individual slot cells (click to toggle select).
- OT hours (read-only display in this mock).
- **Allocation cell**: Project dropdown → Job Order dropdown (scoped to the row's selected Project, same mapping as bulk) → **Assign** button.
  - Row-level Assign button works the same way as bulk: applies the row's selected Project/Job Order to that row's amber (selected) slots only. Disabled when there's no project chosen or no slot selected, or when the row is already fully assigned.
- Remarks — free text field.
- "+ Add employee" row at the bottom to search/add from the department roster.

## Job Order master data (numeric codes, 1900000xxx)
- **Project A**: 1900000107 Pipe Spool Installation · 1900000108 MCB Panel Installation · 1900000109 Sea Chest Grating Renewal
- **Project B**: 1900000204 Block Transfer (Block 223) · 1900000205 Block Cleaning (Block 223) · 1900000206 Block Painting (Block 223)
- **Project C**: 1900000110 Block Washing · 1900000111 Propeller & Rudder Inspection · 1900000112 Hull Blasting
- **Project D**: 1900000113 Deck Furniture Installation
- **Non Project**: 1900000401 General Housekeeping · 1900000402 Administrative / Meeting Time · 1900000403 Training & Induction · 1900000405 Equipment / Machine Maintenance

Job Order dropdowns (bulk and per-row) always filter to only the Job Orders mapped to the currently selected Project.

## Explicit decisions / non-goals
- No checkboxes next to employee names anywhere — selection is expressed entirely through slot state (amber) and the Full Shift checkbox.
- Full Shift button/checkbox cannot unassign an already-"done" row — frozen/greyed out once assigned.
- No budget indicator on this screen (parked for a different view).
- Terminology: shift slots referred to as "1st half" / "2nd half" project allocation, not generic "checkboxes."

## File
`Daily Timesheet Entry Screen.dc.html`
