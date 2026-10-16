import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import {
  BandBadge,
  ExceptionCard,
  JobIdentityCell,
  PlannedWindowCell,
  ScheduleBadge,
  scheduleDaysText,
  Panel,
  PortfolioFilterBar,
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
  isPortfolioTabId,
  panelDomId,
  tabDomId,
  type ReportsTabId,
} from "./portfolioTabs";
import { TimesheetCoveragePanel } from "./TimesheetCoveragePanel";
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
  // strip's, which is the portfolio sections PLUS the coverage report.
  const [tab, setTab] = useState<ReportsTabId>(DEFAULT_TAB);

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

  /** Which strip is on screen: the six portfolio sections, or the coverage report. */
  const coverageTab = tab === "timesheet-coverage";

  return (
    <>
      {/* The FILTER BAR belongs to the report on screen. The portfolio bar's dimensions (projects
          and WBS of the job-order register, band, budget, activity window, as-of) mean nothing to a
          timesheet-coverage report, and drawing it above that report would invite the reader to
          believe it filtered it. So the coverage report carries its own controls — a period plus the
          organisation scope — and the portfolio bar returns with the portfolio sections. */}
      {coverageTab ? null : (
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

      {coverageTab ? null : error && <div className="error-banner">{error}</div>}
      {coverageTab ? null : downloadError && <div className="error-banner">{downloadError}</div>}
      {coverageTab ? null : downloadNotice && <div className="alloc-note">{downloadNotice}</div>}

      {coverageTab ? (
        <>
          <ReportTabs
            tabs={REPORTS_TABS}
            active={tab}
            counts={tabCounts}
            onChange={(id) => {
              if (isPortfolioTabId(id)) setTab(id);
              else if (id === "timesheet-coverage") setTab("timesheet-coverage");
            }}
          />
          <div className="pf-tabpanel" role="tabpanel" id={panelDomId(tab)} aria-labelledby={tabDomId(tab)}>
            <TimesheetCoveragePanel />
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
            tabs={REPORTS_TABS}
            active={tab}
            counts={tabCounts}
            onChange={(id) => {
              if (isPortfolioTabId(id) || id === "timesheet-coverage") setTab(id);
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
