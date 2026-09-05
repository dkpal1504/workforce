import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { todayDateString } from "../utils/date";
import "../styles/summary.css";

type Project = { id: number; code: string; name: string; colorKey: string };
type Row = {
  srNo: number;
  name: string;
  department: string;
  values: Record<string, number>;
  total: number;
  otHours?: number;
};

type GroupBy = "employee" | "supervisor" | "department" | "totals";
type View = "hours" | "cost";
type Frequency = "daily" | "weekly" | "monthly";
type Tab = "project" | "jobOrder";
type JoStatus = "all" | "active" | "closed";

type Department = { id: number; name: string; code: string };

type JoRow = {
  id: number;
  srNo: number;
  code: string;
  name: string;
  status: string; // active | closed | on_hold
  budgetedHours: number | null;
  consumption: number;
  consumptionPct: number;
  balance: number;
};
type JoGroup = {
  projectId: number;
  projectName: string;
  projectCode: string;
  projectColorKey: string;
  rows: JoRow[];
};

export function SummaryPage() {
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
  const [grandTotal, setGrandTotal] = useState(0);
  const [otTotal, setOtTotal] = useState(0);
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

  useEffect(() => {
    api<{ projects: Project[] }>("/projects-wbs").then((d) => setAllProjects(d.projects));
  }, []);

  // Job Order Summary needs a list of (new) Projects for the Select Projects multi-select,
  // and a list of departments for the Department filter.
  useEffect(() => {
    if (tab !== "jobOrder") return;
    api<{ projects: { id: number; code: string; name: string; colorKey: string }[] }>(
      "/projects"
    ).then((d) => {
      // Only keep the shape the dropdown needs (don't carry jobOrders into the
      // filter state — keeps the chip list lean and the projectIds valid).
      setAllProjects(
        d.projects.map((p) => ({ id: p.id, code: p.code, name: p.name, colorKey: p.colorKey }))
      );
    });
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
        grandTotal: number;
        otTotalHours?: number;
      }>(`/summary?${qs.toString()}`);
      setProjects(data.projects);
      setRows(data.rows);
      setTotals(data.totals);
      setGrandTotal(data.grandTotal);
      setOtTotal(data.otTotalHours ?? 0);
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

  // OT column is dynamic — only shown when at least one row (or the total) has OT.
  const hasOt = otTotal > 0 || rows.some((r) => (r.otHours ?? 0) > 0);

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

  function formatJoBudget(n: number | null) {
    if (n == null) return "—";
    return `${n.toLocaleString()} hrs`;
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
        <button
          type="button"
          role="tab"
          className={`hod-tab ${tab === "jobOrder" ? "active" : ""}`}
          aria-selected={tab === "jobOrder"}
          onClick={() => setTab("jobOrder")}
        >
          Job Order Summary
        </button>
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
            <div className="toggle-group">
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
            </div>
            <div className="toggle-group">
              <button type="button" className={view === "hours" ? "active" : ""} onClick={() => setView("hours")}>
                Hours View
              </button>
              <button type="button" className={view === "cost" ? "active" : ""} onClick={() => setView("cost")}>
                Cost View
              </button>
            </div>
          </div>

          {error && <div className="error-banner">{error}</div>}

          <div className="summary-table-wrap summary-desktop-only">
            <table className="summary-table">
              <thead>
                <tr>
                  <th onClick={() => toggleSort("srNo")}>Sr. No.</th>
                  <th onClick={() => toggleSort("name")}>
                    {nameHeader} {sortKey === "name" ? (sortDir === "asc" ? "↓" : "↑") : ""}
                  </th>
                  {groupBy !== "department" && groupBy !== "totals" && (
                    <th onClick={() => toggleSort("department")}>
                      Department {sortKey === "department" ? (sortDir === "asc" ? "↓" : "↑") : ""}
                    </th>
                  )}
                  {projects.map((p) => (
                    <th key={p.id} className="num" onClick={() => toggleSort(`proj:${p.code}`)}>
                      {p.name}
                    </th>
                  ))}
                  <th className="num total-col" onClick={() => toggleSort("total")}>
                    Total
                  </th>
                  {hasOt && <th className="num ot-col">OT</th>}
                </tr>
              </thead>
              <tbody>
                {sortedRows.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="muted">
                      No submitted / tagged hours for this period. Enter timesheet data first.
                    </td>
                  </tr>
                ) : (
                  sortedRows.map((r) => (
                    <tr key={`${r.name}-${r.srNo}`}>
                      <td>{r.srNo}</td>
                      <td>{r.name}</td>
                      {groupBy !== "department" && groupBy !== "totals" && <td>{r.department}</td>}
                      {projects.map((p) => (
                        <td key={p.id} className="num">
                          {formatVal(r.values[p.code] || 0)}
                        </td>
                      ))}
                      <td className="num total-col">{formatVal(r.total)}</td>
                      {hasOt && (
                        <td className="num ot-col">
                          {(r.otHours ?? 0) > 0 ? <span className="ot-badge">{r.otHours}h</span> : "—"}
                        </td>
                      )}
                    </tr>
                  ))
                )}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={groupBy === "department" || groupBy === "totals" ? 2 : 3}>Total</td>
                  {projects.map((p) => (
                    <td key={p.id} className="num">
                      {formatVal(totals[p.code] || 0)}
                    </td>
                  ))}
                  <td className="num total-col">{formatVal(grandTotal)}</td>
                  {hasOt && <td className="num ot-col"><span className="ot-badge">{otTotal}h</span></td>}
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
                    {projects.map((p) => {
                      const val = r.values[p.code] || 0;
                      if (!val) return null;
                      return (
                        <span key={p.id} className="summary-chip">
                          <em style={{ background: `var(--project-${p.colorKey.toLowerCase()})` }}>
                            {p.colorKey}
                          </em>
                          {p.name.replace(/^Project\s+/i, "")}: {formatVal(val)}
                        </span>
                      );
                    })}
                    {projects.every((p) => !(r.values[p.code] || 0)) && (
                      <span className="muted tiny">No project hours</span>
                    )}
                  </div>
                  {(r.otHours ?? 0) > 0 && (
                    <div className="ot-badge ot-badge--card">OT {r.otHours}h</div>
                  )}
                </article>
              ))
            )}
            {sortedRows.length > 0 && (
              <footer className="summary-card summary-card--footer">
                <strong>Grand total</strong>
                <div className="summary-chips">
                  {projects.map((p) => (
                    <span key={p.id} className="summary-chip">
                      <em style={{ background: `var(--project-${p.colorKey.toLowerCase()})` }}>
                        {p.colorKey}
                      </em>
                      {formatVal(totals[p.code] || 0)}
                    </span>
                  ))}
                </div>
                {hasOt && <div className="ot-badge ot-badge--card">OT {otTotal}h</div>}
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
                {(["all", "active", "closed"] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={joStatus === s ? "active" : ""}
                    onClick={() => setJoStatus(s)}
                  >
                    {s === "all" ? "All" : s === "active" ? "Active" : "Closed"}
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

          <div className="summary-table-wrap summary-desktop-only">
            <table className="jo-summary-table">
              <thead>
                <tr>
                  <th>Sr. No.</th>
                  <th>Job Order</th>
                  <th className="num">Budgeted</th>
                  <th className="num">Consumption</th>
                  <th className="num">Consumption %</th>
                  <th className="num">Balance</th>
                </tr>
              </thead>
              <tbody>
                {joGroups.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="muted">
                      No job orders match the current filters.
                    </td>
                  </tr>
                ) : (
                  joGroups.map((g) => (
                    <>
                      <tr key={`proj-${g.projectId}`} className="jo-group-header">
                        <td colSpan={6}>
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
                      {g.rows.map((r) => {
                        const colorClass = consumptionColorClass(r.consumptionPct);
                        return (
                          <tr key={r.id} className="jo-row">
                            <td>{r.srNo}</td>
                            <td>
                              <span className="jo-name-cell">
                                <strong>{r.code}</strong> · {r.name}
                                {r.status === "active" && (
                                  <span className="jo-status-superscript jo-status-active">ACTIVE</span>
                                )}
                                {r.status === "closed" && (
                                  <span className="jo-status-superscript jo-status-closed">CLOSED</span>
                                )}
                              </span>
                            </td>
                            <td className="num">{formatJoBudget(r.budgetedHours)}</td>
                            <td className="num">{r.consumption} hrs</td>
                            <td className="num">
                              {r.budgetedHours == null ? (
                                <span className="muted tiny">—</span>
                              ) : (
                                <span className="jo-bar-cell">
                                  <span className={`jo-bar ${colorClass}`}>
                                    <span
                                      style={{ width: `${Math.min(100, r.consumptionPct)}%` }}
                                    />
                                  </span>
                                  <span
                                    className={`jo-bar-label ${consumptionLabelClass(r.consumptionPct)}`}
                                  >
                                    {r.consumptionPct}%
                                  </span>
                                </span>
                              )}
                            </td>
                            <td className={`num ${r.balance < 0 ? "jo-balance-negative" : ""}`}>
                              {r.budgetedHours == null
                                ? "—"
                                : r.balance < 0
                                  ? `(${Math.abs(r.balance).toLocaleString()} hrs)`
                                  : `${r.balance.toLocaleString()} hrs`}
                            </td>
                          </tr>
                        );
                      })}
                    </>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
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
                  {g.rows.map((r) => {
                    const colorClass = consumptionColorClass(r.consumptionPct);
                    return (
                      <article key={r.id} className="jo-card">
                        <header className="jo-card__head">
                          <div>
                            <strong>
                              {r.code} · {r.name}
                            </strong>
                            <div className="muted tiny">
                              {r.status === "active" ? "Active" : r.status === "closed" ? "Closed" : "On Hold"}
                            </div>
                          </div>
                          <span
                            className={`jo-bar-label ${consumptionLabelClass(r.consumptionPct)}`}
                          >
                            {r.budgetedHours == null ? "—" : `${r.consumptionPct}%`}
                          </span>
                        </header>
                        <div className="jo-card__grid">
                          <div>
                            <span className="muted tiny">Budgeted</span>
                            <strong>{formatJoBudget(r.budgetedHours)}</strong>
                          </div>
                          <div>
                            <span className="muted tiny">Consumption</span>
                            <strong>{r.consumption} hrs</strong>
                          </div>
                          <div>
                            <span className="muted tiny">Balance</span>
                            <strong className={r.balance < 0 ? "jo-balance-negative" : ""}>
                              {r.budgetedHours == null
                                ? "—"
                                : r.balance < 0
                                  ? `(${Math.abs(r.balance).toLocaleString()} hrs)`
                                  : `${r.balance.toLocaleString()} hrs`}
                            </strong>
                          </div>
                        </div>
                        {r.budgetedHours != null && (
                          <div className={`jo-bar ${colorClass}`} style={{ marginTop: 8 }}>
                            <span style={{ width: `${Math.min(100, r.consumptionPct)}%` }} />
                          </div>
                        )}
                      </article>
                    );
                  })}
                </section>
              ))
            )}
          </div>
        </>
      )}
    </>
  );
}
