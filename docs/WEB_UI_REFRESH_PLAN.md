# Workforce — Desktop (Web) UI Refresh Plan

**Status:** plan for review — no application code changed yet.
**Reference design:** `screen_m1.png` (repo root, added by the owner).
**Evidence base:** read-only audit of the working tree at `HEAD 4515b64` plus a captured
responsive baseline. Raw evidence lives in `/tmp/ui_refresh/` (screenshots, metrics, reports).

---

## 1. Verdict (answer first)

**Yes — doable, and low risk, if the refresh is gated to the laptop band (`min-width: 1200px`).**

* Nothing in the app is width-detecting in JavaScript. All responsiveness is CSS media queries
  (`apps/web/src/**` contains no `matchMedia`, no `window.innerWidth`, no `resize` listener).
  So a desktop-only change is a *stylesheet* change plus *additive* markup, not a behavioural change.
* The phone and tablet layouts are defined by their own `@media` blocks
  (`max-width: 767px`, `768–1199px`). A refresh that only *adds* `min-width: 1200px` rules and
  *adds* hidden markup cannot alter those blocks.
* The app already has a 5-theme token system driven by `data-theme` on `<html>`. A refresh built
  from tokens is automatically applied to all five themes, which is exactly what was asked.
* No API route, request, capability guard, route path, or piece of state logic needs to change.
  "No impact on core functionality" is therefore a design constraint we can hold, not a hope.

The two things that must be handled carefully are **duplicate accessible names** (the existing
Playwright suite runs at 1280×720, where the new desktop shell is active) and **content width**
(a fixed left rail makes the content column narrower on a 1280-wide window). Both are covered in
§8 (risks) and §9 (verification).

---

## 2. Scope interpretation (please confirm)

* "Web UI" = the laptop/desktop rendering of the one React SPA (`apps/web`). There is no separate
  native mobile app; `ui.md` states this explicitly.
* "Mobile View" = the narrow-viewport rendering of the same SPA. The repo guards it today with
  `apps/web/e2e/mobile-screens.spec.ts`, which renders four routes at **390×844 (phone)** and
  **768×1024 (tablet)** and asserts: no horizontal overflow, data reachable (row/card/empty state),
  and no uncaught page error. Baseline for this plan: **8 passed / 0 failed**.
* **Working assumption to confirm:** *everything at `≤ 1199px` is untouchable* — phone *and*
  tablet, including the 1024–1199 band where the app currently shows desktop tables but the
  tablet header. If a change is wanted in that band too, say so; it is a separate decision (§8 R4).
* "All themes to follow the same" = the new look must be produced from theme tokens so Harbor,
  Atlas, Daybreak, Forge and Nocturne all restyle with no per-theme CSS forks.

---

## 3. Current state (measured, not assumed)

| Area | Today |
|---|---|
| Shell | One sticky top bar `.app-header` (gradient `--header-bg`): brand mark, the page title as `<h1 class="app-header__title">` (`titleForPath()`), **13 `NavLink` items in a flat wrapping row**, user label, `Themes` + `Logout` buttons |
| Phone shell | `≤767px`: header stacks, hamburger toggles `.app-header__nav.is-open` |
| Content | `<main class="page">`: `padding:22px 22px 36px; max-width:1440px; margin:0 auto` |
| Kernel CSS | `styles/global.css` (674 lines) is imported **last** in the bundle, so it wins equal-specificity ties; `styles/supervisors.css` is the de-facto second kernel (`.sup-table`, `.modal*`, `.sup-form`, `.badge*`, `.btn-sm`) shared by 8 routes |
| Breakpoints | phone `≤767`, tablet `768–1199`, laptop `≥1200` are *documented*; but table↔card switches use **1024px** (`supervisors.css:391/406`, `JobOrderProgressPage.css:568/578`) and three ad-hoc boundaries exist (900px login/select-team, 959px allocations, 420px small phones) |
| Themes | `styles/themes.css`: `:root,[data-theme=harbor]` plus atlas / daybreak / forge / nocturne; ~45 tokens each; `theme/projectColors.ts` publishes project colour tokens |
| Existing desktop defect | At 1440px the 13-link nav wraps onto a second row and **overlaps the brand block** ("Select Team" is drawn over the WORKFORCE wordmark) — see `/tmp/ui_refresh/before/laptop-master-data.png`. This is one of the things the reference design fixes |
| Dead code (leave alone) | `HeaderOnly` (`AppLayout.tsx:165`), `components/DelegationsPanel.tsx`, `.sup-card`, `.badge--pin`, `.wbs-field`, and a no-op `.modal{max-width:520px}` media block (`supervisors.css:428`) |

Baseline artefacts (repo untouched): `/tmp/ui_refresh/before/` — 33 full-page screenshots
(11 routes × phone/tablet/laptop), `metrics.json`, `mobile-e2e.txt`, `full-suite.txt`, `README.md`.

### 3.1 Test baseline (measured before any change) — important for judging "no impact"

| Suite | Result at `HEAD 4515b64` |
|---|---|
| `e2e/mobile-screens.spec.ts` (phone 390 + tablet 768) | **8 passed / 0 failed** |
| `e2e/master-data.spec.ts` | 2 passed / 0 failed |
| `e2e/smoke.spec.ts` (Desktop Chrome 1280×720) | **0 passed / 2 failed** |
| Full run (`npx playwright test`) | **10 passed / 2 failed** |

Both failures are pre-existing and are **seed-data** failures, not layout failures: every step runs
as the employee login `EC1001`, and `POST /api/auth/login` with `EC1001` (or `ec1001`) returns
**401 INVALID_CREDENTIALS** against the current `apps/api/prisma/dev.db`. So `getByRole("heading",
{name: "Select Team for Today"})` and `getByRole("link", {name: "My Hours"})` can never appear for
that account. Consequence for this plan: the desktop gate (`G1`) must compare against **this exact
baseline** (same 2 failures, same reason) rather than requiring a fully green suite, and the
desktop shell must be built so that the 8 mobile tests + 2 master-data tests cannot regress.

---

## 4. Reference design — measured specification

`screen_m1.png` is a 1× capture of a **1632×870** desktop viewport (controls measure 40–44 CSS px,
matching the app's own `--touch-min: 44px`), in the **Harbor** palette
(page background `#f2f5f6` vs `--bg #f2f5f7`; CTA fill `#0d5c63` vs `--primary #0f6e6a`).
It renders the app's own **Project master** page (`/master-data`, Job order tab), so it is a
restyle + shell change of existing screens, not a new product.

### 4.1 Left rail (new)

* Width **269 px** (≈16.5 % of a 1632 viewport), full viewport height, solid deep teal `#0c3a42`
  (`--navy`-family, to be tokenised), no shadow, content column starts immediately after it.
* **Brand block:** 36 px orange rounded-square mark (same as today's `.app-header__mark`) +
  `Workforce` (15 px / 700, white) + `Swan Group` (12 px, muted).
* **Five nav groups**, small muted group labels: *Time tracking* (Select team, Timesheet, Summary,
  Approvals, My hours), *People* (Supervisors, Employees), *Organisation* (Role assignment),
  *Project setup* (Project master, Job order upload, Qty progress, CSV upload), *System*.
  Every item in the mock corresponds 1:1 to an existing capability-gated `NavLink`.
* **Item:** 18 px outline icon + 14 px label, ~40 px tall, radius 10 px, active item = translucent
  white pill (`rgba(255,255,255,.13)`), active icon tinted cyan.
* **Footer:** hairline divider, 34 px circular avatar, user name / role / role-line, then three
  icon buttons: moon (dark mode), palette (themes — opens the existing `ThemePanel`), logout arrow.

### 4.2 Content column

* Content x-range 314 → 1592 px with the rail ending at 269 → **max-width ≈ 1280 px, centred** in
  the space right of the rail, ~40–45 px side padding. (Today: `max-width: 1440px`.)
* **Page head:** title 28–30 px / 700 (e.g. "Project master"), muted 14 px subtitle (two lines),
  right-aligned primary CTA with a leading icon (`↑ Upload job orders`, 44 px, radius 10).
* **Segmented tabs:** white rounded container (radius ≈12, ~4 px padding) holding
  Project / WBS / UoM / Network / Job order; active = filled primary pill (radius 8, ~40 px tall),
  inactive = slate text on white. Today these are five separate bordered buttons.
* **Toolbar row:** project `<select>` (white, radius 10, chevron) · search input (white, radius 10,
  magnifier icon, placeholder "Search job order, WBS or network") · right-aligned stat pair
  (`6 job orders` — `44 hours booked`, bold numbers, muted labels).
* **Info bar:** white rounded card (~46 px) with a bold 13 px label and a chevron — the page's
  existing help paragraph ("How job orders are managed") becomes collapsible.
* **Table:** inside a white card (radius 12–16, soft shadow). Header 11 px uppercase muted; rows
  ≈62 px with hairline separators; cell text 13 px. Per-cell treatments in the mock:
  project chip (11 px/700 uppercase teal on light teal, radius 8) · WBS code + small lock glyph
  (the "frozen once hours are booked" rule) · booked hours as number + 4 px progress bar
  (light track, primary fill) · status pill (light tint, 6 px dot + label) · row action as a
  bordered ghost button with a pencil icon + "Edit".

---

## 5. Gap list — current vs reference

| # | Element | Today | Target |
|---|---|---|---|
| 1 | Primary navigation | 13 flat links in the top bar, wrapping and overlapping the brand at ≥1440 | Grouped left rail, 5 sections, icon + label, active pill |
| 2 | Page identity | Title lives in the top bar (16 px) | Title + subtitle in the content column (28–30 px) |
| 3 | Page action | None (the CTA exists only inside the Job order tab as a text link) | Primary icon CTA in the page head |
| 4 | Tabs | Five bordered buttons ("btn btn-ghost" / "btn-primary") | Segmented control in a white container |
| 5 | Toolbar | Tabs left, search + Add stacked right, uneven | One row: select · search-with-icon · stat pair · Add |
| 6 | Help text | Wide run-on paragraph above the table | Collapsible info card |
| 7 | Table container | `table.sup-table` (border + radius on the table itself) | Card wrapper, taller rows, softer header |
| 8 | Row semantics | Plain numbers, text status ("Active"), `Deactivate` text buttons | Progress bar, tinted status pill, icon row actions |
| 9 | Content width | 1440 px centred under a full-width header | 1280 px centred beside a fixed rail |
| 10 | Header defect | Nav overlaps brand ≥1440 | Gone (nav is not in the top bar on desktop) |

## 5.1 Second work category: theme-correctness defects (decision needed — these DO reach the phone)

The audit found that the theme system is not fully enforced. These are real defects, and fixing them
would change the **phone** view too, because the same classes are used there. They are therefore
listed separately from the desktop-only refresh, and need an explicit decision.

| # | Defect | Where | Effect |
|---|---|---|---|
| T1 | `--project-n` is **never defined** in any theme, yet `theme/projectColors.ts:39` returns `var(--project-n)` for `color_key="n"` and Summary/Approvals put it in an inline `background` | `themes.css`, `projectColors.ts`, `SummaryPage.tsx`, `ApprovalsPage.tsx` | An undefined custom property with no fallback drops the declaration: a "standing / non-project" row renders a **colourless chip**, an invisible dot, and a `--text-muted` cell on Timesheet — the same project looks different on three screens |
| T2 | ~53 literal colours repeat the semantic ramp (`#15803d`, `#dc2626`, `#b45309`, …) instead of `var(--success|--danger|--warning)` | `approvals.css`, `summary.css`, `timesheet.css` | On **Nocturne** the tokens are deliberately lightened (`--success:#4ade80`, `--danger:#f87171`), so the literals become dark-on-dark: job-order bar labels, approve/reject buttons, status chips and OT alerts are hard to read |
| T3 | `.btn-primary{color:#fff}` with `--primary` on Nocturne (`#38bdf8`), plus `#fff` text on `--project-*`/`--orange-selected` slots | `global.css:333`, `allocations.css`, `timesheet.css` | White on a light accent — worst on `.slot-cell.assigned-e` (white on `#facc15`) |
| T4 | `color-mix(..., #000)` (7 places) and 4 light-only `rgba(15,23,42,…)` shadows/scrims | `JobOrderProgressPage.css`, `approvals.css`, `supervisors.css` | Darkens an already-light token in dark mode; shadows ignore `--shadow-*`, which Nocturne overrides |
| T5 | The app's only inline colour literal: `background:"#dbeafe"` (Select Team drag/selected row) | `SelectTeamPage.tsx:229` | Ignores all five themes |

**Options**

* **(a) Desktop-only scope (strict reading of the request).** Fix nothing globally; at most give the
  desktop band its own corrected declarations. The phone keeps today's look, including the defects.
* **(b) Fix globally (recommended for T1–T5).** These are legibility/correctness defects; fixing them
  changes pixels on the phone in the affected states, but it makes the phone *better*, not different in
  layout. "Mobile view unchanged" would then mean "layout and structure unchanged", not "pixel-identical".
* **(c) Mixed.** Fix T1 (a genuine bug with no visual trade-off beyond giving the chip its colour) and
  leave T2–T5 for a separate theme-hardening task with its own verification.

If strict pixel identity on the phone is a hard requirement, choose **(a)** or **(c)** and keep T2–T5 in
a follow-up.

---

## 5.2 In-page inconsistencies the same refresh can clean up (desktop-facing, optional)

From the same audit; each is small and independent:

| Area | Finding |
|---|---|
| Page titles | Only `AppLayout` renders a page `<h1>`; two pages add their own `<h2>` (`ApprovalsPage.tsx:449` 22px, `JobOrderProgressPage.tsx:652` 22px whose text "Job Order Quantity Progress" does not even match the header's "Quantity Progress"); the other 12 pages have no page heading, so vertical rhythm differs per page |
| Buttons | `.btn-sm` is declared 3 times with 3 different sizes; the same "primary action" has 3 visual forms (green fill `.btn-approve`, teal fill `.btn-primary`, outlined `.btn-secondary`); row actions mix `btn-ghost`/`btn-secondary`/`btn-danger`; 62 inline `margin*` patches and 5 identical inline patches fighting `.modal__footer` |
| Tables | **Six** unrelated table implementations (`.sup-table`, `.hod-table`, `.timesheet-table`, `.summary-table`, `.jo-summary-table`, `.alloc-timesheet`) with different header sizes and different tablet behaviour; the actions column is right-aligned three different ways |
| States | Four empty-state classes, two loading idioms, **no spinner anywhere**; `.error-banner` defined twice with different values; `.alloc-note` is a warning-styled class used as a success notice by 8 modules |
| Tabs | Two tab systems (`.hod-tabs`, `.jop-tabs`) plus `.toggle-group` and `.view-toggle`; only one has `overflow-x:auto`, only one has `:focus-visible` |
| Accessibility | `role="dialog"`/`aria-modal` on 1 of 6 modals; no modal closes on `Escape` (only the theme panel does); `role="status"`/`role="alert"` on a minority of banners; no `aria-live` |
| Dead code | `HeaderOnly`, `DelegationsPanel`, ~72 lines of `.sup-card*`, `.badge--pin`, `.wbs-field`, a no-op `.modal` media block |

Recommended: fold the *desktop-visible* parts into P1/P2 (one page-head component, one row-action style,
one table shell, one empty/loading state), and schedule the rest (a11y, dead code) as a separate
housekeeping task so the mobile risk stays at zero.

---

---

## 6. Safety model — why Mobile View cannot change

1. **Breakpoint gate.** Every new rule goes inside `@media (min-width: 1200px)`. No existing
   `≤1199px` rule is edited, so the phone/tablet cascade is unchanged.
2. **Additive markup only.** The rail is new DOM, `display: none` below 1200 px. Phone and tablet
   therefore render the same boxes, the same order, the same text.
3. **One visible instance per accessible name.** At ≥1200 px the top bar is hidden (not merely
   unstyled), so the rail becomes the only source of each nav link and of the page `<h1>`;
   below 1200 px the rail is `display: none`, so the top bar remains the only source. This keeps
   `getByRole(...)` selectors resolving to exactly one element at every width.
4. **No duplicate actions.** The desktop page head may show an action only where that action does
   not already exist as a visible button on the same screen (otherwise existing strict-mode
   selectors such as `getByRole("button", { name: /Add WBS/i })` would match twice at 1280×720).
5. **No logic change.** Same routes, same capability guards, same API calls, same labels; the rail
   renders the *same* `NavLink` targets that the header renders today.
6. **CSS placement is deliberate.** The bundle order is fixed and `global.css` is last, so
   *shared* desktop rules are appended at the **end of `global.css`**, and *page-scoped* desktop
   rules at the **end of that page's stylesheet** (or at the end of `supervisors.css` for kernel
   classes such as `.sup-table`). A new stylesheet imported from a component would be ordered
   *before* `global.css` and lose equal-specificity ties — do not do that.
7. **Proof, not promise.** §9 G2 diffs phone/tablet screenshots and geometry before vs after.

---

## 7. Work plan

### P0 — Desktop shell (~0.5–1 day) *(biggest visible win)*

| File | Change |
|---|---|
| `apps/web/src/styles/themes.css` | Add rail tokens to all five themes: `--rail-w`, `--rail-bg`, `--rail-bg-alt`, `--rail-text`, `--rail-text-muted`, `--rail-group`, `--rail-hover`, `--rail-active`, `--rail-border`, `--rail-icon-active` |
| `apps/web/src/styles/global.css` | Append one `@media (min-width:1200px)` block: `.app-shell{display:grid;grid-template-columns:var(--rail-w) 1fr}`, hide `.app-header` on desktop, `--page-max` width, rail layout rules |
| `apps/web/src/components/AppLayout.tsx` | Render `<aside class="app-rail">` (hidden below 1200): brand block, 5 groups built from the *existing* capability checks, footer user chip + 3 icon buttons (moon → Nocturne/Harbor toggle, palette → existing `openPanel`, logout → existing handler). No change to the existing header markup, so phone/tablet are untouched |
| new `apps/web/src/components/icons.tsx` | ~12 inline SVG outline icons (people, clock, chart, check-circle, badge, user, folder, upload, trend, file, pencil, moon, palette, logout). Small file, no dependency added |

### P1 — Shared page anatomy + Project master match (~1 day)

* **Page head** (`titleForPath` + a subtitle map + an optional CTA registered by the page through a
  tiny context). Rendered by `AppLayout` above `<Outlet/>`, `display:none` below 1200 px, with the
  top-bar title hidden at ≥1200 px so exactly one `<h1>` is visible.
* **Segmented tabs**, **toolbar row**, **stat pair**, **collapsible info card**, **card-wrapped
  table**, **row progress bar / status pill / icon actions** — first on `/master-data`
  (`MasterDataPage.tsx`, `pages/MasterDataPage.css`, `styles/supervisors.css`), because that is the
  page in the reference.

### P2 — Roll the same anatomy to the other list screens (~1–1.5 days)

`SupervisorsPage`, `EmployeesPage`, `DepartmentsPage`, `JobOrderUploadPage`, `JobOrderProgressPage`,
`RoleAssignmentPage`, `CsvUploadPage` (+ `Summary`/`Approvals`/`Timesheet` only where a desktop
treatment is clearly shared). Markup-light: reuse the same classes; page-specific CSS stays
page-scoped. The reference is a *system*, not a pixel copy — each page keeps its own columns and
actions.

### P3 — Theme pass (~0.5 day)

Contrast check for all five themes at ≥1200 (WCAG AA 4.5:1 for text, 3:1 for the rail's icon
strokes), especially Nocturne (dark theme + dark rail) and Forge/Daybreak (warm, low-contrast).
Optional: the moon button toggles Harbor ↔ Nocturne (already a supported theme).

### P4 — Verification + docs (~0.5 day)

Run §9, update `ui.md` (it is the responsive spec) with the new desktop section, delete or archive
`screen_m1.png` once the design is implemented.

**Effort:** ≈3.5–4.5 focused days for one engineer. P0 alone (~1 day) delivers most of the visible
improvement (grouped rail, no more overlapping nav) with the smallest diff.

---

## 8. Risk register

| # | Risk | Likelihood | Mitigation |
|---|---|---|---|
| R1 | The existing suites (`smoke.spec.ts`, `master-data.spec.ts`) run at **Desktop Chrome 1280×720**, i.e. *inside* the new desktop band. A duplicated heading/link/button name breaks them in strict mode | High if unmanaged | Hide the top bar at ≥1200 so each name has one visible source; never duplicate action buttons; run the **full** suite, not just the mobile one (§9 G1) |
| R2 | A fixed rail narrows the content column at 1280 px; wide pages (`/timesheet` 13-column grid, `/summary`, `/approvals`) could overflow or clip their sticky column | Medium | Rail 240–264 px; keep `.page` centred with its own max-width; test all 11 routes at 1280×720 **and** 1440×900; the mobile suite does not cover 1280 |
| R3 | A new stylesheet imported from a component loses ties to `global.css` (bundle order) | Medium | Append desktop rules to `global.css` / the page's own stylesheet (§6.6) |
| R4 | Two desktop looks: ≥1200 gets the rail, 1024–1199 keeps the current wrapping header | Certain (by design) | Deliberate: 1024–1199 is the tablet band, and 1024 px is the app's own table↔card switch. If the rail should also cover 1024–1199, that band becomes part of the change scope and must be re-verified — a separate decision |
| R5 | The 1024 px ad-hoc breakpoints (`supervisors.css`, `JobOrderProgressPage.css`) make a 1024 px gate dangerous | – | Do **not** gate any new shell rule at 1024 |
| R6 | Theme contrast: dark rail in a light theme, light rail in Nocturne | Medium | Rail colours are tokens, defined per theme; numeric contrast check in §9 G4 |
| R7 | Stale dev server / HMR order makes a browser check misleading | Medium | Restart both dev servers before visual checks, then confirm the served file hash |
| R8 | Scope creep into dead code (`HeaderOnly`, `DelegationsPanel`, `.sup-card`, `.wbs-field`) | Medium | Explicitly out of scope; no deletion in this work |
| R9 | Title text divergence ("Project Master Data" vs "Project master") | Low | Keep one string per page from `titleForPath`; if a shorter desktop label is wanted, drive both from one map so they cannot disagree |
| R10 | The mock is only page 1 | – | Treat `screen_m1.png` as the pattern for the *system*; the owner may supply `screen_m2…` later; the plan already generalises |

---

## 9. Verification plan (three gates)

**G1 — Existing behaviour unchanged.** Re-run the full suite after each phase:
`cd apps/web && npx playwright test` (smoke, master-data, mobile-screens; Desktop Chrome 1280×720
plus the phone/tablet viewports). Baseline is `/tmp/ui_refresh/before/full-suite.txt`:
**10 passed / 2 failed**, the two failures being the `EC1001` seed-data failures described in §3.1.
Acceptance = the same 10 pass, and the same 2 fail **for the same reason** (no new failure, no new
reason). Any phase that changes a result is a regression, regardless of how good it looks.

**G2 — Phone/tablet pixel proof.** Re-run the capture harness (`/tmp/ui_refresh/capture-before.cjs`)
against the changed code into `/tmp/ui_refresh/after/`, then:
* `node /tmp/ui_refresh/compare-before-after.cjs before/metrics.json after/metrics.json` → must
  report **no change** for the phone and tablet rows (the script exits 1 on any change and is
  self-tested: comparing a file with itself reports IDENTICAL);
* byte/pixel-compare the 22 phone+tablet PNGs → expected: **identical**. Any diff is a defect of
  this change, not an acceptable side effect.

**G3 — Desktop acceptance (new spec, `apps/web/e2e/desktop-shell.spec.ts`).** At 1440×900 and
1280×720, for all 11 routes: rail visible; `nav.app-header__nav` not visible; exactly one visible
`h1`; `document.documentElement.scrollWidth - innerWidth <= 1`; the page's primary action visible;
no page error. Plus a 5-theme screenshot sweep of `/master-data` and `/timesheet` for the contrast
check (G4).

---

## 10. Open questions for the owner

1. Confirm **mobile view = `≤1199px`** (phone + tablet) is untouchable, or should the 1024–1199
   band also get the new shell?
2. Confirm the rail **replaces** the top bar on desktop (as in `screen_m1.png`), rather than
   sitting beside it.
3. Confirm the scope: match `screen_m1.png` closely on **Project master**, and apply the same
   *system* (not the same pixels) to the other list screens?
4. Keep the existing Harbor green-teal for the rail, or adopt the mock's deeper `#0c3a42` (as a
   per-theme token, both are possible — the mock's value suits Harbor)?
5. Include the moon (dark-mode quick toggle) and the palette/logout icon buttons in the rail footer?
6. Deliverable: is this plan enough for now, or should P0 (rail + tokens) be implemented on a
   branch next, with the G1–G3 evidence attached?

---

## 11. Appendix — measured artefacts

| Artefact | Path |
|---|---|
| Read-only UI/CSS/theming audit (file map, breakpoints, hard-coded colours, leverage points) | `/tmp/ui_refresh/inventory.md` |
| Responsive baseline README (commands, credentials, probes) | `/tmp/ui_refresh/before/README.md` |
| 33 baseline screenshots (phone 390 / tablet 768 / laptop 1440 × 11 routes) | `/tmp/ui_refresh/before/*.png` |
| Baseline geometry + shell metrics (`scrollWidth`, boxes, computed styles) | `/tmp/ui_refresh/before/metrics.json` |
| Mobile suite result (8 passed / 0 failed) | `/tmp/ui_refresh/before/mobile-e2e.txt` |
| Full suite result | `/tmp/ui_refresh/before/full-suite.txt` |
| Capture + diff harness used for G2 | `/tmp/ui_refresh/capture-before.cjs`, `/tmp/ui_refresh/compare-before-after.cjs` |

---

## 12. Proof of mechanism (built, measured, then reverted)

To test the claim in §1 rather than assert it, the smallest possible version of P0 (the rail plus a
desktop page title, nothing else) was built on the live tree, measured, and then reverted. The tree
is back at `HEAD 4515b64` for `apps/web` (both files byte-identical: md5 before = md5 after).
The diff is kept as a patch, **+316 lines, additive only**:

* `/tmp/ui_refresh/poc-rail.patch` — `git diff` of the experiment
* `/tmp/ui_refresh/poc-patched-AppLayout.tsx`, `/tmp/ui_refresh/poc-patched-global.css` — patched copies

| What was added | Where |
|---|---|
| `.app-rail` markup: brand, 4 capability-gated groups (Time tracking, People, Organisation, Project setup), item icons, footer with avatar + Themes/Logout icon buttons | `AppLayout.tsx` |
| One `@media (min-width: 1200px)` block: grid shell, hide `.app-header`, rail styling, `.page{max-width:1280px}` | end of `global.css` |
| `--rail-*` tokens for **all five themes** (bg, text, muted, group, hover, active, border, accent) | same block |
| A desktop-only `<h1 class="page-title">` from the existing `titleForPath()` | `AppLayout.tsx` |

### Result

| Gate | Result |
|---|---|
| **G1** existing suites, with the change applied | `mobile-screens` (phone 390 + tablet 768) **8/8 pass**, `master-data` **2/2 pass** — identical to baseline. `smoke` (Desktop Chrome 1280×720, i.e. *inside* the new desktop band) fails **the same 2 tests for the same `EC1001` data reason** as the baseline of §3.1 — no new failure, no new reason |
| **G2** phone/tablet unchanged | `metrics.json` comparison: **0 of 29 differences are phone or tablet** (all 29 are laptop rows). Screenshots: **19 of 22 phone+tablet PNGs byte-identical**; the other 3 differ by at most **±2/255 per channel** (text antialiasing only — visually identical, and a control pair captured twice with the *same* code showed 0 differences) |
| **G3** desktop acceptance | rail renders at 1440×900 on all 11 routes, top bar hidden, page title in the content column, **horizontal overflow 0** on every route including the 13-column Timesheet; the nav/brand overlap defect of §3 is gone |

Full log: `/tmp/ui_refresh/after2/suites.txt`, `/tmp/ui_refresh/after2/smoke.txt`.

Screenshots: `/tmp/ui_refresh/after2/laptop-*.png` (with the rail) versus
`/tmp/ui_refresh/before3/laptop-*.png` (today). Example: `after2/laptop-master-data.png`,
`after2/laptop-timesheet.png` (the wide timesheet table still scrolls inside its own box, so the page
never overflows).

### Two findings from running it

1. **Vite does not see file changes under `/mnt/c` (drvfs has no inotify).** The first capture after
   the edit returned the *old* page even though HMR looked healthy; the served CSS still had no new
   rules. Restarting the dev server fixed it. Any future visual check on this host must restart the
   dev server first, then verify the served file (e.g. `curl -s localhost:5173/src/styles/global.css
   | grep -c app-rail`). This is risk R7, now confirmed with a repro.
2. **CSS order is load-bearing.** The first version put the bare `.page-title{display:none}` *after*
   the `min-width:1200px` block, so the desktop title stayed hidden — exactly risk R3. The fix is
   trivial (bare rule first, desktop block last), but it shows the rule must be enforced by review:
   desktop overrides are always the **last** declarations for a selector.

---

## 13. Implemented on branch `feature/web-ui-desktop-refresh`

Three commits on top of `main` (`4515b64`); `main` is untouched, so the current state can be
kept or discarded by switching branches.

| Commit | Content |
|---|---|
| `8b82f2b` | **Desktop shell**: the `>=1200px` left rail, grouped capability-gated nav, rail footer (avatar, pin, themes, logout), desktop page head (title, lede, CTA), `--rail-*` tokens for all five themes, desktop `.sup-table` treatment |
| `65fb88c` | The plan in §1–§12 of this document |
| `b0bfd37` | **Project master page polish** (segmented tabs, one toolbar row, collapsible help card, table card), `e2e/desktop-shell.spec.ts`, `e2e/mobile-shell-guard.spec.ts`, `--on-primary` token |

### 13.1 The auto-hide rail (as requested)

* The rail **starts open**, so the first paint is the same as before and no layout animation runs
  on load. The width transition is armed only after the first paint (`.rail-ready`).
* When the pointer **leaves the rail to the right**, it slides away and the content takes the whole
  window: measured at 1600×900 → `padding-left: 0px`, `main.page` x = 0, width = 1600, rail x = −264,
  page overflow 0.
* A slim handle stays at the left edge; hovering it (or the left edge) brings the rail back.
* **Keyboard focus** inside the rail keeps it open; the **pin** button keeps it open permanently and
  remembers the choice in `localStorage` (`workforce_rail_pinned`).
* `prefers-reduced-motion: reduce` turns the slide off.
* Reading width: 1280px while the rail is open (the reference width), up to 1600px while it is
  hidden — so hiding the rail genuinely gains working space on a wide screen.

### 13.2 Measured result (same database state, back-to-back captures)

| Gate | Result |
|---|---|
| **Mobile isolation, admin routes** (10 routes × phone 390 + tablet 768) | metrics identical except that `.app-rail` exists and reports `display:none`; **18 of 20 screenshots byte-identical**; the other 2 differ on 52 and 44 pixels at **≤2/255 per channel** (a control run with identical code also diffed one of them, so this is rasterisation jitter) |
| **Mobile isolation, supervisor routes** (`/select-team`, `/timesheet`, `/allocations`, `/approvals` × 390 + 768) | metrics identical (same single `railDisplay` entry); **8 of 8 screenshots byte-identical** |
| `e2e/mobile-screens.spec.ts` + `e2e/master-data.spec.ts` | **10 passed / 0 failed** (same as the pre-change baseline) |
| `e2e/mobile-shell-guard.spec.ts` (new) | **12 passed** — below 1200px the rail, its handle and the page head are not visible, the top bar stays, exactly one heading, no horizontal overflow |
| `e2e/desktop-shell.spec.ts` (new) | **6 passed** at 1440×900 and 1280×720 — rail visible, top bar hidden, one `<h1>`, no page overflow on 12 routes, auto-hide to the right and return from the left, pin survives a reload |
| `e2e/smoke.spec.ts` | same 2 pre-existing `EC1001` seed-data failures as the baseline (§3.1) — no new failure |
| Visual | `final2/rail-open.png` (rail, page head, segmented tabs, toolbar row, help card) and `final2/rail-hidden.png` (full-width content, handle at the edge) |

### 13.3 How to re-run the gates

```bash
# servers first: Vite does not see edits under /mnt/c (drvfs has no inotify), so restart it
cd /mnt/c/data/comp/workforce && npm run dev:api & npm run dev:web &
curl -s localhost:5173/src/styles/global.css | grep -c app-rail   # must be 1 after the shell landed

cd apps/web
npx playwright test                        # smoke (2 known EC1001 failures) + master-data + mobile + both new specs
npx playwright test e2e/mobile-shell-guard.spec.ts
npx playwright test e2e/desktop-shell.spec.ts

# pixel proof against the unmodified main branch (worktree + its own dev server on another port)
git worktree add /tmp/wf-baseline main
ln -sfn $PWD/node_modules /tmp/wf-baseline/node_modules
cd /tmp/wf-baseline/apps/web && npx vite --port 5174 --strictPort &
BASE_URL=http://localhost:5174 OUT_DIR=/tmp/ui_refresh/rm/base node /tmp/ui_refresh/rm/capture.cjs
BASE_URL=http://localhost:5175 OUT_DIR=/tmp/ui_refresh/rm/shell node /tmp/ui_refresh/rm/capture.cjs
```
`/tmp/ui_refresh/rm/capture.cjs` captures phone+tablet with `reducedMotion: "reduce"` and measures
after the screenshot, so its numbers are stable.

### 13.4 Still open

1. **P2** — roll the same page anatomy to the other list screens (Supervisors, Employees,
   Organisation, Job Order Upload, Qty Progress, Role Assignment, CSV Upload).
2. **P3 / §5.1** — the theme-correctness defects (T2–T5) still change the **phone** colours if fixed
   globally; the decision is still yours. T1 (`--project-n` undefined) is a genuine bug.
3. The Project master toolbar is a single row at the reference width; between roughly 1200 and 1450px
   it wraps to two lines. A hard one-row rule at 1280 costs the stat pair or the tab labels.
4. The desktop title reads `Project Master Data` (the same string the phone shows); the mock's shorter
   "Project master" would need a second label source, which §8 R9 argues against.
5. Dev-database note: to capture the supervisor routes for verification, the account `FRNEGJ063`
   (`users.id = 6`) was given the seed password with the repo's own `apps/api/set-dev-password.cjs`.
   Its previous `password_hash` is recorded in `/tmp/ui_refresh/verify/README.md` and can be restored
   with one `UPDATE users SET password_hash=... WHERE id=6`.

---

## 14. Theme-correctness fixes (done — §5.1 T1–T5)

The owner asked for the theme defects to be fixed, accepting that phone colours change where a
colour was wrong. That is `939e3d5` on the same branch. **93 colour-only replacements**; no
selector, geometry value, media query or declaration count changed (verified per line: strip the
colours and the before/after skeletons match).

### New tokens (`themes.css`, defined for all five themes)

| Token | Why |
|---|---|
| `--project-n` | **It was never defined** while the Summary chip, the Approvals dot and the Timesheet/Allocations slot for a non-project row all referenced `var(--project-n)`. An undefined custom property makes the declaration invalid, so those inline `background: var(--project-n)` styles were dropped: the chip was white-on-transparent, the dot invisible, the slot grey. A non-project row now carries its own colour (harbor `#64748b`, Nocturne `#94a3b8`). |
| `--project-ink` | The text/icon colour on a project colour. Nocturne's palette is light (`--project-e` is `#facc15`), where white text is unreadable; ink is dark there, white in the light themes. |
| `--on-primary` | Same for text on `--primary` (Nocturne's primary is a light blue). |
| `--scrim` | Modal backdrop, so a dark theme can darken it properly instead of a light-theme `rgba`. |
| `--success-ink`, `--danger-ink`, `--warning-ink`, `--accent-ink` | Each semantic hue used as **text on its own pale surface**. The light themes darken the hue toward black (what those rules did with a literal); Nocturne uses the token itself, which is already light on a dark surface. Fills keep the base token, so button/slot backgrounds are unchanged. |

### Measured result (`/tmp/ui_refresh/contrast/{before2,after4}/contrast.json`)

A probe injects each target class into the page that defines it, flattens translucent
backgrounds over the real surface, and computes the WCAG ratio of the computed colours — 29
pairs × 5 themes:

| Theme | Below 4.5:1 before | Fixed | Below 4.5:1 after |
|---|---|---|---|
| Harbor | 2 | 2 | **0** |
| Atlas | 3 | 3 | **0** |
| Daybreak | 2 | 2 | **0** |
| Forge | 5 | 5 | **0** |
| Nocturne | 13 | 13 | **0** |

Worst Nocturne offenders before → after: primary button 2.14 → 8.82, project-E slot 1.53 → 12.23,
non-project slot 2.56 → 7.30, summary project chip 2.14 → 8.74, view/summary toggles 2.14 → 8.82,
quantity bar labels 2.64–3.41 → 6.19–10.25.

### What changed on the phone

Only colours, and only where they were wrong: the phone/tablet **geometry** metrics still differ
from `main` by the single hidden-rail entry (`/tmp/ui_refresh/rm/{base_theme,shell_theme}`), while
7 of 20 phone/tablet screenshots differ in colour (max channel delta 32/255, concentrated on
chips, status labels and buttons). Examples: `themes/board-{harbor,nocturne}.png` (project A–F and
the non-project N slot), `themes/desktop-nocturne-master-data.png`,
`themes/desktop-nocturne-timesheet.png`.

### Not changed (deliberately)

`--project-a … --project-f` are still defined only in Harbor and Nocturne; Atlas, Daybreak and
Forge inherit Harbor's project palette. Giving each theme its own project palette is a design
decision, not a defect, so it is left for a follow-up.

---

## 15. Owner-requested screen fixes (done, 2026-09-21)

Two rounds of small, owner-reported defects. Both are display-only: no API route, request body,
capability, stored value or database row changed.

### 15.1 The Select Team filter row, and the Job Order option cap (`da191a1`)

| Defect (as reported) | Cause | Fix |
|---|---|---|
| On Select Team the Search label and box sat above the Date / Department / Section line | `.filter-row` aligns its fields with `align-items: flex-end`, and `.search-input` brings a `margin-bottom: 12px` from its toolbar use, which lifted the whole Search field 12px | `.filter-row .search-input { margin-bottom: 0 }` — scoped, so page toolbars keep their margin. A native date input is also 2px taller than a select, which lifted the Date label; pinned to 40px inside `@media (min-width: 768px)` so the phone's 16px touch font is untouched |
| The Timesheet Entry Job Order list ran past the row | A native `<select>` sizes both its box and its popup to the LONGEST option; `M4116-Welding of anchor loose stud welding in conjunction with anchor ranging` is 77 characters, which made the column 563px wide and pushed ASSIGN out of the row | The option text is capped at 34 characters, Job Order number included (`utils/jobOrderLabel.ts`), for the per-row picker, the bulk picker and a frozen booking snapshot. The option VALUE is still the Job Order id |

Measured at 1817 / 1900 / 1440 / 1280 / 1024 px: the four filter fields share label top, control top
and control bottom; the Job Order column is 286px and nothing overflows. Playwright 28 passed / 2
failed, the 2 being the pre-existing `EC1001` smoke seed-data failures (the same 2 fail on the
unmodified tree, with the same errors).

### 15.2 The identity moved to the page head, and the My Hours picker cap (2026-09-21)

The owner asked for the signed-in name out of the left panel and into the header, joined to the
Department or Section by a hyphen — and for the My Hours Job Order picker to get the same 34-character
cap as the Timesheet screen.

* `AppLayout.tsx`: the rail footer keeps only the pin / themes / logout buttons. The page head carries a
  chip with the initials bubble and `Name - Section` (an employee's or supervisor's own Section wins),
  else `Name - Department`, else `Name - Role` for an office account that has neither; the role stays as
  the muted second line. `userIdentityLine()` and `userInitials()` hold the rule in one place.
* `utils/jobOrderLabel.ts` is now shared, so `TimesheetPage` and `AllocationsPage` (My Hours, and the
  Manhour Allocation view for HOD/PM) both show at most 34 characters in the Job Order dropdown.

Measured at 1817 / 1440 / 1280 px: chip on the same row as the Project Master Data CTA, rail footer
renders no text, one visible `<h1>`, page overflow 0, no page errors. At 390 / 768 px: `.page-head` is
`display:none`, so the chip is not visible and the phone/tablet top bar is unchanged; one `<h1>`, no
overflow. My Hours: longest option 34 characters (271px), picker 308px, no overflow.
