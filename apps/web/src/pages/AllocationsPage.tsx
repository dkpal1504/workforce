import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { todayDateString } from "../utils/date";
import "../styles/allocations.css";

type JobOrder = { id: number; code: string; name: string; status: string };
type Project = { id: number; code: string; name: string; colorKey: string; jobOrders: JobOrder[] };
type EmployeeOption = { id: number; name: string; ecNo: string };
type AllocationSlot = {
  id: number;
  shiftSlot: ShiftSlot;
  project: { id: number; name: string; colorKey: string };
  jobOrder: { id: number; code: string; name: string } | null;
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
type ShiftSlot = "am1" | "am2" | "pm1" | "pm2";

const SHIFT_SLOTS: Array<{ id: ShiftSlot; label: string; time: string }> = [
  { id: "am1", label: "AM 1", time: "9:00–11:00" },
  { id: "am2", label: "AM 2", time: "11:00–13:00" },
  { id: "pm1", label: "PM 1", time: "14:00–16:00" },
  { id: "pm2", label: "PM 2", time: "16:00–18:00" },
];

function messageFor(error: unknown, fallback: string) {
  if (error instanceof ApiError && typeof error.payload === "object" && error.payload && "error" in error.payload) {
    return String((error.payload as { error: unknown }).error);
  }
  return error instanceof Error ? error.message : fallback;
}

export function AllocationsPage() {
  const { user } = useAuth();
  const canAllocateOthers = Boolean(user && ["HOD", "PM", "ADMIN", "HR"].includes(user.role));

  const [days, setDays] = useState<AllocationDay[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [employeeId, setEmployeeId] = useState("");
  const [workDate, setWorkDate] = useState(todayDateString());
  const [shiftSlot, setShiftSlot] = useState<ShiftSlot>("am1");
  const [projectId, setProjectId] = useState("");
  const [jobOrderId, setJobOrderId] = useState("");
  const [formErr, setFormErr] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [allocationResult, projectResult] = await Promise.all([
        api<{ days?: AllocationDay[]; note?: string }>("/allocations"),
        api<{ projects?: Project[] }>("/projects"),
      ]);
      if (!Array.isArray(allocationResult.days)) {
        throw new Error("The allocations service returned an invalid response. Please restart the API and try again.");
      }
      if (!Array.isArray(projectResult.projects)) {
        throw new Error("The projects service returned an invalid response. Please restart the API and try again.");
      }
      setDays(allocationResult.days);
      setProjects(projectResult.projects);
      setNotice(allocationResult.note ?? "");
    } catch (e) {
      setDays([]);
      setError(messageFor(e, "Failed to load allocations"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!canAllocateOthers) return;
    api<{ employees?: EmployeeOption[] }>("/employees")
      .then((result) => setEmployees(Array.isArray(result.employees) ? result.employees : []))
      .catch(() => setEmployees([]));
  }, [canAllocateOthers]);

  const selectedProject = useMemo(
    () => projects.find((project) => String(project.id) === projectId) ?? null,
    [projects, projectId]
  );

  const selectedDay = useMemo(
    () =>
      days.find(
        (day) =>
          day.workDate.slice(0, 10) === workDate &&
          (!canAllocateOthers || (employeeId !== "" && day.employeeId === Number(employeeId)))
      ) ?? null,
    [canAllocateOthers, days, employeeId, workDate]
  );

  const selectedSlot = selectedDay?.allocations.find((slot) => slot.shiftSlot === shiftSlot) ?? null;
  const editable = !selectedDay || ["DRAFT", "REJECTED"].includes(selectedDay.status);
  const visibleDays = useMemo(
    () => days.filter((day) => !canAllocateOthers || !employeeId || day.employeeId === Number(employeeId)),
    [canAllocateOthers, days, employeeId]
  );

  function chooseSlot(slot: ShiftSlot) {
    setShiftSlot(slot);
    const allocation = selectedDay?.allocations.find((item) => item.shiftSlot === slot);
    setProjectId(allocation ? String(allocation.project.id) : "");
    setJobOrderId(allocation?.jobOrder ? String(allocation.jobOrder.id) : "");
    setFormErr({});
  }

  async function assignSlot() {
    const errors: Record<string, string> = {};
    if (canAllocateOthers && !employeeId) errors.employeeId = "Select an employee.";
    if (!workDate) errors.workDate = "Date is required.";
    if (!projectId) errors.projectId = "Project is required.";
    setFormErr(errors);
    if (Object.keys(errors).length > 0) return;

    setBusy(true);
    setError("");
    try {
      await api("/allocations/slot", {
        method: "POST",
        body: JSON.stringify({
          employeeId: employeeId ? Number(employeeId) : undefined,
          workDate,
          shiftSlot,
          projectId: Number(projectId),
          jobOrderId: jobOrderId ? Number(jobOrderId) : null,
        }),
      });
      await load();
      setNotice(`${SHIFT_SLOTS.find((slot) => slot.id === shiftSlot)?.label} assigned.`);
    } catch (e) {
      setError(messageFor(e, "Failed to assign the slot"));
    } finally {
      setBusy(false);
    }
  }

  async function removeSlot(id: number) {
    setBusy(true);
    setError("");
    try {
      await api(`/allocations/slot/${id}`, { method: "DELETE" });
      setProjectId("");
      setJobOrderId("");
      await load();
      setNotice("Slot removed.");
    } catch (e) {
      setError(messageFor(e, "Failed to remove the slot"));
    } finally {
      setBusy(false);
    }
  }

  async function submitDay() {
    if (!selectedDay || selectedDay.allocations.length === 0) {
      setError("Assign at least one slot before submitting.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api("/allocations/submit", {
        method: "POST",
        body: JSON.stringify({ employeeId: employeeId ? Number(employeeId) : undefined, workDate }),
      });
      await load();
      setNotice("Hours submitted for HOD approval.");
    } catch (e) {
      setError(messageFor(e, "Failed to submit hours"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* Keep the repaired four-slot layout aligned with the Timesheet screen. */}
      <section className="alloc-card alloc-card--timesheet-slots" data-layout="timesheet-slots">
        <header className="alloc-card__head">
          <h2>{canAllocateOthers ? "Allocate Manhours" : "My Hours"}</h2>
          <p className="muted">
            Each slot is 2 hours. Select a project and optional work order, then submit the day for HOD approval.
            Payroll allocations do not allow overtime.
          </p>
        </header>

        {notice && <div className="alloc-note" role="status">{notice}</div>}
        {error && <div className="error-banner" role="alert">{error}</div>}

        <div className="alloc-form alloc-form--day">
          {canAllocateOthers && (
            <label className={`alloc-field ${formErr.employeeId ? "alloc-field--error" : ""}`}>
              <span>Employee</span>
              <select
                aria-label="Employee"
                value={employeeId}
                onChange={(event) => {
                  setEmployeeId(event.target.value);
                  setProjectId("");
                  setJobOrderId("");
                }}
              >
                <option value="">Select employee…</option>
                {employees.map((employee) => (
                  <option key={employee.id} value={employee.id}>{employee.name} ({employee.ecNo})</option>
                ))}
              </select>
              {formErr.employeeId && <span className="field-error">{formErr.employeeId}</span>}
            </label>
          )}
          <label className={`alloc-field ${formErr.workDate ? "alloc-field--error" : ""}`}>
            <span>Date</span>
            <input
              aria-label="Allocation date"
              type="date"
              value={workDate}
              onChange={(event) => {
                setWorkDate(event.target.value);
                setProjectId("");
                setJobOrderId("");
              }}
            />
            {formErr.workDate && <span className="field-error">{formErr.workDate}</span>}
          </label>
          {selectedDay && (
            <div className="alloc-day-summary">
              <span className={`alloc-status alloc-status--${selectedDay.status.toLowerCase()}`}>{selectedDay.status.replace(/_/g, " ")}</span>
              <strong>{selectedDay.allocations.length * 2} / 8 hours</strong>
            </div>
          )}
        </div>

        {canAllocateOthers && !employeeId ? (
          <div className="empty-state alloc-empty-compact">Select an employee to manage a day.</div>
        ) : (
          <>
            <div className="alloc-slot-grid" aria-label="Work slots">
              {SHIFT_SLOTS.map((slot) => {
                const allocation = selectedDay?.allocations.find((item) => item.shiftSlot === slot.id);
                return (
                  <button
                    key={slot.id}
                    type="button"
                    className={`alloc-slot ${shiftSlot === slot.id ? "is-selected" : ""} ${allocation ? "is-filled" : ""}`}
                    onClick={() => chooseSlot(slot.id)}
                    disabled={!editable}
                    aria-pressed={shiftSlot === slot.id}
                  >
                    <span>{slot.label}</span>
                    <small>{slot.time} · 2h</small>
                    <strong>{allocation?.project.name ?? "Empty"}</strong>
                    {allocation?.jobOrder && <small>{allocation.jobOrder.code}</small>}
                  </button>
                );
              })}
            </div>

            <div className="alloc-form alloc-form--assign">
              <label className={`alloc-field ${formErr.projectId ? "alloc-field--error" : ""}`}>
                <span>Project *</span>
                <select
                  aria-label="Project"
                  value={projectId}
                  disabled={!editable}
                  onChange={(event) => {
                    setProjectId(event.target.value);
                    setJobOrderId("");
                  }}
                >
                  <option value="">Select project…</option>
                  {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                </select>
                {formErr.projectId && <span className="field-error">{formErr.projectId}</span>}
              </label>
              <label className="alloc-field">
                <span>Work Order (optional)</span>
                <select
                  aria-label="Work Order"
                  value={jobOrderId}
                  disabled={!editable || !selectedProject}
                  onChange={(event) => setJobOrderId(event.target.value)}
                >
                  <option value="">{selectedProject ? "None / not applicable" : "Pick a project first"}</option>
                  {(selectedProject?.jobOrders ?? []).map((order) => (
                    <option key={order.id} value={order.id}>{order.code} - {order.name}</option>
                  ))}
                </select>
              </label>
              <div className="alloc-form__action alloc-action-group">
                <button type="button" className="btn btn-primary" disabled={busy || !editable} onClick={assignSlot}>
                  {busy ? "Saving…" : selectedSlot ? "Update Slot" : "Assign 2 Hours"}
                </button>
                {selectedSlot && editable && (
                  <button type="button" className="btn btn-danger" disabled={busy} onClick={() => removeSlot(selectedSlot.id)}>
                    Remove Slot
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy || !selectedDay || selectedDay.allocations.length === 0 || !editable}
                  onClick={submitDay}
                >
                  Submit for HOD Approval
                </button>
              </div>
            </div>
          </>
        )}
      </section>

      <div className="alloc-list-head"><h3>Recent Allocation Days</h3></div>
      {loading && <div className="loading-state">Loading allocations…</div>}
      {!loading && visibleDays.length === 0 && <div className="empty-state">No allocation days yet. Assign a slot above.</div>}
      {!loading && visibleDays.length > 0 && (
        <div className="alloc-day-list">
          {visibleDays.map((day) => (
            <article key={day.id} className="alloc-item alloc-day-item">
              <header>
                <div><strong>{day.employee.name}</strong><div className="muted tiny">{day.employee.ecNo} · {day.workDate.slice(0, 10)}</div></div>
                <span className={`alloc-status alloc-status--${day.status.toLowerCase()}`}>{day.status.replace(/_/g, " ")}</span>
              </header>
              <div className="alloc-day-slots">
                {SHIFT_SLOTS.map((shift) => {
                  const allocation = day.allocations.find((item) => item.shiftSlot === shift.id);
                  return (
                    <div key={shift.id} className={allocation ? "is-filled" : ""}>
                      <span>{shift.label}</span>
                      <strong>{allocation?.project.name ?? "—"}</strong>
                      {allocation?.jobOrder && <small>{allocation.jobOrder.code}</small>}
                    </div>
                  );
                })}
              </div>
              <div className="muted tiny">Total: {day.allocations.length * 2} hours</div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
