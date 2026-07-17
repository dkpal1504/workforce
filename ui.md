# Workforce — Responsive UI Plan

This document defines how the Workforce web app adapts across **phone**, **tablet**, and **laptop**. One React SPA is used; there is no separate native mobile app.

## 1. Goals and non-goals

### Goals

- Screens auto-adjust so HOD / Project Head can **approve and reject on a phone** without relying on landscape-only horizontal scrolling.
- Supervisors can use **Select Team** and **Timesheet** on tablet / phone with usable touch targets.
- Preserve existing workflows: expand supervisor → employees, partial approve/reject, bulk actions, Planning send-back, Summary grouping.

### Non-goals

- Native iOS / Android apps
- Separate mobile-only routes or backends
- Changing approval business rules (only layout / interaction)

## 2. Current state

| Area | Today |
|------|--------|
| Viewport | `width=device-width` set in `apps/web/index.html` |
| Shell | Hamburger nav ≤767px; safe-area padding (`AppLayout`, `global.css`) |
| Select Team | Stacks at 900px (`selectTeam.css`) |
| Timesheet | Phone cards + hour chips; tablet sticky employee col; laptop full grid |
| Summary | Phone cards + project chips; tablet sticky name col; laptop full table |
| Approvals | Phone cards + sticky bulk bar; tablet sticky identity col |

## 3. Breakpoint system

| Name | Width | Primary pattern |
|------|-------|-----------------|
| **Phone** | `max-width: 767px` | Card / stacked actions; collapsible nav |
| **Tablet** | `768px–1199px` | Compact tables + sticky first column; scroll for extra cols |
| **Laptop** | `min-width: 1200px` | Full desktop tables (current layouts) |

Shared tokens live in `apps/web/src/styles/themes.css` / `global.css`:

```css
--bp-phone-max: 767px;
--bp-tablet-max: 1199px;
--touch-min: 44px;
```

## 4. Shell / navigation

**Phone (`≤767px`):**

- Brand row + **menu (hamburger)** toggle
- Nav links, user label, Themes, Logout in a slide-down panel
- Safe-area padding for notched devices

**Tablet / laptop:**

- Existing horizontal nav (wrap allowed)

Files: `AppLayout.tsx`, `global.css`

## 5. Screen-by-screen adaptations

### 5.1 Approvals — P0 (approve on phone)

**Phone**

- Hide wide tables; show **cards**:
  - Supervisor card: name, date, badge, project hour chips (A/B/C/OH/Total), Approve / Reject, expand employees
  - Employee cards under expanded supervisor (or flat “By Employee” cards)
  - Planning returned / Approved history as stacked cards
- **Bulk bar** sticky at bottom of viewport (Select all / Reject / Approve)

**Tablet**

- Keep table; sticky Supervisor / Employee column; horizontal scroll for project + action columns
- Larger tap targets on Approve / Reject / expand chevron

**Laptop**

- Current full table UI

Files: `ApprovalsPage.tsx`, `approvals.css`

### 5.2 Timesheet — P1

**Phone:** Per-employee card with hour chips (select + assign), not a 13-column grid.  
**Tablet:** Sticky employee column + horizontal scroll.  
**Laptop:** Full grid.

Files: `TimesheetPage.tsx`, `timesheet.css`

### 5.3 Summary — P1

**Phone:** Card rows with project chips.  
**Tablet:** Compact scroll table.  
**Laptop:** Full table.

Files: `SummaryPage.tsx`, `summary.css`

### 5.4 Select Team / Login — P2

Already mostly responsive; polish touch targets and spacing only.

## 6. Touch UX standards

- Minimum tap target ~**44×44px** for primary actions and expand controls
- Form inputs on phone: font-size **≥16px** (avoids iOS focus zoom)
- Primary actions never clipped off-screen; sticky bulk bars on Approvals phone
- Prefer `overflow-x: auto` only as a **fallback** on tablet, not as the only phone UX for Approvals

## 7. Implementation phases

| Phase | Scope | Status target |
|-------|--------|----------------|
| **A** | Breakpoint tokens, hamburger shell, page padding / safe-area | **Implemented** |
| **B** | Approvals phone cards + sticky bulk bar + tablet sticky column | **Implemented** |
| **C** | Timesheet + Summary phone/tablet patterns | **Implemented** |
| **D** | QA matrix: iPhone / Android / iPad / laptop Chrome | Planned |

## 8. Acceptance criteria

- [ ] HOD can complete **Approve / Reject** (single and bulk) on a phone in portrait without landscape-only use.
- [ ] Expand / collapse supervisor groups is clearly tappable.
- [ ] Navigation does not permanently consume half the viewport on phone (menu collapses).
- [ ] Tablet Approvals: first identity column stays visible while scrolling project columns.
- [ ] Laptop layouts remain functionally equivalent to today’s desktop UI.
- [ ] No regression to approval workflow data (same APIs; layout-only change).

## 9. Files to touch

| File | Role |
|------|------|
| `ui.md` (this file) | Spec |
| `apps/web/src/styles/themes.css` | Breakpoint / touch tokens |
| `apps/web/src/styles/global.css` | Shell + shared phone/tablet rules |
| `apps/web/src/components/AppLayout.tsx` | Hamburger nav |
| `apps/web/src/pages/ApprovalsPage.tsx` | Card markup (phone) |
| `apps/web/src/styles/approvals.css` | Cards, sticky bulk, tablet sticky |
| `apps/web/src/pages/TimesheetPage.tsx` | Phone employee cards + hour chips |
| `apps/web/src/styles/timesheet.css` | Phone/tablet Timesheet styles |
| `apps/web/src/pages/SummaryPage.tsx` | Phone summary cards + chips |
| `apps/web/src/styles/summary.css` | Phone/tablet Summary styles |

## 10. Approach diagram

```text
Device width
     │
     ├─ ≤767px  → Cards + collapsible nav + sticky bulk (Approvals)
     ├─ 768–1199 → Compact tables + sticky identity col
     └─ ≥1200   → Full desktop tables
```
