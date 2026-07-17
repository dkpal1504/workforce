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
};

type GroupBy = "employee" | "supervisor" | "department" | "totals";
type View = "hours" | "cost";
type Frequency = "daily" | "weekly" | "monthly";

export function SummaryPage() {
  const [date, setDate] = useState(todayDateString);
  const [frequency, setFrequency] = useState<Frequency>("daily");
  const [groupBy, setGroupBy] = useState<GroupBy>("supervisor");
  const [view, setView] = useState<View>("hours");
  const [allProjects, setAllProjects] = useState<Project[]>([]);
  const [selectedProjectIds, setSelectedProjectIds] = useState<number[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [totals, setTotals] = useState<Record<string, number>>({});
  const [grandTotal, setGrandTotal] = useState(0);
  const [sortKey, setSortKey] = useState<string>("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ projects: Project[] }>("/projects-wbs").then((d) => setAllProjects(d.projects));
  }, []);

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
      }>(`/summary?${qs.toString()}`);
      setProjects(data.projects);
      setRows(data.rows);
      setTotals(data.totals);
      setGrandTotal(data.grandTotal);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load summary");
    }
  }, [date, frequency, groupBy, view, selectedProjectIds]);

  useEffect(() => {
    load();
  }, [load]);

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

  return (
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
              else setSelectedProjectIds(v.split(",").map(Number));
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
            <div className="summary-card__total">
              <strong>{formatVal(grandTotal)}</strong>
            </div>
          </footer>
        )}
      </div>
    </>
  );
}
