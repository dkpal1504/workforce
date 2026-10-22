import test from "node:test";
import assert from "node:assert/strict";
import {
  COVERAGE_TAB,
  DELAY_INSIGHTS_TAB,
  DEFAULT_TAB,
  PORTFOLIO_TABS,
  defaultTabFor,
  PORTFOLIO_TAB_IDS,
  REPORTS_TAB_IDS,
  TAB_TONES,
  isPortfolioTabId,
  isReportsTabId,
  reportsTabFromId,
  panelDomId,
  tabDomId,
  tabForKey,
} from "./portfolioTabs";

/**
 * WHY THESE TESTS EXIST: both operations screens render their six sections through ONE tab list, and
 * the list is what the operator uses instead of scrolling. Four things are easy to break and
 * expensive in the browser:
 *   1. the ORDER of the sections is the screen's table of contents — it must not drift;
 *   2. every tab must wear a TONE from the closed set, or the strip renders a colourless tab that
 *      does not read as a tab at all (and a literal colour would break the dark theme);
 *   3. the DOM ids the aria wiring uses must be unique and distinct per tab, or `aria-controls`
 *      silently points at the wrong panel;
 *   4. the keyboard walk must wrap, must leave the selection alone on any other key, and must never
 *      return an id outside the list (a throw inside a keydown handler kills the tab strip).
 */

test("the eight sections are present, in the required order, with unique ids and non-empty labels", () => {
  // The order is the operator-facing table of contents: attention first, the register last.
  assert.deepEqual(PORTFOLIO_TAB_IDS, [
    "needs-push",
    "on-track",
    "on-track-not-measurable",
    // The schedule axis sits with the two hours sections it must not be confused with, and BEFORE the
    // register: a breached window is an answer; the whole register is a reference.
    "schedule-delays",
    "job-work",
    // The same data as "Job work", arranged as the hierarchy it belongs to. It follows the register
    // because that is the reading order, and it precedes the department view.
    "project-structure",
    "department-load",
    "exceptions",
  ]);
  assert.equal(PORTFOLIO_TABS.length, 8);
  for (const tab of PORTFOLIO_TABS) {
    assert.ok(tab.label.trim().length > 0, `tab ${tab.id} has no label`);
    assert.ok(tab.id.trim().length > 0, "every tab needs an id");
  }
  assert.equal(new Set(PORTFOLIO_TAB_IDS).size, PORTFOLIO_TAB_IDS.length, "ids must be unique");
  assert.equal(
    new Set(PORTFOLIO_TABS.map((tab) => tab.label)).size,
    PORTFOLIO_TABS.length,
    "labels must be unique — two identical tabs are indistinguishable"
  );
});

test("the screen opens on the primary answer, and that tab exists", () => {
  assert.equal(DEFAULT_TAB, "needs-push");
  assert.ok(isPortfolioTabId(DEFAULT_TAB));
});

test("a Project Manager opens on his projects, everyone else on the primary answer", () => {
  assert.equal(defaultTabFor("PROJECT_MANAGER"), "project-structure");
  assert.ok(isPortfolioTabId(defaultTabFor("PROJECT_MANAGER")), "the role's tab must exist in the strip");
  for (const role of ["PM", "ADMIN", "COO", "HOD", "DEPT_HEAD", "SUPERVISOR", "EMPLOYEE", null, undefined, "UNKNOWN"]) {
    assert.equal(defaultTabFor(role), DEFAULT_TAB, `${String(role)} keeps the default section`);
  }
});

test("isPortfolioTabId accepts exactly the six ids and rejects anything else", () => {
  for (const id of PORTFOLIO_TAB_IDS) assert.ok(isPortfolioTabId(id), `${id} should be a tab`);
  for (const junk of ["", "needs_push", "NEEDS-PUSH", "page", "needs push", null, undefined, 7, {}]) {
    assert.equal(isPortfolioTabId(junk), false, `${String(junk)} is not a tab`);
  }
});

test("every tab wears a tone from the closed set, so no tab can render colourless", () => {
  // The strip relies on the tone for BOTH its colour and its "these are tabs" affordance; a tab
  // added without one would render a grey label that looks like static text.
  for (const tab of PORTFOLIO_TABS) {
    assert.ok(
      (TAB_TONES as readonly string[]).includes(tab.tone),
      `tab ${tab.id} has tone "${tab.tone}", which is not one of ${TAB_TONES.join(", ")}`
    );
  }
  // The tones are semantic, so these pairings are the contract, not decoration.
  assert.deepEqual(
    PORTFOLIO_TABS.map((tab) => [tab.id, tab.tone]),
    [
      ["needs-push", "danger"],
      ["on-track", "success"],
      // A data gap is deliberately NOT green — the app paints NOT_MEASURABLE grey everywhere.
      ["on-track-not-measurable", "neutral"],
      // A breach is this section's whole purpose, so it wears the alert tone like Needs push: the two
      // are the only sections that name work going wrong today.
      ["schedule-delays", "danger"],
      ["job-work", "primary"],
      ["project-structure", "primary"],
      ["department-load", "warning"],
      ["exceptions", "danger"],
    ]
  );
  // The strip must not be a single colour: at least four distinct tones across the sections.
  assert.ok(new Set(PORTFOLIO_TABS.map((tab) => tab.tone)).size >= 4);
});

test("the REPORTS strip is the portfolio sections PLUS the two Reports-only reports", () => {
  // The dashboard renders PORTFOLIO_TABS (its own filters cannot produce a timesheet report, and its
  // query cannot produce delay insights), and Reports renders REPORTS_TABS. Pinning the difference stops
  // a Reports-only tab leaking onto the dashboard, where its dataset does not exist.
  assert.deepEqual(REPORTS_TAB_IDS, [...PORTFOLIO_TAB_IDS, "timesheet-coverage", "delay-insights"]);
  assert.equal(REPORTS_TAB_IDS.length, PORTFOLIO_TAB_IDS.length + 2);
  assert.equal(COVERAGE_TAB.label, "Timesheet coverage");
  assert.ok((TAB_TONES as readonly string[]).includes(COVERAGE_TAB.tone));
  assert.equal(DELAY_INSIGHTS_TAB.label, "Delay insights");
  assert.ok((TAB_TONES as readonly string[]).includes(DELAY_INSIGHTS_TAB.tone));
  for (const reportsOnly of ["timesheet-coverage", "delay-insights"]) {
    assert.equal(PORTFOLIO_TAB_IDS.includes(reportsOnly as never), false, `${reportsOnly} is not a portfolio section`);
    assert.ok(isReportsTabId(reportsOnly));
  }
  assert.ok(isReportsTabId("job-work"));
  assert.equal(isReportsTabId("page"), false);
});

test("EVERY tab in the Reports strip selects itself when clicked", () => {
  // The bug this pins: the strip rendered a "Delay insights" button, but the click handler enumerated
  // the ids it accepted (the portfolio sections, plus coverage) so the click was ignored and the tab
  // appeared to open nothing. Derived from the strip, the rule cannot fall behind it — and this loop
  // fails the suite for any FUTURE tab whose id the handler does not resolve.
  for (const id of REPORTS_TAB_IDS) {
    assert.equal(reportsTabFromId(id), id, `${id} renders a tab that does not select itself`);
  }
  assert.equal(reportsTabFromId("not-a-tab"), null);
  assert.equal(reportsTabFromId(undefined), null);
  assert.equal(reportsTabFromId(42), null);
});

test("the keyboard walk follows the STRIP IT IS GIVEN, so Reports reaches both extra reports and the dashboard neither", () => {
  // Reports: the two Reports-only tabs sit at the end, in strip order, and the walk wraps off the last
  // one back to the first section.
  assert.equal(tabForKey("exceptions", "ArrowRight", REPORTS_TAB_IDS), "timesheet-coverage");
  assert.equal(tabForKey("timesheet-coverage", "ArrowRight", REPORTS_TAB_IDS), "delay-insights");
  assert.equal(tabForKey("delay-insights", "ArrowRight", REPORTS_TAB_IDS), "needs-push");
  assert.equal(tabForKey("needs-push", "ArrowLeft", REPORTS_TAB_IDS), "delay-insights");
  assert.equal(tabForKey("job-work", "End", REPORTS_TAB_IDS), "delay-insights");
  // The dashboard walk must NOT land on either Reports-only tab, which it does not render.
  for (const current of PORTFOLIO_TAB_IDS) {
    const next = tabForKey(current, "ArrowRight", PORTFOLIO_TAB_IDS);
    assert.notEqual(next, "timesheet-coverage");
    assert.notEqual(next, "delay-insights");
    assert.ok(PORTFOLIO_TAB_IDS.includes(next));
  }
});

test("arrow keys move one tab along and wrap at both ends", () => {
  assert.equal(tabForKey("needs-push", "ArrowRight"), "on-track");
  assert.equal(tabForKey("on-track", "ArrowRight"), "on-track-not-measurable");
  // Wrapping forward from the last tab returns to the first: the list is reachable with one key.
  assert.equal(tabForKey("exceptions", "ArrowRight"), "needs-push");
  // And wrapping backwards from the first returns to the last.
  assert.equal(tabForKey("needs-push", "ArrowLeft"), "exceptions");
  assert.equal(tabForKey("exceptions", "ArrowLeft"), "department-load");
});

test("ArrowDown/ArrowUp are the same walk as ArrowRight/ArrowLeft", () => {
  for (const current of PORTFOLIO_TAB_IDS) {
    assert.equal(tabForKey(current, "ArrowDown"), tabForKey(current, "ArrowRight"), `down from ${current}`);
    assert.equal(tabForKey(current, "ArrowUp"), tabForKey(current, "ArrowLeft"), `up from ${current}`);
  }
});

test("Home and End jump to the first and last section", () => {
  assert.equal(tabForKey("job-work", "Home"), "needs-push");
  assert.equal(tabForKey("needs-push", "End"), "exceptions");
});

test("any other key leaves the selection where it is", () => {
  // Tab must move FOCUS, not selection; Enter/Space and shortcuts must not move the reader off the
  // section they are reading.
  for (const key of ["Tab", "Enter", " ", "a", "Escape", "PageDown"]) {
    assert.equal(tabForKey("job-work", key), "job-work", `key ${key} must not change the tab`);
  }
});

test("a stale current tab has no neighbours to walk from and falls back to the default", () => {
  const stale = "not-a-tab" as unknown as Parameters<typeof tabForKey>[0];
  assert.equal(tabForKey(stale, "ArrowRight"), DEFAULT_TAB);
  assert.equal(tabForKey(stale, "ArrowLeft"), DEFAULT_TAB);
});

test("every tab's DOM ids are unique, and the tab id never equals the panel id it controls", () => {
  const tabIds = PORTFOLIO_TAB_IDS.map(tabDomId);
  const panelIds = PORTFOLIO_TAB_IDS.map(panelDomId);
  assert.equal(new Set([...tabIds, ...panelIds]).size, tabIds.length + panelIds.length);
  // The pairing is stable: the tab labelled `x` controls the panel named `pf-panel-x`.
  for (const id of PORTFOLIO_TAB_IDS) {
    assert.equal(tabDomId(id), `pf-tab-${id}`);
    assert.equal(panelDomId(id), `pf-panel-${id}`);
  }
});
