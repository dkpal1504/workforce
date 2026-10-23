import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import {
  BandBadge,
  ExceptionCard,
  JobIdentityCell,
  PlannedWindowCell,
  ScheduleBadge,
  scheduleDaysText,
  Panel,
  PortfolioFilterBar,
  ProjectStructureSection,
  PctQtyCell,
  ReasonsCell,
  ReportTabs,
  SlicePager,
  downloadPortfolioFile,
  fmtDate,
  fmtDateTime,
  fmtHours,
  fmtNumber,
  fmtPct,
  fmtPercent,
  fmtRate,
  useFilterUrlSync,
  usePortfolioReport,
  useTablePager,
  type DepartmentOption,
  type PortfolioReport,
  type ProjectOption,
  type SectionOption,
  type WbsOption,
} from "./PortfolioDashboardPage";
import { defaultFilters, decodeFilters, portfolioQuery, type PortfolioFilterState } from "./portfolioFilters";
import {
  DEFAULT_TAB,
  REPORTS_TABS,
  defaultTabFor,
  reportsTabFromId,
  panelDomId,
  tabDomId,
  type ReportsTabId,
} from "./portfolioTabs";
import { TimesheetCoveragePanel } from "./TimesheetCoveragePanel";
import { NotBookedPanel } from "./NotBookedPanel";
import "../styles/portfolio.css";

/**
 * Reports (/reports) — the SAME six datasets as the /portfolio dashboard, presented
 * TABLE-FIRST so the screen can be read top-to-bottom and taken away.
 *
 * The two screens share ONE filter bar component and ONE fetch hook, so they always ask
 * the API for the same scope; they also share the ONE tab strip and the ONE pager, so the
 * six sections are found the same way on both screens. The Download Excel / Download PDF
 * buttons here carry the IDENTICAL query string the report below was built from — both come
 * from the pure `portfolioQuery()` helper, which the tests pin.
 *
 * There are no KPI tiles here on purpose: the dashboard answers "what needs attention",
 * this screen answers "give me the rows". The numbers are the same because the data is.
 *
 * The report scope panel stays ABOVE the tabs: it names the scope and carries the downloads, so
 * it must be readable (and clickable) whichever section is open. The sections themselves are one
 * tab each — see the note in `PortfolioDashboardPage` and `portfolioTabs.ts`.
 */
export function ReportsPage() {
  const [filters, setFilters] = useState<PortfolioFilterState>(() => decodeFilters(window.location.search));
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [wbs, setWbs] = useState<WbsOption[]>([]);
  const [departments, setDepartments] = useState<DepartmentOption[]>([]);
  const [sections, setSections] = useState<SectionOption[]>([]);
  const [downloadError, setDownloadError] = useState("");
  const [downloadNotice, setDownloadNotice] = useState("");
  const [busyFormat, setBusyFormat] = useState<"xlsx" | "pdf" | null>(null);
  // Which section is open. View state, not in the URL (see portfolioTabs.ts). Type is the REPORTS
  // strip's, which is the portfolio sections PLUS the coverage report. A Project Manager opens on
  // his projects, exactly as he does on the dashboard.
  const { user } = useAuth();
  const [tab, setTab] = useState<ReportsTabId>(() => defaultTabFor(user?.role));

  /**
   * A project scope cannot define the coverage report's EMPLOYEE ROSTER, so the API refuses that
   * role on its two routes. Its tab is hidden to match — and `!== false` (never `!== true`) keeps the
   * tab VISIBLE for an older bundle whose capabilities predate the flag: fail-visible, so no existing
   * reader loses a tab to a stale session.
   */
  const canCoverage = user?.capabilities.viewTimesheetCoverage !== false;
  const tabs = canCoverage
    ? REPORTS_TABS
    : REPORTS_TABS.filter((entry) => entry.id !== "timesheet-coverage" && entry.id !== "not-booked");

  const { report, loading, error, query } = usePortfolioReport(filters);

  // The canonical filter encoding: what the fetch and the downloads carry, and the key each
  // section's pager resets on. Paging is CLIENT-SIDE and never encoded into the query string, so
  // the export always carries every row while the screen shows one page of 50.
  const filterKey = useMemo(() => portfolioQuery(filters), [filters]);

  // Same URL contract as the dashboard: initial scope from the URL, every change mirrored back.
  useFilterUrlSync(filters);

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
        // The report below still renders without the picker options.
      }
    })();
  }, []);

  async function download(format: "xlsx" | "pdf") {
    setBusyFormat(format);
    setDownloadError("");
    setDownloadNotice("");
    try {
      // SAME query string as the fetch above — the helper is the single source of truth.
      const { filename } = await downloadPortfolioFile(format, query);
      setDownloadNotice(`Saved ${filename}. It carries the identical filters as this screen.`);
    } catch (e) {
      setDownloadError(e instanceof Error ? e.message : "Download failed.");
    } finally {
      setBusyFormat(null);
    }
  }

  /**
   * The counts the tabs carry. The six portfolio sections show their row counts; the coverage report
   * carries NONE, because its size is a function of the period and the roster and would be a number
   * nobody had asked for yet (the report states it the moment it is generated).
   */
  const tabCounts: Partial<Record<string, number>> = report
    ? {
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
      }
    : {};

  const downloads = (
    <span className="pf-downloads">
      <button
        type="button"
        className="btn btn-primary btn-sm"
        disabled={busyFormat !== null}
        onClick={() => void download("xlsx")}
      >
        {busyFormat === "xlsx" ? "Preparing…" : "Download Excel"}
      </button>
      <button
        type="button"
        className="btn btn-primary btn-sm"
        disabled={busyFormat !== null}
        onClick={() => void download("pdf")}
      >
        {busyFormat === "pdf" ? "Preparing…" : "Download PDF"}
      </button>
    </span>
  );

  /** Which strip is on screen: the portfolio sections, or the coverage report. */
  // Both of these tabs are roster reports, not portfolio cuts, so they share the coverage branch: their
  // content comes from /reports/*, not from the portfolio report the filter bar drives.
  const coverageTab = canCoverage && (tab === "timesheet-coverage" || tab === "not-booked");
  // Delay insights reads an entirely different endpoint, so it renders like coverage: its own panel,
  // without waiting for the portfolio report.
  const delayTab = tab === "delay-insights";
  const hindranceTab = tab === "hindrances";

  return (
    <>
      {/* The FILTER BAR belongs to the report on screen. The portfolio bar's dimensions (projects
          and WBS of the job-order register, band, budget, activity window, as-of) mean nothing to a
          timesheet-coverage report, and drawing it above that report would invite the reader to
          believe it filtered it. So the coverage report carries its own controls — a period plus the
          organisation scope — and the portfolio bar returns with the portfolio sections. */}
      {coverageTab || delayTab || hindranceTab ? null : (
        <PortfolioFilterBar
          filters={filters}
          onChange={setFilters}
          projects={projects}
          wbs={wbs}
          departments={departments}
          sections={sections}
          onReset={() => setFilters(defaultFilters())}
          extra={downloads}
        />
      )}

      {coverageTab || delayTab || hindranceTab ? null : error && <div className="error-banner">{error}</div>}
      {coverageTab || delayTab || hindranceTab ? null : downloadError && <div className="error-banner">{downloadError}</div>}
      {coverageTab || delayTab || hindranceTab ? null : downloadNotice && <div className="alloc-note">{downloadNotice}</div>}

      {hindranceTab ? (
        <>
          <ReportTabs
            tabs={tabs}
            active={tab}
            counts={tabCounts}
            onChange={(id) => {
              const next = reportsTabFromId(id);
              if (next) setTab(next);
            }}
          />
          <div className="pf-tabpanel" role="tabpanel" id={panelDomId(tab)} aria-labelledby={tabDomId(tab)}>
            <HindranceRegisterPanel />
          </div>
        </>
      ) : delayTab ? (
        <>
          <ReportTabs
            tabs={tabs}
            active={tab}
            counts={tabCounts}
            onChange={(id) => {
              const next = reportsTabFromId(id);
              if (next) setTab(next);
            }}
          />
          <div className="pf-tabpanel" role="tabpanel" id={panelDomId(tab)} aria-labelledby={tabDomId(tab)}>
            <DelayInsightsPanel query={query} />
          </div>
        </>
      ) : coverageTab ? (
        <>
          <ReportTabs
            tabs={tabs}
            active={tab}
            counts={tabCounts}
            onChange={(id) => {
              // ONE handler rule for every strip on this screen: a Reports tab is whichever tab the
              // Reports list contains. Enumerating the two Reports-only ids here meant a third one
              // rendered a tab that ignored its own click.
              const next = reportsTabFromId(id);
              if (next) setTab(next);
            }}
          />
          <div className="pf-tabpanel" role="tabpanel" id={panelDomId(tab)} aria-labelledby={tabDomId(tab)}>
            {tab === "not-booked" ? <NotBookedPanel /> : <TimesheetCoveragePanel />}
          </div>
        </>
      ) : loading && !report ? (
        <div className="loading-state">Building the report…</div>
      ) : report ? (
        <>
          {/* ---- Scope statement + the download actions (table-first, take-away) ----
              Above the tabs on purpose: it names the scope every section below is drawn from and it
              holds the downloads, so it must not hide behind a tab. */}
          <Panel
            title="Report scope"
            count={report.provenance.filtersHash}
            hint="Every download below is generated from this exact scope — the same query string this screen sent, so the file and the screen cannot disagree."
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
                <div className="pf-basis__label">Totals</div>
                <div className="pf-basis__value">
                  {report.pulse.jobOrders} job orders · {fmtHours(report.pulse.budgetHours)} budgeted ·{" "}
                  {fmtHours(report.pulse.actualHours)} actual · {fmtPct(report.pulse.portfolioBurnPct)} burn
                </div>
              </div>
              <div className="pf-downloads" style={{ alignSelf: "end" }}>
                {downloads}
                <p className="pf-downloads__note">
                  Excel and PDF are produced server-side from the same assembled report, so neither recomputes a
                  band or a score.
                </p>
              </div>
            </div>
          </Panel>

          {/* ---- The section tabs: one dataset at a time, each with its row count ---- */}
          <ReportTabs
            tabs={tabs}
            active={tab}
            counts={tabCounts}
            onChange={(id) => {
              const next = reportsTabFromId(id);
              if (next) setTab(next);
            }}
          />

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
        </>
      ) : (
        <div className="empty-state">The report could not be loaded. Adjust or reset the filters and try again.</div>
      )}
    </>
  );
}

/* --------------------------------------------------------------------------- *
 * The six sections, one per tab. Each is the take-away view of ONE dataset and
 * pages at 50 rows through the shared `useTablePager`.
 * ------------------------------------------------------------------------- */

type SectionProps = { report: PortfolioReport; resetKey: string };

/** Needs push — ranked, with the reasons in full. Capped by the API; the header says so. */
function NeedsPushSection({ report, resetKey }: SectionProps) {
  const pager = useTablePager(report.needsPush, resetKey);
  return (
    <Panel
      title="Needs push"
      count={`${report.needsPush.length} of ${report.needsPushTotal}`}
      hint="Ranked by attention score. The REASONS column states why a row is here, in full."
    >
      {report.needsPush.length === 0 ? (
        <div className="empty-state">No job order in scope carries an attention signal.</div>
      ) : (
        <div className="pf-table-wrap" ref={pager.anchorRef}>
          <table className="pf-table">
            <thead>
              <tr>
                <th>Job order</th>
                <th>Department</th>
                <th>Band</th>
                <th className="pf-num">% Qty</th>
                <th className="pf-num">Budget h</th>
                <th className="pf-num">Actual h</th>
                <th className="pf-num">Burn</th>
                <th>Forecast</th>
                <th className="pf-num">Attention</th>
                <th>Reasons</th>
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
                  <PctQtyCell row={row} />
                  <td className="pf-num">{fmtHours(row.budgetHours)}</td>
                  <td className="pf-num">{fmtHours(row.actualHours)}</td>
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
              Showing the top {report.needsPush.length} of {report.needsPushTotal} ranked job orders; the export
              carries the full register.
            </p>
          )}
          <SlicePager {...pager} label="ranked job orders" />
        </div>
      )}
    </Panel>
  );
}

/** On track — measurable on hours, under 75% burn. */
function OnTrackSection({ report, resetKey }: SectionProps) {
  const pager = useTablePager(report.onTrack, resetKey);
  return (
    <Panel title="On track" count={report.onTrack.length} hint="Measurable on hours, under 75% burn.">
      {report.onTrack.length === 0 ? (
        <div className="empty-state">No measurable job order is under 75% burn.</div>
      ) : (
        <div className="pf-table-wrap" ref={pager.anchorRef}>
          <table className="pf-table pf-table--compact">
            <thead>
              <tr>
                <th>Job order</th>
                <th>Department</th>
                <th>Band</th>
                <th className="pf-num">Budget h</th>
                <th className="pf-num">Actual h</th>
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

/** On track, not yet measurable — SEPARATE, never mixed into GREEN. */
function OnTrackNotMeasurableSection({ report, resetKey }: SectionProps) {
  const pager = useTablePager(report.onTrackNotMeasurable, resetKey);
  return (
    <Panel
      title="On track — not yet measurable"
      count={report.onTrackNotMeasurable.length}
      hint="Job orders with no budget in force. Kept apart from the GREEN rows so a green figure is never borrowed from missing data."
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
                  <td className="pf-num">
                    {fmtNumber(row.targetQty, 2)}
                    {row.uom ? <span className="pf-cell-sub">{row.uom}</span> : null}
                  </td>
                  <td className="pf-num">{fmtNumber(row.achievedQty, 2)}</td>
                  <PctQtyCell row={row} />
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

/**
 * Schedule & delays — the seventh section, mirroring the dashboard's own.
 *
 * Both screens render it because both are the same report; the columns are deliberately identical so a
 * reader moving between the dashboard and the print-out is reading the same table. It is a section of
 * its own because "on track" is a claim about HOURS: a job order can be GREEN on burn and past its
 * planned end, and that pair must stay visible as exactly that.
 */
function ScheduleDelaysSection({ report, resetKey }: SectionProps) {
  const pager = useTablePager(report.scheduleDelays, resetKey);
  const pulse = report.pulse.schedule;
  return (
    <Panel
      title="Schedule & delays"
      count={`${report.scheduleDelays.length} of ${pulse.scheduled} scheduled`}
      hint="Every planned window that has closed with quantity outstanding, or that the approved progress projects will run beyond it, worst first. A job order with no window is not late and is not listed: it is unscheduled, and it is never counted as on time."
    >
      {report.scheduleDelays.length === 0 ? (
        <div className="empty-state">
          No planned window is breached or about to be, across {fmtNumber(pulse.scheduled)} scheduled job order
          {pulse.scheduled === 1 ? "" : "s"}. {fmtNumber(pulse.notScheduled)} job order
          {pulse.notScheduled === 1 ? "" : "s"} in scope carry no window at all and are not judged here.
        </div>
      ) : (
        <div className="pf-table-wrap" ref={pager.anchorRef}>
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
                <th className="pf-num">Attention</th>
                <th>Reasons</th>
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
                    <ScheduleBadge band={row.scheduleBand} />
                  </td>
                  <PlannedWindowCell start={row.plannedStartDate} end={row.plannedEndDate} />
                  <td>{scheduleDaysText(row)}</td>
                  <td className="pf-num">{fmtPercent(row.planElapsedPct)}</td>
                  <PctQtyCell row={row} />
                  <td className="pf-num">{fmtRate(row.requiredRate)}</td>
                  <td className="pf-num">{fmtRate(row.actualRate)}</td>
                  <td>{fmtDate(row.projectedFinish)}</td>
                  <td className="pf-num">{row.attentionScore}</td>
                  <td className="pf-reasons">{row.reasons.length ? row.reasons.join("; ") : "—"}</td>
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

/** Job work — every job order in scope, the full register, 50 rows per page. */
function JobWorkSection({ report, resetKey }: SectionProps) {
  const pager = useTablePager(report.jobWork, resetKey);
  return (
    <Panel
      title="Job work"
      count={report.jobWork.length}
      hint="Every job order in scope. Hours and quantity are separate measures and are never added together."
    >
      {report.jobWork.length === 0 ? (
        <div className="empty-state">No job order matches the current filters.</div>
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

/** Department load — one row per department. */
function DepartmentLoadSection({ report, resetKey }: SectionProps) {
  const pager = useTablePager(report.departmentLoad, resetKey);
  return (
    <Panel title="Department load" count={report.departmentLoad.length}>
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
                <th className="pf-num">Budget h</th>
                <th className="pf-num">Actual h</th>
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

/** Exceptions & readiness — the four flagged buckets, each paged independently. */
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


/* --------------------------------------------------------------------------- *
 * Delay insights — what the conversations say is holding the work up.
 *
 * Counts come from the server (one aggregation over coded messages, scoped to the reader's portfolio
 * or department). Nothing here ranks a cause it was not given, and the sample size is always on
 * screen: "41% of 68" is a claim, "41%" alone is a rumour.
 * ------------------------------------------------------------------------- */

type SlaStats = {
  answered: number;
  expected: number;
  medianHours: number | null;
  withinTargetPct: number | null;
  overdue24: number;
  remindersEnabled: boolean;
  buckets: Array<{ bucket: "under4" | "4to8" | "8to24" | "over24"; count: number }>;
};

type DelayInsights = {
  period: "quarter" | "month" | "year";
  from: string;
  to: string;
  summary: {
    total: number;
    uncoded: number;
    byReason: Array<{ code: string; label: string; count: number; share: number; averageOpenDays: number }>;
  };
  sentence: string;
};

function DelayInsightsPanel({ query }: { query: string }) {
  const [period, setPeriod] = useState<"quarter" | "month" | "year">("quarter");
  const [data, setData] = useState<DelayInsights | null>(null);
  const [sla, setSla] = useState<SlaStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sweeping, setSweeping] = useState(false);
  const [downloading, setDownloading] = useState<"xlsx" | "pdf" | null>(null);
  const [downloadNote, setDownloadNote] = useState<string | null>(null);
  const [sweepNote, setSweepNote] = useState<string | null>(null);
  const { user } = useAuth();
  const canSweep = user?.role === "PM" || user?.role === "ADMIN" || user?.role === "PROJECT_MANAGER";

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const [causes, clock] = await Promise.all([
          api<DelayInsights>(`/conversations/insights/delays?period=${period}`),
          api<SlaStats>(`/conversations/sla/stats?period=${period}`).catch(() => null),
        ]);
        if (!cancelled) {
          setData(causes);
          setSla(clock);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "The delay insights could not be loaded.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [period]);

  const widest = data?.summary.byReason[0]?.share ?? 0;

  return (
    <Panel
      title="Delay insights"
      count={data ? data.summary.total : undefined}
      hint="Causes recorded by Job Order owners and PMs in conversations. A reply without a cause is counted separately and never folded into a percentage."
    >
      <div className="di-head">
        <div className="di-period" role="group" aria-label="Period">
          {(["quarter", "month", "year"] as const).map((option) => (
            <button
              key={option}
              type="button"
              className={`di-period__btn${period === option ? " di-period__btn--on" : ""}`}
              aria-pressed={period === option}
              onClick={() => setPeriod(option)}
            >
              {option === "quarter" ? "This quarter" : option === "month" ? "This month" : "This year"}
            </button>
          ))}
        </div>
      </div>
      {loading && <p className="di-empty">Counting…</p>}
      {error && !loading && <p className="di-empty di-empty--error">{error}</p>}

      {!loading && !error && data && (
        <>
          <p className="di-lead">{data.sentence}</p>

          {data.summary.total === 0 ? (
            <p className="di-empty">
              Nothing reported in this period. Causes appear here once owners reply and pick one.
            </p>
          ) : (
            <div className="di-bars">
              {data.summary.byReason.map((reason) => (
                <div className="di-bar" key={reason.code}>
                  <span className="di-bar__label">{reason.label}</span>
                  <span className="di-bar__track">
                    <span
                      className="di-bar__fill"
                      style={{ width: `${widest === 0 ? 0 : Math.round((reason.count / (data.summary.byReason[0].count || 1)) * 100)}%` }}
                    />
                  </span>
                  <span className="di-bar__n">{reason.count}</span>
                  <span className="di-bar__share">{reason.share}%</span>
                  <span className="di-bar__age">{reason.averageOpenDays.toFixed(1)} d</span>
                </div>
              ))}
            </div>
          )}

          <p className="di-foot">
            {data.summary.total} cause{data.summary.total === 1 ? "" : "s"} recorded
            {data.summary.uncoded > 0 ? ` · ${data.summary.uncoded} repl${data.summary.uncoded === 1 ? "y" : "ies"} without a cause` : ""}
            {" · "}
            bar length is relative to the largest cause; the percentage is of the {data.summary.total} recorded
          </p>
        </>
      )}

      {/* ---- the other half of the same question: not WHAT holds work up, but HOW LONG we take to answer ── */}
      {!loading && !error && sla && (
        <>
          <div className="di-split" />
          <div className="di-sla">
            <div className="di-sla__head">
              <span>Response time</span>
              <span className="di-sla__sub">
                median {sla.medianHours == null ? "—" : `${sla.medianHours}h`}
                {sla.withinTargetPct == null ? "" : ` · ${sla.withinTargetPct}% answered inside target`}
              </span>
            </div>

            {sla.expected === 0 ? (
              <p className="di-empty">
                No message in this period expected a reply. Escalations and recovery proposals start the clock.
              </p>
            ) : (
              <>
                <div className="di-sla__bars">
                  {sla.buckets.map((bucket) => {
                    const label =
                      bucket.bucket === "under4" ? "under 4h" : bucket.bucket === "4to8" ? "4–8h" : bucket.bucket === "8to24" ? "8–24h" : "over 24h";
                    const worst = Math.max(...sla.buckets.map((entry) => entry.count), 1);
                    return (
                      <div className="di-bar" key={bucket.bucket}>
                        <span className="di-bar__label">{label}</span>
                        <span className="di-bar__track">
                          <span className="di-bar__fill" style={{ width: `${Math.round((bucket.count / worst) * 100)}%` }} />
                        </span>
                        <span className="di-bar__n">{bucket.count}</span>
                        <span className="di-bar__share" />
                        <span className="di-bar__age">unanswered</span>
                      </div>
                    );
                  })}
                </div>
                <p className="di-foot">
                  {sla.answered} of {sla.expected} answered · {sla.overdue24} waiting longer than 24h
                  {" · "}
                  each message is measured against its own target (an escalation expects a reply sooner than a recovery)
                </p>
              </>
            )}

            <div className="di-sla__actions">
              {(["xlsx", "pdf"] as const).map((format) => (
                <button
                  key={format}
                  type="button"
                  className="di-period__btn"
                  disabled={downloading !== null}
                  title={`Download the report with the ${period} delay data and ${sla ? "the" : ""} hindrance register`}
                  onClick={async () => {
                    setDownloading(format);
                    setDownloadNote(null);
                    try {
                      // The SAME filter string the screen sent, plus the period on screen: the file and the
                      // panel state one period, not two.
                      const separator = query ? (query.includes("?") ? "&" : "?") : "?";
                      const { filename } = await downloadPortfolioFile(
                        format,
                        `${query || ""}${separator}insightsPeriod=${period}`
                      );
                      setDownloadNote(`Saved ${filename}`);
                    } catch (err) {
                      setDownloadNote(err instanceof Error ? err.message : "Download failed.");
                    } finally {
                      setDownloading(null);
                    }
                  }}
                >
                  {downloading === format ? "Preparing…" : format === "xlsx" ? "Excel" : "PDF"}
                </button>
              ))}
              <button
                type="button"
                className="di-period__btn"
                disabled={!canSweep || !sla.remindersEnabled || sweeping}
                title={
                  !canSweep
                    ? "Only a Project Manager or an administrator can run the reminders"
                    : !sla.remindersEnabled
                      ? "Reminders are switched off in this server's configuration, so the sweep would send nothing"
                      : "Run the reminder and escalation ladder once, now"
                }
                onClick={async () => {
                  setSweeping(true);
                  setSweepNote(null);
                  try {
                    const result = await api<{ reminded: number; escalated: number }>("/conversations/sla/sweep", { method: "POST" });
                    setSweepNote(`${result.reminded} reminded · ${result.escalated} escalated`);
                  } catch (err) {
                    setSweepNote(err instanceof Error ? err.message : "The sweep did not run.");
                  } finally {
                    setSweeping(false);
                  }
                }}
              >
                {sweeping ? "Running…" : "Run reminders now"}
              </button>
              <span className="di-sla__state">
                {sla.remindersEnabled ? "reminders ON" : "reminders OFF"}
                {sweepNote ? ` · ${sweepNote}` : ""}
                {downloadNote ? ` · ${downloadNote}` : ""}
              </span>
            </div>
          </div>
        </>
      )}
    </Panel>
  );
}


/* --------------------------------------------------------------------------- *
 * The hindrance register. Every constraint raised against a WBS node, with its owner, its age and its
 * closure — the list Central Planning opens, not a summary of it.
 * ------------------------------------------------------------------------- */

type HindranceRow = {
  id: number;
  projectWbsId: number;
  wbsCode: string | null;
  jobOrderCode: string | null;
  jobOrderName: string | null;
  category: string;
  description: string;
  ownerEmail: string | null;
  raisedByEmail: string;
  raisedAt: string;
  impactDays: number | null;
  state: "OPEN" | "CLOSED";
  closedAt: string | null;
  closedByName: string | null;
  closureNote: string | null;
  age: { days: number; stale: boolean };
};

function HindranceRegisterPanel() {
  const [state, setState] = useState<"OPEN" | "CLOSED">("OPEN");
  const [rows, setRows] = useState<HindranceRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const data = await api<{ hindrances: HindranceRow[] }>(`/conversations/hindrances?state=${state}`);
        if (!cancelled) setRows(data.hindrances);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "The register could not be loaded.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state]);

  const stale = rows.filter((row) => row.age.stale).length;

  const exportCsv = () => {
    const header = ["WBS", "Job order", "Category", "Description", "Owner", "Raised on", "Days open", "Stale", "State", "Closed by", "Closure note"];
    const lines = rows.map((row) => [
      row.wbsCode ?? "",
      row.jobOrderCode ?? "",
      row.category,
      row.description.replace(/"/g, '""'),
      row.ownerEmail ?? "",
      row.raisedAt.slice(0, 10),
      String(row.age.days),
      row.age.stale ? "yes" : "no",
      row.state,
      row.closedByName ?? "",
      row.closureNote ?? "",
    ]);
    const csv = [header, ...lines].map((line) => line.map((cell) => `"${cell}"`).join(",")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `hindrances-${state.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Panel
      title="Hindrance register"
      count={rows.length}
      hint="Constraints raised against a WBS node, with the owner who must clear them. An open item is stale after 14 days; impact days are what the raiser stated, never derived."
    >
      <div className="di-head" style={{ justifyContent: "space-between" }}>
        <div className="di-period" role="group" aria-label="Register state">
          {(["OPEN", "CLOSED"] as const).map((option) => (
            <button
              key={option}
              type="button"
              className={`di-period__btn${state === option ? " di-period__btn--on" : ""}`}
              aria-pressed={state === option}
              onClick={() => setState(option)}
            >
              {option === "OPEN" ? "Open" : "Closed"}
            </button>
          ))}
        </div>
        <button type="button" className="di-period__btn" onClick={exportCsv} disabled={rows.length === 0}>
          Export CSV
        </button>
      </div>

      {loading && <p className="di-empty">Loading the register…</p>}
      {error && !loading && <p className="di-empty di-empty--error">{error}</p>}
      {!loading && !error && rows.length === 0 && (
        <p className="di-empty">
          {state === "OPEN"
            ? "Nothing open. Hindrances appear here as soon as somebody raises one from a Job Order conversation."
            : "Nothing has been closed yet in this scope."}
        </p>
      )}

      {!loading && !error && rows.length > 0 && (
        <>
          <table className="hr-table">
            <thead>
              <tr>
                <th>WBS</th>
                <th>Job order</th>
                <th>Cause</th>
                <th>What is holding it up</th>
                <th>Owner</th>
                <th>Age</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.wbsCode ?? "—"}</td>
                  <td>
                    <strong>{row.jobOrderCode ?? "—"}</strong>
                    <div className="muted tiny">{row.jobOrderName ?? ""}</div>
                  </td>
                  <td><span className="conv-chip conv-chip--reason">{row.category.toLowerCase()}</span></td>
                  <td>
                    {row.description}
                    {row.impactDays ? <div className="muted tiny">stated impact {row.impactDays} d</div> : null}
                    {row.state === "CLOSED" && row.closedByName ? (
                      <div className="muted tiny">closed by {row.closedByName} on {(row.closedAt ?? "").slice(0, 10)}</div>
                    ) : null}
                  </td>
                  <td>{row.ownerEmail ?? "—"}</td>
                  <td className={row.age.stale ? "hr-stale" : ""}>
                    {row.age.days} d{row.age.stale ? " · stale" : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="di-foot">
            {rows.length} {state === "OPEN" ? "open" : "closed"} · {stale} stale (&gt;14 days) · raised by{" "}
            {[...new Set(rows.map((row) => row.raisedByEmail))].length} people
          </p>
        </>
      )}
    </Panel>
  );
}
