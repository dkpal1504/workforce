/**
 * The section tabs both operations screens are built from.
 *
 * WHY TABS: the report is six sections long and the Job work register alone runs to hundreds of
 * rows, so reading the screen top-to-bottom meant scrolling past five sections to reach the one an
 * operator came for. A tab shows ONE section at a time, so the section is found by name rather
 * than by scrolling — and the tabs carry each section's row count, so the operator can see how
 * much is in a section before opening it.
 *
 * WHY THIS IS A MODULE AND NOT A MAP INSIDE THE COMPONENT: the tab list is the screen's table of
 * contents, and both screens (/portfolio and /reports) plus their keyboard handling have to agree
 * on it exactly — the order, the labels and the DOM ids the `aria-controls` wiring uses. Two
 * definitions would drift into a tab that selects a panel which is not rendered. The tests pin the
 * order, the ids and the keyboard walk.
 *
 * THE TAB IS NOT IN THE URL, deliberately. It is a VIEW of the same report: the query string is
 * the one contract shared by the JSON fetch, the filter round-trip and both downloads, and a
 * display choice has no business in it (the same rule paging follows — see `portfolioFilters`, whose
 * round-trip tests pin that a hand-edited `page`/`offset` never survives re-encoding).
 */

/**
 * The colour a tab wears. Every tone is a THEME TOKEN PAIR (`--x-soft` surface + `--x-ink` text),
 * never a literal, so the strip follows all five themes including the dark one — a hardcoded palette
 * would produce dark-on-dark tab labels in nocturne. The set is closed and tested so a new tab
 * cannot be added without deciding its colour.
 */
export const TAB_TONES = ["danger", "success", "warning", "primary", "neutral"] as const;
export type PortfolioTabTone = (typeof TAB_TONES)[number];

/** The shape every tab shares, so a screen can extend the strip with its own report. */
export type ReportTab = { id: string; label: string; tone: PortfolioTabTone };

/**
 * The sections, in screen order, each with the tone it wears.
 *
 * THE TONE IS SEMANTIC, matching the colour the app already uses for the same idea: a section of
 * "what is on fire" is danger-red, healthy measured work is green, a data gap is deliberately GREY
 * (the app paints NOT_MEASURABLE grey everywhere, so it must not borrow the green), the structural
 * register is the primary hue, load is amber, and the flagged buckets are red again. It is also what
 * makes the strip read as TABS rather than as six plain labels: the coloured underline and the
 * tinted count pill are visible whether or not a tab is selected.
 */
export const PORTFOLIO_TABS = [
  { id: "needs-push", label: "Needs push", tone: "danger" },
  { id: "on-track", label: "On track", tone: "success" },
  { id: "on-track-not-measurable", label: "On track — not yet measurable", tone: "neutral" },
  // The schedule axis, beside the hours sections rather than inside them: "on track" is a claim about
  // HOURS, and a Job Order can be GREEN on burn and past its planned end. That pair is the most
  // dangerous row in the portfolio, so it gets a tab of its own instead of silently redefining one.
  { id: "schedule-delays", label: "Schedule & delays", tone: "danger" },
  { id: "job-work", label: "Job work", tone: "primary" },
  { id: "department-load", label: "Department load", tone: "warning" },
  { id: "exceptions", label: "Exceptions & readiness", tone: "danger" },
] as const satisfies readonly { id: string; label: string; tone: PortfolioTabTone }[];

export type PortfolioTabId = (typeof PORTFOLIO_TABS)[number]["id"];

/** The tab ids in screen order — the walk order for keyboard selection. */
export const PORTFOLIO_TAB_IDS: readonly PortfolioTabId[] = PORTFOLIO_TABS.map((tab) => tab.id);

/**
 * The ONE tab that is not a portfolio section: the timesheet-coverage report.
 *
 * WHY IT IS NOT IN `PORTFOLIO_TABS`: that list IS the portfolio report's table of contents, and both
 * its screens render it. This report reads an entirely different dataset (timesheets, not job
 * orders) and belongs on Reports only, so adding it to the shared list would put a tab on the
 * dashboard that its own filters cannot produce. Reports composes the two lists instead — see
 * `REPORTS_TABS`.
 */
export const COVERAGE_TAB = { id: "timesheet-coverage", label: "Timesheet coverage", tone: "primary" } as const;

/** The tab strip the REPORTS screen renders: the six portfolio sections, plus coverage. */
export const REPORTS_TABS = [...PORTFOLIO_TABS, COVERAGE_TAB] as const;
export type ReportsTabId = (typeof REPORTS_TABS)[number]["id"];
export const REPORTS_TAB_IDS: readonly ReportsTabId[] = REPORTS_TABS.map((tab) => tab.id);

/** The section the screen opens on: the primary answer ("what needs a push"). */
export const DEFAULT_TAB: PortfolioTabId = "needs-push";

/** Is this string one of the tabs? Guards a value that came from outside (a stale bundle, a link). */
export function isPortfolioTabId(value: unknown): value is PortfolioTabId {
  return typeof value === "string" && (PORTFOLIO_TAB_IDS as readonly string[]).includes(value);
}

/** Is this string a tab of the REPORTS strip (the six, plus coverage)? */
export function isReportsTabId(value: unknown): value is ReportsTabId {
  return typeof value === "string" && (REPORTS_TAB_IDS as readonly string[]).includes(value);
}

/**
 * The tab a keypress selects, per the WAI-ARIA tabs pattern, walking the list it is GIVEN.
 *
 * The list is a parameter rather than a constant because the two screens carry different strips
 * (Reports adds coverage). Walking the wrong list would land the keyboard on a tab that screen does
 * not render — which is why the walk and the rendering must be driven by the same array.
 *
 * ArrowRight/ArrowDown and ArrowLeft/ArrowUp move one tab along and WRAP at the ends (that is the
 * pattern's behaviour, and wrapping is what makes the tab list reachable in both directions with
 * one key). Home/End jump to the first/last tab. Any other key leaves the selection alone, so
 * typing Tab, Enter or a shortcut never moves the operator off the section they are reading.
 *
 * Pure and total: it never throws and never returns an id outside the list.
 */
export function tabForKey<T extends string>(
  current: T,
  key: string,
  ids: readonly T[] = PORTFOLIO_TAB_IDS as readonly T[]
): T {
  const count = ids.length;
  const index = ids.indexOf(current);
  // A current id that is not in the list (a stale selection) has no neighbours to walk from; the
  // honest answer is the strip's own default rather than a throw in a keydown handler.
  if (index === -1) return (ids.includes(DEFAULT_TAB as T) ? DEFAULT_TAB : ids[0]) as T;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return ids[(index + 1) % count];
    case "ArrowLeft":
    case "ArrowUp":
      return ids[(index - 1 + count) % count];
    case "Home":
      return ids[0];
    case "End":
      return ids[count - 1];
    default:
      return current;
  }
}

/** The DOM id of a tab button, and of the panel it controls. Built in ONE place so `aria-controls`
 *  can never point at a panel that does not exist. */
export function tabDomId(id: string): string {
  return `pf-tab-${id}`;
}

export function panelDomId(id: string): string {
  return `pf-panel-${id}`;
}
