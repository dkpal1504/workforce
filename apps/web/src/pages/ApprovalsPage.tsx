import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import "../styles/approvals.css";

type ProjectHours = { A: number; B: number; C: number };

type EmployeeRow = {
  id: number;
  workDate: string;
  status: string;
  remarks: string | null;
  pendingDays: number;
  projectHours: ProjectHours;
  overhead: number;
  totalAlloc: number;
  unallocatedHours?: number;
  dayTotalHours: number;
  maxDailyHours: number;
  exceedsLimit: boolean;
  isAmendment?: boolean;
  hasConflict: boolean;
  employee: { id: number; name: string; ecNo: string; department: string };
  supervisor: { id: number; name: string; email: string };
};

type SupervisorGroup = {
  supervisorId: number;
  supervisorName: string;
  workDate: string;
  pendingDays: number;
  hasConflict: boolean;
  isAmendment?: boolean;
  exceedsLimit?: boolean;
  projectHours: ProjectHours;
  overhead: number;
  totalAlloc: number;
  unallocatedHours?: number;
  employees: EmployeeRow[];
};

type ReturnedRow = {
  id: number;
  workDate: string;
  supervisor: { id: number; name: string; email: string };
  employee: { id: number; name: string; ecNo: string; department: string };
  projectHours: ProjectHours;
  overhead: number;
  totalAlloc: number;
  planningComment: string | null;
  planningReturnedAt: string | null;
  planningApprover: string | null;
};

type HistoryItem = {
  approvalId: number;
  action: string;
  comment: string | null;
  approvedAt: string;
  resultingStatus: string;
  id: number;
  workDate: string;
  projectHours: ProjectHours;
  overhead: number;
  totalAlloc: number;
  employee: { id: number; name: string; ecNo: string; department: string };
  supervisor: { id: number; name: string; email: string };
};

type PendingPayload = {
  role: string;
  roleLabel: string;
  maxDailyHours: number;
  received: SupervisorGroup[];
  returnedByPlanning: ReturnedRow[];
};

function fmtHours(n: number) {
  return n ? String(n) : "—";
}

function HourChips({
  projectHours,
  overhead,
  totalAlloc,
  unallocatedHours,
  exceedsLimit,
  dayTotalHours,
  maxDailyHours,
}: {
  projectHours: ProjectHours;
  overhead: number;
  totalAlloc: number;
  unallocatedHours?: number;
  exceedsLimit?: boolean;
  dayTotalHours?: number;
  maxDailyHours?: number;
}) {
  return (
    <div className="hour-chips">
      <span>
        <em>A</em> {fmtHours(projectHours.A)}
      </span>
      <span>
        <em>B</em> {fmtHours(projectHours.B)}
      </span>
      <span>
        <em>C</em> {fmtHours(projectHours.C)}
      </span>
      <span>
        <em>OH</em> {fmtHours(overhead)}
      </span>
      <span>
        <em>Unalloc</em> {fmtHours(unallocatedHours ?? 0)}
      </span>
      <span className="hour-chips__total">
        <em>Total</em> {fmtHours(totalAlloc)}
      </span>
      {exceedsLimit && dayTotalHours != null && maxDailyHours != null && (
        <span className="hour-chips__ot">
          <em>OT</em> {dayTotalHours}h / {maxDailyHours}h
        </span>
      )}
    </div>
  );
}

function statusBadge(group: SupervisorGroup) {
  if (group.hasConflict) return { text: "Conflict", className: "badge badge-conflict" };
  if (group.exceedsLimit) return { text: "Over daily limit", className: "badge badge-conflict" };
  if (group.isAmendment) return { text: "New hours only", className: "badge badge-pending" };
  if (group.pendingDays > 0) {
    return {
      text: `Pending ${group.pendingDays} day${group.pendingDays === 1 ? "" : "s"}`,
      className: "badge badge-pending",
    };
  }
  return { text: "Pending", className: "badge badge-pending" };
}

export function ApprovalsPage() {
  const { user } = useAuth();
  const canApprove = user && ["HOD", "PM", "ADMIN"].includes(user.role);
  const isHodLike = user && (user.role === "HOD" || user.role === "ADMIN");
  const isProjectHead = user?.role === "PM";

  const [tab, setTab] = useState<"pending" | "approved">("pending");
  const [viewMode, setViewMode] = useState<"supervisor" | "employee">("supervisor");
  const [received, setReceived] = useState<SupervisorGroup[]>([]);
  const [returned, setReturned] = useState<ReturnedRow[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [roleLabel, setRoleLabel] = useState("HOD");
  const [maxDailyHours, setMaxDailyHours] = useState(8);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [comments, setComments] = useState<Record<number, string>>({});
  const [hodNotes, setHodNotes] = useState<Record<number, string>>({});
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  const title = isProjectHead ? "Project Head Approvals" : `${roleLabel === "Admin" ? "HOD" : roleLabel} Approvals`;

  const allEmployeeIds = useMemo(
    () => received.flatMap((g) => g.employees.map((e) => e.id)),
    [received]
  );

  const loadPending = useCallback(async () => {
    if (!canApprove) return;
    setLoading(true);
    setError("");
    try {
      const data = await api<PendingPayload>("/approvals/pending");
      setReceived(data.received);
      setReturned(data.returnedByPlanning || []);
      setRoleLabel(data.roleLabel);
      setMaxDailyHours(data.maxDailyHours);
      setExpanded((prev) => {
        const next = { ...prev };
        for (const g of data.received) {
          const key = `${g.supervisorId}|${g.workDate}`;
          if (next[key] === undefined) next[key] = g.hasConflict || data.received.length <= 3;
        }
        return next;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load approvals");
    } finally {
      setLoading(false);
    }
  }, [canApprove]);

  const loadHistory = useCallback(async () => {
    if (!canApprove) return;
    setLoading(true);
    setError("");
    try {
      const data = await api<{ items: HistoryItem[]; roleLabel: string }>("/approvals/history");
      setHistory(data.items);
      setRoleLabel(data.roleLabel);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load approval history");
    } finally {
      setLoading(false);
    }
  }, [canApprove]);

  useEffect(() => {
    if (tab === "pending") loadPending();
    else loadHistory();
  }, [tab, loadPending, loadHistory]);

  function toggleSelect(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleGroup(group: SupervisorGroup) {
    const ids = group.employees.map((e) => e.id);
    const allOn = ids.every((id) => selected.has(id));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (allOn) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }

  function toggleSelectAll() {
    if (selected.size === allEmployeeIds.length && allEmployeeIds.length > 0) {
      setSelected(new Set());
    } else {
      setSelected(new Set(allEmployeeIds));
    }
  }

  async function batchAct(action: "approve" | "reject", ids: number[], comment?: string) {
    if (!ids.length) return;
    setMessage("");
    setError("");
    try {
      await api("/approvals/batch", {
        method: "POST",
        body: JSON.stringify({ ids, action, comment: comment || undefined }),
      });
      setMessage(
        action === "approve"
          ? isProjectHead
            ? `Approved ${ids.length} employee sheet${ids.length === 1 ? "" : "s"}.`
            : `Approved ${ids.length} employee sheet${ids.length === 1 ? "" : "s"}. Forwarded to Project Head.`
          : isProjectHead
            ? `Returned ${ids.length} sheet${ids.length === 1 ? "" : "s"} to HOD (Planning).`
            : `Rejected ${ids.length} employee sheet${ids.length === 1 ? "" : "s"}.`
      );
      setSelected((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
      await loadPending();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    }
  }

  async function actOne(id: number, action: "approve" | "reject") {
    await batchAct(action, [id], comments[id]);
  }

  async function sendBack(id: number) {
    setMessage("");
    setError("");
    try {
      await api(`/approvals/${id}/send-back`, {
        method: "POST",
        body: JSON.stringify({ comment: hodNotes[id] || undefined }),
      });
      setMessage("Sent back to supervisor.");
      await loadPending();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Send back failed");
    }
  }

  if (!canApprove) {
    return (
      <div className="error-banner">
        Approvals are available for HOD / Project Head / Admin. Log in as hod@company.com / password123.
      </div>
    );
  }

  const flatEmployees = received.flatMap((g) => g.employees);

  return (
    <div className="hod-approvals">
      <div className="hod-approvals__head">
        <h2 className="hod-approvals__title">{title}</h2>
        <p className="muted hod-approvals__hint">
          Daily limit {maxDailyHours}h · Project A/B/C from WBS · OH = other projects · Unallocated = remaining vs daily max
          · After a prior approval, only newly added hours appear here for re-approval.
        </p>
      </div>

      <div className="hod-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          className={`hod-tab ${tab === "pending" ? "active" : ""}`}
          aria-selected={tab === "pending"}
          onClick={() => setTab("pending")}
        >
          Pending
        </button>
        <button
          type="button"
          role="tab"
          className={`hod-tab ${tab === "approved" ? "active" : ""}`}
          aria-selected={tab === "approved"}
          onClick={() => setTab("approved")}
        >
          Approved
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {message && <div className="carry-banner">{message}</div>}
      {loading && <p className="muted">Loading…</p>}

      {tab === "pending" && (
        <>
          <section className="hod-section">
            <div className="hod-section__header">
              <h3>{isProjectHead ? "Received from HOD" : "Received from Supervisors"}</h3>
              <div className="view-toggle" role="group" aria-label="View mode">
                <button
                  type="button"
                  className={viewMode === "supervisor" ? "active" : ""}
                  onClick={() => setViewMode("supervisor")}
                >
                  By Supervisor
                </button>
                <button
                  type="button"
                  className={viewMode === "employee" ? "active" : ""}
                  onClick={() => setViewMode("employee")}
                >
                  By Employee
                </button>
              </div>
            </div>

            <div className="bulk-bar bulk-bar--desktop">
              <label className="bulk-bar__select">
                <input
                  type="checkbox"
                  checked={allEmployeeIds.length > 0 && selected.size === allEmployeeIds.length}
                  onChange={toggleSelectAll}
                />
                Select All
              </label>
              <div className="bulk-bar__actions">
                <button
                  type="button"
                  className="btn btn-danger-outline"
                  disabled={selected.size === 0}
                  onClick={() => batchAct("reject", [...selected])}
                >
                  Reject Selected ({selected.size})
                </button>
                <button
                  type="button"
                  className="btn btn-approve"
                  disabled={selected.size === 0}
                  onClick={() => batchAct("approve", [...selected])}
                >
                  Approve Selected ({selected.size})
                </button>
              </div>
            </div>

            <div className="hod-table-wrap hod-desktop-only">
              <table className="hod-table">
                <thead>
                  <tr>
                    <th className="col-check" />
                    <th>{viewMode === "supervisor" ? "Supervisor" : "Employee"}</th>
                    <th>Date</th>
                    <th>Project A</th>
                    <th>Project B</th>
                    <th>Project C</th>
                    <th>Total Alloc.</th>
                    <th>Unallocated</th>
                    <th>Approve</th>
                    <th>Reject</th>
                    <th>Comments</th>
                  </tr>
                </thead>
                <tbody>
                  {viewMode === "supervisor" &&
                    received.map((g) => {
                      const key = `${g.supervisorId}|${g.workDate}`;
                      const isOpen = !!expanded[key];
                      const badge = statusBadge(g);
                      const groupSelected = g.employees.every((e) => selected.has(e.id));
                      return (
                        <Fragment key={key}>
                          <tr className={`hod-row supervisor-row ${g.hasConflict ? "conflict" : ""}`}>
                            <td>
                              <input
                                type="checkbox"
                                checked={groupSelected && g.employees.length > 0}
                                onChange={() => toggleGroup(g)}
                              />
                            </td>
                            <td>
                              <button
                                type="button"
                                className="expand-btn"
                                onClick={() => setExpanded((p) => ({ ...p, [key]: !p[key] }))}
                                aria-expanded={isOpen}
                              >
                                <span className={`chevron ${isOpen ? "open" : ""}`}>▸</span>
                                <strong>{g.supervisorName}</strong>
                                <span className={badge.className}>{badge.text}</span>
                              </button>
                            </td>
                            <td>{g.workDate}</td>
                            <td>{fmtHours(g.projectHours.A)}</td>
                            <td>{fmtHours(g.projectHours.B)}</td>
                            <td>{fmtHours(g.projectHours.C)}</td>
                            <td className="total-cell">{fmtHours(g.totalAlloc)}</td>
                            <td>{fmtHours(g.unallocatedHours ?? 0)}</td>
                            <td>
                              <button
                                type="button"
                                className="btn-sm btn-approve"
                                onClick={() => batchAct("approve", g.employees.map((e) => e.id))}
                              >
                                Approve
                              </button>
                            </td>
                            <td>
                              <button
                                type="button"
                                className="btn-sm btn-reject"
                                onClick={() => batchAct("reject", g.employees.map((e) => e.id))}
                              >
                                Reject
                              </button>
                            </td>
                            <td />
                          </tr>
                          {isOpen &&
                            g.employees.map((emp) => (
                              <tr
                                key={emp.id}
                                className={`hod-row employee-row ${emp.hasConflict ? "conflict" : ""}`}
                              >
                                <td>
                                  <input
                                    type="checkbox"
                                    checked={selected.has(emp.id)}
                                    onChange={() => toggleSelect(emp.id)}
                                  />
                                </td>
                                <td className="emp-indent">
                                  {emp.employee.name}
                                  {emp.isAmendment && (
                                    <div className="muted tiny">New hours only</div>
                                  )}
                                  {emp.exceedsLimit && (
                                    <div className="ot-alert">
                                      {emp.dayTotalHours}h / {emp.maxDailyHours}h limit
                                      {emp.remarks ? ` · ${emp.remarks}` : ""}
                                    </div>
                                  )}
                                  {!emp.exceedsLimit && emp.remarks && (
                                    <div className="muted tiny">{emp.remarks}</div>
                                  )}
                                </td>
                                <td>{emp.workDate}</td>
                                <td>{fmtHours(emp.projectHours.A)}</td>
                                <td>{fmtHours(emp.projectHours.B)}</td>
                                <td>{fmtHours(emp.projectHours.C)}</td>
                                <td className="total-cell">{fmtHours(emp.totalAlloc)}</td>
                                <td>{fmtHours(emp.unallocatedHours ?? 0)}</td>
                                <td>
                                  <button
                                    type="button"
                                    className="btn-sm btn-approve"
                                    onClick={() => actOne(emp.id, "approve")}
                                  >
                                    Approve
                                  </button>
                                </td>
                                <td>
                                  <button
                                    type="button"
                                    className="btn-sm btn-reject"
                                    onClick={() => actOne(emp.id, "reject")}
                                  >
                                    Reject
                                  </button>
                                </td>
                                <td>
                                  <input
                                    className="comment-input"
                                    placeholder="Add comment…"
                                    value={comments[emp.id] || ""}
                                    onChange={(e) =>
                                      setComments((p) => ({ ...p, [emp.id]: e.target.value }))
                                    }
                                  />
                                </td>
                              </tr>
                            ))}
                        </Fragment>
                      );
                    })}

                  {viewMode === "employee" &&
                    flatEmployees.map((emp) => (
                      <tr
                        key={emp.id}
                        className={`hod-row ${emp.hasConflict ? "conflict" : ""}`}
                      >
                        <td>
                          <input
                            type="checkbox"
                            checked={selected.has(emp.id)}
                            onChange={() => toggleSelect(emp.id)}
                          />
                        </td>
                        <td>
                          <strong>{emp.employee.name}</strong>
                          <div className="muted tiny">Sup: {emp.supervisor.name}</div>
                          {emp.isAmendment && <div className="muted tiny">New hours only</div>}
                          {emp.exceedsLimit && (
                            <div className="ot-alert">
                              {emp.dayTotalHours}h / {emp.maxDailyHours}h limit
                              {emp.remarks ? ` · ${emp.remarks}` : ""}
                            </div>
                          )}
                          {!emp.exceedsLimit && emp.remarks && (
                            <div className="muted tiny">{emp.remarks}</div>
                          )}
                        </td>
                        <td>{emp.workDate}</td>
                        <td>{fmtHours(emp.projectHours.A)}</td>
                        <td>{fmtHours(emp.projectHours.B)}</td>
                        <td>{fmtHours(emp.projectHours.C)}</td>
                        <td className="total-cell">{fmtHours(emp.totalAlloc)}</td>
                        <td>{fmtHours(emp.unallocatedHours ?? 0)}</td>
                        <td>
                          <button
                            type="button"
                            className="btn-sm btn-approve"
                            onClick={() => actOne(emp.id, "approve")}
                          >
                            Approve
                          </button>
                        </td>
                        <td>
                          <button
                            type="button"
                            className="btn-sm btn-reject"
                            onClick={() => actOne(emp.id, "reject")}
                          >
                            Reject
                          </button>
                        </td>
                        <td>
                          <input
                            className="comment-input"
                            placeholder="Add comment…"
                            value={comments[emp.id] || ""}
                            onChange={(e) => setComments((p) => ({ ...p, [emp.id]: e.target.value }))}
                          />
                        </td>
                      </tr>
                    ))}

                  {!loading && received.length === 0 && (
                    <tr>
                      <td colSpan={11} className="empty-cell">
                        No pending submissions from supervisors.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Phone card layout */}
            <div className="hod-cards hod-mobile-only">
              {viewMode === "supervisor" &&
                received.map((g) => {
                  const key = `${g.supervisorId}|${g.workDate}`;
                  const isOpen = !!expanded[key];
                  const badge = statusBadge(g);
                  const groupSelected = g.employees.every((e) => selected.has(e.id));
                  return (
                    <article
                      key={key}
                      className={`hod-card ${g.hasConflict ? "conflict" : ""}`}
                    >
                      <header className="hod-card__head">
                        <label className="hod-card__check">
                          <input
                            type="checkbox"
                            checked={groupSelected && g.employees.length > 0}
                            onChange={() => toggleGroup(g)}
                          />
                        </label>
                        <button
                          type="button"
                          className="expand-btn hod-card__expand"
                          onClick={() => setExpanded((p) => ({ ...p, [key]: !p[key] }))}
                          aria-expanded={isOpen}
                        >
                          <span className={`chevron ${isOpen ? "open" : ""}`}>▸</span>
                          <div>
                            <strong>{g.supervisorName}</strong>
                            <div className="muted tiny">{g.workDate}</div>
                          </div>
                          <span className={badge.className}>{badge.text}</span>
                        </button>
                      </header>
                      <HourChips
                        projectHours={g.projectHours as ProjectHours}
                        overhead={g.overhead}
                        totalAlloc={g.totalAlloc}
                        unallocatedHours={g.unallocatedHours}
                        exceedsLimit={g.exceedsLimit}
                      />
                      <div className="hod-card__actions">
                        <button
                          type="button"
                          className="btn-sm btn-approve"
                          onClick={() => batchAct("approve", g.employees.map((e) => e.id))}
                        >
                          Approve all
                        </button>
                        <button
                          type="button"
                          className="btn-sm btn-reject"
                          onClick={() => batchAct("reject", g.employees.map((e) => e.id))}
                        >
                          Reject all
                        </button>
                      </div>
                      {isOpen && (
                        <div className="hod-card__children">
                          {g.employees.map((emp) => (
                            <div
                              key={emp.id}
                              className={`hod-card hod-card--child ${emp.hasConflict ? "conflict" : ""}`}
                            >
                              <header className="hod-card__head">
                                <label className="hod-card__check">
                                  <input
                                    type="checkbox"
                                    checked={selected.has(emp.id)}
                                    onChange={() => toggleSelect(emp.id)}
                                  />
                                </label>
                                <div>
                                  <strong>{emp.employee.name}</strong>
                                  <div className="muted tiny">{emp.workDate}</div>
                                </div>
                              </header>
                              <HourChips
                                projectHours={emp.projectHours}
                                overhead={emp.overhead}
                                totalAlloc={emp.totalAlloc}
                                unallocatedHours={emp.unallocatedHours}
                                exceedsLimit={emp.exceedsLimit}
                                dayTotalHours={emp.dayTotalHours}
                                maxDailyHours={emp.maxDailyHours}
                              />
                              {emp.isAmendment && (
                                <div className="muted tiny">New hours only (prior approval kept)</div>
                              )}
                              {emp.exceedsLimit && (
                                <div className="ot-alert">
                                  Day total {emp.dayTotalHours}h exceeds {emp.maxDailyHours}h limit
                                  {emp.remarks ? ` — Remarks: ${emp.remarks}` : " — remarks required"}
                                </div>
                              )}
                              {!emp.exceedsLimit && emp.remarks && (
                                <div className="muted tiny">Remarks: {emp.remarks}</div>
                              )}
                              <input
                                className="comment-input"
                                placeholder="Add comment…"
                                value={comments[emp.id] || ""}
                                onChange={(e) =>
                                  setComments((p) => ({ ...p, [emp.id]: e.target.value }))
                                }
                              />
                              <div className="hod-card__actions">
                                <button
                                  type="button"
                                  className="btn-sm btn-approve"
                                  onClick={() => actOne(emp.id, "approve")}
                                >
                                  Approve
                                </button>
                                <button
                                  type="button"
                                  className="btn-sm btn-reject"
                                  onClick={() => actOne(emp.id, "reject")}
                                >
                                  Reject
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </article>
                  );
                })}

              {viewMode === "employee" &&
                flatEmployees.map((emp) => (
                  <article
                    key={emp.id}
                    className={`hod-card ${emp.hasConflict ? "conflict" : ""}`}
                  >
                    <header className="hod-card__head">
                      <label className="hod-card__check">
                        <input
                          type="checkbox"
                          checked={selected.has(emp.id)}
                          onChange={() => toggleSelect(emp.id)}
                        />
                      </label>
                      <div>
                        <strong>{emp.employee.name}</strong>
                        <div className="muted tiny">
                          {emp.supervisor.name} · {emp.workDate}
                        </div>
                      </div>
                    </header>
                    <HourChips
                      projectHours={emp.projectHours}
                      overhead={emp.overhead}
                      totalAlloc={emp.totalAlloc}
                      unallocatedHours={emp.unallocatedHours}
                      exceedsLimit={emp.exceedsLimit}
                      dayTotalHours={emp.dayTotalHours}
                      maxDailyHours={emp.maxDailyHours}
                    />
                    {emp.isAmendment && (
                      <div className="muted tiny">New hours only (prior approval kept)</div>
                    )}
                    {emp.exceedsLimit && (
                      <div className="ot-alert">
                        Day total {emp.dayTotalHours}h exceeds {emp.maxDailyHours}h limit
                        {emp.remarks ? ` — Remarks: ${emp.remarks}` : " — remarks required"}
                      </div>
                    )}
                    {!emp.exceedsLimit && emp.remarks && (
                      <div className="muted tiny">Remarks: {emp.remarks}</div>
                    )}
                    <input
                      className="comment-input"
                      placeholder="Add comment…"
                      value={comments[emp.id] || ""}
                      onChange={(e) => setComments((p) => ({ ...p, [emp.id]: e.target.value }))}
                    />
                    <div className="hod-card__actions">
                      <button
                        type="button"
                        className="btn-sm btn-approve"
                        onClick={() => actOne(emp.id, "approve")}
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        className="btn-sm btn-reject"
                        onClick={() => actOne(emp.id, "reject")}
                      >
                        Reject
                      </button>
                    </div>
                  </article>
                ))}

              {!loading && received.length === 0 && (
                <p className="muted empty-card">No pending submissions from supervisors.</p>
              )}
            </div>

            <div className="bulk-bar bulk-bar--mobile hod-mobile-only">
              <label className="bulk-bar__select">
                <input
                  type="checkbox"
                  checked={allEmployeeIds.length > 0 && selected.size === allEmployeeIds.length}
                  onChange={toggleSelectAll}
                />
                Select All
              </label>
              <div className="bulk-bar__actions">
                <button
                  type="button"
                  className="btn btn-danger-outline"
                  disabled={selected.size === 0}
                  onClick={() => batchAct("reject", [...selected])}
                >
                  Reject ({selected.size})
                </button>
                <button
                  type="button"
                  className="btn btn-approve"
                  disabled={selected.size === 0}
                  onClick={() => batchAct("approve", [...selected])}
                >
                  Approve ({selected.size})
                </button>
              </div>
            </div>
          </section>

          {isHodLike && (
            <section className="hod-section">
              <div className="hod-section__header">
                <h3>Sent Back by Planning</h3>
              </div>
              <div className="hod-table-wrap hod-desktop-only">
                <table className="hod-table">
                  <thead>
                    <tr>
                      <th>Sr.</th>
                      <th>Supervisor</th>
                      <th>Employee</th>
                      <th>Date</th>
                      <th>Project A</th>
                      <th>Project B</th>
                      <th>Project C</th>
                      <th>Total Alloc.</th>
                      <th>Overhead</th>
                      <th>Planning’s Comment</th>
                      <th>Action</th>
                      <th>HOD Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {returned.map((row, idx) => (
                      <tr key={row.id} className="hod-row">
                        <td>{idx + 1}</td>
                        <td>{row.supervisor.name}</td>
                        <td>{row.employee.name}</td>
                        <td>{row.workDate}</td>
                        <td>{fmtHours(row.projectHours.A)}</td>
                        <td>{fmtHours(row.projectHours.B)}</td>
                        <td>{fmtHours(row.projectHours.C)}</td>
                        <td className="total-cell">{fmtHours(row.totalAlloc)}</td>
                        <td>{fmtHours(row.overhead)}</td>
                        <td className="planning-comment">{row.planningComment || "—"}</td>
                        <td>
                          <button
                            type="button"
                            className="btn-sm btn-send-back"
                            onClick={() => sendBack(row.id)}
                          >
                            Send back to Supervisor
                          </button>
                        </td>
                        <td>
                          <input
                            className="comment-input"
                            placeholder="HOD note…"
                            value={hodNotes[row.id] || ""}
                            onChange={(e) => setHodNotes((p) => ({ ...p, [row.id]: e.target.value }))}
                          />
                        </td>
                      </tr>
                    ))}
                    {!loading && returned.length === 0 && (
                      <tr>
                        <td colSpan={12} className="empty-cell">
                          No sheets returned by Project Head / Planning.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="hod-cards hod-mobile-only">
                {returned.map((row) => (
                  <article key={row.id} className="hod-card">
                    <header className="hod-card__head">
                      <div>
                        <strong>{row.employee.name}</strong>
                        <div className="muted tiny">
                          {row.supervisor.name} · {row.workDate}
                        </div>
                      </div>
                    </header>
                    <HourChips
                      projectHours={row.projectHours}
                      overhead={row.overhead}
                      totalAlloc={row.totalAlloc}
                    />
                    <p className="planning-comment">{row.planningComment || "—"}</p>
                    <input
                      className="comment-input"
                      placeholder="HOD note…"
                      value={hodNotes[row.id] || ""}
                      onChange={(e) => setHodNotes((p) => ({ ...p, [row.id]: e.target.value }))}
                    />
                    <div className="hod-card__actions">
                      <button
                        type="button"
                        className="btn-sm btn-send-back"
                        onClick={() => sendBack(row.id)}
                      >
                        Send back to Supervisor
                      </button>
                    </div>
                  </article>
                ))}
                {!loading && returned.length === 0 && (
                  <p className="muted empty-card">No sheets returned by Project Head / Planning.</p>
                )}
              </div>
            </section>
          )}
        </>
      )}

      {tab === "approved" && (
        <section className="hod-section">
          <div className="hod-section__header">
            <h3>My approvals</h3>
            <p className="muted" style={{ margin: 0 }}>
              All decisions you have taken as {roleLabel}.
            </p>
          </div>
          <div className="hod-table-wrap hod-desktop-only">
            <table className="hod-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Action</th>
                  <th>Employee</th>
                  <th>Supervisor</th>
                  <th>Date</th>
                  <th>Project A</th>
                  <th>Project B</th>
                  <th>Project C</th>
                  <th>Total</th>
                  <th>Overhead</th>
                  <th>Status now</th>
                  <th>Comment</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.approvalId} className="hod-row">
                    <td>{new Date(h.approvedAt).toLocaleString()}</td>
                    <td>
                      <span className={`badge ${h.action === "APPROVE" ? "badge-ok" : "badge-pending"}`}>
                        {h.action}
                      </span>
                    </td>
                    <td>{h.employee.name}</td>
                    <td>{h.supervisor.name}</td>
                    <td>{h.workDate}</td>
                    <td>{fmtHours(h.projectHours.A)}</td>
                    <td>{fmtHours(h.projectHours.B)}</td>
                    <td>{fmtHours(h.projectHours.C)}</td>
                    <td className="total-cell">{fmtHours(h.totalAlloc)}</td>
                    <td>{fmtHours(h.overhead)}</td>
                    <td>{h.resultingStatus}</td>
                    <td>{h.comment || "—"}</td>
                  </tr>
                ))}
                {!loading && history.length === 0 && (
                  <tr>
                    <td colSpan={12} className="empty-cell">
                      No approvals recorded yet for your account.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="hod-cards hod-mobile-only">
            {history.map((h) => (
              <article key={h.approvalId} className="hod-card">
                <header className="hod-card__head">
                  <div>
                    <strong>{h.employee.name}</strong>
                    <div className="muted tiny">
                      {h.supervisor.name} · {h.workDate}
                    </div>
                  </div>
                  <span className={`badge ${h.action === "APPROVE" ? "badge-ok" : "badge-pending"}`}>
                    {h.action}
                  </span>
                </header>
                <HourChips
                  projectHours={h.projectHours}
                  overhead={h.overhead}
                  totalAlloc={h.totalAlloc}
                />
                <div className="muted tiny">
                  {new Date(h.approvedAt).toLocaleString()} · Now: {h.resultingStatus}
                </div>
                {h.comment && <p className="planning-comment">{h.comment}</p>}
              </article>
            ))}
            {!loading && history.length === 0 && (
              <p className="muted empty-card">No approvals recorded yet for your account.</p>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
