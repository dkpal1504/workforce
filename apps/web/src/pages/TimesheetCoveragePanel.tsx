import { Fragment, useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { api, getToken } from "../api/client";
import { MultiSelectFilter } from "./MultiSelectFilter";
import type { DepartmentOption, ProjectOption, SectionOption } from "./PortfolioDashboardPage";
import { applyProjectColorVars, projectColorToken } from "../theme/projectColors";
import "../styles/portfolio.css";

/**
 * TIMESHEET COVERAGE BY DATE — the report behind the Reports screen's "Timesheet coverage" tab.
 *
 * WHAT THE SCREEN SHOWS, in the order an operator needs it:
 *   1. the PERIOD and the scope controls;
 *   2. the COVERAGE table (Department > Section: employees, employee-days, filled, not filled, %),
 *      because the question asked of this report is "who was not covered", not "show me the hours";
 *   3. the DETAIL rows — one per (date x employee), every employee in scope for every date, with
 *      "Not Filled" where no sheet exists — paged at 50.
 *
 * WHY THE DETAIL IS PAGED SERVER-SIDE (the one place in this app that is): the row count is
 * `employees x days` — 500 people over a month is 15,500 rows — so the alternative is shipping
 * megabytes of JSON for one screenful. The coverage figures are computed over ALL rows before the
 * page is cut, so the summary does not change as the operator pages.
 *
 * WHY THE DATE RANGE IS REQUIRED: there is no sensible default period, and a report that silently
 * picked one would be quoted as if it covered everything. The screen opens on the current month to
 * date — a real period, stated on screen, and changed by the operator in two clicks.
 */

type CoverageStatus = "Draft" | "Submitted" | "HOD Approved" | "Approved" | "Not Filled";

/** The Approval Status filter's menu: the four stages in order, then the gap. The id IS the label the
 *  API matches on, so nothing can drift between the menu, the query string and the report. */
const COVERAGE_STATUS_OPTIONS: Array<{ id: CoverageStatus; label: string; detail: string }> = [
  { id: "Not Filled", label: "Not Filled", detail: "no timesheet at all — the gap" },
  { id: "Draft", label: "Draft", detail: "draft, rejected or sent back" },
  { id: "Submitted", label: "Submitted", detail: "with the HOD" },
  { id: "HOD Approved", label: "HOD Approved", detail: "with the PM" },
  { id: "Approved", label: "Approved", detail: "approved by the PM" },
];

type CoverageRow = {
  date: string;
  department: { id: number; name: string };
  section: { id: number; name: string } | null;
  supervisors: string[];
  employee: { id: number; ecNo: string; name: string };
  projectHours: Record<string, number>;
  projectOtHours: Record<string, number>;
  regularTotal: number;
  otTotal: number;
  totalHours: number;
  overheads: number;
  combinedHours: number;
  status: CoverageStatus;
};

type CoverageBucket = {
  department: { id: number; name: string };
  section: { id: number; name: string } | null;
  employees: number;
  employeeDays: number;
  filledDays: number;
  notFilledDays: number;
  employeesWithFilledDay: number;
  employeesWithNoFilledDay: number;
  filledPct: number;
};

export type TimesheetCoverageReport = {
  from: string;
  to: string;
  days: string[];
  generatedAt: string;
  provenance: { filters: Array<{ label: string; value: string }>; scope: string; generatedBy: { id: number; name: string; role: string } };
  definitions: {
    statuses: Array<{ status: CoverageStatus; meaning: string }>;
    hours: { regular: string; overtime: string; overheads: string; combined: string; maxDailyHours: number };
    population: string;
    duplicateSheets: string;
    notes: string[];
  };
  projects: Array<{ colorKey: string; name: string }>;
  rows: CoverageRow[];
  rowTotal: number;
  page: number;
  pageSize: number;
  pageCount: number;
  coverage: CoverageBucket[];
  totals: {
    employees: number;
    employeeDays: number;
    filledDays: number;
    notFilledDays: number;
    employeesWithNoFilledDay: number;
    filledPct: number;
  };
  maxDailyHours: number;
};

/** A fraction as a whole/decimal percent — `0.87` -> `87.0%`. Always finite; `—` never appears. */
export function fmtCoveragePct(value: number): string {
  if (!Number.isFinite(value)) return "0.0%";
  return `${(value * 100).toFixed(1)}%`;
}

/** Today as `YYYY-MM-DD` in LOCAL time — the operator's day, not UTC's. */
function todayIso(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60 * 1000);
  return local.toISOString().slice(0, 10);
}

/** The first day of the current month, as `YYYY-MM-DD`. */
function monthStartIso(): string {
  return `${todayIso().slice(0, 7)}-01`;
}

/** The status pill class: an unfilled day is the finding, so it reads as a warning, not as a value. */
function statusTone(status: CoverageStatus): "GREEN" | "AMBER" | "NOT_MEASURABLE" {
  if (status === "Approved" || status === "HOD Approved") return "GREEN";
  if (status === "Submitted" || status === "Draft") return "AMBER";
  return "NOT_MEASURABLE";
}

export function TimesheetCoveragePanel() {
  const [from, setFrom] = useState(monthStartIso);
  const [to, setTo] = useState(todayIso);
  const [departmentIds, setDepartmentIds] = useState<number[]>([]);
  const [sectionIds, setSectionIds] = useState<number[]>([]);
  const [projectIds, setProjectIds] = useState<number[]>([]);
  // The Approval Status filter. It narrows the DETAIL rows only — see the panel's own note, which
  // says so in words, because a filtered table under an unfiltered summary invites the wrong reading.
  const [statuses, setStatuses] = useState<CoverageStatus[]>([]);
  const [page, setPage] = useState(1);

  const [departments, setDepartments] = useState<DepartmentOption[]>([]);
  const [sections, setSections] = useState<SectionOption[]>([]);
  const [projects, setProjects] = useState<ProjectOption[]>([]);

  const [report, setReport] = useState<TimesheetCoverageReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  /** The one query string both the JSON fetch and the download use — they cannot diverge. */
  const query = useMemo(() => {
    const params = new URLSearchParams();
    params.set("from", from);
    params.set("to", to);
    if (departmentIds.length) params.set("departmentIds", departmentIds.join(","));
    if (sectionIds.length) params.set("sectionIds", sectionIds.join(","));
    if (projectIds.length) params.set("projectIds", projectIds.join(","));
    // Sent in the report's own vocabulary order, so the URL does not depend on ticking order and the
    // export's provenance matches the screen exactly.
    if (statuses.length) params.set("statuses", COVERAGE_STATUS_OPTIONS.filter((o) => statuses.includes(o.id)).map((o) => o.id).join(","));
    return `?${params.toString()}`;
  }, [from, to, departmentIds, sectionIds, projectIds, statuses]);

  // The pickers. Their failure must not blank the report, so it is caught separately.
  useEffect(() => {
    void (async () => {
      try {
        const [departmentData, sectionData, projectData] = await Promise.all([
          api<{ departments: DepartmentOption[] }>("/departments"),
          api<{ sections: SectionOption[] }>("/sections"),
          api<{ projects: ProjectOption[] }>("/projects"),
        ]);
        setDepartments(departmentData.departments);
        setSections(sectionData.sections);
        setProjects(projectData.projects);
      } catch {
        /* the report still renders with the period alone */
      }
    })();
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await api<TimesheetCoverageReport>(`/reports/timesheet-coverage${query}&page=${page}`);
      setReport(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to build the coverage report.");
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [query, page]);

  useEffect(() => {
    void load();
  }, [load]);

  // Publish `--project-<key>` for the columns on screen, so a project that is not in the curated
  // palette still resolves to its own colour instead of a blank header.
  useEffect(() => {
    if (report) applyProjectColorVars(report.projects.map((project) => project.colorKey));
  }, [report]);

  // A change of PERIOD or SCOPE resets to page 1: a page index only means something for the result
  // set it was chosen against.
  useEffect(() => {
    setPage(1);
  }, [query]);

  async function download() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const token = getToken();
      // SAME query string as the fetch, and deliberately WITHOUT the page: the download is always
      // the whole period.
      const res = await fetch(`/api/reports/timesheet-coverage.xlsx${query}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        let message = `Download failed (${res.status}).`;
        try {
          const body = await res.json();
          if (body && typeof body.error === "string") message = body.error;
        } catch {
          /* keep the status message */
        }
        throw new Error(message);
      }
      const disposition = res.headers.get("Content-Disposition") || "";
      const match = /filename="?([^";]+)"?/i.exec(disposition);
      const filename = match ? match[1] : `timesheet-coverage.xlsx`;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
      setNotice(`Saved ${filename} — it carries the same period and scope as this screen.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Download failed.");
    } finally {
      setBusy(false);
    }
  }

  const scopedSections = departmentIds.length ? sections.filter((row) => departmentIds.includes(row.departmentId)) : sections;
  const totals = report?.totals;

  return (
    <>
      <div className="pf-filters pf-filters--coverage">
        <div className="filter-field">
          <label>From</label>
          <input type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} />
        </div>
        <div className="filter-field">
          <label>To</label>
          <input type="date" value={to} min={from} onChange={(event) => setTo(event.target.value)} />
        </div>
        <MultiSelectFilter
          label="Department"
          allLabel="All departments"
          options={departments.map((department) => ({ id: department.id, label: department.name }))}
          selected={departmentIds}
          onChange={(next) => {
            setDepartmentIds(next.map(Number));
            // A Section belongs to one Department, so the Sections that no longer apply are dropped
            // rather than left to build a filter that matches nothing.
            setSectionIds([]);
          }}
          searchPlaceholder="Search department…"
        />
        <MultiSelectFilter
          label="Section"
          allLabel="All sections"
          options={scopedSections.map((section) => ({ id: section.id, label: `${section.code} · ${section.name}` }))}
          selected={sectionIds}
          onChange={(next) => setSectionIds(next.map(Number))}
          searchPlaceholder="Search section…"
        />
        <MultiSelectFilter
          label="Projects (columns)"
          allLabel="All projects"
          options={projects.map((project) => ({ id: project.id, label: project.code, detail: project.name }))}
          selected={projectIds}
          onChange={(next) => setProjectIds(next.map(Number))}
        />
        {/* The Approval Status filter sits beside Projects, because those two are the same kind of
            choice: Projects picks the COLUMNS, this one picks which ROWS are listed. */}
        <MultiSelectFilter
          label="Approval status"
          allLabel="All statuses"
          options={COVERAGE_STATUS_OPTIONS}
          selected={statuses}
          onChange={(next) => setStatuses(next.map(String) as CoverageStatus[])}
        />
        <div className="pf-filters__actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void load()} disabled={loading}>
            {loading ? "Building…" : "Generate report"}
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void download()} disabled={busy || !report}>
            {busy ? "Preparing…" : "Download Excel"}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setFrom(monthStartIso());
              setTo(todayIso());
              setDepartmentIds([]);
              setSectionIds([]);
              setProjectIds([]);
              setStatuses([]);
            }}
          >
            Reset to this month
          </button>
          <span className="pf-filters__hint">
            Every active contract employee in scope is listed for every date in the period — an employee with no
            timesheet is a row reading “Not Filled”. Sections follow the Department; the Project filter chooses which
            project columns appear; Approval status narrows the detail rows (pick “Not Filled” to see only the gap).
          </span>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="alloc-note">{notice}</div>}

      {loading && !report ? (
        <div className="loading-state">Building the coverage report…</div>
      ) : report ? (
        <>
          <section className="pf-hero" aria-label="Coverage headline figures">
            <article className="pf-hero__card">
              <div className="pf-hero__lab">
                Employees in scope
                <span className="pf-hero__lab-note">{report.days.length} day(s)</span>
              </div>
              <div className="pf-hero__mid">{totals?.employees.toLocaleString()}</div>
              <div className="pf-hero__note">
                Every active contract employee in scope, listed for every date — {totals?.employeeDays.toLocaleString()} rows.
              </div>
            </article>
            <article className="pf-hero__card">
              <div className="pf-hero__lab">Employee-days filled</div>
              <div className="pf-hero__mid">
                {totals?.filledDays.toLocaleString()}
                <small>of {totals?.employeeDays.toLocaleString()}</small>
              </div>
              <div className="pf-hero__note">{fmtCoveragePct(totals?.filledPct ?? 0)} of the period is accounted for.</div>
            </article>
            <article className="pf-hero__card">
              <div className="pf-hero__lab">Not covered at all</div>
              <div className="pf-hero__mid pf-hero__mid--warn">{totals?.employeesWithNoFilledDay.toLocaleString()}</div>
              <div className="pf-hero__note">
                Employees with NO filled day anywhere in the period — the population this report exists for.
              </div>
            </article>
          </section>

          <section className="panel pf-panel">
            <div className="panel__header">
              <span>Coverage by Department &amp; Section</span>
              <span className="panel__count">{report.coverage.length}</span>
            </div>
            <p className="pf-panel__hint" style={{ padding: "10px 14px 0", margin: 0 }}>
              Counted over the whole period, from the same rows as the detail below. “Employees” is the roster;
              “employee-days” is the exposure (people × dates), so a person with one filled day out of twenty still
              leaves nineteen unfilled days.
            </p>
            {report.coverage.length === 0 ? (
              <div className="empty-state">No active contract employee is in scope for this period.</div>
            ) : (
              <div className="pf-table-wrap">
                <table className="pf-table pf-table--compact pf-table--coverage">
                  <thead>
                    <tr>
                      <th className="pf-th--id">Department</th>
                      <th className="pf-th--id">Section</th>
                      <th className="pf-num pf-th--roster">Employees</th>
                      <th className="pf-num pf-th--roster">Employee-days</th>
                      <th className="pf-num pf-th--filled">Filled</th>
                      <th className="pf-num pf-th--gap">Not filled</th>
                      <th className="pf-num pf-th--filled">Filled %</th>
                      <th className="pf-num pf-th--filled">With ≥1 filled day</th>
                      <th className="pf-num pf-th--gap">No filled day</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.coverage.map((bucket) => (
                      <tr key={`${bucket.department.id}-${bucket.section?.id ?? "none"}`}>
                        <td className="pf-cell-strong">{bucket.department.name}</td>
                        <td>{bucket.section?.name ?? "No section"}</td>
                        <td className="pf-num">{bucket.employees}</td>
                        <td className="pf-num">{bucket.employeeDays}</td>
                        <td className="pf-num">{bucket.filledDays}</td>
                        <td className="pf-num">{bucket.notFilledDays}</td>
                        <td className="pf-num">{fmtCoveragePct(bucket.filledPct)}</td>
                        <td className="pf-num">{bucket.employeesWithFilledDay}</td>
                        <td className="pf-num">{bucket.employeesWithNoFilledDay}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="panel pf-panel">
            <div className="panel__header">
              <span>Timesheet detail — one row per employee per date</span>
              <span className="panel__count">
                {report.rowTotal.toLocaleString()} row(s)
                {/* The filter is named on the count itself: a number that changes under a filter must
                    say that it did, or the whole roster is read as the filtered set. */}
                {statuses.length > 0 && <em className="pf-count-note"> — {statuses.join(", ")} only</em>}
              </span>
            </div>
            <p className="pf-panel__hint" style={{ padding: "10px 14px 0", margin: 0 }}>
              {report.definitions.population} {report.definitions.duplicateSheets}
              {statuses.length > 0 && (
                <>
                  {" "}
                  <strong>
                    The Approval Status filter lists {statuses.join(", ")} rows here; the headline figures and the coverage
                    table above still count the whole roster.
                  </strong>
                </>
              )}
            </p>
            {report.rows.length === 0 ? (
              <div className="empty-state">Nothing to list for this period.</div>
            ) : (
              <div className="pf-table-wrap">
                <table className="pf-table pf-table--grouped">
                  <thead>
                    <tr>
                      <th className="pf-th--id">Date</th>
                      <th className="pf-th--id">Department</th>
                      <th className="pf-th--id">Section</th>
                      <th className="pf-th--id">Supervisor</th>
                      <th className="pf-th--id">Employee</th>
                      {report.projects.map((project) => (
                        <th
                          key={project.colorKey}
                          className="pf-num pf-th--project"
                          colSpan={2}
                          // The column group wears the SAME colour the project already has everywhere
                          // else in the app (`--project-<key>`), so a reader who knows MV AINA is teal
                          // on the allocations grid recognises it here without reading the label.
                          style={{ "--col-tone": projectColorToken(project.colorKey) } as CSSProperties}
                        >
                          {project.name}
                        </th>
                      ))}
                      <th className="pf-num pf-th--total" colSpan={3}>
                        Total project hours
                      </th>
                      <th className="pf-num pf-th--overheads">Overheads</th>
                      <th className="pf-num pf-th--combined">Combined</th>
                      <th className="pf-th--status">Approval status</th>
                    </tr>
                    <tr>
                      <th className="pf-th--id" />
                      <th className="pf-th--id" />
                      <th className="pf-th--id" />
                      <th className="pf-th--id" />
                      <th className="pf-th--id" />
                      {report.projects.map((project) => (
                        <Fragment key={project.colorKey}>
                          <th
                            className="pf-num pf-th--project pf-th--sub"
                            style={{ "--col-tone": projectColorToken(project.colorKey) } as CSSProperties}
                          >
                            Regular
                          </th>
                          <th
                            className="pf-num pf-th--project pf-th--sub"
                            style={{ "--col-tone": projectColorToken(project.colorKey) } as CSSProperties}
                          >
                            OT
                          </th>
                        </Fragment>
                      ))}
                      <th className="pf-num pf-th--total pf-th--sub">Regular</th>
                      <th className="pf-num pf-th--total pf-th--sub">OT</th>
                      <th className="pf-num pf-th--total pf-th--sub">Total</th>
                      <th className="pf-th--overheads pf-th--sub" />
                      <th className="pf-th--combined pf-th--sub" />
                      <th className="pf-th--status pf-th--sub" />
                    </tr>
                  </thead>
                  <tbody>
                    {report.rows.map((row) => (
                      <tr key={`${row.employee.id}-${row.date}`}>
                        <td className="pf-nowrap">{row.date}</td>
                        <td>{row.department.name}</td>
                        <td>{row.section?.name ?? "No section"}</td>
                        <td>{row.supervisors.length ? row.supervisors.join(", ") : "—"}</td>
                        <td>
                          <span className="pf-cell-strong">{row.employee.name}</span>
                          <span className="pf-cell-sub">{row.employee.ecNo}</span>
                        </td>
                        {report.projects.map((project) => (
                          <Fragment key={project.colorKey}>
                            <td className="pf-num">{row.projectHours[project.colorKey] ?? 0}</td>
                            <td className="pf-num">{row.projectOtHours[project.colorKey] ?? 0}</td>
                          </Fragment>
                        ))}
                        <td className="pf-num">{row.regularTotal}</td>
                        <td className="pf-num">{row.otTotal}</td>
                        <td className="pf-num">{row.totalHours}</td>
                        <td className="pf-num">{row.overheads}</td>
                        <td className="pf-num">{row.combinedHours}</td>
                        <td>
                          <span className={`pf-badge pf-badge--${statusTone(row.status)}`}>{row.status}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {report.pageCount > 1 && (
                  <div className="pf-pager">
                    <span className="pf-pager__info">
                      Showing {(report.page - 1) * report.pageSize + 1}-{Math.min(report.page * report.pageSize, report.rowTotal)} of{" "}
                      {report.rowTotal.toLocaleString()} rows
                    </span>
                    <div className="pf-pager__controls">
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={report.page <= 1}
                        onClick={() => setPage(report.page - 1)}
                      >
                        Previous
                      </button>
                      <span className="pf-pager__info">
                        Page {report.page} of {report.pageCount}
                      </span>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={report.page >= report.pageCount}
                        onClick={() => setPage(report.page + 1)}
                      >
                        Next
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>

          <section className="panel pf-panel">
            <div className="panel__header">
              <span>How to read this report</span>
              <span className="panel__count">
                {report.from} → {report.to}
              </span>
            </div>
            <div className="pf-basis">
              {report.provenance.filters.map((entry) => (
                <div key={entry.label}>
                  <div className="pf-basis__label">{entry.label}</div>
                  <div className="pf-basis__value">{entry.value}</div>
                </div>
              ))}
              <div>
                <div className="pf-basis__label">Scope</div>
                <div className="pf-basis__value">{report.provenance.scope}</div>
              </div>
              <div>
                <div className="pf-basis__label">Generated by</div>
                <div className="pf-basis__value">
                  {report.provenance.generatedBy.name} ({report.provenance.generatedBy.role})
                </div>
              </div>
              <div>
                <div className="pf-basis__label">Hours are defined as</div>
                <div className="pf-basis__value">
                  {report.definitions.hours.regular} {report.definitions.hours.overtime} {report.definitions.hours.overheads}{" "}
                  {report.definitions.hours.combined}
                </div>
              </div>
              <ul className="pf-basis__notes">
                {report.definitions.statuses.map((entry) => (
                  <li key={entry.status}>
                    <b>{entry.status}</b> — {entry.meaning}
                  </li>
                ))}
                {report.definitions.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </div>
          </section>
        </>
      ) : (
        <div className="empty-state">Pick a period and generate the report.</div>
      )}
    </>
  );
}
