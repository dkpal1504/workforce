import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { todayDateString } from "../utils/date";
import "../styles/summary.css";

type Project = { id: number; code: string; name: string; colorKey: string; sortOrder?: number };
type Row = {
  srNo: number;
  name: string;
  department: string;
  values: Record<string, number>;
  projectOtValues: Record<string, number>;
  total: number;
  overheadHours?: number;
  overheadCost?: number;
};

type GroupBy = "employee" | "supervisor" | "department" | "totals";
type View = "hours" | "cost";
type Frequency = "daily" | "weekly" | "monthly";
type Tab = "project" | "jobOrder";
type JoStatus = "all" | "active" | "inactive";

const JO_STATUS_OPTIONS: { value: JoStatus; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "In-Active" },
];

type Department = { id: number; name: string; code: string };

type JoRow = {
  id: number;
  srNo: number;
  code: string;
  name: string;
  status: string; // active | inactive
  /** The WBS row that disambiguates a repeated Job Order number. */
  wbsId: number;
  wbsCode: string;
  wbsName: string | null;
  /** Unit of measure for the quantity columns; hours are always hours. */
  uom: string;
  // Hours - an independent measure of the approved booked hours.
  budgetedHours: number;
  consumption: number;
  consumptionPct: number;
  balance: number;
  // Quantity - an independent measure of the effective-dated budget and the
  // approved cumulative progress.
  budgetedQuantity: number;
  achievedQuantity: number;
  progressReported: boolean;
  balanceQuantity: number;
  quantityPct: number;
  // Which budget revision supplied the row, for the cell tooltip.
  budgetSource: "revision" | "current";
  budgetRevisionNo: number | null;
  budgetEffectiveFrom: string | null;
  budgetWorkDate: string;
};
type JoWbsGroup = {
  wbsId: number;
  wbsCode: string;
  wbsName: string | null;
  rows: JoRow[];
};
type JoGroup = {
  projectId: number;
  projectName: string;
  projectCode: string;
  projectColorKey: string;
  sortOrder: number;
  wbsGroups: JoWbsGroup[];
};

export function SummaryPage() {
  const { user } = useAuth();
  const employeeView = user?.role === "EMPLOYEE";
  const canViewCost = ["HOD", "DEPT_HEAD", "PM", "FINANCE", "ADMIN"].includes(user?.role ?? "");
  const [tab, setTab] = useState<Tab>("project");

  // Project Summary state
  const [date, setDate] = useState(todayDateString);
  const [frequency, setFrequency] = useState<Frequency>("daily");
  const [groupBy, setGroupBy] = useState<GroupBy>("supervisor");
  const [view, setView] = useState<View>("hours");
  const [allProjects, setAllProjects] = useState<Project[]>([]);
  // Selected project colorKey codes (A/B/C/D/…) — the unified identity across
  // both WBS and JobOrder tagging paths. Numeric ids differ between the two
  // models, so the filter uses colorKey codes to match the backend.
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [totals, setTotals] = useState<Record<string, number>>({});
  const [projectOtTotals, setProjectOtTotals] = useState<Record<string, number>>({});
  const [grandTotal, setGrandTotal] = useState(0);
  const [overheadTotal, setOverheadTotal] = useState(0);
  const [sortKey, setSortKey] = useState<string>("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [error, setError] = useState("");

  // Job Order Summary state
  const [joGroups, setJoGroups] = useState<JoGroup[]>([]);
  const [joSelectedProjectIds, setJoSelectedProjectIds] = useState<number[]>([]);
  const [joStatus, setJoStatus] = useState<JoStatus>("all");
  const [joDepartmentId, setJoDepartmentId] = useState<number | "all">("all");
  const [joDepartments, setJoDepartments] = useState<Department[]>([]);
  const [joError, setJoError] = useState("");
  const [joLoading, setJoLoading] = useState(false);

  // One Project master list for both tabs. The Project filter is keyed by the
  // Project's `color_key` and ordered by its sort order.
  useEffect(() => {
    api<{ projects: Project[] }>("/projects").then((d) =>
      setAllProjects(
        d.projects.map((p) => ({ id: p.id, code: p.code, name: p.name, colorKey: p.colorKey }))
      )
    );
  }, []);

  useEffect(() => {
    if (employeeView) { setGroupBy("employee"); setView("hours"); }
  }, [employeeView]);

  // The Job Order Summary Department filter is the only extra lookup it needs; the
  // Project list comes from the shared master list above.
  useEffect(() => {
    if (tab !== "jobOrder") return;
    api<{ departments: Department[] }>("/departments").then((d) => setJoDepartments(d.departments));
  }, [tab]);

  const load = useCallback(async () => {
    setError("");
    try {
      const qs = new URLSearchParams({
        date,
        frequency,
        groupBy,
        view,
      });
      if (selectedProjectIds.length) qs.set("projectIds", selectedProjectIds.join(","));
      const data = await api<{
        projects: Project[];
        rows: Row[];
        totals: Record<string, number>;
        projectOtTotals: Record<string, number>;
        grandTotal: number;
        overheadTotalHours?: number;
        overheadTotalCost?: number;
      }>(`/summary?${qs.toString()}`);
      setProjects(data.projects);
      setRows(data.rows);
      setTotals(data.totals);
      setProjectOtTotals(data.projectOtTotals ?? {});
      setGrandTotal(data.grandTotal);
      setOverheadTotal(view === "cost" ? data.overheadTotalCost ?? 0 : data.overheadTotalHours ?? 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load summary");
    }
  }, [date, frequency, groupBy, view, selectedProjectIds]);

  useEffect(() => {
    if (tab === "project") load();
  }, [tab, load]);

  const loadJo = useCallback(async () => {
    if (tab !== "jobOrder") return;
    setJoError("");
    setJoLoading(true);
    try {
      const qs = new URLSearchParams({ status: joStatus });
      if (joSelectedProjectIds.length) qs.set("projectIds", joSelectedProjectIds.join(","));
      if (joDepartmentId !== "all") qs.set("departmentId", String(joDepartmentId));
      const data = await api<{ groups: JoGroup[] }>(`/summary/job-order?${qs.toString()}`);
      setJoGroups(data.groups ?? []);
    } catch (e) {
      setJoError(e instanceof Error ? e.message : "Failed to load job order summary");
    } finally {
      setJoLoading(false);
    }
  }, [tab, joStatus, joSelectedProjectIds, joDepartmentId]);

  useEffect(() => {
    if (tab === "jobOrder") loadJo();
  }, [tab, loadJo]);

  const nameHeader =
    groupBy === "employee"
      ? "Employee"
      : groupBy === "department"
        ? "Department"
        : groupBy === "totals"
          ? "Group"
          : "Supervisor";

  const sortedRows = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      let av: string | number = a.name;
      let bv: string | number = b.name;
      if (sortKey === "department") {
        av = a.department;
        bv = b.department;
      } else if (sortKey === "total") {
        av = a.total;
        bv = b.total;
      } else if (sortKey.startsWith("proj:")) {
        const code = sortKey.slice(5);
        av = a.values[code] || 0;
        bv = b.values[code] || 0;
      } else if (sortKey.startsWith("projectOt:")) {
        const code = sortKey.slice(10);
        av = a.projectOtValues[code] || 0;
        bv = b.projectOtValues[code] || 0;
      }
      if (typeof av === "number" && typeof bv === "number") {
        return sortDir === "asc" ? av - bv : bv - av;
      }
      return sortDir === "asc"
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    });
    return copy.map((r, i) => ({ ...r, srNo: i + 1 }));
  }, [rows, sortKey, sortDir]);

  function toggleSort(key: string) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  function formatVal(n: number) {
    if (view === "cost") return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
    return String(n);
  }

  // Hours and quantity are formatted by separate helpers so the two measures can
  // never be read as one figure.
  function joHours(n: number) {
    return `${n.toLocaleString()} hrs`;
  }

  function joHoursBalance(n: number) {
    return n < 0 ? `(${Math.abs(n).toLocaleString()} hrs)` : `${n.toLocaleString()} hrs`;
  }

  function joQuantity(n: number, uom: string | null) {
    const value = n.toLocaleString(undefined, { maximumFractionDigits: 2 });
    return uom ? `${value} ${uom}` : value;
  }

  function joQuantityBalance(n: number, uom: string | null) {
    return n < 0 ? `(${joQuantity(Math.abs(n), uom)})` : joQuantity(n, uom);
  }

  // The Budgeted cells carry the revision the figure came from, so an
  // effective-dated budget is auditable from the screen.
  function budgetBasisTitle(r: JoRow) {
    const basis =
      r.budgetSource === "revision"
        ? `Budget revision ${r.budgetRevisionNo} effective ${r.budgetEffectiveFrom}`
        : "Job Order's own budget (no revision in force)";
    return `${basis} · work date ${r.budgetWorkDate}`;
  }

  function consumptionColorClass(pct: number) {
    if (pct < 85) return "jo-bar--green";
    if (pct < 100) return "jo-bar--amber";
    return "jo-bar--red";
  }

  function consumptionLabelClass(pct: number) {
    if (pct < 85) return "jo-bar-label--green";
    if (pct < 100) return "jo-bar-label--amber";
    return "jo-bar-label--red";
  }

  return (
    <>
      {employeeView && <div className="carry-banner">Only your final approved My Hours are shown.</div>}
      {user?.capabilities.viewDepartmentSummary && !user?.sectionId && !employeeView && (
        <div className="carry-banner">
          Department-wide view: approved hours for every Section of {user?.department?.name ?? "your Department"}.
          Hours still with a Section HOD are not included.
        </div>
      )}
      {/* Tab bar — Project Summary | Job Order Summary */}
      <div className="hod-tabs" role="tablist" aria-label="Summary views">
        <button
          type="button"
          role="tab"
          className={`hod-tab ${tab === "project" ? "active" : ""}`}
          aria-selected={tab === "project"}
          onClick={() => setTab("project")}
        >
          Project Summary
        </button>
        {!employeeView && <button
          type="button"
          role="tab"
          className={`hod-tab ${tab === "jobOrder" ? "active" : ""}`}
          aria-selected={tab === "jobOrder"}
          onClick={() => setTab("jobOrder")}
        >
          Job Order Summary
        </button>}
      </div>

      {tab === "project" && (
        <>
          <div className="filter-row">
            <div className="filter-field">
              <label>Frequency</label>
              <select value={frequency} onChange={(e) => setFrequency(e.target.value as Frequency)}>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </div>
            <div className="filter-field">
              <label>Select Projects</label>
              <select
                value={selectedProjectIds.length ? selectedProjectIds.join(",") : "all"}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "all") setSelectedProjectIds([]);
                  else setSelectedProjectIds(v.split(","));
                }}
              >
                <option value="all">All Projects</option>
                {allProjects.map((p) => (
                  <option key={p.id} value={p.colorKey}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="filter-field">
              <label>Date</label>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
          </div>

          <div className="summary-toggles">
            {!employeeView && <div className="toggle-group">
              {(
                [
                  ["employee", "Group by Employee"],
                  ["supervisor", "Group by Supervisor"],
                  ["department", "Group by Department"],
                  ["totals", "Totals"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className={groupBy === key ? "active" : ""}
                  onClick={() => setGroupBy(key)}
                >
                  {label}
                </button>
              ))}
            </div>}
            <div className="toggle-group">
              <button type="button" className={view === "hours" ? "active" : ""} onClick={() => setView("hours")}>
                Hours View
              </button>
              {canViewCost && <button type="button" className={view === "cost" ? "active" : ""} onClick={() => setView("cost")}>
                Cost View
              </button>}
            </div>
          </div>

          {error && <div className="error-banner">{error}</div>}

          <div className="summary-table-wrap summary-desktop-only">
            <table className="summary-table">
              <thead>
                <tr>
                  <th rowSpan={2} onClick={() => toggleSort("srNo")}>Sr. No.</th>
                  <th rowSpan={2} onClick={() => toggleSort("name")}>
                    {nameHeader} {sortKey === "name" ? (sortDir === "asc" ? "↓" : "↑") : ""}
                  </th>
                  {groupBy !== "department" && groupBy !== "totals" && (
                    <th rowSpan={2} onClick={() => toggleSort("department")}>
                      Department {sortKey === "department" ? (sortDir === "asc" ? "↓" : "↑") : ""}
                    </th>
                  )}
                  {projects.map((project) => (
                    <th
                      key={project.id}
                      colSpan={2}
                      className="num project-group-head"
                      title={project.name}
                    >
                      <span
                        className="project-key"
                        style={{ background: `var(--project-${project.colorKey.toLowerCase()})` }}
                      >
                        {project.colorKey}
                      </span>
                      <span className="project-name-sub">{project.name}</span>
                    </th>
                  ))}
                  <th rowSpan={2} className="num total-col" onClick={() => toggleSort("total")}>
                    Total
                  </th>
                  <th rowSpan={2} className="num overhead-total-col">Overhead Total</th>
                </tr>
                <tr className="project-subhead-row">
                  {projects.map((project) => (
                    <Fragment key={project.id}>
                      <th className="num" onClick={() => toggleSort(`proj:${project.colorKey}`)}>
                        Regular
                      </th>
                      <th className="num project-ot-col" onClick={() => toggleSort(`projectOt:${project.colorKey}`)}>
                        OT
                      </th>
                    </Fragment>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedRows.length === 0 ? (
                  <tr>
                    <td colSpan={(groupBy === "department" || groupBy === "totals" ? 2 : 3) + projects.length * 2 + 2} className="muted">
                      No submitted / tagged hours for this period. Enter timesheet data first.
                    </td>
                  </tr>
                ) : (
                  sortedRows.map((r) => (
                    <tr key={`${r.name}-${r.srNo}`}>
                      <td>{r.srNo}</td>
                      <td>{r.name}</td>
                      {groupBy !== "department" && groupBy !== "totals" && <td>{r.department}</td>}
                      {projects.map((project) => (
                        <Fragment key={project.id}>
                          <td className="num">{formatVal(r.values[project.colorKey] || 0)}</td>
                          <td className="num project-ot-col">
                            {(r.projectOtValues[project.colorKey] || 0) > 0 ? (
                              <span className="project-ot-badge">
                                {formatVal(r.projectOtValues[project.colorKey])}
                              </span>
                            ) : "—"}
                          </td>
                        </Fragment>
                      ))}
                      <td className="num total-col">{formatVal(r.total)}</td>
                      <td className="num overhead-total-col">
                        {formatVal(view === "cost" ? r.overheadCost ?? 0 : r.overheadHours ?? 0)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={groupBy === "department" || groupBy === "totals" ? 2 : 3}>Total</td>
                  {projects.map((project) => (
                    <Fragment key={project.id}>
                      <td className="num">{formatVal(totals[project.colorKey] || 0)}</td>
                      <td className="num project-ot-col">
                        {(projectOtTotals[project.colorKey] || 0) > 0 ? (
                          <span className="project-ot-badge">
                            {formatVal(projectOtTotals[project.colorKey])}
                          </span>
                        ) : "—"}
                      </td>
                    </Fragment>
                  ))}
                  <td className="num total-col">{formatVal(grandTotal)}</td>
                  <td className="num overhead-total-col">{formatVal(overheadTotal)}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Phone: card rows with project chips */}
          <div className="summary-cards summary-mobile-only">
            {sortedRows.length === 0 ? (
              <p className="muted summary-empty">
                No submitted / tagged hours for this period. Enter timesheet data first.
              </p>
            ) : (
              sortedRows.map((r) => (
                <article key={`${r.name}-${r.srNo}`} className="summary-card">
                  <header className="summary-card__head">
                    <div>
                      <span className="summary-card__sr">#{r.srNo}</span>
                      <strong>{r.name}</strong>
                      {groupBy !== "department" && groupBy !== "totals" && r.department && (
                        <div className="muted tiny">{r.department}</div>
                      )}
                    </div>
                    <div className="summary-card__total">
                      <span className="summary-card__total-label">Total</span>
                      <strong>{formatVal(r.total)}</strong>
                    </div>
                  </header>
                  <div className="summary-chips">
                    {projects.map((project) => {
                      const regular = r.values[project.colorKey] || 0;
                      const ot = r.projectOtValues[project.colorKey] || 0;
                      if (!regular && !ot) return null;
                      return (
                        <span key={project.id} className="summary-chip summary-chip--split">
                          <em style={{ background: `var(--project-${project.colorKey.toLowerCase()})` }}>
                            {project.colorKey}
                          </em>
                          {project.name.replace(/^Project\s+/i, "")}: Regular {formatVal(regular)} · OT{" "}
                          {ot > 0 ? <span className="project-ot-badge">{formatVal(ot)}</span> : "—"}
                        </span>
                      );
                    })}
                    {projects.every(
                      (project) =>
                        !(r.values[project.colorKey] || 0) && !(r.projectOtValues[project.colorKey] || 0)
                    ) && <span className="muted tiny">No project hours</span>}
                  </div>
                  {(r.overheadHours ?? 0) > 0 && (
                    <div className="summary-card__overhead">
                      Overhead {formatVal(view === "cost" ? r.overheadCost ?? 0 : r.overheadHours ?? 0)}
                    </div>
                  )}
                </article>
              ))
            )}
            {sortedRows.length > 0 && (
              <footer className="summary-card summary-card--footer">
                <strong>Grand total</strong>
                <div className="summary-chips">
                  {projects.map((project) => (
                    <span key={project.id} className="summary-chip summary-chip--split">
                      <em style={{ background: `var(--project-${project.colorKey.toLowerCase()})` }}>
                        {project.colorKey}
                      </em>
                      Regular {formatVal(totals[project.colorKey] || 0)} · OT{" "}
                      {(projectOtTotals[project.colorKey] || 0) > 0 ? (
                        <span className="project-ot-badge">{formatVal(projectOtTotals[project.colorKey])}</span>
                      ) : "—"}
                    </span>
                  ))}
                </div>
                <div className="summary-card__overhead">Overhead {formatVal(overheadTotal)}</div>
                <div className="summary-card__total">
                  <strong>{formatVal(grandTotal)}</strong>
                </div>
              </footer>
            )}
          </div>
        </>
      )}

      {tab === "jobOrder" && (
        <>
          <div className="filter-row">
            <div className="filter-field">
              <label>Select Projects</label>
              <select
                value={joSelectedProjectIds.length ? joSelectedProjectIds.join(",") : "all"}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "all") setJoSelectedProjectIds([]);
                  else setJoSelectedProjectIds(v.split(",").map(Number));
                }}
              >
                <option value="all">All Projects</option>
                {allProjects.map((p) => (
                  <option key={p.id} value={String(p.id)}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="filter-field">
              <label>Job Order Status</label>
              <div className="toggle-group toggle-group--inline">
                {JO_STATUS_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={joStatus === option.value ? "active" : ""}
                    onClick={() => setJoStatus(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="filter-field">
              <label>Department</label>
              <select
                value={joDepartmentId === "all" ? "all" : String(joDepartmentId)}
                onChange={(e) =>
                  setJoDepartmentId(e.target.value === "all" ? "all" : Number(e.target.value))
                }
              >
                <option value="all">All Departments</option>
                {joDepartments.map((d) => (
                  <option key={d.id} value={String(d.id)}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {joError && <div className="error-banner">{joError}</div>}
          {joLoading && <p className="muted">Loading…</p>}

          {/* Project -> WBS -> Job Order. The WBS level stays visible because a Job
              Order number repeats across projects. */}
          <div className="summary-table-wrap summary-desktop-only">
            <table className="jo-summary-table">
              <thead>
                <tr>
                  <th rowSpan={2}>Sr. No.</th>
                  <th rowSpan={2}>Job Order</th>
                  <th colSpan={4} className="num jo-measure-head">
                    Hours
                  </th>
                  <th colSpan={4} className="num jo-measure-head jo-measure-head--qty">
                    Quantity
                  </th>
                </tr>
                <tr>
                  <th className="num">Budgeted hours</th>
                  <th className="num">Consumption</th>
                  <th className="num">Consumption %</th>
                  <th className="num">Balance</th>
                  <th className="num jo-qty-col">Budget Qty</th>
                  <th className="num jo-qty-col">Achieved Qty</th>
                  <th className="num jo-qty-col">Balance Qty</th>
                  <th className="num jo-qty-col">Qty %</th>
                </tr>
              </thead>
              <tbody>
                {joGroups.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="muted">
                      No job orders match the current filters.
                    </td>
                  </tr>
                ) : (
                  joGroups.map((g) => (
                    <Fragment key={`proj-${g.projectId}`}>
                      <tr className="jo-group-header">
                        <td colSpan={10}>
                          <span
                            className="jo-color-dot"
                            style={{ background: `var(--project-${g.projectColorKey.toLowerCase()})` }}
                          />
                          <strong>{g.projectName}</strong>
                          <span className="muted tiny" style={{ marginLeft: 8 }}>
                            ({g.projectCode})
                          </span>
                        </td>
                      </tr>
                      {g.wbsGroups.map((wbs) => (
                        <Fragment key={`wbs-${wbs.wbsId}`}>
                          <tr className="jo-wbs-header">
                            <td colSpan={10}>
                              <span className="jo-wbs-label">WBS</span>
                              <strong>{wbs.wbsCode}</strong>
                              {wbs.wbsName && (
                                <span className="muted tiny" style={{ marginLeft: 8 }}>
                                  {wbs.wbsName}
                                </span>
                              )}
                            </td>
                          </tr>
                          {wbs.rows.map((r) => (
                            <tr key={r.id} className="jo-row">
                              <td>{r.srNo}</td>
                              <td>
                                <span className="jo-name-cell">
                                  <strong title={`WBS ${r.wbsCode}`}>
                                    {r.code}-{r.name}
                                  </strong>
                                  <span
                                    className={`jo-status-superscript ${
                                      r.status === "active" ? "jo-status-active" : "jo-status-inactive"
                                    }`}
                                  >
                                    {r.status === "active" ? "ACTIVE" : "IN-ACTIVE"}
                                  </span>
                                  {r.uom && <span className="jo-uom-tag">{r.uom}</span>}
                                </span>
                              </td>
                              <td className="num" title={budgetBasisTitle(r)}>
                                {joHours(r.budgetedHours)}
                              </td>
                              <td className="num">{joHours(r.consumption)}</td>
                              <td className="num">
                                <span className="jo-bar-cell">
                                  <span className={`jo-bar ${consumptionColorClass(r.consumptionPct)}`}>
                                    <span style={{ width: `${Math.min(100, r.consumptionPct)}%` }} />
                                  </span>
                                  <span
                                    className={`jo-bar-label ${consumptionLabelClass(r.consumptionPct)}`}
                                  >
                                    {r.consumptionPct}%
                                  </span>
                                </span>
                              </td>
                              <td className={`num ${r.balance < 0 ? "jo-balance-negative" : ""}`}>
                                {joHoursBalance(r.balance)}
                              </td>
                              <td className="num jo-qty-col">{joQuantity(r.budgetedQuantity, r.uom)}</td>
                              <td className="num jo-qty-col">
                                {r.progressReported ? (
                                  joQuantity(r.achievedQuantity, r.uom)
                                ) : (
                                  <span className="muted tiny" title="No approved progress yet">
                                    —
                                  </span>
                                )}
                              </td>
                              <td
                                className={`num jo-qty-col ${
                                  r.progressReported && r.balanceQuantity < 0 ? "jo-balance-negative" : ""
                                }`}
                              >
                                {r.progressReported ? (
                                  joQuantityBalance(r.balanceQuantity, r.uom)
                                ) : (
                                  <span className="muted tiny">—</span>
                                )}
                              </td>
                              <td className="num jo-qty-col">
                                {r.progressReported ? (
                                  <span className={`jo-bar-label ${consumptionLabelClass(r.quantityPct)}`}>
                                    {r.quantityPct}%
                                  </span>
                                ) : (
                                  <span className="muted tiny">—</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </Fragment>
                      ))}
                    </Fragment>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <p className="muted tiny jo-table-note summary-desktop-only">
            Hours and quantity are separate measures and are never added together. Quantities carry each
            Job Order's UoM. A Budgeted figure is the budget revision in force on that Job Order's last
            booked work date (hover the cell for the revision).
          </p>

          {/* Mobile: same three levels, WBS as a sub-heading inside the Project card. */}
          <div className="jo-cards summary-mobile-only">
            {joGroups.length === 0 ? (
              <p className="muted empty-card">No job orders match the current filters.</p>
            ) : (
              joGroups.map((g) => (
                <section key={`mobile-proj-${g.projectId}`} className="jo-cards-group">
                  <header className="jo-cards-group__head">
                    <span
                      className="jo-color-dot"
                      style={{ background: `var(--project-${g.projectColorKey.toLowerCase()})` }}
                    />
                    <strong>{g.projectName}</strong>
                    <span className="muted tiny">({g.projectCode})</span>
                  </header>
                  {g.wbsGroups.map((wbs) => (
                    <div key={`mobile-wbs-${wbs.wbsId}`} className="jo-cards-wbs">
                      <div className="jo-cards-wbs__head">
                        <span className="jo-wbs-label">WBS</span>
                        <strong>{wbs.wbsCode}</strong>
                        {wbs.wbsName && <span className="muted tiny">{wbs.wbsName}</span>}
                      </div>
                      {wbs.rows.map((r) => (
                        <article key={r.id} className="jo-card">
                          <header className="jo-card__head">
                            <div>
                              <strong>
                                {r.code}-{r.name}
                              </strong>
                              <div className="muted tiny">
                                {r.status === "active" ? "Active" : "In-Active"}
                                {r.uom ? ` · ${r.uom}` : ""}
                              </div>
                            </div>
                            <span className={`jo-bar-label ${consumptionLabelClass(r.consumptionPct)}`}>
                              {r.consumptionPct}%
                            </span>
                          </header>
                          <div className="jo-card__grid">
                            <div>
                              <span className="muted tiny">Budgeted hours</span>
                              <strong>{joHours(r.budgetedHours)}</strong>
                            </div>
                            <div>
                              <span className="muted tiny">Consumption</span>
                              <strong>{joHours(r.consumption)}</strong>
                            </div>
                            <div>
                              <span className="muted tiny">Balance</span>
                              <strong className={r.balance < 0 ? "jo-balance-negative" : ""}>
                                {joHoursBalance(r.balance)}
                              </strong>
                            </div>
                          </div>
                          <div className="jo-card__grid jo-card__grid--qty">
                            <div>
                              <span className="muted tiny">Budget Qty</span>
                              <strong>{joQuantity(r.budgetedQuantity, r.uom)}</strong>
                            </div>
                            <div>
                              <span className="muted tiny">Achieved Qty</span>
                              <strong>{r.progressReported ? joQuantity(r.achievedQuantity, r.uom) : "—"}</strong>
                            </div>
                            <div>
                              <span className="muted tiny">Balance Qty</span>
                              <strong
                                className={
                                  r.progressReported && r.balanceQuantity < 0 ? "jo-balance-negative" : ""
                                }
                              >
                                {r.progressReported ? joQuantityBalance(r.balanceQuantity, r.uom) : "—"}
                              </strong>
                            </div>
                            <div>
                              <span className="muted tiny">Qty %</span>
                              <strong className={consumptionLabelClass(r.quantityPct)}>
                                {r.progressReported ? `${r.quantityPct}%` : "—"}
                              </strong>
                            </div>
                          </div>
                          <div className={`jo-bar ${consumptionColorClass(r.consumptionPct)}`} style={{ marginTop: 8 }}>
                            <span style={{ width: `${Math.min(100, r.consumptionPct)}%` }} />
                          </div>
                        </article>
                      ))}
                    </div>
                  ))}
                </section>
              ))
            )}
          </div>
        </>
      )}
    </>
  );
}
