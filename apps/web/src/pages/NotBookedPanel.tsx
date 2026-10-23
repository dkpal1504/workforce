import { useCallback, useEffect, useMemo, useState } from "react";
import { api, getToken } from "../api/client";
import { formatDay } from "./formatDate";

/**
 * "Not booked" — the CLMS men nobody put on a team, folded per person for the chosen range.
 *
 * This is NOT another portfolio tab: it does not read the portfolio report, it does not take the project
 * or section filters, and its numbers cannot be compared row-for-row with the sections next door. It is a
 * roster question — who was paid to be here and booked nowhere — and it says so above the table, because a
 * reader who assumes it obeys the filter bar will misread it.
 */

type Person = {
  id: number;
  ecNo: string;
  name: string;
  department: string;
  section: string;
  category: string;
  notBookedDays: number;
  rangeDays: number;
  firstDay: string;
  lastDay: string;
  longestRun: number;
  runAtEnd: number;
  hours: number;
  cost: number;
};

type Report = {
  from: string;
  to: string;
  rangeDays: number;
  maxDailyHours: number;
  people: Person[];
  totals: { roster: number; peopleWithAnyGap: number; notBookedDays: number; hours: number; cost: number };
  notes: string[];
};

const money = (value: number) =>
  value.toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

function firstOfMonth(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

export function NotBookedPanel() {
  const [from, setFrom] = useState(firstOfMonth);
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<Report>(`/reports/not-booked?from=${from}&to=${to}`);
      setReport(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not build the report.");
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => {
    if (!report) return [];
    return showAll ? report.people : report.people.slice(0, 50);
  }, [report, showAll]);

  const download = async () => {
    try {
      const token = getToken();
      const response = await fetch(`/api/reports/not-booked.csv?from=${from}&to=${to}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) throw new Error(`Export failed (${response.status}).`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `not-booked-${from}_to_${to}.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed.");
    }
  };

  return (
    <div className="not-booked">
      <div className="filter-row">
        <div className="filter-field">
          <label>From Date</label>
          <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="filter-field">
          <label>To Date</label>
          <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div className="filter-field">
          <label>&nbsp;</label>
          <button type="button" className="csv-link" onClick={() => void download()} disabled={!report}>
            ⤓ Export CSV
          </button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {loading && !report && <div className="loading-state">Looking for men nobody booked…</div>}

      {report && (
        <>
          <div className="not-booked__totals">
            <div><span>Roster</span><strong>{report.totals.roster}</strong></div>
            <div><span>Nobody booked, at least one day</span><strong>{report.totals.peopleWithAnyGap}</strong></div>
            <div><span>Unbooked days</span><strong>{report.totals.notBookedDays.toLocaleString("en-IN")}</strong></div>
            <div><span>Idle hours</span><strong>{report.totals.hours.toLocaleString("en-IN")}</strong></div>
            <div><span>Idle cost</span><strong>{money(report.totals.cost)}</strong></div>
          </div>

          <p className="not-booked__note">
            {report.rangeDays} days in range · a day with ANY sheet counts as booked, whatever its status ·
            idle hours are {report.maxDailyHours} per unbooked day at each person's category rate · payroll
            staff are not in this report.
          </p>

          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>EC No</th>
                  <th>Employee</th>
                  <th>Department</th>
                  <th>Section</th>
                  <th className="num">Not booked</th>
                  <th className="num">Of</th>
                  <th>First</th>
                  <th>Last</th>
                  <th className="num">Longest run</th>
                  <th className="num">Run at end</th>
                  <th className="num">Idle hours</th>
                  <th className="num">Idle cost</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((person) => (
                  <tr key={person.id}>
                    <td className="mono">{person.ecNo}</td>
                    <td>{person.name}</td>
                    <td>{person.department}</td>
                    <td>{person.section || "—"}</td>
                    <td className="num">{person.notBookedDays}</td>
                    <td className="num muted">{person.rangeDays}</td>
                    <td>{formatDay(person.firstDay)}</td>
                    <td>{formatDay(person.lastDay)}</td>
                    <td className="num">
                      {person.longestRun}
                      {person.longestRun >= 7 && <span className="chip chip--danger"> pattern</span>}
                    </td>
                    <td className="num">{person.runAtEnd || "—"}</td>
                    <td className="num">{person.hours}</td>
                    <td className="num">{money(person.cost)}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={12} className="muted">
                      Everyone on the roster has a sheet on at least one day of this range.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {report.people.length > rows.length && (
            <button type="button" className="link-button" onClick={() => setShowAll(true)}>
              Show all {report.people.length} people
            </button>
          )}

          <ul className="not-booked__notes">
            {report.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
