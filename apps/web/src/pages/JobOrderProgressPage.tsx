import { FormEvent, Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import "../styles/supervisors.css";
import "./JobOrderProgressPage.css";

/* ============================================================================
   Job Order quantity progress — punching (HOD) and decisions (PM).

   Quantity and hours are INDEPENDENT measures: this screen only ever shows
   quantity. Regular hours are booked on the Timesheet screen.

   `cumulativeQuantity` is the total achieved TO DATE, never a daily increment,
   so it must never decrease. An HOD amends a figure only after the PM rejects
   it or sends it back; an amendment keeps the old revision as history.
   ============================================================================ */

type ProgressStatus = "SUBMITTED" | "APPROVED" | "REJECTED" | "SENT_BACK";
type Tab = "punch" | "queue";
type DecisionAction = "APPROVE" | "REJECT" | "SEND_BACK";

type Uom = { code: string; name: string };
type SectionRef = { id: number; code: string; name: string; departmentId: number };
type ProjectRef = { id: number; code: string; name: string; colorKey: string };

type JobOrderOption = {
  id: number;
  code: string;
  name: string;
  status: string;
  sectionId: number | null;
  departmentId: number;
  uom: Uom | null;
  budgetedQuantity: number;
  project: { id: number; code: string; name: string; colorKey: string };
  projectWbs: { wbsCode: string } | null;
  lastApprovedCumulative: number;
  lastEntry: {
    id: number;
    progressDate: string;
    cumulativeQuantity: number;
    revisionNo: number;
    status: string;
  } | null;
};

type RemarkHistoryItem = {
  id: number;
  kind: string;
  remark: string;
  authorName: string | null;
  authorRole: string;
  createdAt: string;
};

type HistoryRevision = {
  id: number;
  revisionNo: number;
  status: string;
  cumulativeQuantity: number;
  remarks: string | null;
  createdAt: string;
  punchedBy: { name: string } | null;
  approvedBy: { name: string } | null;
};

type ProgressEntry = {
  id: number;
  progressDate: string;
  cumulativeQuantity: number;
  revisionNo: number;
  status: string;
  remarks: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  section: { id: number; name: string } | null;
  approvedBy: { name: string } | null;
  jobOrder: {
    id: number;
    code: string;
    name: string;
    budgetedQuantity: number;
    uom: Uom | null;
    project: { code: string; name: string; colorKey: string };
  };
  history: HistoryRevision[];
  /** Every remark about this entry, oldest first. */
  remarksHistory: RemarkHistoryItem[];
};

type MinePayload = {
  requiresSectionSelection: boolean;
  sectionId: number | null;
  /** Present when the punch scope cannot be resolved yet, for example before a section is chosen. */
  scopeError?: { code: string; error: string } | null;
  sections: SectionRef[];
  projects: ProjectRef[];
  jobOrders: JobOrderOption[];
  entries: ProgressEntry[];
};

type PendingEntry = {
  id: number;
  progressDate: string;
  cumulativeQuantity: number;
  revisionNo: number;
  status: string;
  remarks: string | null;
  createdAt: string;
  punchedBy: { name: string } | null;
  section: { name: string } | null;
  budgetedQuantity: number;
  lastApprovedCumulative: number;
  proposedCumulative: number;
  previousCumulative: number | null;
  remarksHistory: RemarkHistoryItem[];
};

type PendingGroup = {
  jobOrderId: number;
  jobOrderCode: string;
  jobOrderName: string;
  display: string;
  colorKey: string;
  projectName: string;
  wbsCode: string | null;
  uom: Uom | null;
  budgetedQuantity: number;
  lastApprovedCumulative: number;
  entries: PendingEntry[];
};

type PendingPayload = { pendingCount: number; groups: PendingGroup[] };

const QTY_FMT = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 3 });

const STATUS_LABEL: Record<string, string> = {
  SUBMITTED: "Submitted",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  SENT_BACK: "Sent back",
};

/** Sorted list used by the status filter and the status map. */
const STATUSES: ProgressStatus[] = ["SUBMITTED", "APPROVED", "REJECTED", "SENT_BACK"];

function fmtQty(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "—" : QTY_FMT.format(value);
}

function fmtDate(iso: string): string {
  const date = new Date(iso.length <= 10 ? iso + "T00:00:00" : iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function fmtDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function todayIso(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

const REMARK_KIND_LABEL: Record<string, string> = {
  PUNCH: "Punch",
  AMEND: "Amendment",
  APPROVE: "Approval",
  REJECT: "Rejection",
  SEND_BACK: "Sent back",
};

function remarkKindLabel(kind: string): string {
  return REMARK_KIND_LABEL[kind] ?? kind;
}

/** The stage a remark was written at, as its own chip colour. */
function remarkChipClass(kind: string): string {
  return "jop-chip jop-chip--remark-" + kind.toLowerCase().replace(/_/g, "-");
}

function hasEntryDetail(entry: { history: HistoryRevision[]; remarksHistory: RemarkHistoryItem[] }): boolean {
  return entry.history.length > 1 || entry.remarksHistory.length > 0;
}

function detailLabel(entry: { history: HistoryRevision[]; remarksHistory: RemarkHistoryItem[] }): string {
  const parts: string[] = [];
  if (entry.remarksHistory.length) {
    parts.push(entry.remarksHistory.length + (entry.remarksHistory.length === 1 ? " remark" : " remarks"));
  }
  if (entry.history.length > 1) parts.push(entry.history.length + " revisions");
  return parts.join(" · ") || "Detail";
}

function chipClass(status: string): string {
  return "jop-chip jop-chip--" + status.toLowerCase().replace(/_/g, "-");
}

/** The display form required on every Job Order picker: Job_Order-Job_Description. */
function jobOrderDisplay(code: string, name: string): string {
  return code + "-" + name;
}

function unitSuffix(uom: Uom | null | undefined): string {
  return uom && uom.code ? " " + uom.code : "";
}

function projectDot(colorKey: string): string {
  const key = colorKey.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
  return key ? "var(--project-" + key + ", var(--primary))" : "var(--primary)";
}

/** An HOD may amend a figure only after the PM rejects it or sends it back. */
function isAmendable(status: string): boolean {
  return status === "REJECTED" || status === "SENT_BACK";
}

function errorText(e: unknown): string {
  return e instanceof ApiError && e.payload && typeof e.payload === "object" && "error" in e.payload
    ? String((e.payload as { error: string }).error)
    : e instanceof Error
      ? e.message
      : "Request failed";
}

function HistoryList({ history, uom }: { history: HistoryRevision[]; uom: Uom | null }) {
  const unit = unitSuffix(uom);
  return (
    <ol className="jop-history">
      {history.map((revision) => (
        <li key={revision.id} className="jop-history__item">
          <div className="jop-history__top">
            <strong>Revision {revision.revisionNo}</strong>
            <span className={chipClass(revision.status)}>{statusLabel(revision.status)}</span>
            <span className="jop-qty">
              {fmtQty(revision.cumulativeQuantity)}
              {unit}
            </span>
          </div>
          <div className="jop-history__meta">
            Punched by {revision.punchedBy?.name ?? "—"}
            {revision.approvedBy ? " · decided by " + revision.approvedBy.name : ""} · {fmtDateTime(revision.createdAt)}
          </div>
          {revision.remarks && <div className="jop-history__meta">Remark: {revision.remarks}</div>}
        </li>
      ))}
    </ol>
  );
}

/** Every remark about one entry, oldest first: what was said, by whom, at which stage. */
function RemarkHistoryList({ items }: { items: RemarkHistoryItem[] }) {
  if (items.length === 0) return null;
  return (
    <ol className="jop-remark-list">
      {items.map((item) => (
        <li key={item.id} className="jop-remark">
          <div className="jop-remark__top">
            <span className={remarkChipClass(item.kind)}>{remarkKindLabel(item.kind)}</span>
            <span className="jop-remark__author">
              {item.authorName ?? "System"}
              {item.authorRole ? " · " + item.authorRole : ""}
            </span>
            <span className="jop-remark__when jop-tiny muted">{fmtDateTime(item.createdAt)}</span>
          </div>
          <p className="jop-remark__text">{item.remark}</p>
        </li>
      ))}
    </ol>
  );
}

function AmendModal({
  entry,
  floor,
  busy,
  onClose,
  onSubmit,
}: {
  entry: ProgressEntry;
  floor: number;
  busy: boolean;
  onClose: () => void;
  onSubmit: (payload: { cumulativeQuantity: number; remarks: string }) => void;
}) {
  const [quantity, setQuantity] = useState(String(entry.cumulativeQuantity));
  const [remarks, setRemarks] = useState(entry.remarks ?? "");
  const [localError, setLocalError] = useState("");
  const uom = entry.jobOrder.uom;
  const unit = unitSuffix(uom);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Amend quantity progress" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <h2>Amend quantity progress</h2>
          <button type="button" className="modal__close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <form
          className="modal__body jop-stack"
          onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            const value = Number(quantity);
            if (!quantity.trim() || !Number.isFinite(value) || value < 0) {
              setLocalError("Enter the corrected cumulative quantity (0 or more).");
              return;
            }
            if (value < floor) {
              setLocalError("Cumulative quantity cannot decrease. The last approved figure is " + fmtQty(floor) + unit + ".");
              return;
            }
            setLocalError("");
            onSubmit({ cumulativeQuantity: value, remarks: remarks.trim() });
          }}
        >
          <div className="jop-facts">
            <span className="jop-fact">
              <em>Job Order</em>
              {jobOrderDisplay(entry.jobOrder.code, entry.jobOrder.name)}
            </span>
            <span className="jop-fact">
              <em>Date</em>
              {fmtDate(entry.progressDate)}
            </span>
            <span className="jop-fact">
              <em>Current</em>
              {fmtQty(entry.cumulativeQuantity)}
              {unit} · r{entry.revisionNo}
            </span>
            <span className="jop-fact">
              <em>Status</em>
              {statusLabel(entry.status)}
            </span>
            <span className="jop-fact jop-fact--budget">
              <em>Approved to date</em>
              {fmtQty(floor)}
              {unit}
            </span>
          </div>
          <div className="jop-field">
            <label htmlFor="jop-amend-quantity">Corrected cumulative quantity{unit ? " (" + uom?.code + ")" : ""}</label>
            <input
              id="jop-amend-quantity"
              aria-label="Corrected cumulative quantity"
              type="number"
              min={0}
              step="any"
              inputMode="decimal"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              required
            />
          </div>
          <div className="jop-field">
            <label htmlFor="jop-amend-remarks">Remarks</label>
            <textarea
              id="jop-amend-remarks"
              aria-label="Amendment remarks"
              rows={3}
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
            />
          </div>
          <p className="muted jop-tiny">
            The refused revision stays in the history. This amendment is saved as revision {entry.revisionNo + 1} and
            goes back to the Project Head for a decision.
          </p>
          {localError && (
            <div className="error-banner" role="alert" style={{ marginBottom: 0 }}>
              {localError}
            </div>
          )}
          <div className="modal__footer" style={{ padding: 0, borderTop: "none" }}>
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? "Amending…" : "Amend revision"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function JobOrderProgressPage() {
  const { user } = useAuth();
  const role = user?.role ?? "";
  const canPunch = role === "HOD" || role === "DEPT_HEAD" || role === "ADMIN";
  // Approval is the PM's alone. An Admin may watch the queue but decides nothing.
  const canDecide = role === "PM";
  // A Department Head owns every section under his department, so he punches with an
  // explicitly selected section; the decision on the figure stays with the PM.
  const isDeptHead = role === "DEPT_HEAD";

  const [tab, setTab] = useState<Tab>(role === "PM" ? "queue" : "punch");
  const [mine, setMine] = useState<MinePayload | null>(null);
  const [queue, setQueue] = useState<PendingPayload | null>(null);

  const [sectionId, setSectionId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [jobOrderId, setJobOrderId] = useState("");
  const [progressDate, setProgressDate] = useState(todayIso);
  const [quantity, setQuantity] = useState("");
  const [remarks, setRemarks] = useState("");
  const [comments, setComments] = useState<Record<number, string>>({});
  const [expandedHistory, setExpandedHistory] = useState<Record<number, boolean>>({});
  const [amendEntry, setAmendEntry] = useState<ProgressEntry | null>(null);

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [decidingId, setDecidingId] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [formError, setFormError] = useState("");
  const [message, setMessage] = useState("");

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (sectionId) params.set("sectionId", sectionId);
    if (projectId) params.set("projectId", projectId);
    if (statusFilter) params.set("status", statusFilter);
    const search = params.toString();
    return search ? "?" + search : "";
  }, [sectionId, projectId, statusFilter]);

  const loadMine = useCallback(async () => {
    if (!canPunch) return;
    setLoading(true);
    setError("");
    try {
      const data = await api<MinePayload>("/job-order-progress/mine" + query);
      setMine(data);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [canPunch, query]);

  const loadPending = useCallback(async () => {
    if (!canDecide) return;
    setLoading(true);
    setError("");
    try {
      const data = await api<PendingPayload>("/job-order-progress/pending");
      setQueue(data);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [canDecide]);

  useEffect(() => {
    if (tab === "punch") void loadMine();
    else void loadPending();
  }, [tab, loadMine, loadPending]);

  // A Job Order that the current filters no longer offer must not stay selected.
  useEffect(() => {
    if (!mine || !jobOrderId) return;
    if (!mine.jobOrders.some((jobOrder) => String(jobOrder.id) === jobOrderId)) setJobOrderId("");
  }, [mine, jobOrderId]);

  const jobOrders = mine?.jobOrders ?? [];
  const entries = mine?.entries ?? [];
  const groups = queue?.groups ?? [];
  const pendingCount = queue?.pendingCount ?? 0;

  const selectedJobOrder = useMemo(
    () => jobOrders.find((jobOrder) => String(jobOrder.id) === jobOrderId) ?? null,
    [jobOrders, jobOrderId]
  );

  /** The latest punched figure for the chosen Job Order, when the API returned one. */
  const lastEntry = selectedJobOrder?.lastEntry ?? null;
  const sameDayEntry = lastEntry && lastEntry.progressDate.slice(0, 10) === progressDate ? lastEntry : null;
  const lastApproved = selectedJobOrder?.lastApprovedCumulative ?? 0;
  /** The figure the next cumulative quantity may not go below. */
  const quantityFloor = Math.max(lastApproved, sameDayEntry ? sameDayEntry.cumulativeQuantity : 0);

  function switchTab(next: Tab) {
    setTab(next);
    setError("");
    setFormError("");
    setMessage("");
    setAmendEntry(null);
  }

  function toggleHistory(id: number) {
    setExpandedHistory((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  function setComment(id: number, value: string) {
    setComments((prev) => ({ ...prev, [id]: value }));
  }

  async function submitPunch(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setMessage("");
    setFormError("");

    if (mine?.requiresSectionSelection && !sectionId) {
      setFormError("Select a section before punching: as a department-level HOD you own every section of your department.");
      return;
    }
    const jobOrder = selectedJobOrder;
    if (!jobOrder) {
      setFormError("Select a Job Order.");
      return;
    }
    if (jobOrder.status !== "active") {
      setFormError("Job Order " + jobOrder.code + " is inactive, so quantity cannot be punched against it.");
      return;
    }
    const value = Number(quantity);
    if (!quantity.trim() || !Number.isFinite(value) || value < 0) {
      setFormError("Enter the cumulative quantity achieved to date (0 or more).");
      return;
    }
    if (value < quantityFloor) {
      setFormError(
        "Cumulative quantity cannot decrease. It must be at least " +
          fmtQty(quantityFloor) +
          unitSuffix(jobOrder.uom) +
          ", the figure already achieved to date."
      );
      return;
    }
    if (sameDayEntry) {
      setFormError(
        "This Job Order already has an entry for " +
          fmtDate(progressDate) +
          " (revision " +
          sameDayEntry.revisionNo +
          ", " +
          statusLabel(sameDayEntry.status) +
          "). " +
          (isAmendable(sameDayEntry.status) ? "Amend it from the list below." : "Amend it only if the Project Head rejects or sends it back.")
      );
      return;
    }

    setBusy(true);
    try {
      await api<{ entry: ProgressEntry }>("/job-order-progress", {
        method: "POST",
        body: JSON.stringify({
          jobOrderId: jobOrder.id,
          progressDate,
          cumulativeQuantity: value,
          ...(sectionId ? { sectionId: Number(sectionId) } : {}),
          ...(remarks.trim() ? { remarks: remarks.trim() } : {}),
        }),
      });
      setMessage("Quantity progress punched for " + jobOrderDisplay(jobOrder.code, jobOrder.name) + ". It waits for the Project Head.");
      setQuantity("");
      setRemarks("");
      await loadMine();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitAmendment(payload: { cumulativeQuantity: number; remarks: string }) {
    if (!amendEntry) return;
    setError("");
    setMessage("");
    setBusy(true);
    try {
      await api<{ entry: ProgressEntry }>("/job-order-progress/" + amendEntry.id + "/amend", {
        method: "POST",
        body: JSON.stringify({
          cumulativeQuantity: payload.cumulativeQuantity,
          ...(payload.remarks ? { remarks: payload.remarks } : {}),
        }),
      });
      const label = jobOrderDisplay(amendEntry.jobOrder.code, amendEntry.jobOrder.name);
      setAmendEntry(null);
      setMessage("Amendment punched for " + label + " as revision " + (amendEntry.revisionNo + 1) + ". It waits for the Project Head.");
      await loadMine();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function decide(entryId: number, action: DecisionAction) {
    const remark = (comments[entryId] ?? "").trim();
    setMessage("");
    setError("");
    if (action !== "APPROVE" && !remark) {
      setError(
        action === "REJECT"
          ? "A remark is required to reject a quantity entry. Write one in the remark box next to the entry, then press Reject."
          : "A remark is required to send a quantity entry back. Write one in the remark box next to the entry, then press Send back."
      );
      return;
    }
    setDecidingId(entryId);
    try {
      await api<{ entry: ProgressEntry }>("/job-order-progress/" + entryId + "/decision", {
        method: "POST",
        body: JSON.stringify({ action, ...(remark ? { remarks: remark } : {}) }),
      });
      setComments((prev) => {
        const next = { ...prev };
        delete next[entryId];
        return next;
      });
      setMessage(
        action === "APPROVE"
          ? "Quantity entry approved. It now counts towards the achieved quantity."
          : action === "REJECT"
            ? "Quantity entry rejected. The HOD must amend it."
            : "Quantity entry sent back to the HOD for an amendment."
      );
      await loadPending();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setDecidingId(null);
    }
  }

  if (!canPunch && !canDecide) {
    return <div className="error-banner">Quantity progress is available to HOD, Department Head, Project Head (PM) and Admin accounts.</div>;
  }

  const punchUnit = unitSuffix(selectedJobOrder?.uom);
  const resolvedSectionId = mine?.sectionId ?? null;
  const punchSectionName = resolvedSectionId == null ? null : (mine?.sections.find((section) => section.id === resolvedSectionId)?.name ?? String(resolvedSectionId));

  return (
    <div className="jop">
      <div className="jop__head">
        <h2 className="jop__title">Job Order Quantity Progress</h2>
        <p className="muted jop__hint">
          Quantity to date only. Regular hours are booked on the Timesheet screen and are never mixed with quantity.
        </p>
      </div>

      <div className="jop-tabs" role="tablist" aria-label="Quantity progress">
        {canPunch && (
          <button
            type="button"
            role="tab"
            aria-selected={tab === "punch"}
            className={"jop-tab" + (tab === "punch" ? " active" : "")}
            onClick={() => switchTab("punch")}
          >
            Punch progress
          </button>
        )}
        {canDecide && (
          <button
            type="button"
            role="tab"
            aria-selected={tab === "queue"}
            className={"jop-tab" + (tab === "queue" ? " active" : "")}
            onClick={() => switchTab("queue")}
          >
            Approval queue{canDecide && pendingCount > 0 ? " (" + pendingCount + ")" : ""}
          </button>
        )}
      </div>

      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      {message && (
        <div className="carry-banner" role="status">
          {message}
        </div>
      )}

      {tab === "punch" && canPunch && (
        <>
          <section className="jop-panel">
            <div className="jop-panel__header">
              <h3>Punch cumulative quantity</h3>
              <span className="jop-panel__count">
                {mine?.requiresSectionSelection
                  ? "Pick the section you are punching for"
                  : punchSectionName
                    ? "Punching for section " + punchSectionName
                    : ""}
              </span>
            </div>
            <div className="jop-panel__body">
              {isDeptHead && (
                <p className="muted jop-oversight">
                  As Department Head you own every section of your department: pick the section you are punching for.
                  The Project Head (PM) approves, rejects or sends the figure back.
                  {user?.capabilities?.viewSummary && (
                    <>
                      {" "}
                      <Link className="jop-link" to="/summary">
                        Open the department Summary
                      </Link>
                    </>
                  )}
                </p>
              )}
              {mine?.scopeError && <div className="warning-banner">{mine.scopeError.error}</div>}
              <form className="jop-form" onSubmit={submitPunch}>
                {mine?.requiresSectionSelection && (
                  <div className="jop-field">
                    <label htmlFor="jop-section">Section</label>
                    <select
                      id="jop-section"
                      aria-label="Section"
                      required
                      value={sectionId}
                      onChange={(e) => setSectionId(e.target.value)}
                    >
                      <option value="">Select a section…</option>
                      {mine.sections.map((section) => (
                        <option key={section.id} value={section.id}>
                          {section.code} · {section.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <div className="jop-field">
                  <label htmlFor="jop-project">Project</label>
                  <select
                    id="jop-project"
                    aria-label="Project filter"
                    value={projectId}
                    onChange={(e) => setProjectId(e.target.value)}
                  >
                    <option value="">All projects</option>
                    {mine?.projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.code} · {project.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="jop-field">
                  <label htmlFor="jop-job-order">Job Order</label>
                  <select
                    id="jop-job-order"
                    aria-label="Job Order"
                    required
                    value={jobOrderId}
                    onChange={(e) => setJobOrderId(e.target.value)}
                  >
                    <option value="">Select a Job Order…</option>
                    {jobOrders.map((jobOrder) => (
                      <option key={jobOrder.id} value={jobOrder.id}>
                        {jobOrderDisplay(jobOrder.code, jobOrder.name)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="jop-field">
                  <label htmlFor="jop-progress-date">Progress date</label>
                  <input
                    id="jop-progress-date"
                    aria-label="Progress date"
                    type="date"
                    value={progressDate}
                    onChange={(e) => setProgressDate(e.target.value)}
                    required
                  />
                </div>
                <div className="jop-field">
                  <label htmlFor="jop-quantity">Cumulative quantity to date{punchUnit ? " (" + selectedJobOrder?.uom?.code + ")" : ""}</label>
                  <input
                    id="jop-quantity"
                    aria-label="Cumulative quantity to date"
                    type="number"
                    min={0}
                    step="any"
                    inputMode="decimal"
                    placeholder="Total achieved to date"
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                    required
                  />
                </div>
                <div className="jop-field jop-field--wide">
                  <label htmlFor="jop-remarks">Remarks</label>
                  <textarea
                    id="jop-remarks"
                    aria-label="Punch remarks"
                    rows={2}
                    placeholder="Optional note for the Project Head"
                    value={remarks}
                    onChange={(e) => setRemarks(e.target.value)}
                  />
                </div>
                <div className="jop-field--wide">
                  {selectedJobOrder ? (
                    <div className="jop-facts">
                      <span className="jop-fact">
                        <em>Approved to date</em>
                        <span className="jop-qty">
                          {fmtQty(lastApproved)}
                          {punchUnit}
                        </span>
                      </span>
                      <span className="jop-fact jop-fact--budget">
                        <em>Budget in force</em>
                        <span className="jop-qty">
                          {fmtQty(selectedJobOrder.budgetedQuantity)}
                          {punchUnit}
                        </span>
                      </span>
                      {lastEntry && (
                        <span className={"jop-fact" + (sameDayEntry ? " jop-fact--warn" : "")}>
                          <em>{sameDayEntry ? "Already punched for this date" : "Latest entry"}</em>
                          <span className="jop-qty">
                            {fmtQty(lastEntry.cumulativeQuantity)}
                            {punchUnit}
                          </span>{" "}
                          · {fmtDate(lastEntry.progressDate)} · r{lastEntry.revisionNo} · {statusLabel(lastEntry.status)}
                        </span>
                      )}
                      {selectedJobOrder.status !== "active" && (
                        <span className="jop-fact jop-fact--warn">
                          <em>Status</em>Inactive Job Order — quantity cannot be punched
                        </span>
                      )}
                      {selectedJobOrder.projectWbs?.wbsCode && (
                        <span className="jop-fact">
                          <em>WBS</em>
                          {selectedJobOrder.projectWbs.wbsCode}
                        </span>
                      )}
                    </div>
                  ) : (
                    <p className="muted jop-tiny">
                      Select a Job Order to see the quantity already achieved to date, its unit of measure and the
                      budget revision in force.
                    </p>
                  )}
                  {sameDayEntry && (
                    <p className="jop-warn jop-tiny">
                      An entry for {fmtDate(progressDate)} already exists for this Job Order, so a second punch for the
                      same day is refused.{" "}
                      {isAmendable(sameDayEntry.status)
                        ? "Amend it from the list below."
                        : "It can be amended only after the Project Head rejects or sends it back."}
                    </p>
                  )}
                </div>
                <div className="jop-actions jop-field--wide">
                  <button type="submit" className="btn btn-primary" disabled={busy}>
                    {busy ? "Punching…" : "Punch progress"}
                  </button>
                  <span className="muted jop-tiny">
                    One entry per Job Order per date. The cumulative figure may never go below the achieved quantity.
                  </span>
                </div>
              </form>
              {formError && (
                <div className="error-banner" role="alert" style={{ marginTop: 14, marginBottom: 0 }}>
                  {formError}
                </div>
              )}
            </div>
          </section>

          <section className="jop-panel">
            <div className="jop-panel__header">
              <h3>{role === "ADMIN" ? "Department entries" : "My punched entries"}</h3>
              <div className="jop-filters">
                <select
                  aria-label="Filter entries by status"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                >
                  <option value="">All statuses</option>
                  {STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {statusLabel(status)}
                    </option>
                  ))}
                </select>
                <button type="button" className="btn btn-ghost btn-sm" disabled={loading} onClick={() => void loadMine()}>
                  Refresh
                </button>
              </div>
            </div>
            <div className="jop-panel__body">
              {loading && entries.length === 0 ? (
                <div className="loading-state">Loading quantity progress…</div>
              ) : entries.length === 0 ? (
                <div className="empty-state">
                  {role === "ADMIN"
                    ? "No quantity progress in your department yet."
                    : "No quantity progress punched yet. Punch the first cumulative figure above."}
                </div>
              ) : (
                <>
                  <div className="jop-table-wrap">
                    <table className="sup-table">
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th>Job Order</th>
                          <th>Section</th>
                          <th style={{ textAlign: "right" }}>Cumulative</th>
                          <th>Rev</th>
                          <th>Status</th>
                          <th>Remarks</th>
                          <th style={{ textAlign: "right" }}>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {entries.map((entry) => {
                          const unit = unitSuffix(entry.jobOrder.uom);
                          const open = expandedHistory[entry.id] === true;
                          const canExpand = hasEntryDetail(entry);
                          return (
                            <Fragment key={entry.id}>
                              <tr>
                                <td>{fmtDate(entry.progressDate)}</td>
                                <td>
                                  <strong>{jobOrderDisplay(entry.jobOrder.code, entry.jobOrder.name)}</strong>
                                  <div className="muted jop-tiny">{entry.jobOrder.project.name}</div>
                                </td>
                                <td>{entry.section?.name ?? "—"}</td>
                                <td style={{ textAlign: "right" }}>
                                  <span className="jop-qty">
                                    {fmtQty(entry.cumulativeQuantity)}
                                    {unit}
                                  </span>
                                </td>
                                <td>r{entry.revisionNo}</td>
                                <td>
                                  <span className={chipClass(entry.status)}>{statusLabel(entry.status)}</span>
                                </td>
                                <td>
                                  {entry.remarks ? entry.remarks : <span className="muted">—</span>}
                                  {canExpand && (
                                    <div>
                                      <button
                                        type="button"
                                        className="jop-disclosure"
                                        aria-expanded={open}
                                        onClick={() => toggleHistory(entry.id)}
                                      >
                                        {open ? "Hide remarks & history" : detailLabel(entry)}
                                      </button>
                                    </div>
                                  )}
                                </td>
                                <td>
                                  <div className="sup-table__actions">
                                    {isAmendable(entry.status) ? (
                                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAmendEntry(entry)}>
                                        Amend
                                      </button>
                                    ) : (
                                      <span className="muted jop-tiny">
                                        {entry.approvedBy ? "Approved by " + entry.approvedBy.name : "—"}
                                      </span>
                                    )}
                                  </div>
                                </td>
                              </tr>
                              {open && (
                                <tr className="jop-history-row">
                                  <td colSpan={8}>
                                    <div className="jop-entry-detail">
                                      <div>
                                        <h4 className="jop-detail__title">Remarks</h4>
                                        <RemarkHistoryList items={entry.remarksHistory} />
                                      </div>
                                      <div>
                                        <h4 className="jop-detail__title">Revisions</h4>
                                        <HistoryList history={entry.history} uom={entry.jobOrder.uom} />
                                      </div>
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  <div className="jop-cards">
                    {entries.map((entry) => {
                      const unit = unitSuffix(entry.jobOrder.uom);
                      const open = expandedHistory[entry.id] === true;
                      const canExpand = hasEntryDetail(entry);
                      return (
                        <article key={entry.id} className="jop-card">
                          <div className="jop-card__top">
                            <strong>{jobOrderDisplay(entry.jobOrder.code, entry.jobOrder.name)}</strong>
                            <span className={chipClass(entry.status)}>{statusLabel(entry.status)}</span>
                          </div>
                          <div className="jop-stats">
                            <div className="jop-stat">
                              <em>Date</em>
                              <span>{fmtDate(entry.progressDate)}</span>
                            </div>
                            <div className="jop-stat">
                              <em>Section</em>
                              <span>{entry.section?.name ?? "—"}</span>
                            </div>
                            <div className="jop-stat">
                              <em>Cumulative</em>
                              <strong className="jop-qty">
                                {fmtQty(entry.cumulativeQuantity)}
                                {unit}
                              </strong>
                            </div>
                            <div className="jop-stat">
                              <em>Revision</em>
                              <span>r{entry.revisionNo}</span>
                            </div>
                            <div className="jop-stat">
                              <em>Project</em>
                              <span>{entry.jobOrder.project.name}</span>
                            </div>
                          </div>
                          {entry.remarks && <p className="jop-entry__remarks">Remark: {entry.remarks}</p>}
                          <div className="jop-entry__actions">
                            {isAmendable(entry.status) && (
                              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAmendEntry(entry)}>
                                Amend
                              </button>
                            )}
                            {canExpand && (
                              <button
                                type="button"
                                className="jop-disclosure"
                                aria-expanded={open}
                                onClick={() => toggleHistory(entry.id)}
                              >
                                {open ? "Hide remarks & history" : detailLabel(entry)}
                              </button>
                            )}
                            {!isAmendable(entry.status) && entry.approvedBy && (
                              <span className="muted jop-tiny">Approved by {entry.approvedBy.name}</span>
                            )}
                          </div>
                          {open && (
                            <div className="jop-entry-detail">
                              <div>
                                <h4 className="jop-detail__title">Remarks</h4>
                                <RemarkHistoryList items={entry.remarksHistory} />
                              </div>
                              <div>
                                <h4 className="jop-detail__title">Revisions</h4>
                                <HistoryList history={entry.history} uom={entry.jobOrder.uom} />
                              </div>
                            </div>
                          )}
                        </article>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          </section>
        </>
      )}

      {tab === "queue" && canDecide && (
        <>
          <div className="jop-summary">
            <span className="jop-fact jop-fact--budget">
              <em>Pending entries</em>
              <span className="jop-qty">{pendingCount}</span>
            </span>
            <span className="jop-fact">
              <em>Job Orders awaiting approval</em>
              <span className="jop-qty">{groups.length}</span>
            </span>
            <button type="button" className="btn btn-ghost btn-sm" disabled={loading} onClick={() => void loadPending()}>
              Refresh
            </button>
          </div>

          {loading && groups.length === 0 ? (
            <div className="loading-state">Loading the approval queue…</div>
          ) : groups.length === 0 ? (
            <div className="empty-state">Nothing is waiting for your decision. New quantity punches appear here immediately.</div>
          ) : (
            groups.map((group) => {
              const unit = unitSuffix(group.uom);
              const display = group.display || jobOrderDisplay(group.jobOrderCode, group.jobOrderName);
              return (
                <section key={group.jobOrderId} className="jop-group">
                  <header className="jop-group__head">
                    <div className="jop-group__title">
                      <span className="jop-key">
                        <i aria-hidden style={{ background: projectDot(group.colorKey) }} />
                        {group.colorKey}
                      </span>
                      {display}
                      <span className="jop-chip jop-chip--submitted">
                        {group.entries.length} awaiting decision
                      </span>
                    </div>
                    <div className="jop-group__meta">
                      <span>
                        Project <strong>{group.projectName}</strong>
                      </span>
                      {group.wbsCode && (
                        <span>
                          WBS <strong>{group.wbsCode}</strong>
                        </span>
                      )}
                      <span>
                        Budget <strong className="jop-qty">{fmtQty(group.budgetedQuantity)}{unit}</strong>
                      </span>
                      <span>
                        Approved to date <strong className="jop-qty">{fmtQty(group.lastApprovedCumulative)}{unit}</strong>
                      </span>
                    </div>
                  </header>
                  <div className="jop-group__body">
                    {group.entries.map((entry) => {
                      const delta = entry.proposedCumulative - entry.lastApprovedCumulative;
                      const isDeciding = decidingId === entry.id;
                      return (
                        <article key={entry.id} className="jop-entry">
                          <div className="jop-entry__meta">
                            <div className="jop-stat">
                              <em>Progress date</em>
                              <span>{fmtDate(entry.progressDate)}</span>
                            </div>
                            <div className="jop-stat">
                              <em>Punched by</em>
                              <span>{entry.punchedBy?.name ?? "—"}</span>
                            </div>
                            <div className="jop-stat">
                              <em>Section</em>
                              <span>{entry.section?.name ?? "—"}</span>
                            </div>
                            <div className="jop-stat">
                              <em>Previous cumulative</em>
                              <span className="jop-qty">
                                {entry.previousCumulative == null ? "—" : fmtQty(entry.previousCumulative) + unit}
                              </span>
                            </div>
                            <div className="jop-stat">
                              <em>Proposed cumulative</em>
                              <strong className="jop-qty">
                                {fmtQty(entry.proposedCumulative)}
                                {unit}
                              </strong>
                            </div>
                            <div className="jop-stat">
                              <em>Step against approved</em>
                              <span className="jop-qty">
                                {delta >= 0 ? "+" : ""}
                                {fmtQty(delta)}
                                {unit}
                              </span>
                            </div>
                            <div className="jop-stat">
                              <em>Budget in force</em>
                              <span className="jop-qty">
                                {fmtQty(entry.budgetedQuantity)}
                                {unit}
                              </span>
                            </div>
                            <div className="jop-stat">
                              <em>Revision</em>
                              <span>r{entry.revisionNo}</span>
                            </div>
                          </div>
                          {entry.remarks && <p className="jop-entry__remarks">Latest remark: {entry.remarks}</p>}
                          {entry.remarksHistory.length > 0 && (
                            <div className="jop-entry__history">
                              <h4 className="jop-detail__title">What was said about this entry</h4>
                              <RemarkHistoryList items={entry.remarksHistory} />
                            </div>
                          )}
                          <label className="jop-field">
                            <span className="jop-field__label">Remark (required to reject or send back)</span>
                            <textarea
                              className="jop-remark-input"
                              aria-label="Decision remark"
                              rows={2}
                              placeholder="Tell the HOD what to correct…"
                              value={comments[entry.id] ?? ""}
                              onChange={(e) => setComment(entry.id, e.target.value)}
                            />
                          </label>
                          <div className="jop-entry__actions">
                            <button
                              type="button"
                              className="btn btn-primary btn-sm"
                              disabled={isDeciding}
                              onClick={() => void decide(entry.id, "APPROVE")}
                            >
                              {isDeciding ? "Working…" : "Approve"}
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              disabled={isDeciding}
                              onClick={() => void decide(entry.id, "SEND_BACK")}
                            >
                              Send back
                            </button>
                            <button
                              type="button"
                              className="btn btn-danger btn-sm"
                              disabled={isDeciding}
                              onClick={() => void decide(entry.id, "REJECT")}
                            >
                              Reject
                            </button>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </section>
              );
            })
          )}
        </>
      )}

      {amendEntry && (
        <AmendModal
          entry={amendEntry}
          floor={jobOrders.find((jobOrder) => jobOrder.id === amendEntry.jobOrder.id)?.lastApprovedCumulative ?? 0}
          busy={busy}
          onClose={() => setAmendEntry(null)}
          onSubmit={(payload) => void submitAmendment(payload)}
        />
      )}
    </div>
  );
}
