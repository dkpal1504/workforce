import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EscalatableNodeRow, EscalatableRow } from "../components/EscalateToOwner";
import { api, getToken } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { burnSummary, healthSummary } from "./portfolioHero";
import { MultiSelectFilter } from "./MultiSelectFilter";
import {
  BANDS,
  DEFAULT_ACTIVITY_DAYS,
  decodeFilters,
  defaultFilters,
  portfolioQuery,
  type Band,
  type PortfolioBudget,
  type PortfolioFilterState,
  type PortfolioStatus,
} from "./portfolioFilters";
import { formatDay, formatStamp } from "./formatDate";
// The tested, pure pagination rules — reused verbatim, never reimplemented here.
import { paginate, pageNumbers, type PageSlice } from "./portfolioPaging";
// The section tabs (order, labels, keyboard walk) — ONE definition shared by both screens.
import {
  DEFAULT_TAB,
  PORTFOLIO_TABS,
  defaultTabFor,
  isPortfolioTabId,
  panelDomId,
  tabDomId,
  tabForKey,
  type PortfolioTabId,
  type ReportTab,
} from "./portfolioTabs";
// The pure `% Qty` formatting rule (see the module header for why it is exported, not inline).
import { fmtQtyCompletePct, qtyCompleteNote } from "./portfolioQty";
import "../styles/portfolio.css";

/* ============================================================================
   Portfolio & Job-Work Operations Dashboard — the JSON screen for /portfolio,
   plus the SHARED pieces (types, filter bar, fetch hook, band badge, formatting)
   that the /reports screen imports. Keeping the shared view code in one module
   is what lets the two screens carry the IDENTICAL query string: both call
   `portfolioQuery(state)` and nothing else builds a URL.

   The API is already built and tested (apps/api/src/routes/reports.ts). This file
   reimplements none of the banding, scoring or filtering rules — it renders what
   the API returns and prints the rules back to the operator from `definitions`.
   ============================================================================ */

/* --------------------------------------------------------------------------- *
 * The response shape (mirrors services/portfolioReport.ts — read, not rewritten)
 * ------------------------------------------------------------------------- */

export type PortfolioBand = Band;

export type PortfolioJobRow = {
  id: number;
  code: string;
  name: string;
  displayName: string;
  project: { id: number; code: string; name: string };
  wbs: { id: number; wbsCode: string; name: string };
  department: { id: number; name: string };
  section: { id: number; name: string } | null;
  status: string;
  uom: string | null;
  budgetHours: number;
  actualHours: number;
  burnPct: number | null;
  hoursBand: PortfolioBand;
  hoursPerDay: number | null;
  /**
   * The OPTIONAL planned window, as `YYYY-MM-DD` days, or null for continual / standing work.
   * Rendered through `PlannedWindowCell`, which says "Not scheduled" rather than a dash: a Job Order
   * with no plan is never counted as on time.
   */
  plannedStartDate: string | null;
  plannedEndDate: string | null;
  forecastExhaustedOn: string | null;
  targetQty: number;
  achievedQty: number;
  qtyPct: number | null;
  /**
   * Quantity completion as a FRACTION, ALWAYS finite (the API never sends NaN/Infinity/null).
   * This is the `% Qty` figure; it is ADDITIVE to `qtyPct`, which keeps its "null = not
   * measurable" reporting meaning. Rendered through `fmtQtyCompletePct`.
   */
  qtyCompletePct: number;
  qtyBand: PortfolioBand;
  /**
   * The SCHEDULE axis, judged separately from the hours band (see the API's `jobOrderSchedule`).
   * `NOT_SCHEDULED` means there is no planned window at all — continual work — and it is never
   * rendered as "on time".
   */
  scheduleBand: PortfolioScheduleBand;
  daysToEnd: number | null;
  planElapsedPct: number | null;
  scheduleGapPct: number | null;
  requiredRate: number | null;
  actualRate: number | null;
  projectedFinish: string | null;
  projectedSlipDays: number | null;
  balanceQty: number;
  lastBooking: string | null;
  daysSinceActivity: number | null;
  unapprovedHours: number;
  oldestUnapprovedAt: string | null;
  measurableOnHours: boolean;
  measurableOnQuantity: boolean;
  attentionScore: number;
  reasons: string[];
};

type RollUpCounts = {
  budgetHours: number;
  actualHours: number;
  burnPct: number | null;
  hoursBand: PortfolioBand;
  burnBand: PortfolioBand;
  jobOrderCount: number;
  redCount: number;
  amberCount: number;
  greenCount: number;
  notMeasurableCount: number;
  attentionScore: number;
  lastBooking: string | null;
};

export type ProjectRollUp = RollUpCounts & { project: { id: number; code: string; name: string } };
export type DepartmentRollUp = RollUpCounts & {
  department: { id: number; name: string };
  sectionCount: number;
};

/**
 * The Project → WBS → Network register (see `services/projectStructure.ts` on the API).
 *
 * `jobOrderCount` is what the READER can see; `jobOrderCountAll` is the master count. Both are
 * printed, because "0 of 6 in your scope" and "an empty WBS element" are different facts and only
 * the pair of numbers tells them apart.
 */
export type StructureNode = {
  id: number;
  code: string;
  name: string | null;
  active: boolean;
  jobOrderCount: number;
  jobOrderCountAll: number;
  budgetHours: number;
  actualHours: number;
  burnPct: number | null;
  hoursBand: PortfolioBand;
  scheduleBand: PortfolioScheduleBand;
  qtyCompletePct: number | null;
  qtyBand: PortfolioBand;
  noActivity: number;
  unapprovedHours: number;
  jobOrderIds: number[];
};

export type StructureWbsNode = StructureNode & { networks: StructureNode[] };

export type ProjectStructureRow = {
  project: { id: number; code: string; name: string; active: boolean };
  totals: StructureNode;
  wbs: StructureWbsNode[];
};

export type ExceptionBucket = { count: number; rows: PortfolioJobRow[] };

export type PortfolioPulse = {
  projects: number;
  jobOrders: number;
  budgetHours: number;
  actualHours: number;
  portfolioBurnPct: number | null;
  bands: Record<PortfolioBand, number>;
  /** Schedule coverage and bands: `notScheduled` is what stops an undated portfolio reading as punctual. */
  schedule: {
    scheduled: number;
    notScheduled: number;
    onPlan: number;
    dueSoon: number;
    atRisk: number;
    delayed: number;
  };
  noActivity: number;
  hoursAwaitingApproval: number;
  oldestUnapprovedAt: string | null;
};

export type PortfolioDefinitions = {
  bands: Record<PortfolioBand, { min: number | null; max: number | null; label: string }>;
  attentionWeights: {
    hoursRed: number;
    hoursAmber: number;
    noActivity7d: number;
    unapprovedAging3d: number;
    quantityBehind: number;
    noBudget: number;
  };
  measurable: { onHours: string; onQuantity: string };
  activityWindowDaysNote: string;
  /** The schedule rules as printed data: the bands, the thresholds and the coverage statement. */
  schedule: {
    bands: Record<PortfolioScheduleBand, { label: string }>;
    weights: { delayedNotComplete: number; atRisk: number; dueSoon: number };
    rules: { atRiskProjectedSlipDays: number; dueSoonDays: number };
    coverageNote: string;
  };
  notes: string[];
};

export type PortfolioReport = {
  generatedAt: string;
  asOf: string;
  provenance: {
    filters: Array<{ label: string; value: string }>;
    filtersHash: string;
    generatedBy: { id: number; name: string; role: string };
  };
  definitions: PortfolioDefinitions;
  pulse: PortfolioPulse;
  projectRollUps: ProjectRollUp[];
  /** The hierarchy register. Every number in it comes from the same scoped facts as the sections. */
  projectStructure: ProjectStructureRow[];
  needsPush: PortfolioJobRow[];
  needsPushTotal: number;
  onTrack: PortfolioJobRow[];
  onTrackNotMeasurable: PortfolioJobRow[];
  /** The schedule section: breached or about-to-be-breached windows, worst first. */
  scheduleDelays: PortfolioJobRow[];
  jobWork: PortfolioJobRow[];
  departmentLoad: DepartmentRollUp[];
  exceptions: {
    noBudgetHours: ExceptionBucket;
    budgetWithNoBookings: ExceptionBucket;
    noProgress: ExceptionBucket;
    unapproved: ExceptionBucket;
    endDatePassed: ExceptionBucket;
    scheduledNoProgress: ExceptionBucket;
    scheduleIncomplete: ExceptionBucket;
  };
};

export type ProjectOption = { id: number; code: string; name: string };
export type WbsOption = { id: number; projectId: number; wbsCode: string; name: string | null };
export type DepartmentOption = { id: number; name: string };
export type SectionOption = { id: number; departmentId: number; code: string; name: string };

/* --------------------------------------------------------------------------- *
 * Formatting (plain helpers — no chart library exists in this app and none may be added)
 * --------------------------------------------------------------------------- */

export function fmtHours(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${Math.round(value).toLocaleString()} h`;
}

/** A fraction (0.87) as a whole-percent string, or "—" when there is no denominator. */
export function fmtPct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${Math.round(value * 100)}%`;
}

export function fmtNumber(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toLocaleString(undefined, { maximumFractionDigits: digits });
}

/** A `YYYY-MM-DD` wire date rendered as a local day, or "—". Never invents a date. */
/**
 * A day, printed `dd-mm-yyyy` by the ONE formatter that defines the format (`formatDate.ts`).
 *
 * Kept as a named export here because both screens and the coverage panel import it from this module;
 * the format itself lives in one place so the screen, the workbook and the print cannot disagree.
 */
export function fmtDate(value: string | null | undefined): string {
  return formatDay(value);
}

export function fmtDateTime(value: string | null | undefined): string {
  // dd-mm-yyyy HH:mm, from the ONE instant formatter — `toLocaleString()` reordered the date per
  // machine, which is the defect this app already removed everywhere else.
  return formatStamp(value);
}

export const BAND_LABELS: Record<PortfolioBand, string> = {
  RED: "RED",
  AMBER: "AMBER",
  GREEN: "GREEN",
  NOT_MEASURABLE: "Not measurable",
};

/* --------------------------------------------------------------------------- *
 * Shared components
 * --------------------------------------------------------------------------- */

/** The RAG badge — one badge class per band, using the app's own soft colours. */
export function BandBadge({ band }: { band: PortfolioBand }) {
  return <span className={`pf-badge pf-badge--${band}`}>{BAND_LABELS[band]}</span>;
}

/** The schedule bands, in the operator's words. The label IS the value, so it is not abbreviated. */
export type PortfolioScheduleBand = "DELAYED" | "AT_RISK" | "DUE_SOON" | "ON_PLAN" | "NOT_SCHEDULED";

export const SCHEDULE_LABELS: Record<PortfolioScheduleBand, string> = {
  DELAYED: "Delayed",
  AT_RISK: "At risk",
  DUE_SOON: "Due soon",
  ON_PLAN: "On plan",
  NOT_SCHEDULED: "Not scheduled",
};

/**
 * The schedule judgement as a chip, reusing the bands' own tones: a breach is RED, a projection
 * running beyond the plan is AMBER, an unplanned row is the same grey the app paints NOT_MEASURABLE.
 * Grey is the point — a Job Order with no window is NOT on time, it is simply not planned.
 */
export function ScheduleBadge({ band }: { band: PortfolioScheduleBand }) {
  const tone = band === "DELAYED" ? "RED" : band === "AT_RISK" || band === "DUE_SOON" ? "AMBER" : band === "ON_PLAN" ? "GREEN" : "NOT_MEASURABLE";
  return <span className={`pf-badge pf-badge--${tone}`} title={SCHEDULE_LABELS[band]}>{SCHEDULE_LABELS[band]}</span>;
}

/** The days a window has left, or how late it is: one number, never a bare date to subtract by eye. */
export function scheduleDaysText(row: { daysToEnd: number | null; projectedSlipDays: number | null }): string {
  if (row.daysToEnd !== null) {
    if (row.daysToEnd < 0) return `${Math.abs(row.daysToEnd)} d late`;
    if (row.daysToEnd === 0) return "due today";
    return `${row.daysToEnd} d left`;
  }
  if (row.projectedSlipDays !== null && row.projectedSlipDays > 0) return `${row.projectedSlipDays} d beyond plan`;
  return "—";
}

/**
 * The `% Qty` cell: the API's `qtyCompletePct` (a fraction) as a one-decimal percentage.
 *
 * Uses the pure `fmtQtyCompletePct`, whose guard is why a stale bundle or an old cached
 * payload shows "0.0%" rather than the literal "NaN%" (see portfolioQty.ts). A short
 * `qtyCompleteNote` is appended INLINE (never a wider column) so a 0.0% from "nothing done yet"
 * and a 0.0% from "no quantity budget" are told apart; a positive target's zero gets no note
 * because its non-zero QTY BDG already says which case it is.
 */
export function PctQtyCell({ row }: { row: PortfolioJobRow }) {
  const note = qtyCompleteNote(row.targetQty);
  return (
    <td className="pf-num">
      {fmtQtyCompletePct(row.qtyCompletePct)}
      {note ? <span className="pf-cell-sub">{note}</span> : null}
    </td>
  );
}

/**
 * A table pager for the two long tables on the operations screens.
 *
 * WHY IT IS NEVER A DEAD PAGER: it renders NOTHING unless the table spans more than one
 * page (pageCount > 1), so a single-page table — including the empty one — carries no
 * controls at all. The numbered buttons come straight from the tested `pageNumbers` helper.
 *
 * WHY CLICKING SCROLLS THE TABLE INTO VIEW: the pager sits BELOW its table, so changing the
 * page would otherwise leave the reader looking at the pager while the rows changed above the
 * fold. The `anchorRef` is the scroll target (`scroll-margin-top` keeps it clear of a sticky
 * header).
 *
 * FILTER-CHANGE RESET lives in the CALLER: both pages reset to page 1 whenever the filter set
 * changes (see the `useEffect` in each page), because a page index that is valid for one result
 * set is meaningless for another.
 */
export function TablePager({
  page,
  pageCount,
  total,
  from,
  to,
  hasPrev,
  hasNext,
  onChange,
  anchorRef,
  label = "job orders",
}: {
  page: number;
  pageCount: number;
  total: number;
  from: number;
  to: number;
  hasPrev: boolean;
  hasNext: boolean;
  onChange: (page: number) => void;
  anchorRef: React.RefObject<HTMLElement>;
  label?: string;
}) {
  // A single-page table must not carry a dead pager.
  if (pageCount <= 1) return null;
  const go = (next: number) => {
    onChange(next);
    // Keep the reader with the rows: bring the table back into view after the page swaps.
    anchorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  return (
    <div className="pf-pager">
      <span className="pf-pager__info">
        Showing {from}-{to} of {total} {label}
      </span>
      <div className="pf-pager__controls">
        <button type="button" className="btn btn-ghost btn-sm" disabled={!hasPrev} onClick={() => go(page - 1)}>
          Previous
        </button>
        {pageNumbers(page, pageCount).map((number) => (
          <button
            key={number}
            type="button"
            className={`btn btn-sm ${number === page ? "btn-primary" : "btn-ghost"}`}
            aria-current={number === page ? "page" : undefined}
            onClick={() => go(number)}
          >
            {number}
          </button>
        ))}
        <button type="button" className="btn btn-ghost btn-sm" disabled={!hasNext} onClick={() => go(page + 1)}>
          Next
        </button>
      </div>
    </div>
  );
}

/**
 * One table's page state, kept in ONE place because every section needs the identical three parts:
 * the clamped slice, a setter for the pager, and the scroll target the pager pulls into view.
 *
 * WHY THE RESET IS IN HERE AND NOT IN EACH SECTION: a page index is only meaningful for the result
 * set it was chosen against, so changing the filters must send the reader back to page 1. Keying
 * that on the canonical filter string (the same one the fetch and the downloads use) means one
 * `useEffect` covers every table instead of six copies of the same effect drifting apart.
 */
export function useTablePager<T>(rows: readonly T[], resetKey: string) {
  const [page, setPage] = useState(1);
  useEffect(() => {
    setPage(1);
  }, [resetKey]);
  const slice = useMemo(() => paginate(rows, page), [rows, page]);
  const anchorRef = useRef<HTMLDivElement>(null);
  return { slice, setPage, anchorRef };
}

/**
 * The pager for a slice from `useTablePager` — thin on purpose, so a section never has to restate
 * eleven props and get one wrong (a `from` and `to` crossed over renders "Showing 50-1 of 416").
 */
export function SlicePager({
  slice,
  setPage,
  anchorRef,
  label,
}: {
  slice: PageSlice<unknown>;
  setPage: (page: number) => void;
  anchorRef: React.RefObject<HTMLDivElement>;
  label?: string;
}) {
  return (
    <TablePager
      page={slice.page}
      pageCount={slice.pageCount}
      total={slice.total}
      from={slice.from}
      to={slice.to}
      hasPrev={slice.hasPrev}
      hasNext={slice.hasNext}
      onChange={setPage}
      anchorRef={anchorRef}
      label={label}
    />
  );
}

/**
 * The section tabs — the screen's table of contents, rendered ONCE for both operations screens.
 *
 * WHY IT REPLACES A LONG SCROLL: the report is six sections long and the Job work register alone
 * holds hundreds of rows, so the section an operator came for was reachable only by scrolling past
 * the five that come before it. One section at a time makes every section one click away, and the
 * tab carries its section's row count so the size of a section is visible BEFORE opening it.
 *
 * WHY THE COUNTS ARE PASSED IN: the tabs must state what the screen actually holds. The counts come
 * from the SAME response the sections render, so a badge can never disagree with the table behind
 * it — and a tab whose section is empty shows 0 rather than nothing.
 *
 * KEYBOARD: the WAI-ARIA tabs pattern — arrows walk the list (wrapping), Home/End jump to the ends,
 * and only the selected tab is in the tab order (`tabIndex -1` on the rest), so Tab moves past the
 * strip rather than through six buttons. The walk itself is the tested pure `tabForKey`.
 */
export function ReportTabs({
  active,
  counts,
  onChange,
  tabs = PORTFOLIO_TABS,
}: {
  active: string;
  counts: Partial<Record<string, number>>;
  onChange: (tab: string) => void;
  /** The strip to render. Defaults to the portfolio sections; Reports passes a longer list. */
  tabs?: readonly ReportTab[];
}) {
  const buttons = useRef<Record<string, HTMLButtonElement | null>>({});
  const ids = tabs.map((tab) => tab.id);

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const next = tabForKey(active, event.key, ids);
    // Only a key that actually moves the selection is claimed: every other key (Tab, Enter, a
    // shortcut) must keep its normal behaviour.
    if (next === active) return;
    event.preventDefault();
    onChange(next);
    buttons.current[next]?.focus();
  }

  return (
    <div className="pf-tabs" role="tablist" aria-label="Report sections" onKeyDown={onKeyDown}>
      {tabs.map((tab) => {
        const selected = tab.id === active;
        const count = counts[tab.id];
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={tabDomId(tab.id)}
            aria-selected={selected}
            aria-controls={panelDomId(tab.id)}
            tabIndex={selected ? 0 : -1}
            ref={(element) => {
              buttons.current[tab.id] = element;
            }}
            className={`pf-tab pf-tab--${tab.tone}${selected ? " pf-tab--on" : ""}`}
            onClick={() => onChange(tab.id)}
          >
            <span className="pf-tab__label">{tab.label}</span>
            {count === undefined ? null : <span className="pf-tab__count">{count.toLocaleString()}</span>}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The attention REASONS, rendered IN FULL.
 *
 * An operator must be able to read WHY a row is on the push list, so this is a list (not
 * a truncated tooltip) and the weights behind each point are printed in the panel footer
 * from the API's own `definitions`. A row with no reasons reads "—", which is honest.
 */
export function ReasonsCell({ reasons }: { reasons: string[] }) {
  if (!reasons.length) return <span className="muted">—</span>;
  return (
    <ul className="pf-reasons">
      {reasons.map((reason, index) => (
        <li key={`${reason}-${index}`}>{reason}</li>
      ))}
    </ul>
  );
}

/**
 * The planned window of a Job Order — ONE definition for the dashboard and the Reports screen.
 *
 * Both days when they are known; "Not scheduled" when the work is continual / standing, which the
 * report NEVER counts as on time; a labelled one-sided window when only one day is known (a start with
 * no end is open-ended, an end with no start is a deadline). A blank is never rendered as a dash that
 * could be mistaken for a date.
 */
export function PlannedWindowCell({ start, end }: { start: string | null; end: string | null }) {
  // Through the shared formatter, so a window reads in the same `dd-mm-yyyy` as every other date column.
  const from = formatDay(start);
  const to = formatDay(end);
  if (!start && !end) return <td><span className="pf-cell-sub">Not scheduled</span></td>;
  if (start && !end) return <td><span className="pf-cell-sub">{from} → open-ended</span></td>;
  if (!start && end) return <td><span className="pf-cell-sub">deadline → {to}</span></td>;
  return <td><span className="pf-cell-sub">{from} → {to}</span></td>;
}

/**
 * The job-order identity cell: project / WBS / code-name / department, stacked.
 *
 * The description is CAPPED at 75 characters and wraps onto further lines (`.pf-cell-cap`).
 * Uncapped, the auto layout hands this column as much width as its longest description wants,
 * which pushes band, quantities, forecast, attention and reasons off to the right of the table.
 * The cap sits on a BLOCK inside the cell because `max-width` on a table cell is only a
 * suggestion to the auto layout, while a block-level child's width is genuinely respected.
 */
export function JobIdentityCell({ row, showProject = true }: { row: PortfolioJobRow; showProject?: boolean }) {
  return (
    <td>
      <div className="pf-cell-cap">
        <span className="pf-cell-strong">{row.displayName || `${row.code}-${row.name}`}</span>
        <span className="pf-cell-sub">
          {showProject ? `${row.project.code} · ${row.project.name} · ` : ""}
          WBS {row.wbs.wbsCode}
        </span>
      </div>
    </td>
  );
}

/** The shared card head: a title on the left, an optional muted note on the right. */
export function CardLabel({ children, note }: { children: React.ReactNode; note?: React.ReactNode }) {
  return (
    <div className="pf-hero__lab">
      {children}
      {note ? <span className="pf-hero__lab-note">{note}</span> : null}
    </div>
  );
}

/**
 * The panel wrapper. Every table lives in one of these with its own empty state, so a
 * blank table is never mistaken for "no problems found".
 */
export function Panel({
  title,
  count,
  hint,
  children,
}: {
  title: string;
  count?: React.ReactNode;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="panel pf-panel">
      <div className="panel__header">
        <span>{title}</span>
        {count !== undefined ? <span className="panel__count">{count}</span> : null}
      </div>
      {hint ? <p className="pf-panel__hint" style={{ padding: "10px 14px 0", margin: 0 }}>{hint}</p> : null}
      {children}
    </section>
  );
}

/* --------------------------------------------------------------------------- *
 * The fetch hook — BOTH screens use it, so both issue the SAME request
 * --------------------------------------------------------------------------- */

export function usePortfolioReport(filters: PortfolioFilterState) {
  const [report, setReport] = useState<PortfolioReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // The query string is built by the pure helper and is byte-identical to the one the
  // download links carry (see portfolioFilters.test.ts).
  const query = useMemo(() => portfolioQuery(filters), [filters]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await api<PortfolioReport>(`/reports/portfolio${query}`);
      // NORMALISE THE ENVELOPE, once, here.
      //
      // A section the server did not send used to throw from `report.<section>.length` DURING
      // render, which unmounts the whole screen and leaves a blank page. That is a real state: an
      // older API process (this repo's `tsx watch` does not reload on /mnt/c) or a cached bundle
      // can answer without newer fields. Defaulting additive sections to `[]` means the screen
      // renders with that section empty — honest about what it received — instead of dying.
      setReport({ ...data, projectStructure: data.projectStructure ?? [] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load the portfolio report.");
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);

  return { report, loading, error, query, reload: load };
}

/**
 * Download a report file with the SAME query string as the on-screen JSON.
 *
 * The route is auth-gated, so the token is attached and the response is read as a blob
 * (the house pattern from CsvUploadPage). The filename comes from the server's
 * Content-Disposition, so the as-of date and the filters hash the API stamped reach the
 * disk unchanged; it falls back to a local name only if that header is absent.
 */
export async function downloadPortfolioFile(
  format: "xlsx" | "pdf",
  query: string
): Promise<{ filename: string }> {
  const token = getToken();
  const res = await fetch(`/api/reports/portfolio.${format}${query}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    let message = `Download failed (${res.status}).`;
    try {
      const body = await res.json();
      if (body && typeof body.error === "string") message = body.error;
    } catch {
      /* not JSON; keep the status message */
    }
    throw new Error(message);
  }
  const disposition = res.headers.get("Content-Disposition") || "";
  const match = /filename="?([^";]+)"?/i.exec(disposition);
  const filename = match ? match[1] : `portfolio-report.${format}`;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
  return { filename };
}

/* --------------------------------------------------------------------------- *
 * The ONE filter bar, shared by /portfolio and /reports
 * --------------------------------------------------------------------------- */

export function PortfolioFilterBar({
  filters,
  onChange,
  projects,
  wbs,
  departments,
  sections,
  onReset,
  extra,
}: {
  filters: PortfolioFilterState;
  onChange: (next: PortfolioFilterState) => void;
  projects: ProjectOption[];
  wbs: WbsOption[];
  departments: DepartmentOption[];
  sections: SectionOption[];
  onReset: () => void;
  /** Screen-specific controls (e.g. the two download buttons) appended to the bar. */
  extra?: React.ReactNode;
}) {
  // WBS options are scoped to the chosen projects: a WBS code is unique only inside its
  // project, so offering one from an unselected project would let the operator build a
  // filter that matches nothing.
  const scopedWbs = filters.projectIds.length
    ? wbs.filter((row) => filters.projectIds.includes(row.projectId))
    : wbs;
  const scopedSections = filters.departmentIds.length
    ? sections.filter((row) => filters.departmentIds.includes(row.departmentId))
    : sections;

  return (
    <div className="pf-filters">
      {/* ONE ROW on a desktop. Every dimension is the same compact checkbox-dropdown control, so a
          dimension with 86 options costs exactly as much space as one with 3 — which is what lets
          nine controls share a single line. Two changes made that true:
            (a) the controls are COMPACT (smaller type and padding — see .pf-filters in
                portfolio.css), and
            (b) NO inline min-width is passed here any more. The columns come from the grid, and an
                inline min-width on a grid item does not widen its track — it overflows it, which
                left controls overlapping their neighbours rather than fitting. The grid is the one
                lever for the row. */}
      <MultiSelectFilter
        label="Projects"
        allLabel="All projects"
        options={projects.map((project) => ({ id: project.id, label: project.code, detail: project.name }))}
        selected={filters.projectIds}
        // Choosing a project re-scopes the WBS list, so a WBS that no longer belongs is dropped here
        // rather than left to build a filter that matches nothing.
        onChange={(next) => onChange({ ...filters, projectIds: next.map(Number), wbsIds: [] })}
      />

      <MultiSelectFilter
        label="WBS"
        allLabel="All WBS"
        options={scopedWbs.map((row) => ({
          id: row.id,
          label: row.wbsCode,
          detail: [projects.find((p) => p.id === row.projectId)?.code, row.name].filter(Boolean).join(" · "),
        }))}
        selected={filters.wbsIds}
        onChange={(next) => onChange({ ...filters, wbsIds: next.map(Number) })}
        searchPlaceholder="Search WBS code…"
      />

      <MultiSelectFilter
        label="Department"
        allLabel="All departments"
        options={departments.map((department) => ({ id: department.id, label: department.name }))}
        selected={filters.departmentIds}
        onChange={(next) => onChange({ ...filters, departmentIds: next.map(Number), sectionIds: [] })}
        searchPlaceholder="Search department…"
      />

      <MultiSelectFilter
        label="Section"
        allLabel="All sections"
        options={scopedSections.map((section) => ({ id: section.id, label: `${section.code} · ${section.name}` }))}
        selected={filters.sectionIds}
        onChange={(next) => onChange({ ...filters, sectionIds: next.map(Number) })}
        searchPlaceholder="Search section…"
      />

      <div className="filter-field">
        <label>Status</label>
        <select
          value={filters.status}
          onChange={(e) => onChange({ ...filters, status: e.target.value as PortfolioStatus })}
        >
          <option value="all">All job orders</option>
          <option value="active">Active only</option>
          <option value="inactive">In-active only</option>
        </select>
      </div>

      <div className="filter-field">
        <label>Budget</label>
        <select
          value={filters.budget}
          onChange={(e) => onChange({ ...filters, budget: e.target.value as PortfolioBudget })}
        >
          <option value="all">All</option>
          <option value="with">With budget</option>
          <option value="without">Without budget</option>
        </select>
      </div>

      <MultiSelectFilter
        label="Band"
        allLabel="All bands"
        options={BANDS.map((band) => ({ id: band, label: BAND_LABELS[band] }))}
        selected={filters.bands}
        onChange={(next) => onChange({ ...filters, bands: next as PortfolioBand[] })}
      />

      <div className="filter-field">
        <label>As of</label>
        <input
          type="date"
          value={filters.asOf}
          onChange={(e) => onChange({ ...filters, asOf: e.target.value })}
        />
      </div>

      <div className="filter-field">
        <label>Activity window (days)</label>
        <input
          type="number"
          min={1}
          max={365}
          value={filters.activityDays}
          onChange={(e) => {
            const parsed = Number(e.target.value);
            if (!Number.isFinite(parsed)) {
              onChange({ ...filters, activityDays: DEFAULT_ACTIVITY_DAYS });
              return;
            }
            onChange({ ...filters, activityDays: Math.min(365, Math.max(1, Math.round(parsed))) });
          }}
        />
      </div>

      {/* Actions and the explanatory note sit on their OWN row, after the filters — not inline, so a
          long filter row never pushes the buttons around. `grid-column: 1 / -1` spans both. */}
      <div className="pf-filters__actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onReset}>
          Reset filters
        </button>
        {extra}
        <span className="pf-filters__hint">
          Every filter is optional: empty means “no filter”, never “match nothing”. WBS follows the Projects you pick,
          Sections follow the Department.
        </span>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------- *
 * The dashboard
 * --------------------------------------------------------------------------- */

export function PortfolioDashboardPage() {
  const [filters, setFilters] = useState<PortfolioFilterState>(() => decodeFilters(window.location.search));
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [wbs, setWbs] = useState<WbsOption[]>([]);
  const [departments, setDepartments] = useState<DepartmentOption[]>([]);
  const [sections, setSections] = useState<SectionOption[]>([]);
  const [downloadError, setDownloadError] = useState("");
  const [busyFormat, setBusyFormat] = useState<"xlsx" | "pdf" | null>(null);
  // Which section is open. View state, deliberately NOT in the URL: the query string is the one
  // contract shared by the fetch, the filter round-trip and both downloads (see portfolioTabs.ts).
  // A Project Manager opens on HIS projects; everyone else opens on the headline answer
  // ("what needs a push"). The pure helper is shared with /reports so the two screens agree.
  const { user } = useAuth();
  // A RETURN HINT, read once: the conversation screen sends the reader back to the tab and the project
  // they were on. It is not a contract for the report fetch — `portfolioTabs.ts` deliberately keeps the
  // tab out of that query string.
  const [returnParams] = useState(() => new URLSearchParams(window.location.search));
  const [tab, setTab] = useState<PortfolioTabId>(() => {
    const hint = returnParams.get("returnTab");
    return isPortfolioTabId(hint) ? hint : defaultTabFor(user?.role);
  });

  const { report, loading, error, query, reload } = usePortfolioReport(filters);

  // The canonical, stable encoding of the filter state. It is BOTH what the fetch and the downloads
  // carry AND the key each section's pager resets on: a page index only means something for the
  // result set it was chosen against, so a filter change must send the reader back to page 1.
  // Paging itself is CLIENT-SIDE over the rows the API already returned and is never encoded into
  // the query string, so the export always carries every row while the screen shows one page.
  const filterKey = useMemo(() => portfolioQuery(filters), [filters]);

  // A filtered view is a shareable link: the initial scope came from the URL, and every
  // change is mirrored back to the address bar (defaults omitted by the encoder).
  useFilterUrlSync(filters);

  // Filter option lists. `/projects` and `/project-wbs` are the masters the Summary screen
  // already reads; departments and sections are the same shared pickers used elsewhere.
  useEffect(() => {
    void (async () => {
      try {
        const [projectData, wbsData, departmentData, sectionData] = await Promise.all([
          api<{ projects: ProjectOption[] }>("/projects"),
          api<{ wbs: WbsOption[] }>("/project-wbs"),
          api<{ departments: DepartmentOption[] }>("/departments"),
          api<{ sections: SectionOption[] }>("/sections"),
        ]);
        setProjects(projectData.projects);
        setWbs(wbsData.wbs);
        setDepartments(departmentData.departments);
        setSections(sectionData.sections);
      } catch {
        // The report still renders with whatever filters it has; the option lists are a
        // convenience, not the report, so their failure must not blank the screen.
      }
    })();
  }, []);

  async function download(format: "xlsx" | "pdf") {
    setBusyFormat(format);
    setDownloadError("");
    try {
      await downloadPortfolioFile(format, query);
    } catch (e) {
      setDownloadError(e instanceof Error ? e.message : "Download failed.");
    } finally {
      setBusyFormat(null);
    }
  }

  const toggleBand = (band: PortfolioBand) => {
    setFilters((current) => ({
      ...current,
      bands: current.bands.includes(band)
        ? current.bands.filter((value) => value !== band)
        : [...current.bands, band],
    }));
  };

  const pulse = report?.pulse;

  return (
    <>
      <PortfolioFilterBar
        filters={filters}
        onChange={setFilters}
        projects={projects}
        wbs={wbs}
        departments={departments}
        sections={sections}
        onReset={() => setFilters(defaultFilters())}
        extra={
          <span className="pf-downloads">
            <button type="button" className="btn btn-secondary btn-sm" disabled={busyFormat !== null} onClick={() => void download("xlsx")}>
              {busyFormat === "xlsx" ? "Preparing…" : "Download Excel"}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" disabled={busyFormat !== null} onClick={() => void download("pdf")}>
              {busyFormat === "pdf" ? "Preparing…" : "Download PDF"}
            </button>
          </span>
        }
      />

      {error && <div className="error-banner">{error}</div>}
      {downloadError && <div className="error-banner">{downloadError}</div>}

      {loading && !report ? (
        <div className="loading-state">Building the portfolio report…</div>
      ) : report ? (
        <>
          {/* ---- The three hero tiles --------------------------------------------
              Eleven equal tiles made every figure look equally important, which is the
              same as none of them mattering. Burn leads because it is the number the
              operator acts on; budget health follows as ONE story rather than four
              counts; the two attention figures sit beside them. Nothing is lost: the
              band counts are still CLICKABLE filters, they now live in the health
              legend where they read as a breakdown instead of four separate tiles. */}
          <section className="pf-hero" aria-label="Portfolio headline figures">
            <BurnHero
              burnPct={pulse?.portfolioBurnPct}
              budgetHours={pulse?.budgetHours}
              actualHours={pulse?.actualHours}
            />
            <BudgetHealth
              bands={pulse?.bands}
              activeBands={filters.bands}
              onToggleBand={toggleBand}
            />
            <AttentionFigures pulse={pulse} activityDays={filters.activityDays} />
          </section>

          {/* The scope the figures above are drawn from, and the hours they are built on.
              These were five of the eleven old tiles; they are not headline figures, but they
              must stay visible or a tile can be read without knowing what it covers. */}
          <p className="pf-scope-line">
            <span>
              <b>{fmtNumber(pulse?.projects)}</b> project{(pulse?.projects ?? 0) === 1 ? "" : "s"}
            </span>
            <span>
              <b>{fmtNumber(pulse?.jobOrders)}</b> job order{(pulse?.jobOrders ?? 0) === 1 ? "" : "s"} in scope
            </span>
            <span>
              <b>{fmtHours(pulse?.budgetHours)}</b> budgeted
            </span>
            <span>
              <b>{fmtHours(pulse?.actualHours)}</b> booked
            </span>
            {/* The schedule coverage, stated where the other coverage is stated. Without it, a
                portfolio whose rows carry no dates reads as a portfolio that is punctual. */}
            <span>
              <b>{fmtNumber(pulse?.schedule.scheduled)}</b> with a planned window
            </span>
            <span>
              <b>{fmtNumber(pulse?.schedule.delayed)}</b> delayed
            </span>
            <span>
              <b>{fmtNumber(pulse?.schedule.atRisk)}</b> at risk
            </span>
            <span>
              <b>{fmtNumber(pulse?.schedule.dueSoon)}</b> due within 7 days
            </span>
          </p>

          {/* ---- The section tabs ------------------------------------------------
              ONE section at a time. Before this, the screen was a single six-section scroll: the
              section an operator came for took scrolling past five others to reach, and the Job
              work register alone pushed everything below it off the page. The tabs carry each
              section's row count, so how much a section holds is visible without opening it. */}
          <ReportTabs
            active={tab}
            counts={{
              "needs-push": report.needsPush.length,
              "on-track": report.onTrack.length,
              "on-track-not-measurable": report.onTrackNotMeasurable.length,
              "schedule-delays": report.scheduleDelays.length,
              "job-work": report.jobWork.length,
              "project-structure": report.projectStructure.length,
              "department-load": report.departmentLoad.length,
              exceptions:
                report.exceptions.noBudgetHours.count +
                report.exceptions.budgetWithNoBookings.count +
                report.exceptions.noProgress.count +
                report.exceptions.unapproved.count,
            }}
            onChange={(id) => {
              // The default strip IS the portfolio sections, so an unknown id cannot arrive; the
              // predicate keeps it type-safe rather than casting.
              if (isPortfolioTabId(id)) setTab(id);
            }}
          />

          {/* The ACTIVE section, and only it. One panel is mounted at a time, so a table's pager
              position cannot outlive the section it belonged to, and nothing below the fold of one
              section can lengthen another. */}
          <div className="pf-tabpanel" role="tabpanel" id={panelDomId(tab)} aria-labelledby={tabDomId(tab)}>
            {tab === "needs-push" ? <NeedsPushSection report={report} resetKey={filterKey} /> : null}
            {tab === "on-track" ? <OnTrackSection report={report} resetKey={filterKey} /> : null}
            {tab === "on-track-not-measurable" ? (
              <OnTrackNotMeasurableSection report={report} resetKey={filterKey} />
            ) : null}
            {tab === "schedule-delays" ? <ScheduleDelaysSection report={report} resetKey={filterKey} /> : null}
            {tab === "job-work" ? <JobWorkSection report={report} resetKey={filterKey} /> : null}
            {tab === "project-structure" ? <ProjectStructureSection report={report} /> : null}
            {tab === "department-load" ? <DepartmentLoadSection report={report} resetKey={filterKey} /> : null}
            {tab === "exceptions" ? <ExceptionsSection report={report} resetKey={filterKey} /> : null}
          </div>

          {/* ---- How to read this screen (provenance + the rules as DATA) ---- */}
          <Panel
            title="How to read this screen"
            count={report.provenance.filtersHash}
            hint="The rules the report applied, printed from the API's own definitions rather than restated here — so what you read cannot drift from what the code did."
          >
            <div className="pf-basis">
              {report.provenance.filters.map((entry) => (
                <div key={entry.label}>
                  <div className="pf-basis__label">{entry.label}</div>
                  <div className="pf-basis__value">{entry.value}</div>
                </div>
              ))}
              <div>
                <div className="pf-basis__label">As of</div>
                <div className="pf-basis__value">{fmtDate(report.asOf)}</div>
              </div>
              <div>
                <div className="pf-basis__label">Generated</div>
                <div className="pf-basis__value">{fmtDateTime(report.generatedAt)}</div>
              </div>
              <div>
                <div className="pf-basis__label">Generated by</div>
                <div className="pf-basis__value">
                  {report.provenance.generatedBy.name} ({report.provenance.generatedBy.role})
                </div>
              </div>
              <div>
                <div className="pf-basis__label">Attention weights</div>
                <div className="pf-basis__value">
                  RED +{report.definitions.attentionWeights.hoursRed} · AMBER +{report.definitions.attentionWeights.hoursAmber} ·
                  no activity +{report.definitions.attentionWeights.noActivity7d} · approval aging +{report.definitions.attentionWeights.unapprovedAging3d} ·
                  quantity behind +{report.definitions.attentionWeights.quantityBehind} · no budget +{report.definitions.attentionWeights.noBudget}
                </div>
              </div>
              <div>
                <div className="pf-basis__label">Measurable on hours</div>
                <div className="pf-basis__value">{report.definitions.measurable.onHours}</div>
              </div>
              <div>
                <div className="pf-basis__label">Measurable on quantity</div>
                <div className="pf-basis__value">{report.definitions.measurable.onQuantity}</div>
              </div>
              <div>
                <div className="pf-basis__label">Activity window</div>
                <div className="pf-basis__value">{report.definitions.activityWindowDaysNote}</div>
              </div>
              <ul className="pf-basis__notes">
                {report.definitions.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
                <li>
                  Bands: RED {report.definitions.bands.RED.label}; AMBER {report.definitions.bands.AMBER.label}; GREEN{" "}
                  {report.definitions.bands.GREEN.label}; {BAND_LABELS.NOT_MEASURABLE} — {report.definitions.bands.NOT_MEASURABLE.label}.
                </li>
              </ul>
            </div>
          </Panel>

          <p className="muted" style={{ marginTop: 0 }}>
            Numbers update live with the filters above. Pull the same scope into a file from the Reports screen —
            the download carries the identical query string this screen sent.
          </p>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void reload()} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </>
      ) : (
        <div className="empty-state">The report could not be loaded. Adjust or reset the filters and try again.</div>
      )}
    </>
  );
}

/* --------------------------------------------------------------------------- *
 * The six sections, one per tab. Each owns its own paging (see `useTablePager`),
 * so a page index can never leak from one section into another.
 * ------------------------------------------------------------------------- */

/** Every section is rendered from the ONE response, so a tab and its table cannot disagree. */
type SectionProps = { report: PortfolioReport; resetKey: string };

/**
 * One row's numeric cells, shared by the WBS and Network levels so the two can never drift.
 *
 * The job-order cell prints `in scope / total` ONLY when they differ: "0 / 6" is the honest way to
 * say "this element holds work you cannot see", while a bare "6" would claim those six.
 */
function StructureCells({ node }: { node: StructureNode }) {
  return (
    <>
      <td
        className="pf-num"
        title={`${node.jobOrderCount} in this scope of ${node.jobOrderCountAll} in total`}
      >
        {node.jobOrderCount === node.jobOrderCountAll
          ? node.jobOrderCount
          : `${node.jobOrderCount} / ${node.jobOrderCountAll}`}
      </td>
      <td><BandBadge band={node.hoursBand} /></td>
      <td><ScheduleBadge band={node.scheduleBand} /></td>
      <td className="pf-num">{fmtPct(node.qtyCompletePct)}</td>
      <td className="pf-num">{fmtHours(node.budgetHours)}</td>
      <td className="pf-num">{fmtHours(node.actualHours)}</td>
      <td className="pf-num">{fmtPct(node.burnPct)}</td>
      <td className="pf-num">{node.noActivity === 0 ? "—" : node.noActivity}</td>
      <td className="pf-num">{fmtHours(node.unapprovedHours)}</td>
    </>
  );
}

/**
 * Project structure — Project → WBS → Network, with the work beneath each node.
 *
 * WHY A SECTION OF ITS OWN: the other sections RANK job orders ("what needs a push"). This one
 * answers "what is under this project" — which WBS elements exist, which networks hang off them, and
 * how the work beneath each node stands. It is the same scoped data as "Job work", arranged as the
 * hierarchy it belongs to, and it is the section a Project Manager lands on.
 *
 * TWO LABELS ARE DELIBERATE:
 *  - a node's bands are the WORST of its children, never an average, so one RED job order colours
 *    its WBS and its project;
 *  - a Network has no status of its own (the master stores only active/inactive), so every band on a
 *    network row is DERIVED from its job orders — the panel hint says so rather than letting a
 *    derived figure read as a stored SAP status.
 */
export function ProjectStructureSection({ report }: { report: PortfolioReport }) {
  if (report.projectStructure.length === 0) {
    return (
      <Panel
        title="Project structure"
        count={0}
        hint="Each project's WBS elements and their Networks, with the job orders beneath them."
      >
        <div className="empty-state">
          No project is in this scope. A Project Manager sees this until an Admin assigns a project to the
          account on <strong>Project Managers</strong>; a Department Head sees it when nothing in the
          scope carries a Job Order.
        </div>
      </Panel>
    );
  }

  return (
    <div className="pf-structure">
      {report.projectStructure.map((row) => (
        <Panel
          key={row.project.id}
          title={`${row.project.code} · ${row.project.name}${row.project.active ? "" : " (inactive)"}`}
          count={`${row.totals.jobOrderCount} job order${row.totals.jobOrderCount === 1 ? "" : "s"}`}
          hint="A node's bands are the WORST of its job orders, never an average. A Network has no status of its own — its bands are derived from its job orders."
        >
          <div className="pf-basis">
            <div>
              <div className="pf-basis__label">Budgeted</div>
              <div className="pf-basis__value">{fmtHours(row.totals.budgetHours)}</div>
            </div>
            <div>
              <div className="pf-basis__label">Actual</div>
              <div className="pf-basis__value">{fmtHours(row.totals.actualHours)}</div>
            </div>
            <div>
              <div className="pf-basis__label">Burn</div>
              <div className="pf-basis__value">{fmtPct(row.totals.burnPct)}</div>
            </div>
            <div>
              <div className="pf-basis__label">Worst hours band</div>
              <div className="pf-basis__value"><BandBadge band={row.totals.hoursBand} /></div>
            </div>
            <div>
              <div className="pf-basis__label">Worst schedule</div>
              <div className="pf-basis__value"><ScheduleBadge band={row.totals.scheduleBand} /></div>
            </div>
            <div>
              <div className="pf-basis__label">Quantity</div>
              <div className="pf-basis__value">{fmtPct(row.totals.qtyCompletePct)}</div>
            </div>
            <div>
              <div className="pf-basis__label">No activity</div>
              <div className="pf-basis__value">{row.totals.noActivity}</div>
            </div>
            <div>
              <div className="pf-basis__label">Hours awaiting approval</div>
              <div className="pf-basis__value">{fmtHours(row.totals.unapprovedHours)}</div>
            </div>
          </div>

          {row.wbs.length === 0 ? (
            <div className="empty-state">
              No WBS element is defined for this project yet, so its job orders have no structure to show.
            </div>
          ) : (
            <div className="pf-table-wrap">
              <table className="pf-table pf-table--compact">
                <thead>
                  <tr>
                    <th>Project / WBS / Network</th>
                    <th className="pf-num">Job orders</th>
                    <th>Hours band</th>
                    <th>Schedule</th>
                    <th className="pf-num">Qty</th>
                    <th className="pf-num">Budget</th>
                    <th className="pf-num">Actual</th>
                    <th className="pf-num">Burn</th>
                    <th className="pf-num">No activity</th>
                    <th className="pf-num">Unapproved</th>
                    <th className="pf-actions" aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {row.wbs.map((wbs) => (
                    <Fragment key={wbs.id}>
                      <EscalatableNodeRow
                        className="pf-structure__wbs"
                        node={wbs}
                        scope={{ projectId: row.project.id, wbsId: wbs.id }}
                        origin="PORTFOLIO_STRUCTURE"
                      >
                        <td>
                          <div className="pf-cell-cap">
                            <span className="pf-cell-strong">{wbs.code}{wbs.name ? ` · ${wbs.name}` : ""}</span>
                            <span className="pf-cell-sub">WBS{wbs.active ? "" : " · inactive"}</span>
                          </div>
                        </td>
                        <StructureCells node={wbs} />
                      </EscalatableNodeRow>
                      {wbs.networks.map((network) => (
                        <EscalatableNodeRow
                          key={network.id}
                          className="pf-structure__network"
                          node={network}
                          scope={{ projectId: row.project.id, wbsId: wbs.id, networkId: network.id }}
                          origin="PORTFOLIO_STRUCTURE"
                        >
                          <td>
                            <div className="pf-cell-cap">
                              <span className="pf-cell-sub">↳ Network {network.code}{network.name ? ` · ${network.name}` : ""}</span>
                              <span className="pf-cell-sub">{network.active ? "derived from its job orders" : "inactive · derived from its job orders"}</span>
                            </div>
                          </td>
                          <StructureCells node={network} />
                        </EscalatableNodeRow>
                      ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      ))}
    </div>
  );
}

/**
 * Schedule & delays — the seventh section, and the reason it is its own tab.
 *
 * "On track" is a claim about HOURS, and it must not be quietly redefined by a date: a Job Order can be
 * GREEN on burn and past its planned end, and that pair is the most dangerous row in the portfolio. So
 * the schedule gets its own section, listing every window that is breached or about to be, worst first,
 * with the numbers that produced each flag beside it.
 */
function ScheduleDelaysSection({ report, resetKey }: SectionProps) {
  const pager = useTablePager(report.scheduleDelays, resetKey);
  const pulse = report.pulse.schedule;
  return (
    <Panel
      title="Schedule & delays"
      count={`${report.scheduleDelays.length} of ${pulse.scheduled} scheduled`}
      hint="Every planned window that has closed with quantity outstanding, or that the approved progress projects will run beyond it. Worst first. A job order with no window is not late and is not listed: it is unscheduled, and it is never counted as on time."
    >
      {report.scheduleDelays.length === 0 ? (
        <p className="pf-empty">
          No planned window is breached or about to be, across {fmtNumber(pulse.scheduled)} scheduled job order
          {pulse.scheduled === 1 ? "" : "s"}. {fmtNumber(pulse.notScheduled)} job order
          {pulse.notScheduled === 1 ? "" : "s"} in scope carry no window at all and are not judged here.
        </p>
      ) : (
        <>
          <div className="pf-table-wrap">
            <table className="pf-table">
              <thead>
                <tr>
                  <th>Job order</th>
                  <th>Department</th>
                  <th>Schedule</th>
                  <th>Planned window</th>
                  <th>Days</th>
                  <th className="pf-num">Plan %</th>
                  <th className="pf-num">% Qty</th>
                  <th className="pf-num">Need / day</th>
                  <th className="pf-num">Achieved / day</th>
                  <th>Projected finish</th>
                  <th>Attention</th>
                  <th>Reasons</th>
                  <th className="pf-actions" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {pager.slice.rows.map((row) => (
                  <EscalatableRow key={row.id} jobOrder={row} origin="PORTFOLIO_SCHEDULE">
                    <JobIdentityCell row={row} />
                    <td>
                      <div className="pf-cell-cap pf-cell-cap--department">{row.department.name}</div>
                    </td>
                    <td>
                      <ScheduleBadge band={row.scheduleBand} />
                    </td>
                    <PlannedWindowCell start={row.plannedStartDate} end={row.plannedEndDate} />
                    <td>{scheduleDaysText(row)}</td>
                    <td className="pf-num">{fmtPercent(row.planElapsedPct)}</td>
                    <td className="pf-num">{fmtQtyCompletePct(row.qtyCompletePct)}</td>
                    <td className="pf-num">{fmtRate(row.requiredRate)}</td>
                    <td className="pf-num">{fmtRate(row.actualRate)}</td>
                    <td>{fmtDate(row.projectedFinish)}</td>
                    <td className="pf-num">{row.attentionScore}</td>
                    <td className="pf-reasons">{row.reasons.length ? row.reasons.join("; ") : "—"}</td>
                  </EscalatableRow>
                ))}
              </tbody>
            </table>
          </div>
          <SlicePager slice={pager.slice} setPage={pager.setPage} anchorRef={pager.anchorRef} />
        </>
      )}
    </Panel>
  );
}

/** A 0..1 fraction as a percentage, or an em dash when it cannot be computed. */
export function fmtPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${Math.round(value * 100)}%`;
}

/** A per-day rate at two decimals, or an em dash: a rate that cannot be measured is never a 0.00. */
export function fmtRate(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return value.toFixed(2);
}

/**
 * Needs push — the primary answer: the job orders with an attention signal, ranked.
 *
 * `needsPush` is CAPPED by the API (the top N by score), so this list is usually a single page and
 * the pager stays hidden; the panel header still prints "N of TOTAL" and the note below the table
 * says where the remainder lives. That is deliberate: the cap is a property of the report, and
 * hiding it would let a 50-row sample read as the whole push list.
 */
function NeedsPushSection({ report, resetKey }: SectionProps) {
  const pager = useTablePager(report.needsPush, resetKey);
  return (
    <Panel
      title="Needs push"
      count={`${report.needsPush.length} of ${report.needsPushTotal}`}
      hint={
        <>
          Ranked by attention score, highest first, exactly as the API returns it. The REASONS column is the whole
          explanation for a row — it is never abbreviated. The weights are printed at the bottom of this screen from
          the API{"'"}s own definitions.
        </>
      }
    >
      {report.needsPush.length === 0 ? (
        <div className="empty-state">Nothing needs a push: no job order in scope carries an attention signal.</div>
      ) : (
        <div className="pf-table-wrap" ref={pager.anchorRef}>
          <table className="pf-table">
            <thead>
              <tr>
                <th>Job order</th>
                <th>Department</th>
                <th>Band</th>
                <th className="pf-num">% Qty</th>
                <th className="pf-num">Burn</th>
                <th>Forecast</th>
                <th className="pf-num">Attention</th>
                <th>Reasons</th>
                <th className="pf-actions" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {pager.slice.rows.map((row) => (
                <EscalatableRow key={row.id} jobOrder={row} origin="PORTFOLIO_NEEDS_PUSH">
                  <JobIdentityCell row={row} />
                  <td>
                    <div className="pf-cell-cap pf-cell-cap--department">
                      {row.department.name}
                      <span className="pf-cell-sub">{row.section ? `${row.section.name}` : "No section"}</span>
                    </div>
                  </td>
                  <td>
                    <BandBadge band={row.hoursBand} />
                  </td>
                  <PctQtyCell row={row} />
                  <td className="pf-num">{fmtPct(row.burnPct)}</td>
                  <td className="pf-nowrap">{fmtDate(row.forecastExhaustedOn)}</td>
                  <td className="pf-num pf-attention">{row.attentionScore}</td>
                  <ReasonsCell reasons={row.reasons} />
                </EscalatableRow>
              ))}
            </tbody>
          </table>
          {report.needsPushTotal > report.needsPush.length && (
            <p className="pf-panel__hint" style={{ padding: "10px 14px 0", margin: 0 }}>
              Showing the top {report.needsPush.length} of {report.needsPushTotal} ranked job orders; the rest are in
              the Job work table and the export.
            </p>
          )}
          <SlicePager {...pager} label="ranked job orders" />
        </div>
      )}
    </Panel>
  );
}

/** On track — measurable on hours and under 75% burn. Paged: this list can run to hundreds of rows. */
function OnTrackSection({ report, resetKey }: SectionProps) {
  const pager = useTablePager(report.onTrack, resetKey);
  return (
    <Panel
      title="On track"
      count={report.onTrack.length}
      hint="Measurable on hours and under 75% burn. This is a claim about work we CAN measure."
    >
      {report.onTrack.length === 0 ? (
        <div className="empty-state">No measurable job order is currently under 75% burn.</div>
      ) : (
        <div className="pf-table-wrap" ref={pager.anchorRef}>
          <table className="pf-table pf-table--compact">
            <thead>
              <tr>
                <th>Job order</th>
                <th>Department</th>
                <th>Band</th>
                <th className="pf-num">Budget</th>
                <th className="pf-num">Actual</th>
                <th className="pf-num">Burn</th>
                <th>Last bk</th>
              </tr>
            </thead>
            <tbody>
              {pager.slice.rows.map((row) => (
                <tr key={row.id}>
                  <JobIdentityCell row={row} />
                  <td>
                    <div className="pf-cell-cap pf-cell-cap--department">{row.department.name}</div>
                  </td>
                  <td>
                    <BandBadge band={row.hoursBand} />
                  </td>
                  <td className="pf-num">{fmtHours(row.budgetHours)}</td>
                  <td className="pf-num">{fmtHours(row.actualHours)}</td>
                  <td className="pf-num">{fmtPct(row.burnPct)}</td>
                  <td className="pf-nowrap">{fmtDate(row.lastBooking)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <SlicePager {...pager} />
        </div>
      )}
    </Panel>
  );
}

/** On track, not yet measurable — kept SEPARATE so a green figure is never borrowed from missing data. */
function OnTrackNotMeasurableSection({ report, resetKey }: SectionProps) {
  const pager = useTablePager(report.onTrackNotMeasurable, resetKey);
  return (
    <Panel
      title="On track — not yet measurable"
      count={report.onTrackNotMeasurable.length}
      hint={
        <>
          Shown SEPARATELY and never folded into the GREEN tile: these job orders are not measurable on hours (no
          budget in force), so a green figure above must never be borrowed from this missing data.
        </>
      }
    >
      {report.onTrackNotMeasurable.length === 0 ? (
        <div className="empty-state">Every job order in scope has a budget to measure against.</div>
      ) : (
        <div className="pf-table-wrap" ref={pager.anchorRef}>
          <table className="pf-table pf-table--compact">
            <thead>
              <tr>
                <th>Job order</th>
                <th>Department</th>
                <th>Band</th>
                <th className="pf-num">QTY BDG</th>
                <th className="pf-num">QTY Prgsd</th>
                <th className="pf-num">% Qty</th>
                <th>Last bk</th>
                <th>Why unmeasurable</th>
              </tr>
            </thead>
            <tbody>
              {pager.slice.rows.map((row) => (
                <tr key={row.id}>
                  <JobIdentityCell row={row} />
                  <td>
                    <div className="pf-cell-cap pf-cell-cap--department">{row.department.name}</div>
                  </td>
                  <td>
                    <BandBadge band={row.hoursBand} />
                  </td>
                  <td className="pf-num">{fmtNumber(row.targetQty, 2)}</td>
                  <td className="pf-num">{fmtNumber(row.achievedQty, 2)}</td>
                  <PctQtyCell row={row} />
                  <td className="pf-nowrap">{fmtDate(row.lastBooking)}</td>
                  <td>
                    {row.measurableOnQuantity ? "Quantity measurable" : "No budgeted hours in force"}
                    {!row.measurableOnQuantity && <span className="pf-cell-sub">No approved progress to judge yet</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <SlicePager {...pager} />
        </div>
      )}
    </Panel>
  );
}

/** Job work — every job order in scope: the register behind the tiles, paged at 50 rows. */
function JobWorkSection({ report, resetKey }: SectionProps) {
  const pager = useTablePager(report.jobWork, resetKey);
  return (
    <Panel
      title="Job work"
      count={report.jobWork.length}
      hint="Every job order in scope — the register behind the tiles. Hours and quantity are separate measures and are never added together."
    >
      {report.jobWork.length === 0 ? (
        <div className="empty-state">No job order matches the current filters. Widen the filters or clear the band.</div>
      ) : (
        <div className="pf-table-wrap" ref={pager.anchorRef}>
          <table className="pf-table">
            <thead>
              <tr>
                <th>Job order</th>
                <th>Department</th>
                <th>Planned window</th>
                <th>Schedule</th>
                <th>Status</th>
                <th>Band</th>
                <th className="pf-num">Budget h</th>
                <th className="pf-num">Actual h</th>
                <th className="pf-num">Burn</th>
                <th className="pf-num">h/day</th>
                <th>Forecast</th>
                <th className="pf-num">QTY BDG</th>
                <th className="pf-num">QTY Prgsd</th>
                <th className="pf-num">% Qty</th>
                <th>Last bk</th>
                <th className="pf-num">Unappr h</th>
              </tr>
            </thead>
            <tbody>
              {pager.slice.rows.map((row) => (
                <tr key={row.id}>
                  <JobIdentityCell row={row} />
                  <td>
                    <div className="pf-cell-cap pf-cell-cap--department">{row.department.name}</div>
                  </td>
                  <PlannedWindowCell start={row.plannedStartDate} end={row.plannedEndDate} />
                  <td>
                    <ScheduleBadge band={row.scheduleBand} />
                    <span className="pf-cell-sub">{scheduleDaysText(row)}</span>
                  </td>
                  <td>
                    <span className={`pf-badge ${row.status === "active" ? "pf-badge--GREEN" : "pf-badge--NOT_MEASURABLE"}`}>
                      {row.status === "active" ? "Active" : "In-active"}
                    </span>
                  </td>
                  <td>
                    <BandBadge band={row.hoursBand} />
                  </td>
                  <td className="pf-num">{fmtHours(row.budgetHours)}</td>
                  <td className="pf-num">{fmtHours(row.actualHours)}</td>
                  <td className="pf-num">{fmtPct(row.burnPct)}</td>
                  <td className="pf-num">{row.hoursPerDay === null ? "—" : fmtNumber(row.hoursPerDay, 1)}</td>
                  <td className="pf-nowrap">{fmtDate(row.forecastExhaustedOn)}</td>
                  <td className="pf-num">
                    {fmtNumber(row.targetQty, 2)}
                    {row.uom ? <span className="pf-cell-sub">{row.uom}</span> : null}
                  </td>
                  <td className="pf-num">{fmtNumber(row.achievedQty, 2)}</td>
                  <PctQtyCell row={row} />
                  <td className="pf-nowrap">{fmtDate(row.lastBooking)}</td>
                  <td className="pf-num">{fmtHours(row.unapprovedHours)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <SlicePager {...pager} />
        </div>
      )}
    </Panel>
  );
}

/** Department load — one row per department, paged like every other section (one page today). */
function DepartmentLoadSection({ report, resetKey }: SectionProps) {
  const pager = useTablePager(report.departmentLoad, resetKey);
  return (
    <Panel
      title="Department load"
      count={report.departmentLoad.length}
      hint="Worst individual band wins the headline colour; burn band answers how burnt the group is overall. Both are shown, because a fire is not diluted by the green job orders beside it."
    >
      {report.departmentLoad.length === 0 ? (
        <div className="empty-state">No department has a job order in scope.</div>
      ) : (
        <div className="pf-table-wrap" ref={pager.anchorRef}>
          <table className="pf-table pf-table--compact">
            <thead>
              <tr>
                <th>Department</th>
                <th className="pf-num">Job orders</th>
                <th className="pf-num">Sections</th>
                <th>Worst band</th>
                <th>Burn band</th>
                <th className="pf-num">Budget</th>
                <th className="pf-num">Actual</th>
                <th className="pf-num">Burn</th>
                <th className="pf-num">RED / AMBER / GREEN / N/M</th>
              </tr>
            </thead>
            <tbody>
              {pager.slice.rows.map((row) => (
                <tr key={row.department.id}>
                  <td className="pf-cell-strong">{row.department.name}</td>
                  <td className="pf-num">{row.jobOrderCount}</td>
                  <td className="pf-num">{row.sectionCount}</td>
                  <td>
                    <BandBadge band={row.hoursBand} />
                  </td>
                  <td>
                    <BandBadge band={row.burnBand} />
                  </td>
                  <td className="pf-num">{fmtHours(row.budgetHours)}</td>
                  <td className="pf-num">{fmtHours(row.actualHours)}</td>
                  <td className="pf-num">{fmtPct(row.burnPct)}</td>
                  <td className="pf-num">
                    {row.redCount} / {row.amberCount} / {row.greenCount} / {row.notMeasurableCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <SlicePager {...pager} />
        </div>
      )}
    </Panel>
  );
}

/**
 * Exceptions & readiness — the four buckets the API flags.
 *
 * Each bucket is CAPPED by the API (a bounded sample) while its header prints the FULL count, so a
 * bucket can hold up to the cap. `resetKey` is handed to every card so a filter change sends each
 * card's own page index back to 1 — the four cards page independently.
 */
function ExceptionsSection({ report, resetKey }: SectionProps) {
  return (
    <Panel
      title="Exceptions & readiness"
      count={`${report.exceptions.noBudgetHours.count + report.exceptions.budgetWithNoBookings.count + report.exceptions.noProgress.count + report.exceptions.unapproved.count} flagged`}
    >
      <div className="pf-exceptions">
        <ExceptionCard
          title="No budget hours"
          bucket={report.exceptions.noBudgetHours}
          emptyText="Every job order in scope has a positive budget."
          columns={(row) => [row.displayName, row.department.name]}
          resetKey={resetKey}
        />
        <ExceptionCard
          title="Budget with no bookings"
          bucket={report.exceptions.budgetWithNoBookings}
          emptyText="Every budgeted job order has at least one booking."
          columns={(row) => [row.displayName, fmtHours(row.budgetHours)]}
          resetKey={resetKey}
        />
        <ExceptionCard
          title="No progress reported"
          bucket={report.exceptions.noProgress}
          emptyText="Approved quantity progress exists for every job order."
          columns={(row) => [row.displayName, row.department.name]}
          resetKey={resetKey}
        />
        <ExceptionCard
          title="Unapproved hours"
          bucket={report.exceptions.unapproved}
          emptyText="No hours are waiting for approval."
          columns={(row) => [
            row.displayName,
            `${fmtHours(row.unapprovedHours)}${row.oldestUnapprovedAt ? ` since ${fmtDate(row.oldestUnapprovedAt)}` : ""}`,
          ]}
          resetKey={resetKey}
        />
      </div>
    </Panel>
  );
}

/**
 * The burn hero: the portfolio's burn over a 0-150% scale.
 *
 * UNITS: the API sends burn as a RATIO (1.109 means 111%), not a percentage. Every comparison and
 * the track width below are therefore against 1.0 / 1.5. Comparing against 100 silently produced a
 * green "Within budget" pill on an over-budget portfolio and a bar filled to 0.7% — a wrong signal
 * is worse than no signal, so the ratio is named as one throughout.
 *
 * WHY IT LEADS THE SCREEN
 *   Burn is the one number an operations chief acts on, so it gets the largest type on the page and
 *   the only card with a warm fill. The scale is capped at 150% rather than scaled to the value:
 *   a bar that always fills its track would make 40% and 140% look identical, and the whole point
 *   of the card is that the marker's position is comparable between refreshes.
 *
 * The 100% marker is a fixed reference line, so the question answered is visibly "how far past
 * budget are we", not merely "what is the number".
 */
export function BurnHero({
  burnPct,
  budgetHours,
  actualHours,
}: {
  /** A ratio: 0.75 is 75%, 1.109 is 111%. */
  burnPct: number | null | undefined;
  budgetHours: number | null | undefined;
  actualHours: number | null | undefined;
}) {
  const { measurable, fillPct, over, tag } = burnSummary(burnPct);

  return (
    <article className={`pf-hero__card pf-hero__card--burn${over ? " pf-hero__card--over" : ""}`}>
      <div className="pf-hero__lab">
        Portfolio burn
        {tag ? <span className={`pf-tag pf-tag--${tag.tone}`}>{tag.text}</span> : null}
      </div>

      <div className="pf-hero__big">
        {measurable ? fmtPct(burnPct) : "—"}
        {!measurable && <small>not measurable</small>}
      </div>

      <div className="pf-hero__note">
        {measurable
          ? `${fmtHours(actualHours)} booked against ${fmtHours(budgetHours)} budgeted`
          : "No budgeted hours in force, so there is nothing to burn against."}
      </div>

      {/* role=img with a sentence: the bar is decoration, the label is the fact. */}
      <div
        className={`pf-track${over ? " pf-track--over" : ""}`}
        role="img"
        aria-label={measurable ? `Burn ${fmtPct(burnPct)} of budget` : "Burn not measurable"}
      >
        {measurable && <i style={{ width: `${fillPct}%` }} />}
        <u />
      </div>
      <div className="pf-scale">
        <span>0</span>
        <span className="pf-scale__mid">Budget</span>
        <span>150%</span>
      </div>
    </article>
  );
}

/**
 * Budget health: the four band counts as ONE bar plus a legend.
 *
 * THE BAND FILTER IS PRESERVED. Each legend row is a button that filters the whole screen to that
 * band, exactly as the four band tiles used to — losing that would be a regression, and a red row
 * is the most likely thing an operator wants to click. The row states `aria-pressed` so the active
 * filter is announced as well as shown.
 *
 * NOT-MEASURABLE IS ITS OWN ROW, never folded into GREEN: a green figure must never be borrowed
 * from missing data. The bar keeps that separation visible as an unfilled segment.
 */
export function BudgetHealth({
  bands,
  activeBands,
  onToggleBand,
}: {
  bands?: Record<PortfolioBand, number>;
  activeBands: PortfolioBand[];
  onToggleBand: (band: PortfolioBand) => void;
}) {
  const { total, measurable, measurableShare, order } = healthSummary(bands);
  const countOf = (band: PortfolioBand) => order.find((entry) => entry.band === band)?.count ?? 0;

  const bandHint = (band: PortfolioBand) =>
    band === "RED"
      ? "Budget exhausted"
      : band === "AMBER"
        ? "75% or more used"
        : band === "GREEN"
          ? "Under 75%"
          : "No budget to measure";

  return (
    <article className="pf-hero__card">
      <div className="pf-hero__lab">
        Budget health
        <span className="pf-hero__lab-note">
          {fmtNumber(total)} job order{total === 1 ? "" : "s"}
        </span>
      </div>

      {/* Each segment is flex:count; a zero count renders nothing rather than a min-width sliver. */}
      <div
        className="pf-stack"
        role="img"
        aria-label={order.map((entry) => `${entry.count} ${bandHint(entry.band)}`).join(", ")}
      >
        {order.map((entry) =>
          entry.count > 0 ? (
            <span
              key={entry.band}
              className={`pf-stack__seg pf-stack__seg--${entry.band}`}
              style={{ flexGrow: entry.count }}
            />
          ) : null
        )}
      </div>

      <div className="pf-legend">
        {order.map((entry) => (
          <button
            key={entry.band}
            type="button"
            className={`pf-legend__row${activeBands.includes(entry.band) ? " pf-legend__row--on" : ""}`}
            onClick={() => onToggleBand(entry.band)}
            aria-pressed={activeBands.includes(entry.band)}
            title={`Filter the screen to ${BAND_LABELS[entry.band]}`}
          >
            <i className={`pf-dot pf-stack__seg--${entry.band}`} aria-hidden="true" />
            <span className="pf-legend__label">{bandHint(entry.band)}</span>
            <b>{fmtNumber(countOf(entry.band))}</b>
          </button>
        ))}
      </div>

      <p className="pf-hero__note pf-hero__note--foot">
        {total === 0
          ? "Nothing in scope to measure."
          : `Only ${fmtNumber(measurable)} of ${fmtNumber(total)} job orders have a budget, so burn covers ${measurableShare}% of the portfolio.`}
      </p>
    </article>
  );
}

/**
 * The two attention figures, side by side because they are read together: hours that are booked but
 * not yet approved, and measurable work that has gone quiet.
 */
export function AttentionFigures({
  pulse,
  activityDays,
}: {
  pulse?: { noActivity: number; hoursAwaitingApproval: number; oldestUnapprovedAt: string | null };
  activityDays: number;
}) {
  const unapproved = pulse?.hoursAwaitingApproval ?? 0;
  const noActivity = pulse?.noActivity ?? 0;

  return (
    <article className="pf-hero__card pf-hero__card--att">
      <div>
        <div className="pf-hero__lab">Hours awaiting approval</div>
        <div className="pf-hero__mid">
          {fmtHours(unapproved)}
          <small>h</small>
        </div>
        <div className="pf-hero__note">
          {pulse?.oldestUnapprovedAt
            ? `Oldest booking ${fmtDate(pulse.oldestUnapprovedAt)}.`
            : "Nothing unapproved in scope."}
        </div>
      </div>
      <div>
        <div className="pf-hero__lab">No recent activity</div>
        <div className={`pf-hero__mid${noActivity > 0 ? " pf-hero__mid--warn" : ""}`}>
          {fmtNumber(noActivity)}
          <small>job order{noActivity === 1 ? "" : "s"}</small>
        </div>
        <div className="pf-hero__note">
          Measurable on hours, last booking more than {activityDays} day{activityDays === 1 ? "" : "s"} ago.
        </div>
      </div>
    </article>
  );
}

/**
 * One exception bucket: the whole truth in the count, a bounded sample in the table — and the
 * sample is PAGED at the same 50 rows as every other table, because the API's cap is 100 and a
 * hundred rows inside a card in a four-card grid is the longest scroll on the screen.
 *
 * TWO STATEMENTS, TWO DIFFERENT FACTS, and both are needed:
 *   - the note under the table says how much the API SAMPLE holds ("Showing 100 of 412"), which is a
 *     property of the report — that is the reader's warning that rows exist beyond what is listed;
 *   - the pager says which SLICE of that sample is on screen ("Showing 51-100 of 100 job orders").
 * Collapsing them into one sentence would misstate one of the two.
 */
export function ExceptionCard({
  title,
  bucket,
  emptyText,
  columns,
  resetKey = "",
}: {
  title: string;
  bucket: ExceptionBucket;
  emptyText: string;
  /** Maps a row to the [primary, secondary] cell pair this bucket cares about. */
  columns: (row: PortfolioJobRow) => [string, string];
  /** Changes whenever the filter set changes, so the card's own page index resets with the data. */
  resetKey?: string;
}) {
  const pager = useTablePager(bucket.rows, resetKey);
  return (
    <div className="pf-exception">
      <div className="pf-exception__head">
        <span className="pf-exception__title">{title}</span>
        <span className="pf-exception__count">{bucket.count}</span>
      </div>
      {bucket.count === 0 ? (
        <div className="pf-exception__empty">{emptyText}</div>
      ) : (
        <div className="pf-exception__body" ref={pager.anchorRef}>
          <table className="pf-table pf-table--compact">
            <tbody>
              {pager.slice.rows.map((row) => {
                const [primary, secondary] = columns(row);
                return (
                  <tr key={row.id}>
                    <td className="pf-cell-strong">{primary}</td>
                    <td className="pf-num">{secondary}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {bucket.count > bucket.rows.length && (
            <p className="pf-exception__empty">
              Showing {bucket.rows.length} of {bucket.count}; the export carries the full list.
            </p>
          )}
          <SlicePager {...pager} />
        </div>
      )}
    </div>
  );
}

/**
 * Keep the browser URL in step with the filter state, on BOTH screens.
 *
 * The INITIAL state is read from the URL by the page itself (a lazy `useState` initializer
 * using the same decoder), so a shared link opens on the scope it names and only one
 * request is issued. This hook then mirrors every later change back to the address bar with
 * `replaceState`, using the SAME encoder the fetch and the downloads use — so a clean filter
 * set leaves a clean URL and copying the address bar always shares what is on screen.
 */
export function useFilterUrlSync(filters: PortfolioFilterState) {
  useEffect(() => {
    const query = portfolioQuery(filters);
    // replaceState (not pushState) keeps the back button behaving as it did before.
    window.history.replaceState(null, "", `${window.location.pathname}${query}`);
  }, [filters]);
}
