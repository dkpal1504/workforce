import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api/client";
import { todayDateString } from "../utils/date";
import "../styles/supervisors.css";
import "./AttendanceHoursPage.css";

/** What GET /api/attendance-hours/config reports about the source and the job. */
type SourceConfig = {
  source: {
    view: string;
    idColumn: string;
    hoursColumn: string;
    dateColumn: string;
    queryOverride: boolean;
    server: string;
    port: number;
    database: string;
    user: string;
    fixture: boolean;
    fixturePath: string | null;
  };
  schedule: {
    enabled: boolean;
    cron: string;
    lookbackDays: number;
    sweep: { enabled: boolean; cron: string };
  };
  policy: { overwrite: "any" | "improve"; maxAgeDays: number };
};

type PlannedRow = {
  dayId: number;
  employeeId: number;
  employeeName: string;
  ecNo: string;
  workDate: string;
  status: string;
  bookedHours: number;
  previousInOutHours: number | null;
  clockedHours: number | null;
  difference: number | null;
  /** Source records summed into `clockedHours` (2+ means a split day or a night shift). */
  sourceRecords: number;
  /** Days between the work date and the run: the staleness of a pending day. */
  ageDays: number;
  outcome: "matched" | "not-in-source" | "no-hours-in-source" | "manual";
  /** True when this run would (or did) write the figure. */
  wouldChange: boolean;
  /** Why a difference was left alone: an Admin's figure, or the overwrite policy. */
  blockedReason: "manual" | "policy" | null;
  /** Still nothing usable after this run (absent, no hours, or a clocked 0). */
  pending: boolean;
};

type RefreshResult = {
  ok: boolean;
  dateFrom: string;
  dateTo: string;
  dryRun: boolean;
  includeDraft: boolean;
  onlyPending?: boolean;
  overwritePolicy?: "any" | "improve";
  sheets: number;
  matched: number;
  unmatched: number;
  updated: number;
  unchanged: number;
  /** Still nothing usable: the regularization backlog this run could not close. */
  pending: number;
  skipped?: { manual: number; policy: number };
  datesFetched?: number;
  errors: { date: string; message: string }[];
  rows: PlannedRow[];
  /** Only on the sweep response. */
  pendingBefore?: number;
};

/** One day of GET /api/attendance-hours/pending. */
type PendingRow = {
  dayId: number;
  employeeId: number;
  employeeName: string;
  ecNo: string;
  workDate: string;
  status: string;
  bookedHours: number;
  inOutHours: number | null;
  inOutSource: string | null;
  inOutAttempts: number;
  inOutCheckedAt: string | null;
  ageDays: number;
};

type PendingResponse = {
  ok: boolean;
  maxAgeDays: number;
  pending: number;
  neverChecked: number;
  checkedAndStillEmpty: number;
  rows: PendingRow[];
};

const OUTCOME_LABEL: Record<PlannedRow["outcome"], string> = {
  matched: "Clocked hours found",
  "not-in-source": "No attendance row",
  "no-hours-in-source": "No ManHours in the row",
  manual: "Set by hand",
};

/** "3 checks since 19 Sep" - the evidence that a pending day is still outstanding. */
function checkLabel(row: PendingRow): string {
  if (row.inOutAttempts === 0) return "never checked";
  const when = row.inOutCheckedAt ? new Date(row.inOutCheckedAt).toISOString().slice(0, 10) : "—";
  return `${row.inOutAttempts} check${row.inOutAttempts === 1 ? "" : "s"} · last ${when}`;
}

function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    const payload = e.payload as { error?: string } | undefined;
    if (payload?.error) return payload.error;
  }
  return e instanceof Error ? e.message : "Request failed";
}

function hours(value: number | null): string {
  return value == null ? "—" : value.toFixed(2);
}

/**
 * Clocked attendance hours (in/out) — ADMIN only.
 *
 * A supervisor books shift slots and the sheet is submitted with `in_out_hours` NULL;
 * this screen is how the Admin puts the clocked figure next to the booked one. It reads
 * the LabourWorks attendance view (`ManHours` for `IDNo` = the employee ecNo) and stamps
 * the matching submitted sheets.
 *
 * The Preview button runs the exact same refresh with `dryRun: true`, so what is shown
 * before saving is the same computation that writes. Re-running it changes nothing,
 * which is why the 09:00 / 21:00 job can run unattended.
 */
export function AttendanceHoursPage() {
  const today = todayDateString();
  const [config, setConfig] = useState<SourceConfig | null>(null);
  const [dateFrom, setDateFrom] = useState(today);
  const [dateTo, setDateTo] = useState(today);
  const [includeDraft, setIncludeDraft] = useState(false);
  const [result, setResult] = useState<RefreshResult | null>(null);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState<PendingResponse | null>(null);
  const [pendingBusy, setPendingBusy] = useState(false);
  const [manualDraft, setManualDraft] = useState<Record<number, string>>({});
  const [manualBusy, setManualBusy] = useState<number | null>(null);

  useEffect(() => {
    api<SourceConfig>("/attendance-hours/config")
      .then(setConfig)
      .catch(() => setConfig(null));
  }, []);

  /** The backlog list reads the database only, so it is safe to refresh often. */
  const loadPending = useCallback(async () => {
    setPendingBusy(true);
    try {
      setPending(await api<PendingResponse>("/attendance-hours/pending"));
    } catch {
      setPending(null);
    } finally {
      setPendingBusy(false);
    }
  }, []);

  useEffect(() => {
    void loadPending();
  }, [loadPending]);

  const run = useCallback(
    async (dryRun: boolean) => {
      setBusy(true);
      setError("");
      setMessage("");
      setPreview(dryRun);
      try {
        const res = await api<RefreshResult>("/attendance-hours/refresh", {
          method: "POST",
          body: JSON.stringify({ dateFrom, dateTo, dryRun, includeDraft }),
        });
        setResult(res);
        if (dryRun) {
          setMessage(
            `${res.matched} of ${res.sheets} sheet(s) have clocked hours; ${res.updated === 0 ? res.matched - res.unchanged : res.matched} value(s) would change. Nothing was saved.`
          );
        } else {
          setMessage(
            `Saved the clocked hours on ${res.updated} sheet(s); ${res.unchanged} already matched; ${res.pending} still pending.`
          );
        }
        if (!dryRun) void loadPending();
      } catch (e) {
        setError(errorText(e));
        setResult(null);
      } finally {
        setBusy(false);
      }
    },
    [dateFrom, dateTo, includeDraft]
  );

  /** The weekly job's manual trigger: the whole horizon, pending days only. */
  const sweep = useCallback(
    async (dryRun: boolean) => {
      setBusy(true);
      setError("");
      setMessage("");
      setPreview(dryRun);
      try {
        const res = await api<RefreshResult>("/attendance-hours/sweep", {
          method: "POST",
          body: JSON.stringify({ dryRun }),
        });
        setResult(res);
        setMessage(
          dryRun
            ? `Deep sweep over the last ${pending?.maxAgeDays ?? config?.policy.maxAgeDays ?? 45} day(s): ${res.sheets} pending sheet(s) checked, ${res.rows.filter((r) => r.wouldChange).length} would be filled. Nothing was saved.`
            : `Deep sweep saved ${res.updated} figure(s); ${res.pending} still pending.`
        );
        if (!dryRun) void loadPending();
      } catch (e) {
        setError(errorText(e));
      } finally {
        setBusy(false);
      }
    },
    [config?.policy.maxAgeDays, pending?.maxAgeDays, loadPending]
  );

  /** An Admin decision for a day the yard will never regularize (or a clear). */
  const saveManual = useCallback(
    async (dayId: number, value: string) => {
      setManualBusy(dayId);
      setError("");
      setMessage("");
      try {
        const hours = value.trim() === "" ? null : Number(value);
        if (hours != null && (!Number.isFinite(hours) || hours < 0 || hours > 24)) {
          setError("Clocked hours must be a number between 0 and 24.");
          return;
        }
        await api("/attendance-hours/manual", { method: "POST", body: JSON.stringify({ dayId, hours }) });
        setMessage(
          hours == null
            ? "Cleared. The next refresh will fill this day from LabourWorks again."
            : `Saved ${hours}h by hand. No refresh will overwrite it.`
        );
        setManualDraft((drafts) => ({ ...drafts, [dayId]: "" }));
        void loadPending();
      } catch (e) {
        setError(errorText(e));
      } finally {
        setManualBusy(null);
      }
    },
    [loadPending]
  );

  const rows = useMemo(() => result?.rows ?? [], [result]);
  const changedRows = useMemo(
    () => rows.filter((row) => row.outcome === "matched" && row.clockedHours !== row.previousInOutHours),
    [rows]
  );

  return (
    <>
      <div className="supervisors-toolbar">
        <span className="supervisors-toolbar__count">
          Clocked in/out hours come from LabourWorks ({config?.source.view ?? "attendance view"}), matched on the
          employee code the timesheet already carries. Every submit resets the column to empty, so this screen (or the{" "}
          {config?.schedule.cron ?? "0 9,21 * * *"} job) is what fills it. It never changes booked hours, approvals or
          reports.
        </span>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {message && <div className="carry-banner">{message}</div>}
      {result && result.errors.length > 0 && (
        <div className="warning-banner">
          {result.errors.length} day(s) could not be read: {result.errors[0].date} — {result.errors[0].message}
        </div>
      )}

      <div className="filter-row att-filters">
        <div className="filter-field">
          <label htmlFor="att-from">From date</label>
          <input id="att-from" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
        </div>
        <div className="filter-field">
          <label htmlFor="att-to">To date</label>
          <input id="att-to" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
        </div>
        <div className="filter-field att-filters__check">
          <label htmlFor="att-drafts">Scope</label>
          <label className="att-check">
            <input
              id="att-drafts"
              type="checkbox"
              checked={includeDraft}
              onChange={(e) => setIncludeDraft(e.target.checked)}
            />
            <span>Include draft sheets</span>
          </label>
        </div>
        <div className="att-filters__actions">
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void sweep(true)} title="Check every day still pending, across the whole regularization horizon">
            Deep sweep preview
          </button>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void run(true)}>
            {busy && preview ? "Reading LabourWorks…" : "Preview (no save)"}
          </button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run(false)}>
            {busy && !preview ? "Saving…" : "Fetch & save hours"}
          </button>
        </div>
      </div>

      <div className="panel">
        <div className="panel__header">
          <span>{preview ? "Preview" : "Result"}</span>
          <span className="panel__count">
            {result
              ? `${result.sheets} sheet(s) · ${result.matched} matched · ${result.unmatched} without clocked hours`
              : "Not run yet"}
          </span>
        </div>
        <div className="panel__body">
          {result && (
            <p className="att-summary">
              {result.dateFrom === result.dateTo ? result.dateFrom : `${result.dateFrom} → ${result.dateTo}`} ·{" "}
              {result.dryRun ? "nothing written" : `${result.updated} saved`} · {result.unchanged} already current ·{" "}
              {changedRows.length} difference(s) to review
            </p>
          )}
          {rows.length === 0 ? (
            <p className="muted">
              {result
                ? "No submitted sheet in this range. Widen the dates, or include drafts to see work in progress."
                : "Pick a date range, then Preview to see what LabourWorks reports for the submitted sheets."}
            </p>
          ) : (
            <>
              <div className="att-table-wrap">
                <table className="sup-table att-table">
                  <thead>
                    <tr>
                      <th>Employee</th>
                      <th>EC No</th>
                      <th>Work date</th>
                      <th>Status</th>
                      <th>Booked h</th>
                      <th>Clocked h</th>
                      <th>Difference</th>
                      <th>Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.dayId} data-day-id={row.dayId}>
                        <td>{row.employeeName}</td>
                        <td>{row.ecNo}</td>
                        <td>{row.workDate}</td>
                        <td>{row.status}</td>
                        <td>{hours(row.bookedHours)}</td>
                        <td>{hours(row.clockedHours)}</td>
                        <td
                          className={
                            row.difference == null
                              ? ""
                              : row.difference > 0
                                ? "att-diff att-diff--over"
                                : row.difference < 0
                                  ? "att-diff att-diff--under"
                                  : "att-diff"
                          }
                        >
                          {row.difference == null ? "—" : row.difference > 0 ? `+${hours(row.difference)}` : hours(row.difference)}
                        </td>
                        <td>
                          {OUTCOME_LABEL[row.outcome]}
                          {row.sourceRecords > 1 && (
                            <span className="badge" title="Several check-in/out records on this date were added up">
                              {row.sourceRecords} records
                            </span>
                          )}
                          {row.outcome === "matched" && row.clockedHours !== row.previousInOutHours && (
                            <span className="badge badge-warn">changes</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ul className="att-cards">
                {rows.map((row) => (
                  <li key={row.dayId} className="att-card">
                    <div className="att-card__top">
                      <strong>{row.employeeName}</strong>
                      <span>{row.ecNo}</span>
                    </div>
                    <div className="att-card__meta">
                      {row.workDate} · {row.status} · booked {hours(row.bookedHours)}h · clocked {hours(row.clockedHours)}h
                      {row.difference != null && ` (${row.difference > 0 ? "+" : ""}${hours(row.difference)}h)`}
                    </div>
                    <div className="att-card__meta">
                      {OUTCOME_LABEL[row.outcome]}
                      {row.sourceRecords > 1 ? ` · ${row.sourceRecords} records added up` : ""}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>

      <div className="panel">
        <div className="panel__header">
          <span>Still pending (regularization outstanding)</span>
          <span className="panel__count">
            {pendingBusy && !pending
              ? "Loading…"
              : pending
                ? `${pending.pending} day(s) · ${pending.checkedAndStillEmpty} already checked · ${pending.neverChecked} not reached yet`
                : "—"}
          </span>
        </div>
        <div className="panel__body">
          {pending && pending.rows.length > 0 && (
            <p className="att-summary">
              These days have no usable clocked figure inside the last {pending.maxAgeDays} day(s): LabourWorks returned
              no attendance row, no ManHours, or 0.00. Regularization in LabourWorks can take days, so every refresh
              re-reads its window and corrects the value as soon as it changes — the count below shows how often the
              source has been asked. A day HR confirms will never be regularized can be settled by hand; that value is
              flagged MANUAL and no refresh overwrites it.
            </p>
          )}
          {!pending || pending.rows.length === 0 ? (
            <p className="muted">
              {pending
                ? "Nothing pending: every submitted sheet inside the horizon has a clocked figure."
                : "Could not read the pending list."}
            </p>
          ) : (
            <>
              <div className="att-table-wrap">
                <table className="sup-table att-table">
                  <thead>
                    <tr>
                      <th>Employee</th>
                      <th>EC No</th>
                      <th>Work date</th>
                      <th>Age</th>
                      <th>Status</th>
                      <th>Booked h</th>
                      <th>Clocked h</th>
                      <th>Source checks</th>
                      <th>Set by hand</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pending.rows.map((row) => (
                      <tr key={row.dayId} data-day-id={row.dayId}>
                        <td>{row.employeeName}</td>
                        <td>{row.ecNo}</td>
                        <td>{row.workDate}</td>
                        <td className={row.ageDays > 7 ? "att-diff att-diff--over" : ""}>{row.ageDays}d</td>
                        <td>{row.status}</td>
                        <td>{hours(row.bookedHours)}</td>
                        <td>{row.inOutHours == null ? "no row" : hours(row.inOutHours)}</td>
                        <td>{checkLabel(row)}</td>
                        <td>
                          <span className="att-manual">
                            <input
                              type="number"
                              min={0}
                              max={24}
                              step={0.01}
                              placeholder="hours"
                              aria-label={`Clocked hours for ${row.employeeName} on ${row.workDate}`}
                              value={manualDraft[row.dayId] ?? ""}
                              disabled={manualBusy === row.dayId}
                              onChange={(e) =>
                                setManualDraft((drafts) => ({ ...drafts, [row.dayId]: e.target.value }))
                              }
                            />
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              disabled={manualBusy === row.dayId || (manualDraft[row.dayId] ?? "").trim() === ""}
                              onClick={() => void saveManual(row.dayId, manualDraft[row.dayId] ?? "")}
                            >
                              {manualBusy === row.dayId ? "Saving…" : "Save"}
                            </button>
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ul className="att-cards">
                {pending.rows.map((row) => (
                  <li key={row.dayId} className="att-card">
                    <div className="att-card__top">
                      <strong>{row.employeeName}</strong>
                      <span>{row.ecNo}</span>
                    </div>
                    <div className="att-card__meta">
                      {row.workDate} · age {row.ageDays}d · {row.status} · booked {hours(row.bookedHours)}h · clocked{" "}
                      {row.inOutHours == null ? "no row" : `${hours(row.inOutHours)}h`}
                    </div>
                    <div className="att-card__meta">{checkLabel(row)}</div>
                    <span className="att-manual">
                      <input
                        type="number"
                        min={0}
                        max={24}
                        step={0.01}
                        placeholder="hours"
                        aria-label={`Clocked hours for ${row.employeeName} on ${row.workDate}`}
                        value={manualDraft[row.dayId] ?? ""}
                        disabled={manualBusy === row.dayId}
                        onChange={(e) => setManualDraft((drafts) => ({ ...drafts, [row.dayId]: e.target.value }))}
                      />
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={manualBusy === row.dayId || (manualDraft[row.dayId] ?? "").trim() === ""}
                        onClick={() => void saveManual(row.dayId, manualDraft[row.dayId] ?? "")}
                      >
                        {manualBusy === row.dayId ? "Saving…" : "Save by hand"}
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>

      {config && (
        <div className="panel">
          <div className="panel__header">
            <span>Source</span>
            <span className="panel__count">Read-only</span>
          </div>
          <div className="panel__body">
            <ul className="att-source">
              <li>
                <span>View</span>
                <strong>{config.source.view}</strong>
              </li>
              <li>
                <span>Columns</span>
                <strong>
                  {config.source.idColumn} (employee code) · {config.source.hoursColumn} (hours) ·{" "}
                  {config.source.dateColumn} (date)
                </strong>
              </li>
              <li>
                <span>Connection</span>
                <strong>
                  {config.source.server}:{config.source.port} · {config.source.database} · user {config.source.user || "—"}
                </strong>
              </li>
              <li>
                <span>Query</span>
                <strong>{config.source.queryOverride ? "ATTENDANCE_DB_QUERY override" : "generated from the columns above"}</strong>
              </li>
              <li>
                <span>Off-peak job</span>
                <strong>
                  {config.schedule.enabled ? "enabled" : "disabled"} · {config.schedule.cron} · re-reads the last{" "}
                  {config.schedule.lookbackDays} day(s)
                </strong>
              </li>
              <li>
                <span>Weekly sweep</span>
                <strong>
                  {config.schedule.sweep.enabled ? "enabled" : "disabled"} · {config.schedule.sweep.cron} · everything
                  still pending inside {config.policy.maxAgeDays} day(s)
                </strong>
              </li>
              <li>
                <span>Backfill rule</span>
                <strong>
                  {config.policy.overwrite === "any"
                    ? "a later LabourWorks correction wins (up or down)"
                    : "fill a gap or raise a figure; never lower one automatically"}{" "}
                  · days older than {config.policy.maxAgeDays} stop being re-checked
                </strong>
              </li>
              {config.source.fixture && (
                <li>
                  <span>Fixture</span>
                  <strong>{config.source.fixturePath}</strong>
                </li>
              )}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}
