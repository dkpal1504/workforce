import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { SHIFT_LABELS, SHIFT_SLOTS, type ShiftSlot } from "@workforce/shared";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { FilterBar, useWorkContext } from "../hooks/useWorkContext";
import "../styles/timesheet.css";

type JobOrderOption = {
  id: number;
  code: string;
  name: string;
  status: string;
  budgetedHours: number | null;
};
type ProjectOption = {
  id: number;
  code: string;
  name: string;
  colorKey: string;
  jobOrders: JobOrderOption[];
};
type ShiftSlotRow = {
  shiftSlot: ShiftSlot;
  jobOrderId: number | null;
  projectId: number | null;
  projectColorKey: string | null;
  projectName: string | null;
  jobOrderCode: string | null;
  jobOrderName: string | null;
  projectWbsCode: string | null;
  entryId: number | null;
  status: string | null;
  locked: boolean;
};
type ReturnFeedback = {
  action: string;
  comment: string | null;
  at: string;
  by: string;
  role: string;
};
type EditMode = "full" | "addOnly" | "locked";
type Row = {
  employeeId: number;
  employee: { id: number; name: string };
  remarks: string;
  status: string;
  slots: ShiftSlotRow[];
  filledSlots: number;
  fullShiftDone: boolean;
  otherHours?: number;
  otherSlots?: number[];
  dayTotalHours?: number;
  exceedsLimit?: boolean;
  otHours?: number | null;
  otJobOrderId?: number | null;
  remarksRequired?: boolean;
  editMode?: EditMode;
  approvedAt?: string | null;
  lockExpiresAt?: string | null;
  returnFeedback?: ReturnFeedback | null;
};
type OpenReturn = {
  id: number;
  workDate: string;
  employee: { id: number; name: string; ecNo: string };
  remarks: string | null;
  feedback: ReturnFeedback | null;
};

type LocalRow = Row & {
  // Locally-marked "selected" slots (amber), pending assignment via Assign to Selected.
  // Independent of which slots are already filled (which render as project-colored).
  selectedSlots: Set<ShiftSlot>;
  // Per-row Allocation: the Project dropdown value. When set, the Job Order dropdown
  // is filtered to that project's JOs. Defaults to the row's first filled slot's project.
  projectId: number | "";
  // Per-row selected Job Order for the Assign button.
  jobOrderId: number | "";
};

function rowEditMode(r: { editMode?: EditMode }): EditMode {
  return r.editMode ?? "full";
}

/**
 * A slot may be re-selected / cleared / reassigned while the timesheet day is
 * still in an editable (not-yet-submitted) state: DRAFT, REJECTED, or
 * PLANNING_RETURNED. Once the supervisor has submitted for HOD approval
 * (SUBMITTED / HOD_APPROVED / PM_APPROVED), the day is locked down and only
 * an HOD/PM reject re-opens it.
 */
function isEditableForReassign(status: string) {
  return status === "DRAFT" || status === "REJECTED" || status === "PLANNING_RETURNED";
}

function isApprovedDayStatus(status: string) {
  return status === "HOD_APPROVED" || status === "PM_APPROVED";
}

function statusLabel(status: string) {
  switch (status) {
    case "REJECTED":
      return "Sent back / Rejected";
    case "SUBMITTED":
      return "Pending HOD";
    case "HOD_APPROVED":
      return "With Project Head";
    case "PM_APPROVED":
      return "Approved";
    case "DRAFT":
      return "Draft";
    default:
      return status;
  }
}

function fullName(first: string) {
  return first;
}

export function TimesheetPage() {
  const ctx = useWorkContext();
  const { user } = useAuth();
  const [params] = useSearchParams();
  const [rows, setRows] = useState<LocalRow[]>([]);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [poolCandidates, setPoolCandidates] = useState<{ id: number; name: string }[]>([]);
  const [addQuery, setAddQuery] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [maxDailyHours, setMaxDailyHours] = useState(8);
  const [openReturns, setOpenReturns] = useState<OpenReturn[]>([]);

  // Bulk Assignment block state
  const [bulkProjectId, setBulkProjectId] = useState<number | "">("");
  const [bulkJobOrderId, setBulkJobOrderId] = useState<number | "">("");
  // OT entry modal state — which employee's OT cell was clicked
  const [otTarget, setOtTarget] = useState<{ employeeId: number; name: string } | null>(null);
  const [otProjectId, setOtProjectId] = useState<number | "">("");
  const [otJobOrderId, setOtJobOrderId] = useState<number | "">("");
  const [otHours, setOtHours] = useState<string>("");
  const [otSaving, setOtSaving] = useState(false);
  // Expand/collapse state for the per-row grid (default: collapsed)
  const [expandedEmployees, setExpandedEmployees] = useState<Set<number>>(new Set());
  // For the "Select from Previous Day" carryover
  const [carryBanner, setCarryBanner] = useState("");

  useEffect(() => {
    const d = params.get("date");
    const dept = params.get("departmentId");
    const sup = params.get("supervisorId");
    if (d) ctx.setDate(d);
    if (dept) ctx.setDepartmentId(Number(dept));
    if (sup) ctx.setSupervisorId(Number(sup));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(async () => {
    if (!ctx.supervisorId || !ctx.departmentId) return;
    setLoading(true);
    setError("");
    try {
      const data = await api<{
        rows: Row[];
        projects: ProjectOption[];
        filled: number;
        total: number;
        maxDailyHours: number;
        openReturns?: OpenReturn[];
      }>(`/timesheet?supervisor_id=${ctx.supervisorId}&date=${ctx.date}`);
      setProjects(data.projects);
      setMaxDailyHours(data.maxDailyHours ?? 8);
      setOpenReturns(data.openReturns ?? []);
      setRows(
        data.rows.map((r) => {
          // Default per-row project to the first filled slot's project.
          const firstFilled = r.slots.find((s) => s.projectId != null);
          return {
            ...r,
            editMode: r.editMode ?? "full",
            selectedSlots: new Set<ShiftSlot>(),
            projectId: firstFilled?.projectId ?? "",
            jobOrderId: firstFilled?.jobOrderId ?? "",
          };
        })
      );
      const pool = await api<{ employees: { id: number; name: string }[] }>(
        `/teams/pool?department_id=${ctx.departmentId}&date=${ctx.date}&supervisor_id=${ctx.supervisorId}`
      );
      setPoolCandidates(pool.employees);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load timesheet");
    } finally {
      setLoading(false);
    }
  }, [ctx.supervisorId, ctx.departmentId, ctx.date]);

  useEffect(() => {
    load();
  }, [load]);

  const filled = useMemo(() => rows.filter((r) => r.filledSlots > 0).length, [rows]);

  /** Total amber (selected) shift slots across all editable rows — used by Bulk Assignment counter. */
  const totalSelectedSlots = useMemo(() => {
    let n = 0;
    for (const r of rows) {
      if (rowEditMode(r) === "locked") continue;
      n += r.selectedSlots.size;
    }
    return n;
  }, [rows]);

  /** Distinct employees touched by the current selection — used in Bulk Assignment summary. */
  const affectedEmployeeNames = useMemo(() => {
    const names: string[] = [];
    for (const r of rows) {
      if (rowEditMode(r) === "locked") continue;
      if (r.selectedSlots.size > 0) names.push(r.employee.name);
    }
    return names;
  }, [rows]);

  /** Available Job Orders for the Bulk Assignment dropdown, scoped to selected Project. */
  const bulkJobOrders = useMemo(() => {
    if (!bulkProjectId) return [];
    return projects.find((p) => p.id === bulkProjectId)?.jobOrders ?? [];
  }, [projects, bulkProjectId]);

  const bulkJobOrderName = useMemo(() => {
    if (!bulkJobOrderId) return "";
    return bulkJobOrders.find((j) => j.id === bulkJobOrderId)?.name ?? "";
  }, [bulkJobOrderId, bulkJobOrders]);

  // --- Per-row actions ---

  function toggleSlotSelection(employeeId: number, slot: ShiftSlot) {
    setRows((prev) =>
      prev.map((r) => {
        if (r.employeeId !== employeeId) return r;
        if (rowEditMode(r) === "locked") return r;
        const existing = r.slots.find((s) => s.shiftSlot === slot);
        // On an editable (not-yet-submitted) day — DRAFT / REJECTED / PLANNING_RETURNED —
        // the supervisor may re-select an already-assigned slot so they can clear or
        // reassign it. Once submitted (SUBMITTED / approved), a filled slot is not selectable.
        if (existing && existing.jobOrderId != null && !isEditableForReassign(r.status)) return r;
        if (existing && existing.locked) return r;
        const next = new Set(r.selectedSlots);
        if (next.has(slot)) next.delete(slot);
        else next.add(slot);
        return { ...r, selectedSlots: next };
      })
    );
  }

  function toggleFullShift(employeeId: number) {
    setRows((prev) =>
      prev.map((r) => {
        if (r.employeeId !== employeeId) return r;
        if (rowEditMode(r) === "locked") return r;
        // On an editable (not-yet-submitted) day the supervisor may uncheck "full shift"
        // to clear/reassign hours. Otherwise it freezes once the row is fully assigned.
        if (r.fullShiftDone && !isEditableForReassign(r.status)) return r;
        // Select all empty slots
        const next = new Set<ShiftSlot>();
        for (const s of r.slots) {
          if (s.jobOrderId == null && !s.locked) next.add(s.shiftSlot);
        }
        return { ...r, selectedSlots: next };
      })
    );
  }

  function setRowProject(employeeId: number, projectId: number | "") {
    setRows((prev) =>
      prev.map((r) => {
        if (r.employeeId !== employeeId) return r;
        if (rowEditMode(r) === "locked") return r;
        return { ...r, projectId, jobOrderId: "" };
      })
    );
  }

  function setRowJobOrder(employeeId: number, jobOrderId: number | "") {
    setRows((prev) =>
      prev.map((r) => (r.employeeId === employeeId ? { ...r, jobOrderId } : r))
    );
  }

  function setRemarks(employeeId: number, remarks: string) {
    setRows((prev) =>
      prev.map((r) =>
        r.employeeId === employeeId && rowEditMode(r) !== "locked" ? { ...r, remarks } : r
      )
    );
  }

  function openOtModal(employeeId: number, name: string) {
    const row = rows.find((r) => r.employeeId === employeeId);
    setOtTarget({ employeeId, name });
    setOtProjectId("");
    setOtJobOrderId("");
    setOtHours(row?.otHours != null ? String(row.otHours) : "");
  }

  async function saveOt() {
    if (!otTarget) return;
    const hours = Number(otHours);
    if (!Number.isInteger(hours) || hours < 1 || hours > 12) {
      setError("OT hours must be a whole number between 1 and 12.");
      return;
    }
    if (!otJobOrderId) {
      setError("Select a Project and Work Order for the OT hours.");
      return;
    }
    setOtSaving(true);
    setError("");
    try {
      await api("/timesheet/ot", {
        method: "PUT",
        body: JSON.stringify({
          supervisorId: ctx.supervisorId,
          workDate: ctx.date,
          employeeId: otTarget.employeeId,
          otHours: hours,
          jobOrderId: otJobOrderId,
        }),
      });
      setMessage(`Added ${hours}h OT for ${otTarget.name}.`);
      setOtTarget(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save OT hours");
    } finally {
      setOtSaving(false);
    }
  }

  async function clearOt() {
    if (!otTarget) return;
    setOtSaving(true);
    setError("");
    try {
      await api("/timesheet/ot", {
        method: "PUT",
        body: JSON.stringify({
          supervisorId: ctx.supervisorId,
          workDate: ctx.date,
          employeeId: otTarget.employeeId,
          otHours: null,
          jobOrderId: null,
        }),
      });
      setMessage(`Cleared OT for ${otTarget.name}.`);
      setOtTarget(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to clear OT hours");
    } finally {
      setOtSaving(false);
    }
  }

  async function assignRowToSelected(employeeId: number) {
    const row = rows.find((r) => r.employeeId === employeeId);
    if (!row || !row.jobOrderId || row.selectedSlots.size === 0) return;
    if (rowEditMode(row) === "locked") return;
    const employeeIdVal = row.employeeId;
    const jobOrderId = row.jobOrderId as number;
    const slots = Array.from(row.selectedSlots);
    setError("");
    try {
      // Use the per-slot endpoint sequentially (4 max).
      for (const shiftSlot of slots) {
        await api("/timesheet/entry", {
          method: "PUT",
          body: JSON.stringify({
            supervisorId: ctx.supervisorId,
            workDate: ctx.date,
            employeeId: employeeIdVal,
            shiftSlot,
            jobOrderId,
          }),
        });
      }
      setMessage(`Assigned ${slots.length} slot(s) for ${row.employee.name}.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Assign failed");
    }
  }

  async function removeEmployee(employeeId: number) {
    if (!ctx.supervisorId) return;
    await api(`/teams/today/${employeeId}?supervisor_id=${ctx.supervisorId}&date=${ctx.date}`, {
      method: "DELETE",
    });
    await load();
  }

  async function addEmployee(employeeId: number) {
    if (!ctx.supervisorId || !ctx.departmentId) return;
    const nextIds = [...rows.map((r) => r.employeeId), employeeId];
    await api("/teams/today", {
      method: "POST",
      body: JSON.stringify({
        supervisorId: ctx.supervisorId,
        departmentId: ctx.departmentId,
        workDate: ctx.date,
        employeeIds: nextIds,
      }),
    });
    setAddQuery("");
    setShowAdd(false);
    await load();
  }

  // --- Bulk Assignment actions ---

  function selectAllUnassigned() {
    setRows((prev) =>
      prev.map((r) => {
        if (rowEditMode(r) === "locked") return r;
        // On an editable (not-yet-submitted) day include already-assigned slots so the
        // supervisor can bulk-reassign them. Otherwise skip "Assigned" rows.
        if (r.fullShiftDone && !isEditableForReassign(r.status)) return r;
        // Select every empty slot (and assigned slots on editable days)
        const next = new Set<ShiftSlot>();
        for (const s of r.slots) {
          if (!s.locked && (s.jobOrderId == null || isEditableForReassign(r.status))) next.add(s.shiftSlot);
        }
        return { ...r, selectedSlots: next };
      })
    );
  }

  function clearAllSelection() {
    setRows((prev) =>
      prev.map((r) => (rowEditMode(r) === "locked" ? r : { ...r, selectedSlots: new Set<ShiftSlot>() }))
    );
  }

  async function applyBulkAssign() {
    if (!ctx.supervisorId || !bulkProjectId || !bulkJobOrderId) return;
    const slots: { employeeId: number; shiftSlot: ShiftSlot }[] = [];
    for (const r of rows) {
      if (rowEditMode(r) === "locked") continue;
      for (const s of r.selectedSlots) {
        slots.push({ employeeId: r.employeeId, shiftSlot: s });
      }
    }
    if (!slots.length) {
      setError("Select at least one slot before applying.");
      return;
    }
    setError("");
    try {
      const result = await api<{
        ok: boolean;
        taggedSlots: number;
        taggedEmployees: number;
        projectName: string;
        jobOrderCode: string;
      }>("/timesheet/bulk-assign", {
        method: "POST",
        body: JSON.stringify({
          supervisorId: ctx.supervisorId,
          workDate: ctx.date,
          projectId: bulkProjectId,
          jobOrderId: bulkJobOrderId,
          slots,
        }),
      });
      setMessage(
        `Applied ${result.jobOrderCode} (${result.projectName}) to ${result.taggedSlots} slot(s) across ${result.taggedEmployees} employee(s).`
      );
      clearAllSelection();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Bulk assign failed");
    }
  }

  // --- Save Draft / Submit ---

  function buildPayload() {
    return {
      supervisorId: ctx.supervisorId,
      workDate: ctx.date,
      rows: rows.map((r) => ({
        employeeId: r.employeeId,
        remarks: r.remarks,
        slots: SHIFT_SLOTS.map((shiftSlot) => {
          const filled = r.slots.find((s) => s.shiftSlot === shiftSlot);
          return {
            shiftSlot,
            jobOrderId: filled?.jobOrderId ?? null,
          };
        }),
      })),
    };
  }

  async function saveDraft() {
    setError("");
    setWarning("");
    setMessage("");
    try {
      await api("/timesheet/day", { method: "PUT", body: JSON.stringify(buildPayload()) });
      setMessage("Draft saved.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    }
  }

  async function submit() {
    setError("");
    setWarning("");
    setMessage("");
    try {
      await api("/timesheet/day", { method: "PUT", body: JSON.stringify(buildPayload()) });
      const result = await api<{
        ok: boolean;
        warnings?: { message: string }[];
      }>("/timesheet/submit", {
        method: "POST",
        body: JSON.stringify({ supervisorId: ctx.supervisorId, workDate: ctx.date }),
      });
      const warnText = result.warnings?.map((w) => w.message).join(" ") || "";
      setMessage(
        warnText
          ? `Timesheet submitted for approval. ${warnText}`
          : "Timesheet submitted for approval."
      );
      if (warnText) setWarning(warnText);
      await load();
    } catch (e) {
      if (e instanceof ApiError) {
        const payload = e.payload as {
          violations?: { employeeName: string; dayTotalHours: number }[];
        };
        if (payload?.violations?.length) {
          setError(
            `${e.message} Missing remarks: ${payload.violations
              .map((v) => `${v.employeeName} (${v.dayTotalHours}h)`)
              .join(", ")}`
          );
        } else {
          setError(e.message);
        }
      } else {
        setError(e instanceof Error ? e.message : "Submit failed");
      }
    }
  }

  async function selectFromPreviousDay() {
    if (!ctx.supervisorId) return;
    setError("");
    try {
      const prev = await api<{
        rows: { employeeId: number; slots: { shiftSlot: ShiftSlot; jobOrderId: number | null }[] }[];
        closedJobOrderSlots: { employeeId: number; shiftSlot: ShiftSlot }[];
      }>(`/timesheet/previous-day?supervisor_id=${ctx.supervisorId}&date=${ctx.date}`);
      // Apply via bulk-assign per employee
      for (const r of prev.rows) {
        for (const s of r.slots) {
          if (s.jobOrderId == null) continue;
          await api("/timesheet/entry", {
            method: "PUT",
            body: JSON.stringify({
              supervisorId: ctx.supervisorId,
              workDate: ctx.date,
              employeeId: r.employeeId,
              shiftSlot: s.shiftSlot,
              jobOrderId: s.jobOrderId,
            }),
          });
        }
      }
      const closedNote = prev.closedJobOrderSlots?.length
        ? ` ${prev.closedJobOrderSlots.length} carried slot(s) reference Job Orders that are no longer active and were skipped.`
        : "";
      setCarryBanner(`Carried over allocations from previous day.${closedNote}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Carry-over failed");
    }
  }

  const addMatches = poolCandidates.filter(
    (e) =>
      addQuery.trim() &&
      (e.name.toLowerCase().includes(addQuery.toLowerCase()) || String(e.id).includes(addQuery))
  );

  const allUnassigned = rows.filter((r) => !r.fullShiftDone && rowEditMode(r) !== "locked");
  const allFullyAssigned = rows.length > 0 && rows.every((r) => r.fullShiftDone);

  return (
    <>
      <FilterBar
        {...ctx}
        trailing={
          <div className="status-pill">
            ● Filled: {filled} / {rows.length} · Max {maxDailyHours}h/day
          </div>
        }
      />
      {error && <div className="error-banner">{error}</div>}
      {warning && <div className="warning-banner">{warning}</div>}
      {message && (
        <div className="carry-banner" style={{ marginBottom: 12 }}>
          {message}
        </div>
      )}
      {carryBanner && (
        <div className="carry-banner" style={{ marginBottom: 12 }}>
          {carryBanner}
        </div>
      )}
      {openReturns.length > 0 && (
        <div className="returns-panel">
          <div className="returns-panel__title">Sent back for correction ({openReturns.length})</div>
          <p className="returns-panel__hint">
            HOD / Project Head returned these sheets. Open the date, correct hours, then Submit for Approval again.
          </p>
          <ul className="returns-panel__list">
            {openReturns.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="returns-panel__link"
                  onClick={() => ctx.setDate(item.workDate)}
                >
                  {item.workDate}
                </button>
                <strong>{item.employee.name}</strong>
                <span className="muted">
                  {item.feedback
                    ? ` — ${item.feedback.by} (${item.feedback.role === "PM" ? "Project Head" : item.feedback.role}): ${
                        item.feedback.comment || "No comment"
                      }`
                    : item.remarks
                      ? ` — ${item.remarks}`
                      : " — Needs correction"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {loading && <p className="muted">Loading…</p>}

      {/* Bulk Assignment block — primary action area */}
      {user?.role === "SUPERVISOR" && (
        <section className="bulk-assign">
          <header className="bulk-assign__head">
            <h2>Bulk Assignment</h2>
            <p className="bulk-assign__hint">
              Select slots, pick a Project + Job Order, then apply. Already-assigned rows are skipped.
            </p>
          </header>
          <div className="bulk-assign__row">
            <label className="bulk-assign__check">
              <input
                type="checkbox"
                checked={totalSelectedSlots > 0 && !allFullyAssigned}
                onChange={(e) => (e.target.checked ? selectAllUnassigned() : clearAllSelection())}
                disabled={allUnassigned.length === 0}
              />
              <span>Select All</span>
            </label>
            <div className="bulk-assign__field">
              <label>Project</label>
              <select
                value={bulkProjectId}
                onChange={(e) => {
                  setBulkProjectId(e.target.value ? Number(e.target.value) : "");
                  setBulkJobOrderId("");
                }}
              >
                <option value="">Select…</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="bulk-assign__field">
              <label>Job Order</label>
              <select
                value={bulkJobOrderId}
                onChange={(e) => setBulkJobOrderId(e.target.value ? Number(e.target.value) : "")}
                disabled={!bulkProjectId}
              >
                <option value="">{bulkProjectId ? "Select…" : "Select a project first"}</option>
                {bulkJobOrders.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.code} - {j.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="bulk-assign__field bulk-assign__field--readonly">
              <label>Job Order Name</label>
              <input type="text" readOnly value={bulkJobOrderName} placeholder="—" />
            </div>
            <div className="bulk-assign__apply">
              <button
                type="button"
                className="btn btn-primary"
                disabled={totalSelectedSlots === 0 || !bulkJobOrderId}
                onClick={applyBulkAssign}
              >
                Assign to Selected
              </button>
            </div>
          </div>
          <div className="bulk-assign__summary">
            <span>
              {totalSelectedSlots} slot{totalSelectedSlots === 1 ? "" : "s"} selected
            </span>
            <span className="bulk-assign__affected">
              {affectedEmployeeNames.length > 0
                ? `Affecting: ${affectedEmployeeNames.slice(0, 6).join(", ")}${
                    affectedEmployeeNames.length > 6
                      ? `, +${affectedEmployeeNames.length - 6} more`
                      : ""
                  }`
                : "No slots selected"}
            </span>
          </div>
          <div className="bulk-assign__prevday">
            <button type="button" className="btn btn-secondary" onClick={selectFromPreviousDay}>
              Select from Previous Day
            </button>
          </div>
        </section>
      )}

      {/* Per-employee grid — desktop table */}
      <div className="timesheet-wrap ts-desktop-only">
        <table className="timesheet-table">
          <thead>
            <tr>
              <th className="emp-col">Employee</th>
              <th className="fullshift-col">Full Shift</th>
              <th colSpan={2} className="half-head">
                1st Half
              </th>
              <th colSpan={2} className="half-head">
                2nd Half
              </th>
              <th className="ot-col">OT HRS</th>
              <th colSpan={3} className="alloc-head">
                Allocation
              </th>
              <th>Remarks</th>
            </tr>
            <tr>
              <th className="emp-col sub"></th>
              <th className="fullshift-col sub"></th>
              <th className="slot-head">9a–11a</th>
              <th className="slot-head">11a–1p</th>
              <th className="slot-head">2p–4p</th>
              <th className="slot-head">4p–6p</th>
              <th className="ot-col sub"></th>
              <th className="alloc-sub">Project</th>
              <th className="alloc-sub">WBS / Job Order</th>
              <th className="alloc-sub">Assign</th>
              <th className="remarks-sub"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const filledCount = r.slots.filter((s) => s.jobOrderId != null).length;
              const isLocked = rowEditMode(r) === "locked";
              const isAddOnly = rowEditMode(r) === "addOnly";
              const rowClass = [
                r.fullShiftDone ? "row-done" : "",
                r.exceedsLimit ? "row-over-limit" : "",
                r.status === "REJECTED" ? "row-rejected" : "",
                isLocked ? "row-locked" : "",
                isAddOnly ? "row-add-only" : "",
              ]
                .filter(Boolean)
                .join(" ");
              const rowProject = projects.find((p) => p.id === r.projectId);
              const rowJobOrders = rowProject?.jobOrders ?? [];
              const expanded = expandedEmployees.has(r.employeeId) || r.fullShiftDone;
              return (
                <>
                <tr key={r.employeeId} className={`row-summary ${rowClass}`.trim()}>
                  <td className="emp-col" rowSpan={expanded ? 1 : 1}>
                    <div className="emp-name">
                      <button
                        type="button"
                        className="emp-expand"
                        aria-label={expanded ? "Collapse" : "Expand"}
                        aria-expanded={expanded}
                        onClick={() =>
                          setExpandedEmployees((prev) => {
                            const next = new Set(prev);
                            if (next.has(r.employeeId)) next.delete(r.employeeId);
                            else next.add(r.employeeId);
                            return next;
                          })
                        }
                      >
                        {expanded ? "▾" : "▸"}
                      </button>
                      {fullName(r.employee.name)}
                    </div>
                    <div className={`emp-status-chip status-${r.status.toLowerCase()}`}>
                      {statusLabel(r.status)}
                    </div>
                    {r.fullShiftDone && (
                      <div className="emp-status-chip status-assigned">✓ Assigned</div>
                    )}
                    <div className="emp-hours-meta">
                      {filledCount}/4 today
                      {r.exceedsLimit ? ` · over ${maxDailyHours}h limit` : ""}
                    </div>
                    <div className="emp-actions">
                      <button type="button" onClick={() => removeEmployee(r.employeeId)}>
                        Remove
                      </button>
                    </div>
                  </td>
                  <td className="fullshift-col">
                    <label className="fullshift-check">
                      <input
                        type="checkbox"
                        checked={r.fullShiftDone}
                        disabled={isLocked || (r.fullShiftDone && !isEditableForReassign(r.status))}
                        onChange={() => toggleFullShift(r.employeeId)}
                        aria-label="Full Shift (select all 4 slots)"
                      />
                    </label>
                  </td>
                  {r.slots.map((s) => {
                    const selected = r.selectedSlots.has(s.shiftSlot);
                    const colorKey = s.projectColorKey;
                    const slotLocked = isLocked || s.locked;
                    let cls = "slot-cell";
                    let label = "";
                    if (s.jobOrderId != null) {
                      cls += ` assigned-${(colorKey || "n").toLowerCase()}`;
                      label = (colorKey || "•").toUpperCase();
                    } else if (selected) {
                      cls += " selected";
                      label = "✓";
                    }
                    if (slotLocked) cls += " slot-cell--locked";
                    return (
                      <td key={s.shiftSlot} className="slot-td">
                        <button
                          type="button"
                          className={cls}
                          disabled={slotLocked || (s.jobOrderId != null && !isEditableForReassign(r.status))}
                          onClick={() => toggleSlotSelection(r.employeeId, s.shiftSlot)}
                          aria-label={SHIFT_LABELS[s.shiftSlot].long}
                          title={SHIFT_LABELS[s.shiftSlot].long}
                        >
                          {label}
                        </button>
                      </td>
                    );
                  })}
                  <td className="ot-col">
                    <button
                      type="button"
                      className={`ot-cell ot-cell--btn ${r.otHours != null ? "ot-cell--set" : ""}`}
                      disabled={isLocked}
                      onClick={() => openOtModal(r.employeeId, r.employee.name)}
                      title={r.otHours != null ? `OT ${r.otHours}h — click to edit` : "Click to add OT hours"}
                    >
                      {r.otHours != null ? `${r.otHours}h` : "+"}
                    </button>
                  </td>
                  <td>
                    <select
                      className="project-select"
                      value={r.projectId}
                      disabled={isLocked}
                      onChange={(e) =>
                        setRowProject(r.employeeId, e.target.value ? Number(e.target.value) : "")
                      }
                    >
                      <option value="">Select…</option>
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select
                      className="jo-select"
                      value={r.jobOrderId}
                      disabled={isLocked || !r.projectId}
                      onChange={(e) =>
                        setRowJobOrder(r.employeeId, e.target.value ? Number(e.target.value) : "")
                      }
                    >
                      <option value="">{r.projectId ? "Select…" : "Pick a project"}</option>
                      {rowJobOrders.map((j) => (
                        <option key={j.id} value={j.id}>
                          {j.code} - {j.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <button
                      type="button"
                      className={`assign-btn ${r.selectedSlots.size === 0 ? "is-idle" : r.fullShiftDone ? "is-done" : "is-ready"}`}
                      disabled={isLocked || r.selectedSlots.size === 0 || !r.jobOrderId}
                      onClick={() => assignRowToSelected(r.employeeId)}
                    >
                      Assign
                    </button>
                  </td>
                  <td>
                    <input
                      className="remarks-input"
                      value={r.remarks}
                      disabled={isLocked}
                      placeholder="Add note…"
                      onChange={(e) => setRemarks(r.employeeId, e.target.value)}
                    />
                  </td>
                </tr>
                {expanded && r.returnFeedback && (
                  <tr className="row-feedback">
                    <td colSpan={11}>
                      <div className="return-feedback">
                        <div className="return-feedback__label">
                          Feedback from {r.returnFeedback.by}
                          {r.returnFeedback.role === "PM"
                            ? " (Project Head)"
                            : r.returnFeedback.role === "HOD"
                              ? " (HOD)"
                              : ""}
                        </div>
                        <div className="return-feedback__text">
                          {r.returnFeedback.comment || "Correct and resubmit."}
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
                </>
              );
            })}
            <tr className="add-emp-row">
              <td colSpan={11}>
                <div className="add-dropdown">
                  <input
                    className="add-emp-input"
                    placeholder="+ Add employee… (search department roster)"
                    value={addQuery}
                    onChange={(e) => {
                      setAddQuery(e.target.value);
                      setShowAdd(true);
                    }}
                    onFocus={() => setShowAdd(true)}
                  />
                  {showAdd && addMatches.length > 0 && (
                    <ul className="add-dropdown__list">
                      {addMatches.map((e) => (
                        <li key={e.id} onClick={() => addEmployee(e.id)}>
                          {e.name}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Mobile cards — per-employee, 4 slot chips, Full Shift toggle, Allocation stacked */}
      <div className="ts-cards ts-mobile-only">
        {rows.map((r) => {
          const isLocked = rowEditMode(r) === "locked";
          const filledCount = r.slots.filter((s) => s.jobOrderId != null).length;
          const rowProject = projects.find((p) => p.id === r.projectId);
          const rowJobOrders = rowProject?.jobOrders ?? [];
          return (
            <article
              key={r.employeeId}
              className={`ts-card ${r.fullShiftDone ? "row-done" : ""} ${
                r.exceedsLimit ? "row-over-limit" : ""
              } ${r.status === "REJECTED" ? "row-rejected" : ""} ${
                isLocked ? "row-locked" : ""
              }`.trim()}
            >
              <header className="ts-card__head">
                <div>
                  <div className="emp-name">{fullName(r.employee.name)}</div>
                  <div className={`emp-status-chip status-${r.status.toLowerCase()}`}>
                    {statusLabel(r.status)}
                  </div>
                  {r.fullShiftDone && (
                    <div className="emp-status-chip status-assigned">✓ Assigned</div>
                  )}
                  <div className="emp-hours-meta">
                    {filledCount}/4 today
                    {r.exceedsLimit ? ` · over ${maxDailyHours}h limit` : ""}
                  </div>
                </div>
                <label className="ts-fullshift">
                  <input
                    type="checkbox"
                    checked={r.fullShiftDone}
                    disabled={isLocked || (r.fullShiftDone && !isEditableForReassign(r.status))}
                    onChange={() => toggleFullShift(r.employeeId)}
                    aria-label="Full Shift (select all 4 slots)"
                  />
                  <span>Full Shift</span>
                </label>
              </header>
              <div className="ts-shift-grid" role="group" aria-label="Shift slots">
                {r.slots.map((s) => {
                  const selected = r.selectedSlots.has(s.shiftSlot);
                  const colorKey = s.projectColorKey;
                  const slotLocked = isLocked || s.locked;
                  let cls = "ts-shift-chip";
                  let label = "";
                  if (s.jobOrderId != null) {
                    cls += ` assigned-${(colorKey || "n").toLowerCase()}`;
                    label = (colorKey || "•").toUpperCase();
                  } else if (selected) {
                    cls += " selected";
                    label = "✓";
                  }
                  if (slotLocked) cls += " slot-cell--locked";
                  return (
                    <button
                      key={s.shiftSlot}
                      type="button"
                      className={cls}
                      disabled={slotLocked || (s.jobOrderId != null && !isEditableForReassign(r.status))}
                      onClick={() => toggleSlotSelection(r.employeeId, s.shiftSlot)}
                      aria-label={SHIFT_LABELS[s.shiftSlot].long}
                      title={SHIFT_LABELS[s.shiftSlot].long}
                    >
                      <span className="ts-shift-chip__half">
                        {SHIFT_LABELS[s.shiftSlot].half}
                      </span>
                      <span className="ts-shift-chip__time">
                        {SHIFT_LABELS[s.shiftSlot].short}
                      </span>
                      <span className="ts-shift-chip__value">{label || "·"}</span>
                    </button>
                  );
                })}
              </div>
              <div className="ts-ot">
                <span className="muted tiny">OT HRS</span>
                <button
                  type="button"
                  className={`ot-cell ot-cell--btn ${r.otHours != null ? "ot-cell--set" : ""}`}
                  disabled={isLocked}
                  onClick={() => openOtModal(r.employeeId, r.employee.name)}
                  title={r.otHours != null ? `OT ${r.otHours}h — click to edit` : "Click to add OT hours"}
                >
                  {r.otHours != null ? `${r.otHours}h` : "+"}
                </button>
              </div>
              <div className="ts-alloc">
                <label className="ts-field">
                  <span>Project</span>
                  <select
                    className="project-select"
                    value={r.projectId}
                    disabled={isLocked}
                    onChange={(e) =>
                      setRowProject(r.employeeId, e.target.value ? Number(e.target.value) : "")
                    }
                  >
                    <option value="">Select…</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="ts-field">
                  <span>WBS / Job Order</span>
                  <select
                    className="jo-select"
                    value={r.jobOrderId}
                    disabled={isLocked || !r.projectId}
                    onChange={(e) =>
                      setRowJobOrder(r.employeeId, e.target.value ? Number(e.target.value) : "")
                    }
                  >
                    <option value="">{r.projectId ? "Select…" : "Pick a project"}</option>
                    {rowJobOrders.map((j) => (
                      <option key={j.id} value={j.id}>
                        {j.code} - {j.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="assign-btn"
                  disabled={isLocked || r.selectedSlots.size === 0 || !r.jobOrderId}
                  onClick={() => assignRowToSelected(r.employeeId)}
                >
                  Assign
                </button>
              </div>
              <label className="ts-field ts-field--full">
                <span>Remarks</span>
                <input
                  className="remarks-input"
                  value={r.remarks}
                  disabled={isLocked}
                  placeholder="Add note…"
                  onChange={(e) => setRemarks(r.employeeId, e.target.value)}
                />
              </label>
              {r.returnFeedback && (
                <div className="return-feedback">
                  <div className="return-feedback__label">
                    Feedback from {r.returnFeedback.by}
                    {r.returnFeedback.role === "PM"
                      ? " (Project Head)"
                      : r.returnFeedback.role === "HOD"
                        ? " (HOD)"
                        : ""}
                  </div>
                  <div className="return-feedback__text">
                    {r.returnFeedback.comment || "Correct and resubmit."}
                  </div>
                </div>
              )}
            </article>
          );
        })}
        <div className="ts-card ts-card--add">
          <div className="add-dropdown">
            <input
              className="add-emp-input"
              placeholder="+ Add employee… (search department roster)"
              value={addQuery}
              onChange={(e) => {
                setAddQuery(e.target.value);
                setShowAdd(true);
              }}
              onFocus={() => setShowAdd(true)}
            />
            {showAdd && addMatches.length > 0 && (
              <ul className="add-dropdown__list">
                {addMatches.map((e) => (
                  <li key={e.id} onClick={() => addEmployee(e.id)}>
                    {e.name}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      {/* Legend */}
      <div className="legend-row">
        <div className="legend">
          {projects.map((p) => (
            <span key={p.id} className="legend-item">
              <span
                className="legend-swatch"
                style={{ background: `var(--project-${p.colorKey.toLowerCase()})` }}
              >
                {p.colorKey}
              </span>
              {p.name}
            </span>
          ))}
          <span className="legend-item">
            <span className="legend-swatch" style={{ background: "var(--orange-selected)" }}>
              ✓
            </span>
            Selected, unassigned
          </span>
        </div>
        <p className="help-text">
          Bulk Assignment applies the chosen Project + Job Order to all amber (selected) slots in
          one click. The 4 slots per day are 1st Half (9a–11a, 11a–1p) and 2nd Half (2p–4p, 4p–6p).
          Full Shift selects all 4 empty slots for that employee; it freezes once the row is fully
          assigned. Click any cell to toggle its selection. Max {maxDailyHours}h/day; overtime
          requires a Remarks reason.
        </p>
      </div>

      <div className="footer-actions">
        <button className="btn btn-secondary" onClick={saveDraft}>
          Save Draft
        </button>
        <button className="btn btn-primary" onClick={submit}>
          Submit for Approval
        </button>
      </div>

      {/* OT entry modal */}
      {otTarget && (
        <div className="modal-backdrop" onClick={() => setOtTarget(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal__header">
              <h2>Add OT Hours — {otTarget.name}</h2>
              <button type="button" className="modal__close" aria-label="Close" onClick={() => setOtTarget(null)}>
                ×
              </button>
            </div>
            <div className="modal__body">
              <div className="sup-form">
                <div className="sup-field">
                  <label>Project</label>
                  <select
                    value={otProjectId}
                    onChange={(e) => {
                      setOtProjectId(e.target.value ? Number(e.target.value) : "");
                      setOtJobOrderId("");
                    }}
                  >
                    <option value="">Select project…</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="sup-field">
                  <label>Work Order</label>
                  <select
                    value={otJobOrderId}
                    disabled={!otProjectId}
                    onChange={(e) => setOtJobOrderId(e.target.value ? Number(e.target.value) : "")}
                  >
                    <option value="">{otProjectId ? "Select work order…" : "Pick a project first"}</option>
                    {(projects.find((p) => p.id === otProjectId)?.jobOrders ?? []).map((j) => (
                      <option key={j.id} value={j.id}>
                        {j.code} - {j.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="sup-field">
                  <label>OT Hours (1–12)</label>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={12}
                    value={otHours}
                    onChange={(e) => setOtHours(e.target.value)}
                    placeholder="e.g. 2"
                  />
                </div>
                <p className="sup-form__note">
                  OT is added on top of the {maxDailyHours}h shift and is separate from regular
                  allocation. It will be visible to HOD / Project Head in light red.
                </p>
                <div className="modal__footer" style={{ padding: 0, borderTop: "none" }}>
                  {otHours && Number(otHours) >= 1 && (
                    <button type="button" className="btn btn-ghost" disabled={otSaving} onClick={clearOt}>
                      {otSaving ? "Saving…" : "Clear OT"}
                    </button>
                  )}
                  <button type="button" className="btn btn-ghost" onClick={() => setOtTarget(null)}>
                    Cancel
                  </button>
                  <button type="button" className="btn btn-primary" disabled={otSaving} onClick={saveOt}>
                    {otSaving ? "Saving…" : "Save OT"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
