import { useEffect, useState } from "react";
import { api } from "../api/client";
import {
  BandBadge,
  ExceptionCard,
  JobIdentityCell,
  Panel,
  PortfolioFilterBar,
  ReasonsCell,
  downloadPortfolioFile,
  fmtDate,
  fmtDateTime,
  fmtHours,
  fmtNumber,
  fmtPct,
  useFilterUrlSync,
  usePortfolioReport,
  type DepartmentOption,
  type ProjectOption,
  type SectionOption,
  type WbsOption,
} from "./PortfolioDashboardPage";
import { defaultFilters, decodeFilters, type PortfolioFilterState } from "./portfolioFilters";
import "../styles/portfolio.css";

/**
 * Reports (/reports) — the SAME six datasets as the /portfolio dashboard, presented
 * TABLE-FIRST so the screen can be read top-to-bottom and taken away.
 *
 * The two screens share ONE filter bar component and ONE fetch hook, so they always ask
 * the API for the same scope. The Download Excel / Download PDF buttons here carry the
 * IDENTICAL query string the report below was built from — both come from the pure
 * `portfolioQuery()` helper, which the tests pin.
 *
 * There are no KPI tiles here on purpose: the dashboard answers "what needs attention",
 * this screen answers "give me the rows". The numbers are the same because the data is.
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

  const { report, loading, error, query } = usePortfolioReport(filters);

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
        extra={downloads}
      />

      {error && <div className="error-banner">{error}</div>}
      {downloadError && <div className="error-banner">{downloadError}</div>}
      {downloadNotice && <div className="alloc-note">{downloadNotice}</div>}

      {loading && !report ? (
        <div className="loading-state">Building the report…</div>
      ) : report ? (
        <>
          {/* ---- Scope statement + the download actions (table-first, take-away) ---- */}
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

          {/* ---- Needs push (full list, reasons in full) ---- */}
          <Panel
            title="Needs push"
            count={`${report.needsPush.length} of ${report.needsPushTotal}`}
            hint="Ranked by attention score. The REASONS column states why a row is here, in full."
          >
            {report.needsPush.length === 0 ? (
              <div className="empty-state">No job order in scope carries an attention signal.</div>
            ) : (
              <div className="pf-table-wrap">
                <table className="pf-table">
                  <thead>
                    <tr>
                      <th>Job order</th>
                      <th>Department</th>
                      <th>Band</th>
                      <th className="pf-num">Budget h</th>
                      <th className="pf-num">Actual h</th>
                      <th className="pf-num">Burn</th>
                      <th>Forecast exhausted</th>
                      <th className="pf-num">Attention</th>
                      <th>Reasons</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.needsPush.map((row) => (
                      <tr key={row.id}>
                        <JobIdentityCell row={row} />
                        <td>{row.department.name}</td>
                        <td>
                          <BandBadge band={row.hoursBand} />
                        </td>
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
              </div>
            )}
          </Panel>

          {/* ---- On track ---- */}
          <Panel title="On track" count={report.onTrack.length} hint="Measurable on hours, under 75% burn.">
            {report.onTrack.length === 0 ? (
              <div className="empty-state">No measurable job order is under 75% burn.</div>
            ) : (
              <div className="pf-table-wrap">
                <table className="pf-table pf-table--compact">
                  <thead>
                    <tr>
                      <th>Job order</th>
                      <th>Department</th>
                      <th>Band</th>
                      <th className="pf-num">Budget h</th>
                      <th className="pf-num">Actual h</th>
                      <th className="pf-num">Burn</th>
                      <th>Last booking</th>
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

          {/* ---- On track, not yet measurable (SEPARATE — never mixed into GREEN) ---- */}
          <Panel
            title="On track — not yet measurable"
            count={report.onTrackNotMeasurable.length}
            hint="Job orders with no budget in force. Kept apart from the GREEN rows so a green figure is never borrowed from missing data."
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
                      <th className="pf-num">Target qty</th>
                      <th className="pf-num">Achieved</th>
                      <th>Last booking</th>
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
                        <td className="pf-num">
                          {fmtNumber(row.targetQty, 2)}
                          {row.uom ? <span className="pf-cell-sub">{row.uom}</span> : null}
                        </td>
                        <td className="pf-num">{fmtNumber(row.achievedQty, 2)}</td>
                        <td className="pf-nowrap">{fmtDate(row.lastBooking)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          {/* ---- Job work ---- */}
          <Panel
            title="Job work"
            count={report.jobWork.length}
            hint="Every job order in scope. Hours and quantity are separate measures and are never added together."
          >
            {report.jobWork.length === 0 ? (
              <div className="empty-state">No job order matches the current filters.</div>
            ) : (
              <div className="pf-table-wrap">
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
                      <th className="pf-num">Target qty</th>
                      <th className="pf-num">Achieved qty</th>
                      <th className="pf-num">Qty %</th>
                      <th>Last booking</th>
                      <th className="pf-num">Unapproved h</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.jobWork.map((row) => (
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
                        <td className="pf-num">{row.measurableOnQuantity ? fmtPct(row.qtyPct) : "—"}</td>
                        <td className="pf-nowrap">{fmtDate(row.lastBooking)}</td>
                        <td className="pf-num">{fmtHours(row.unapprovedHours)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          {/* ---- Department load ---- */}
          <Panel title="Department load" count={report.departmentLoad.length}>
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
                      <th className="pf-num">Budget h</th>
                      <th className="pf-num">Actual h</th>
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
                columns={(row) => [
                  row.displayName,
                  `${fmtHours(row.unapprovedHours)}${row.oldestUnapprovedAt ? ` since ${fmtDate(row.oldestUnapprovedAt)}` : ""}`,
                ]}
              />
            </div>
          </Panel>
        </>
      ) : (
        <div className="empty-state">The report could not be loaded. Adjust or reset the filters and try again.</div>
      )}
    </>
  );
}
