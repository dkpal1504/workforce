import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { todayDateString } from "../utils/date";
import "../styles/allocations.css";

type Department = { id: number; name: string };
type Section = { id: number; code: string; name: string };
type Project = { id: number; code: string; name: string; colorKey: string; isNonProject: boolean; active: boolean };
type JobOrder = {
  id: number;
  code: string;
  name: string;
  label: string;
  wbsNo: string;
  colorKey: string;
  projectId: number;
  projectName: string;
  sectionId: number | null;
  standing: boolean;
};
/** Payload of GET /api/allocations/job-orders: the picker's single source of truth. */
type JobOrderPicker = {
  department: Department | null;
  sections: Section[];
  projects: Project[];
  jobOrders: JobOrder[];
};
type ShiftSlot = "am1" | "am2" | "pm1" | "pm2";
type AllocationSlot = {
  id: number;
  shiftSlot: ShiftSlot;
  project: { id: number; name: string; colorKey: string };
  jobOrder: { id: number; code: string; name: string } | null;
  jobOrderLabel: string | null;
  allocatedBy: { id: number; name: string };
};
type AllocationDay = {
  id: number;
  employeeId: number;
  workDate: string;
  status: string;
  remarks: string | null;
  employee: {
    id: number;
    name: string;
    ecNo: string;
    grade: string | null;
    department: { name: string } | null;
  };
  allocations: AllocationSlot[];
};

const SHIFT_SLOTS: Array<{ id: ShiftSlot; short: string; time: string; half: string }> = [
  { id: "am1", short: "AM 1", time: "9:00–11:00", half: "1st Half" },
  { id: "am2", short: "AM 2", time: "11:00–13:00", half: "1st Half" },
  { id: "pm1", short: "PM 1", time: "14:00–16:00", half: "2nd Half" },
  { id: "pm2", short: "PM 2", time: "16:00–18:00", half: "2nd Half" },
];

function messageFor(error: unknown, fallback: string) {
  if (error instanceof ApiError && typeof error.payload === "object" && error.payload && "error" in error.payload) {
    return String((error.payload as { error: unknown }).error);
  }
  return error instanceof Error ? error.message : fallback;
}

function statusLabel(status: string) {
  if (status === "SUBMITTED") return "Pending HOD";
  if (status === "HOD_APPROVED") return "With Project Head";
  if (status === "PM_APPROVED") return "Approved";
  if (status === "REJECTED") return "Sent back / Rejected";
  return status || "DRAFT";
}

function projectClass(colorKey: string | undefined) {
  const key = colorKey?.toLowerCase();
  return key && /^[a-f]$/.test(key) ? `alloc-slot-cell--project-${key}` : "alloc-slot-cell--project-n";
}

/**
 * The single-letter badge shown inside an assigned slot: the project's own
 * designation (A / B / C / D / Non-Project), i.e. the letter the Allocation
 * screen also colours the cell with. Never derive it from the project *name* —
 * "Project A".slice(0, 2) renders "PR" for every project, which makes Project A
 * and Project B look identical in a half-filled shift.
 */
function projectBadge(project: { colorKey?: string | null; name?: string | null; code?: string | null }): string {
  const key = project.colorKey?.trim();
  if (key && /^[a-z]$/i.test(key)) return key.toUpperCase();
  const fromCode = project.code?.trim().match(/[A-Za-z](?=\s*$)/);
  if (fromCode) return fromCode[0].toUpperCase();
  const fromName = project.name?.trim().match(/[A-Za-z](?=\s*$)/);
  if (fromName) return fromName[0].toUpperCase();
  const first = project.name?.trim()[0];
  return first ? first.toUpperCase() : "?";
}

/**
 * Job Order display text: the API label in `Job_Order-Job_Description` form
 * (for example `1900000107-Pipe Spool Installation`), falling back to code and
 * name for retained rows written before the label existed.
 */
function slotJobOrderLabel(allocation: AllocationSlot): string | null {
  if (allocation.jobOrderLabel) return allocation.jobOrderLabel;
  return allocation.jobOrder ? `${allocation.jobOrder.code}-${allocation.jobOrder.name}` : null;
}

export function AllocationsPage() {
  const { user } = useAuth();
  const ownEmployeeId = user?.employeeId ?? user?.employee?.id ?? null;
  const employeeInactive = user?.employeeActive === false || user?.employee?.active === false;

  const [days, setDays] = useState<AllocationDay[]>([]);
  const [department, setDepartment] = useState<Department | null>(null);
  const [sections, setSections] = useState<Section[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [jobOrders, setJobOrders] = useState<JobOrder[]>([]);
  const pickerRequest = useRef(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [workDate, setWorkDate] = useState(todayDateString());
  const [sectionId, setSectionId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [jobOrderId, setJobOrderId] = useState("");
  const [remarks, setRemarks] = useState("");
  const [selectedSlots, setSelectedSlots] = useState<Set<ShiftSlot>>(new Set());
  const [formErr, setFormErr] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const allocationPath = ownEmployeeId ? `/allocations?employeeId=${ownEmployeeId}` : "/allocations";
      const allocationResult = await api<{ days?: AllocationDay[]; note?: string }>(allocationPath);
      if (!Array.isArray(allocationResult.days)) {
        throw new Error("The allocations service returned an invalid response. Please restart the API and try again.");
      }
      setDays(ownEmployeeId ? allocationResult.days.filter((day) => day.employeeId === ownEmployeeId) : []);
      setNotice(allocationResult.note ?? (!ownEmployeeId ? "No linked employee record for this account." : ""));
    } catch (e) {
      setDays([]);
      setError(messageFor(e, "Failed to load allocations"));
    } finally {
      setLoading(false);
    }
  }, [ownEmployeeId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * The picker's single source: department, sections, projects and the Job Order
   * list. Loaded once without filters, then refetched when the chosen section or
   * project changes. Out-of-order responses are dropped.
   */
  useEffect(() => {
    if (!ownEmployeeId) {
      setDepartment(null);
      setSections([]);
      setProjects([]);
      setJobOrders([]);
      return;
    }
    const requestId = ++pickerRequest.current;
    const params = new URLSearchParams({ employeeId: String(ownEmployeeId) });
    if (sectionId) params.set("section_id", sectionId);
    if (projectId) params.set("project_id", projectId);
    void api<JobOrderPicker>(`/allocations/job-orders?${params.toString()}`)
      .then((result) => {
        if (requestId !== pickerRequest.current) return;
        setDepartment(result.department ?? null);
        setSections(Array.isArray(result.sections) ? result.sections : []);
        setProjects(Array.isArray(result.projects) ? result.projects : []);
        setJobOrders(Array.isArray(result.jobOrders) ? result.jobOrders : []);
      })
      .catch((e) => {
        if (requestId !== pickerRequest.current) return;
        setJobOrders([]);
        setError(messageFor(e, "Failed to load the Job Order list"));
      });
  }, [ownEmployeeId, sectionId, projectId]);

  const selectedDay = useMemo(
    () => days.find((day) => day.workDate.slice(0, 10) === workDate) ?? null,
    [days, workDate]
  );
  const jobOrdersReady = Boolean(sectionId && projectId);
  const dayEditable = !selectedDay || ["DRAFT", "REJECTED"].includes(selectedDay.status);
  const canEditSlots = Boolean(ownEmployeeId && dayEditable && !employeeInactive);
  const filledCount = selectedDay?.allocations.length ?? 0;

  useEffect(() => {
    setSelectedSlots(new Set());
    setRemarks(selectedDay?.remarks ?? "");
  }, [selectedDay]);

  function toggleSlot(slot: ShiftSlot) {
    if (!canEditSlots || selectedDay?.allocations.some((item) => item.shiftSlot === slot)) return;
    setSelectedSlots((current) => {
      const next = new Set(current);
      if (next.has(slot)) next.delete(slot);
      else next.add(slot);
      return next;
    });
    setFormErr({});
  }

  function toggleFullShift(checked: boolean) {
    if (!canEditSlots) return;
    if (!checked) {
      setSelectedSlots(new Set());
      return;
    }
    const filled = new Set(selectedDay?.allocations.map((slot) => slot.shiftSlot) ?? []);
    setSelectedSlots(new Set(SHIFT_SLOTS.map((slot) => slot.id).filter((slot) => !filled.has(slot))));
  }

  async function assignSelected() {
    const errors: Record<string, string> = {};
    if (!ownEmployeeId) errors.employee = "No employee record is linked to this login.";
    if (!workDate) errors.workDate = "Date is required.";
    if (!projectId) errors.projectId = "Project is required.";
    if (selectedSlots.size === 0) errors.slots = "Select at least one empty slot.";
    setFormErr(errors);
    if (Object.keys(errors).length > 0 || !canEditSlots) return;

    setBusy(true);
    setError("");
    try {
      for (const shiftSlot of selectedSlots) {
        await api("/allocations/slot", {
          method: "POST",
          body: JSON.stringify({
            employeeId: ownEmployeeId,
            workDate,
            shiftSlot,
            projectId: Number(projectId),
            jobOrderId: jobOrderId ? Number(jobOrderId) : null,
            sectionId: sectionId ? Number(sectionId) : null,
            remarks,
          }),
        });
      }
      const count = selectedSlots.size;
      setSelectedSlots(new Set());
      await load();
      setNotice(`${count} slot${count === 1 ? "" : "s"} saved.`);
    } catch (e) {
      const message = messageFor(e, "Failed to assign selected slots");
      await load();
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  async function removeSlot(slot: AllocationSlot) {
    if (!canEditSlots) return;
    setBusy(true);
    setError("");
    try {
      await api(`/allocations/slot/${slot.id}`, { method: "DELETE" });
      await load();
      setNotice(`${SHIFT_SLOTS.find((item) => item.id === slot.shiftSlot)?.short} cleared.`);
    } catch (e) {
      setError(messageFor(e, "Failed to clear the slot"));
    } finally {
      setBusy(false);
    }
  }

  async function submitDay() {
    if (!ownEmployeeId || !selectedDay || selectedDay.allocations.length === 0) {
      setError("Assign at least one slot before submitting.");
      return;
    }
    if (!dayEditable) return;
    setBusy(true);
    setError("");
    try {
      await api("/allocations/submit", {
        method: "POST",
        body: JSON.stringify({ employeeId: ownEmployeeId, workDate, remarks }),
      });
      await load();
      setNotice("Hours submitted for HOD approval.");
    } catch (e) {
      setError(messageFor(e, "Failed to submit hours"));
    } finally {
      setBusy(false);
    }
  }

  const employeeName = selectedDay?.employee.name ?? user?.name ?? "Logged-in employee";
  const ecNo = selectedDay?.employee.ecNo ?? user?.employee?.ecNo ?? "—";
  const departmentName = department?.name ?? user?.department?.name ?? selectedDay?.employee.department?.name ?? "Not assigned";
  const fullShiftChecked = filledCount + selectedSlots.size === SHIFT_SLOTS.length;

  return (
    <>
      <section className="alloc-context" aria-label="Allocation context">
        <label className={formErr.workDate ? "alloc-context__field is-error" : "alloc-context__field"}>
          <span>Date</span>
          <input
            aria-label="Allocation date"
            type="date"
            value={workDate}
            onChange={(event) => {
              setWorkDate(event.target.value);
              setSelectedSlots(new Set());
              setFormErr({});
            }}
          />
          {formErr.workDate && <small>{formErr.workDate}</small>}
        </label>
        <label className="alloc-context__field">
          <span>Department</span>
          <input aria-label="Department" type="text" value={departmentName} readOnly />
        </label>
        <div className="alloc-context__summary">
          <span className={`alloc-status alloc-status--${(selectedDay?.status ?? "draft").toLowerCase()}`}>
            {statusLabel(selectedDay?.status ?? "DRAFT")}
          </span>
          <strong>{filledCount * 2} / 8 hours</strong>
        </div>
      </section>

      {notice && <div className="alloc-note" role="status">{notice}</div>}
      {error && <div className="error-banner" role="alert">{error}</div>}
      {employeeInactive && (
        <div className="alloc-inactive" role="status">
          This employee is inactive. Existing retained drafts may still be submitted when allowed, but slots cannot be changed.
        </div>
      )}

      <section className="alloc-bulk" aria-labelledby="alloc-bulk-title">
        <header className="alloc-bulk__head">
          <h2 id="alloc-bulk-title">Assignment</h2>
          <p>Select empty 2-hour cells, then assign the section, the project and the optional Job Order.</p>
        </header>
        <div className="alloc-bulk__row">
          <label className="alloc-bulk__field">
            <span>Section</span>
            <select
              aria-label="Section"
              value={sectionId}
              disabled={!canEditSlots}
              onChange={(event) => {
                setSectionId(event.target.value);
                setJobOrderId("");
                setFormErr({});
              }}
            >
              <option value="">None / not applicable</option>
              {sections.map((section) => <option key={section.id} value={section.id}>{section.name}</option>)}
            </select>
          </label>
          <label className={`alloc-bulk__field ${formErr.projectId ? "is-error" : ""}`}>
            <span>Project</span>
            <select
              aria-label="Project"
              value={projectId}
              disabled={!canEditSlots}
              onChange={(event) => {
                setProjectId(event.target.value);
                setJobOrderId("");
                setFormErr({});
              }}
            >
              <option value="">Select…</option>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
            {formErr.projectId && <small>{formErr.projectId}</small>}
          </label>
          <label className="alloc-bulk__field">
            <span>Job Order</span>
            <select
              aria-label="Job Order"
              value={jobOrderId}
              disabled={!canEditSlots || !jobOrdersReady}
              onChange={(event) => setJobOrderId(event.target.value)}
            >
              <option value="">{jobOrdersReady ? "None / not applicable" : "Select a section and project first"}</option>
              {jobOrders.map((order) => (
                <option key={order.id} value={order.id}>{order.label}</option>
              ))}
            </select>
          </label>
          <div className="alloc-bulk__apply">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !canEditSlots || !projectId || selectedSlots.size === 0}
              onClick={assignSelected}
            >
              {busy ? "Saving…" : `Assign to Selected (${selectedSlots.size})`}
            </button>
          </div>
        </div>
        {formErr.slots && <div className="alloc-inline-error">{formErr.slots}</div>}
      </section>

      <section className="alloc-sheet" aria-label="My hours timesheet">
        <div className="alloc-sheet__scroll">
          <table className="alloc-timesheet">
            <thead>
              <tr>
                <th rowSpan={2} className="alloc-employee-col">Employee</th>
                <th rowSpan={2} className="alloc-fullshift-col">Full Shift</th>
                <th colSpan={2} className="alloc-half-head">1st Half</th>
                <th colSpan={2} className="alloc-half-head">2nd Half</th>
                <th rowSpan={2} className="alloc-remarks-col">Status / Remarks</th>
              </tr>
              <tr>
                {SHIFT_SLOTS.map((slot) => <th key={slot.id} className="alloc-slot-head">{slot.time}</th>)}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="alloc-employee-col">
                  <strong>{employeeName}</strong>
                  <span>{ecNo} · {departmentName}</span>
                </td>
                <td className="alloc-fullshift-col">
                  <label className="alloc-fullshift">
                    <input
                      type="checkbox"
                      aria-label="Select full shift"
                      checked={fullShiftChecked}
                      disabled={!canEditSlots || filledCount === SHIFT_SLOTS.length}
                      onChange={(event) => toggleFullShift(event.target.checked)}
                    />
                    <span>8h</span>
                  </label>
                </td>
                {SHIFT_SLOTS.map((slot) => {
                  const allocation = selectedDay?.allocations.find((item) => item.shiftSlot === slot.id);
                  const selected = selectedSlots.has(slot.id);
                  const jobOrderText = allocation ? slotJobOrderLabel(allocation) : null;
                  return (
                    <td key={slot.id} className="alloc-slot-td">
                      <button
                        type="button"
                        className={`alloc-slot-cell ${selected ? "is-selected" : ""} ${allocation ? `is-assigned ${projectClass(allocation.project.colorKey)}` : ""}`}
                        disabled={!canEditSlots || busy || Boolean(allocation)}
                        onClick={() => toggleSlot(slot.id)}
                        aria-pressed={selected}
                        aria-label={`${slot.time}: ${allocation ? `${allocation.project.name}, ${jobOrderText ?? "no Job Order"}` : selected ? "selected" : "empty"}`}
                        title={allocation ? `${allocation.project.name}${jobOrderText ? ` · ${jobOrderText}` : ""}` : "Select this 2-hour slot"}
                      >
                        {allocation ? projectBadge(allocation.project) : selected ? "✓" : ""}
                      </button>
                      {allocation && canEditSlots && (
                        <button
                          type="button"
                          className="alloc-clear-slot"
                          disabled={busy}
                          onClick={() => removeSlot(allocation)}
                          aria-label={`Clear ${slot.time} draft slot`}
                        >
                          Clear
                        </button>
                      )}
                    </td>
                  );
                })}
                <td className="alloc-remarks-col">
                  <span className={`alloc-status alloc-status--${(selectedDay?.status ?? "draft").toLowerCase()}`}>
                    {statusLabel(selectedDay?.status ?? "DRAFT")}
                  </span>
                  <textarea
                    aria-label="Remarks"
                    value={remarks}
                    placeholder="Remarks (optional)"
                    disabled={!dayEditable || !ownEmployeeId}
                    onChange={(event) => setRemarks(event.target.value)}
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="alloc-mobile-row">
          <header>
            <div><strong>{employeeName}</strong><span>{ecNo} · {departmentName}</span></div>
            <label className="alloc-fullshift">
              <input
                type="checkbox"
                aria-label="Select full shift"
                checked={fullShiftChecked}
                disabled={!canEditSlots || filledCount === SHIFT_SLOTS.length}
                onChange={(event) => toggleFullShift(event.target.checked)}
              />
              <span>Full Shift</span>
            </label>
          </header>
          <div className="alloc-mobile-slots">
            {SHIFT_SLOTS.map((slot) => {
              const allocation = selectedDay?.allocations.find((item) => item.shiftSlot === slot.id);
              const selected = selectedSlots.has(slot.id);
              const jobOrderText = allocation ? slotJobOrderLabel(allocation) : null;
              return (
                <div key={slot.id} className="alloc-mobile-slot-wrap">
                  <button
                    type="button"
                    className={`alloc-mobile-slot ${selected ? "is-selected" : ""} ${allocation ? `is-assigned ${projectClass(allocation.project.colorKey)}` : ""}`}
                    disabled={!canEditSlots || busy || Boolean(allocation)}
                    onClick={() => toggleSlot(slot.id)}
                    aria-pressed={selected}
                  >
                    <span>{slot.half}</span>
                    <strong>{slot.time}</strong>
                    <small>{allocation ? allocation.project.name : selected ? "Selected" : "Empty · 2h"}</small>
                    {jobOrderText && <small>{jobOrderText}</small>}
                  </button>
                  {allocation && canEditSlots && (
                    <button type="button" className="alloc-clear-slot" disabled={busy} onClick={() => removeSlot(allocation)}>
                      Clear draft slot
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          <label className="alloc-mobile-remarks">
            <span>Remarks</span>
            <textarea
              value={remarks}
              placeholder="Remarks (optional)"
              disabled={!dayEditable || !ownEmployeeId}
              onChange={(event) => setRemarks(event.target.value)}
            />
          </label>
        </div>
      </section>

      {loading && <div className="loading-state">Loading allocations…</div>}
      {!loading && !ownEmployeeId && formErr.employee && <div className="alloc-inline-error">{formErr.employee}</div>}

      <footer className="alloc-footer">
        <div className="alloc-legend">
          <span><i className="alloc-legend__empty" /> Empty</span>
          <span><i className="alloc-legend__selected" /> Selected</span>
          <span><i className="alloc-legend__assigned" /> Assigned project</span>
        </div>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy || !ownEmployeeId || !selectedDay || filledCount === 0 || !dayEditable}
          onClick={submitDay}
        >
          Submit for HOD Approval
        </button>
      </footer>
    </>
  );
}
