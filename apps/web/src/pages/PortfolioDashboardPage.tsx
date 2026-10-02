import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, getToken } from "../api/client";
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
// The tested, pure pagination rules — reused verbatim, never reimplemented here.
import { paginate, pageNumbers } from "./portfolioPaging";
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

export type ExceptionBucket = { count: number; rows: PortfolioJobRow[] };

export type PortfolioPulse = {
  projects: number;
  jobOrders: number;
  budgetHours: number;
  actualHours: number;
  portfolioBurnPct: number | null;
  bands: Record<PortfolioBand, number>;
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
  needsPush: PortfolioJobRow[];
  needsPushTotal: number;
  onTrack: PortfolioJobRow[];
  onTrackNotMeasurable: PortfolioJobRow[];
  jobWork: PortfolioJobRow[];
  departmentLoad: DepartmentRollUp[];
  exceptions: {
    noBudgetHours: ExceptionBucket;
    budgetWithNoBookings: ExceptionBucket;
    noProgress: ExceptionBucket;
    unapproved: ExceptionBucket;
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
export function fmtDate(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString();
}

export function fmtDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
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

/** The job-order identity cell: project / WBS / code-name / department, stacked. */
export function JobIdentityCell({ row, showProject = true }: { row: PortfolioJobRow; showProject?: boolean }) {
  return (
    <td>
      <span className="pf-cell-strong">{row.displayName || `${row.code}-${row.name}`}</span>
      <span className="pf-cell-sub">
        {showProject ? `${row.project.code} · ${row.project.name} · ` : ""}
        WBS {row.wbs.wbsCode}
      </span>
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
      setReport(data);
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
      {/* ONE ROW. Every dimension is the same checkbox-dropdown control, so a dimension with 40
          options costs exactly as much space as one with 3. The previous layout rendered a button
          per Project in a wrapping flex row: with 14 projects that column stacked down the page and
          pushed the real filters out of view, which was the reported layout defect. */}
      <MultiSelectFilter
        label="Projects"
        allLabel="All projects"
        options={projects.map((project) => ({ id: project.id, label: project.code, detail: project.name }))}
        selected={filters.projectIds}
        // Choosing a project re-scopes the WBS list, so a WBS that no longer belongs is dropped here
        // rather than left to build a filter that matches nothing.
        onChange={(next) => onChange({ ...filters, projectIds: next.map(Number), wbsIds: [] })}
        minWidth={190}
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
        minWidth={168}
      />

      <MultiSelectFilter
        label="Department"
        allLabel="All departments"
        options={departments.map((department) => ({ id: department.id, label: department.name }))}
        selected={filters.departmentIds}
        onChange={(next) => onChange({ ...filters, departmentIds: next.map(Number), sectionIds: [] })}
        searchPlaceholder="Search department…"
        minWidth={190}
      />

      <MultiSelectFilter
        label="Section"
        allLabel="All sections"
        options={scopedSections.map((section) => ({ id: section.id, label: `${section.code} · ${section.name}` }))}
        selected={filters.sectionIds}
        onChange={(next) => onChange({ ...filters, sectionIds: next.map(Number) })}
        searchPlaceholder="Search section…"
        minWidth={180}
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
        minWidth={170}
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

  // Client-side paging for the two long tables. The page index is kept SEPARATE per table so
  // paging one does not jump the other.
  const [jobWorkPage, setJobWorkPage] = useState(1);
  const [needsPushPage, setNeedsPushPage] = useState(1);
  // The scroll targets: clicking a page button brings the matching table back into view.
  const jobWorkAnchor = useRef<HTMLDivElement>(null);
  const needsPushAnchor = useRef<HTMLDivElement>(null);

  const { report, loading, error, query, reload } = usePortfolioReport(filters);

  // RESET TO PAGE 1 WHENEVER THE FILTER SET CHANGES. A page index is only meaningful for the
  // result set it was chosen against: a reader on page 3 of 63 rows who narrows to 12 rows
  // would otherwise be left on a clamped page with no explanation. `portfolioQuery` is the
  // canonical, stable encoding of the filter state, so a filter change is exactly a change of
  // that string. The downloads are UNAFFECTED — they never carry a page parameter.
  const filterKey = useMemo(() => portfolioQuery(filters), [filters]);
  useEffect(() => {
    setJobWorkPage(1);
    setNeedsPushPage(1);
  }, [filterKey]);

  // Paging is CLIENT-SIDE over the rows the API already returned: the query string sent to
  // /reports/portfolio (and to the .xlsx/.pdf downloads) is untouched, so the export always
  // carries every row while the screen shows one page.
  const jobWorkSlice = useMemo(() => paginate(report?.jobWork ?? [], jobWorkPage), [report, jobWorkPage]);
  const needsPushSlice = useMemo(() => paginate(report?.needsPush ?? [], needsPushPage), [report, needsPushPage]);

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
          </p>

          {/* ---- Needs push (the primary answer) ---- */}
          <Panel
            title="Needs push"
            count={`${report.needsPush.length} of ${report.needsPushTotal}`}
            hint={
              <>
                Ranked by attention score, highest first, exactly as the API returns it. The REASONS column is the
                whole explanation for a row — it is never abbreviated. The weights are printed at the bottom of this
                screen from the API{"'"}s own definitions.
              </>
            }
          >
            {report.needsPush.length === 0 ? (
              <div className="empty-state">Nothing needs a push: no job order in scope carries an attention signal.</div>
            ) : (
              <div className="pf-table-wrap" ref={needsPushAnchor}>
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
                    </tr>
                  </thead>
                  <tbody>
                    {needsPushSlice.rows.map((row) => (
                      <tr key={row.id}>
                        <JobIdentityCell row={row} />
                        <td>
                          {row.department.name}
                          <span className="pf-cell-sub">{row.section ? `${row.section.name}` : "No section"}</span>
                        </td>
                        <td>
                          <BandBadge band={row.hoursBand} />
                        </td>
                        <PctQtyCell row={row} />
                        <td className="pf-num">{fmtPct(row.burnPct)}</td>
                        <td className="pf-nowrap">{fmtDate(row.forecastExhaustedOn)}</td>
                        <td className="pf-num pf-attention">{row.attentionScore}</td>
                        <ReasonsCell reasons={row.reasons} />
                      </tr>
                    ))}
                  </tbody>
                </table>
                {report.needsPushTotal > report.needsPush.length && (
                  <p className="pf-panel__hint" style={{ padding: "10px 14px 0", margin: 0 }}>
                    Showing the top {report.needsPush.length} of {report.needsPushTotal} ranked job orders; the rest are
                    in the Job work table and the export.
                  </p>
                )}
                <TablePager
                  page={needsPushSlice.page}
                  pageCount={needsPushSlice.pageCount}
                  total={needsPushSlice.total}
                  from={needsPushSlice.from}
                  to={needsPushSlice.to}
                  hasPrev={needsPushSlice.hasPrev}
                  hasNext={needsPushSlice.hasNext}
                  onChange={setNeedsPushPage}
                  anchorRef={needsPushAnchor}
                />
              </div>
            )}
          </Panel>

          {/* ---- On track ---- */}
          <Panel
            title="On track"
            count={report.onTrack.length}
            hint="Measurable on hours and under 75% burn. This is a claim about work we CAN measure."
          >
            {report.onTrack.length === 0 ? (
              <div className="empty-state">No measurable job order is currently under 75% burn.</div>
            ) : (
              <div className="pf-table-wrap">
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
                    {report.onTrack.map((row) => (
                      <tr key={row.id}>
                        <JobIdentityCell row={row} />
                        <td>{row.department.name}</td>
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
              </div>
            )}
          </Panel>

          {/* ---- On track, not yet measurable (SEPARATE and labelled) ---- */}
          <Panel
            title="On track — not yet measurable"
            count={report.onTrackNotMeasurable.length}
            hint={
              <>
                Shown SEPARATELY and never folded into the GREEN tile: these job orders are not measurable on hours
                (no budget in force), so a green figure above must never be borrowed from this missing data.
              </>
            }
          >
            {report.onTrackNotMeasurable.length === 0 ? (
              <div className="empty-state">Every job order in scope has a budget to measure against.</div>
            ) : (
              <div className="pf-table-wrap">
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
                    {report.onTrackNotMeasurable.map((row) => (
                      <tr key={row.id}>
                        <JobIdentityCell row={row} />
                        <td>{row.department.name}</td>
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
              </div>
            )}
          </Panel>

          {/* ---- Job work (every job order) ---- */}
          <Panel
            title="Job work"
            count={report.jobWork.length}
            hint="Every job order in scope — the register behind the tiles. Hours and quantity are separate measures and are never added together."
          >
            {report.jobWork.length === 0 ? (
              <div className="empty-state">No job order matches the current filters. Widen the filters or clear the band.</div>
            ) : (
              <div className="pf-table-wrap" ref={jobWorkAnchor}>
                <table className="pf-table">
                  <thead>
                    <tr>
                      <th>Job order</th>
                      <th>Department</th>
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
                    {jobWorkSlice.rows.map((row) => (
                      <tr key={row.id}>
                        <JobIdentityCell row={row} />
                        <td>{row.department.name}</td>
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
                <TablePager
                  page={jobWorkSlice.page}
                  pageCount={jobWorkSlice.pageCount}
                  total={jobWorkSlice.total}
                  from={jobWorkSlice.from}
                  to={jobWorkSlice.to}
                  hasPrev={jobWorkSlice.hasPrev}
                  hasNext={jobWorkSlice.hasNext}
                  onChange={setJobWorkPage}
                  anchorRef={jobWorkAnchor}
                />
              </div>
            )}
          </Panel>

          {/* ---- Department load ---- */}
          <Panel
            title="Department load"
            count={report.departmentLoad.length}
            hint="Worst individual band wins the headline colour; burn band answers how burnt the group is overall. Both are shown, because a fire is not diluted by the green job orders beside it."
          >
            {report.departmentLoad.length === 0 ? (
              <div className="empty-state">No department has a job order in scope.</div>
            ) : (
              <div className="pf-table-wrap">
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
                    {report.departmentLoad.map((row) => (
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
              </div>
            )}
          </Panel>

          {/* ---- Exceptions / readiness ---- */}
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
              />
              <ExceptionCard
                title="Budget with no bookings"
                bucket={report.exceptions.budgetWithNoBookings}
                emptyText="Every budgeted job order has at least one booking."
                columns={(row) => [row.displayName, fmtHours(row.budgetHours)]}
              />
              <ExceptionCard
                title="No progress reported"
                bucket={report.exceptions.noProgress}
                emptyText="Approved quantity progress exists for every job order."
                columns={(row) => [row.displayName, row.department.name]}
              />
              <ExceptionCard
                title="Unapproved hours"
                bucket={report.exceptions.unapproved}
                emptyText="No hours are waiting for approval."
                columns={(row) => [row.displayName, `${fmtHours(row.unapprovedHours)}${row.oldestUnapprovedAt ? ` since ${fmtDate(row.oldestUnapprovedAt)}` : ""}`]}
              />
            </div>
          </Panel>

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
 * One exception bucket: the whole truth in the count, a bounded sample in the table.
 * The API caps the sample (and says so), so the header always states the FULL count.
 */
export function ExceptionCard({
  title,
  bucket,
  emptyText,
  columns,
}: {
  title: string;
  bucket: ExceptionBucket;
  emptyText: string;
  /** Maps a row to the [primary, secondary] cell pair this bucket cares about. */
  columns: (row: PortfolioJobRow) => [string, string];
}) {
  return (
    <div className="pf-exception">
      <div className="pf-exception__head">
        <span className="pf-exception__title">{title}</span>
        <span className="pf-exception__count">{bucket.count}</span>
      </div>
      {bucket.count === 0 ? (
        <div className="pf-exception__empty">{emptyText}</div>
      ) : (
        <div className="pf-exception__body">
          <table className="pf-table pf-table--compact">
            <tbody>
              {bucket.rows.map((row) => {
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
