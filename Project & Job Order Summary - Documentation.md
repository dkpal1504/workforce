# Project Summary & Job Order Summary — Feature Documentation

## Overview
Two-tab reporting area of the app: **Project Summary** (Supervisor/Department hours & cost roll-up by Project) and **Job Order Summary** (Job Order-level budget vs. consumption, grouped by Project). Shared navy header ("Summary") with a tab bar directly below; active tab has solid highlight, inactive tab is a link to the other screen.

Files: `Summary.dc.html` (Project Summary), `Job Order Summary.dc.html`.

---

## Project Summary (`Summary.dc.html`)

### Filter row
- **Frequency**: Daily / Weekly / Monthly dropdown.
- **Select Projects**: multi-select dropdown panel (checkbox list + "Select All" + Apply button); label reads "All Projects" or "N selected."

### Toggle groups (second row)
- **Group by**: Employee / Supervisor / Department / Totals (segmented button group, single-select).
- **Value type**: Hours View / Cost View (segmented button group, single-select).

### Table
- Columns: Sr. No. | Supervisor | Department | Project A | Project B | Project C | **Total** (highlighted) | Overhead.
- A header sub-row labels the project columns "Active Projects."
- Zero values rendered in muted gray; non-zero in dark text. Overhead > 0 highlighted amber/orange.
- Total column has a distinct tinted background + left border to set it apart.
- Bottom summary row: grand totals per column.

---

## Job Order Summary (`Job Order Summary.dc.html`)

### Filter row (matches Project Summary's Frequency + Select Projects controls)
- **Frequency**: Daily / Weekly / Monthly dropdown (same as Project Summary, for visual consistency).
- **Select Projects**: same multi-select dropdown panel pattern (checkbox list + Select All + Apply). Options: Project A, B, C, D, Non Project. Defaults to all selected.
- **Job Order Status**: new 3-button segmented group — **All / Active / Closed** — single-select, "All" active by default.
- **Department**: single-select dropdown (Hull Production / Blasting & Painting / Ship Repair / All Departments), placed next to Status.

### Table — grouped by Project
- Each Project renders as a **bold, full-width section header row** (name only, light navy-tinted background) — no numeric rollup on this row.
- Under each Project header, Job Orders are listed as numbered rows, **Sr. No. restarting at 1 per Project group**.
- Columns: Sr. No. | **Job Order** (`<code> - <name>`, e.g. "1900000107 - Pipe Spool Installation") | Budgeted | Consumption | Consumption % | Balance.
- Job Order name carries a small italic colored **superscript** showing status: green "ACTIVE" or gray "CLOSED", set immediately after the name.
- **Budgeted / Consumption / Balance are in hours** (e.g. "1,200 hrs"), not cost — this screen is an hours/budget-hours view, distinct from Project Summary's cost/hours toggle.
- **Consumption %**: small colored progress bar + bold percentage — green (<85%), amber (85–99%), red (≥100%).
- **Balance** = Budgeted − Consumption; negative shown in red with parentheses, e.g. "(1,200 hrs)".
- No project-level subtotal row: since Status/Department filters can show only a partial slice of a Project's Job Orders, a subtotal here would misrepresent the true project total. Project-level totals live on the Project Summary screen instead.
- On Hold Job Orders are excluded from this screen entirely — only Active and Closed exist in the underlying data set.

### Job Order master data reused from the Daily Timesheet Entry Screen
- **Project A**: 1900000107 Pipe Spool Installation · 1900000108 MCB Panel Installation · 1900000109 Sea Chest Grating Renewal
- **Project B**: 1900000204 Block Transfer (Block 223) · 1900000205 Block Cleaning (Block 223) · 1900000206 Block Painting (Block 223)
- **Project C**: 1900000110 Block Washing · 1900000111 Propeller & Rudder Inspection · 1900000112 Hull Blasting
- **Project D**: 1900000113 Deck Furniture Installation
- **Non Project**: 1900000401 General Housekeeping · 1900000402 Administrative / Meeting Time · 1900000403 Training & Induction · 1900000405 Equipment / Machine Maintenance

Sample data demonstrates all three consumption states (comfortably under, near-limit ~85–99%, and over-100% budget) across both projects.

## Explicit decisions / non-goals
- Job Order Summary has no action buttons — pure data-dense review table.
- No project-level subtotal row on Job Order Summary (see rationale above).
- Job Order Status is a single-select 3-button group, not a dropdown, to make the Active/Closed/All state visually prominent and matched to the "Group by"/"Value type" segmented-button style already used on Project Summary.
