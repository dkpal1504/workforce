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
  bookedByOther?: boolean;
  bookedBySupervisorNames?: string[];
  otherBookingSubmitted?: boolean;
  otherBookingStatus?: string | null;
  otherProjectColorKey?: string | null;
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
  employee: { id: number; name: string; employmentType: string };
  remarks: string;
  status: string;
  slots: ShiftSlotRow[];
  filledSlots: number;
  fullShiftDone: boolean;
  isSelf?: boolean;
  otherHours?: number;
  otherSlots?: number[];
  dayTotalHours?: number;
  exceedsLimit?: boolean;
  otHours?: number | null;
  otJobOrderId?: number | null;
  otProjectId?: number | null;
  otProjectColorKey?: string | null;
  otLocked?: boolean;
  otBookedByOther?: boolean;
  otBookedBySupervisorNames?: string[];
  otOtherBookingStatus?: string | null;
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
  // OT uses the same row Project / Job Order controls as regular shift slots.
  otSelected: boolean;
  otHoursInput: string;
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
  // A non-owner viewer (HOD/PM/ADMIN, or another supervisor) may VIEW a
  // supervisor's timesheet read-only, but must not be offered write actions —
  // the backend independently enforces NOT_OWNER. Gate all write controls on this.
  const isOwner = user?.id === ctx.supervisorId;
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
  // Expand/collapse state for the per-row grid (default: collapsed)
  const [expandedEmployees, setExpandedEmployees] = useState<Set<number>>(new Set());
  // For the "Select from Previous Day" carryover
  const [carryBanner, setCarryBanner] = useState("");
  const [carryLoading, setCarryLoading] = useState(false);

  useEffect(() => {
    setCarryBanner("");
  }, [ctx.date, ctx.supervisorId]);

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
            projectId: firstFilled?.projectId ?? r.otProjectId ?? "",
            jobOrderId: firstFilled?.jobOrderId ?? r.otJobOrderId ?? "",
            otSelected: false,
            otHoursInput: String(r.otHours ?? 0),
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

  async function reloadIfAnotherSupervisorWon(error: unknown) {
    if (!(error instanceof ApiError)) return false;
    const code = (error.payload as { code?: string })?.code;
    if (code !== "SLOT_ALREADY_BOOKED" && code !== "OT_ALREADY_BOOKED") return false;
    await load();
    return true;
  }

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

  function toggleOtSelection(employeeId: number) {
    setRows((prev) =>
      prev.map((r) => {
        if (r.employeeId !== employeeId || rowEditMode(r) === "locked" || r.otLocked) return r;
        const selecting = !r.otSelected;
        return {
          ...r,
          otSelected: selecting,
          projectId: selecting && r.otProjectId ? r.otProjectId : r.projectId,
          jobOrderId: selecting && r.otJobOrderId ? r.otJobOrderId : r.jobOrderId,
        };
      })
    );
  }

  function setOtHoursInput(employeeId: number, value: string) {
    if (value !== "" && !/^\d{0,2}$/.test(value)) return;
    setRows((prev) =>
      prev.map((r) =>
        r.employeeId === employeeId && rowEditMode(r) !== "locked" && !r.otLocked
          ? { ...r, otHoursInput: value }
          : r
      )
    );
  }

  async function assignRowToSelected(employeeId: number) {
    const row = rows.find((r) => r.employeeId === employeeId);
    if (!row || (row.selectedSlots.size === 0 && !row.otSelected)) return;
    if (rowEditMode(row) === "locked") return;
    if (row.otSelected && row.employee.employmentType !== "CLMS") {
      setError("Overtime entry is available only for contract workmen.");
      return;
    }

    const hours = Number(row.otHoursInput);
    if (row.otSelected && (!Number.isInteger(hours) || hours < 0 || hours > 12)) {
      setError("OT hours must be a whole number between 0 and 12 (use 0 to clear existing OT).");
      return;
    }
    if (row.otSelected && hours === 0 && row.otHours == null) {
      setError("Enter OT hours between 1 and 12.");
      return;
    }
    if (row.otSelected && hours > 0 && !row.remarks.trim()) {
      setError(`Enter mandatory OT remarks for ${row.employee.name} before assigning.`);
      return;
    }
    if (!row.jobOrderId && (row.selectedSlots.size > 0 || (row.otSelected && hours > 0))) {
      setError("Select a Project and Job Order before assigning.");
      return;
    }

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
      if (row.otSelected) {
        await api("/timesheet/ot", {
          method: "PUT",
          body: JSON.stringify({
            supervisorId: ctx.supervisorId,
            workDate: ctx.date,
            employeeId: employeeIdVal,
            otHours: hours === 0 ? null : hours,
            jobOrderId: hours === 0 ? null : jobOrderId,
            remarks: row.remarks,
          }),
        });
      }
      const assigned = [
        slots.length ? `${slots.length} regular slot(s)` : "",
        row.otSelected ? (hours === 0 ? "OT cleared" : `${hours}h OT`) : "",
      ].filter(Boolean).join(" and ");
      setMessage(`${assigned} for ${row.employee.name}.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Assign failed");
      await reloadIfAnotherSupervisorWon(e);
    }
  }

  async function clearDraftSlot(employeeId: number, shiftSlot: ShiftSlot) {
    const row = rows.find((item) => item.employeeId === employeeId);
    const slot = row?.slots.find((item) => item.shiftSlot === shiftSlot);
    if (
      !row ||
      !slot ||
      slot.jobOrderId == null ||
      rowEditMode(row) === "locked" ||
      slot.locked ||
      slot.otherBookingSubmitted ||
      !isEditableForReassign(row.status)
    ) return;

    setError("");
    try {
      await api("/timesheet/entry", {
        method: "PUT",
        body: JSON.stringify({
          supervisorId: ctx.supervisorId,
          workDate: ctx.date,
          employeeId,
          shiftSlot,
          jobOrderId: null,
        }),
      });
      setMessage(`${SHIFT_LABELS[shiftSlot].short} allocation removed for ${row.employee.name}.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove allocation");
      if (e instanceof ApiError && (e.payload as { code?: string })?.code === "SLOT_ALREADY_BOOKED") {
        await load();
      }
    }
  }

  async function clearDraftOt(employeeId: number) {
    const row = rows.find((item) => item.employeeId === employeeId);
    if (
      !row ||
      row.otHours == null ||
      rowEditMode(row) === "locked" ||
      row.otLocked ||
      !isEditableForReassign(row.status)
    ) return;

    setError("");
    try {
      await api("/timesheet/ot", {
        method: "PUT",
        body: JSON.stringify({
          supervisorId: ctx.supervisorId,
          workDate: ctx.date,
          employeeId,
          otHours: null,
          jobOrderId: null,
        }),
      });
      setMessage(`OT allocation removed for ${row.employee.name}.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove OT allocation");
    }
  }

  async function clearSelectedDraftSlots(employeeId: number) {
    const row = rows.find((item) => item.employeeId === employeeId);
    if (!row || rowEditMode(row) === "locked") return;
    const selectedAssigned = row.slots.filter(
      (slot) =>
        row.selectedSlots.has(slot.shiftSlot) &&
        slot.jobOrderId != null &&
        !slot.locked &&
        !slot.otherBookingSubmitted &&
        isEditableForReassign(row.status)
    );
    if (!selectedAssigned.length) return;

    setError("");
    try {
      for (const slot of selectedAssigned) {
        await api("/timesheet/entry", {
          method: "PUT",
          body: JSON.stringify({
            supervisorId: ctx.supervisorId,
            workDate: ctx.date,
            employeeId,
            shiftSlot: slot.shiftSlot,
            jobOrderId: null,
          }),
        });
      }
      setMessage(`Removed ${selectedAssigned.length} draft allocation(s) for ${row.employee.name}.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove allocations");
      await reloadIfAnotherSupervisorWon(e);
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
        // Bulk Select All is intentionally limited to empty editable slots.
        // Assigned slots can still be selected one at a time for reassignment.
        const next = new Set<ShiftSlot>();
        for (const s of r.slots) {
          if (!s.locked && !s.bookedByOther && s.jobOrderId == null) next.add(s.shiftSlot);
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
      await reloadIfAnotherSupervisorWon(e);
    }
  }

  // --- Save Draft / Submit ---

  function buildPayload() {
    return {
      supervisorId: ctx.supervisorId,
      workDate: ctx.date,
      // Locked rows are read-only context, not save targets. Sending them made
      // an unrelated approved employee block a rejected employee's resubmission.
      rows: rows.filter((r) => rowEditMode(r) !== "locked").map((r) => ({
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
      await reloadIfAnotherSupervisorWon(e);
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
          code?: string;
          violations?: { employeeName: string; dayTotalHours: number }[];
        };
        if (payload?.code === "SLOT_ALREADY_BOOKED") {
          setError(e.message);
          await load();
        } else if (payload?.code === "MAX_DAILY_HOURS_REMARKS_REQUIRED" && payload.violations?.length) {
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
    if (!ctx.supervisorId || carryLoading) return;
    setError("");
    setCarryBanner("");
    setCarryLoading(true);
    try {
      const carried = await api<{
        sourceDate: string;
        rosterCopied: number;
        daysCopied: number;
        regularSlotsCopied: number;
        otRowsSkipped: number;
        closedJobOrderSlots: number;
        unsupportedLegacyEntries: number;
        conflictedSlots: number;
        lockedEmployeeIds: number[];
      }>("/timesheet/carry-forward", {
        method: "POST",
        body: JSON.stringify({
          supervisorId: ctx.supervisorId,
          workDate: ctx.date,
        }),
      });
      const warnings = [
        carried.closedJobOrderSlots > 0
          ? `${carried.closedJobOrderSlots} assignment(s) with closed Job Orders were skipped`
          : "",
        carried.unsupportedLegacyEntries > 0
          ? `${carried.unsupportedLegacyEntries} legacy assignment(s) could not be mapped to the current shift grid`
          : "",
        carried.conflictedSlots > 0
          ? `${carried.conflictedSlots} slot(s) already booked by another supervisor were skipped`
          : "",
        carried.lockedEmployeeIds.length > 0
          ? `${carried.lockedEmployeeIds.length} locked current-day sheet(s) were not changed`
          : "",
      ].filter(Boolean);
      setCarryBanner(
        `Copied ${carried.regularSlotsCopied} regular slot(s) from ${carried.sourceDate} as Draft. ` +
          `OT was left unassigned for manual entry.${warnings.length ? ` ${warnings.join("; ")}.` : ""}`
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Carry-over failed");
    } finally {
      setCarryLoading(false);
    }
  }

  const addMatches = poolCandidates.filter(
    (e) =>
      addQuery.trim() &&
      (e.name.toLowerCase().includes(addQuery.toLowerCase()) || String(e.id).includes(addQuery))
  );

  const eligibleBulkSlots = rows.flatMap((r) =>
    rowEditMode(r) === "locked"
      ? []
      : r.slots
          .filter((s) => !s.locked && !s.bookedByOther && s.jobOrderId == null)
          .map((s) => ({ employeeId: r.employeeId, shiftSlot: s.shiftSlot }))
  );
  const allEligibleBulkSlotsSelected =
    eligibleBulkSlots.length > 0 &&
    eligibleBulkSlots.every(({ employeeId, shiftSlot }) =>
      rows.find((r) => r.employeeId === employeeId)?.selectedSlots.has(shiftSlot)
    );

  return (
    <>
      <FilterBar
        {...ctx}
        departmentLabel="Section"
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
      {user?.role === "SUPERVISOR" && isOwner && (
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
                checked={allEligibleBulkSlotsSelected}
                onChange={(e) => (e.target.checked ? selectAllUnassigned() : clearAllSelection())}
                disabled={eligibleBulkSlots.length === 0}
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
            <button
              type="button"
              className="btn btn-secondary"
              onClick={selectFromPreviousDay}
              disabled={carryLoading}
            >
              {carryLoading ? "Copying Previous Day…" : "Select from Previous Day"}
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
              <th colSpan={2} className="ot-col">Overtime</th>
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
              <th className="ot-col sub">Slot</th>
              <th className="ot-hours-col sub">Hrs</th>
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
              const otRemarksRequired =
                Boolean(r.remarksRequired) || (r.otSelected && Number(r.otHoursInput) > 0);
              const otAvailable = r.employee.employmentType === "CLMS";
              const otOnly = filledCount === 0 && (r.otHours ?? 0) > 0;
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
                      {r.isSelf && <span className="badge self-badge">You</span>}
                    </div>
                    <div className={`emp-status-chip status-${r.status.toLowerCase()}`}>
                      {statusLabel(r.status)}
                    </div>
                    {r.fullShiftDone && (
                      <div className="emp-status-chip status-assigned">✓ Assigned</div>
                    )}
                    <div className="emp-hours-meta">
                      {otOnly ? `OT ${r.otHours}h today · 0 overhead` : `${filledCount}/4 today`}
                      {r.exceedsLimit ? ` · over ${maxDailyHours}h limit` : ""}
                    </div>
                    <div className="emp-actions">
                      {!r.isSelf && (
                        <button
                          type="button"
                          onClick={() => removeEmployee(r.employeeId)}
                          disabled={!isOwner || isApprovedDayStatus(r.status)}
                          title={
                            !isOwner
                              ? "Read-only — you are viewing another supervisor's timesheet."
                              : isApprovedDayStatus(r.status)
                                ? "Cannot remove — this day is HOD/Project Head approved."
                                : undefined
                          }
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  </td>
                  <td className="fullshift-col">
                    <label className="fullshift-check">
                      <input
                        type="checkbox"
                        checked={r.fullShiftDone}
                        disabled={!isOwner || isLocked || (r.fullShiftDone && !isEditableForReassign(r.status))}
                        onChange={() => toggleFullShift(r.employeeId)}
                        aria-label="Full Shift (select all 4 slots)"
                      />
                    </label>
                  </td>
                  {r.slots.map((s) => {
                    const selected = r.selectedSlots.has(s.shiftSlot);
                    const colorKey = s.projectColorKey;
                    const slotLocked = isLocked || s.locked || Boolean(s.otherBookingSubmitted);
                    let cls = "slot-cell";
                    let label = "";
                    if (selected) {
                      cls += " selected";
                      label = "✓";
                    } else if (s.jobOrderId != null) {
                      cls += ` assigned-${(colorKey || "n").toLowerCase()}`;
                      label = (colorKey || "•").toUpperCase();
                    } else if (s.bookedByOther) {
                      cls += ` booked-other assigned-${(s.otherProjectColorKey || "n").toLowerCase()}`;
                      label = (s.otherProjectColorKey || "•").toUpperCase();
                    }
                    if (s.bookedByOther && s.jobOrderId != null) cls += " slot-cell--conflict";
                    if (s.otherBookingSubmitted) cls += " booked-other--submitted";
                    if (slotLocked) cls += " slot-cell--locked";
                    return (
                      <td key={s.shiftSlot} className="slot-td">
                        <button
                          type="button"
                          className={cls}
                          disabled={!isOwner || slotLocked || (s.jobOrderId != null && !isEditableForReassign(r.status))}
                          onClick={() => toggleSlotSelection(r.employeeId, s.shiftSlot)}
                          onDoubleClick={() => clearDraftSlot(r.employeeId, s.shiftSlot)}
                          aria-label={SHIFT_LABELS[s.shiftSlot].long}
                          title={
                            s.bookedByOther
                              ? `${SHIFT_LABELS[s.shiftSlot].long} · Allocated by Supervisor ${s.bookedBySupervisorNames?.join(" & ")}`
                              : SHIFT_LABELS[s.shiftSlot].long
                          }
                        >
                          {label}
                        </button>
                      </td>
                    );
                  })}
                  <td className="ot-col">
                    <button
                      type="button"
                      className={`slot-cell ot-slot ${
                        r.otSelected
                          ? "selected"
                          : r.otHours != null
                            ? `assigned-${(r.otProjectColorKey || "n").toLowerCase()}`
                            : ""
                      } ${r.otBookedByOther ? "booked-other booked-other--submitted" : ""} ${r.otLocked ? "slot-cell--locked" : ""}`.trim()}
                      disabled={!isOwner || !otAvailable || isLocked || r.otLocked}
                      onClick={() => toggleOtSelection(r.employeeId)}
                      onDoubleClick={() => clearDraftOt(r.employeeId)}
                      title={
                        r.otBookedByOther
                          ? `OT ${r.otHours ?? 0}h booked by Supervisor ${(r.otBookedBySupervisorNames ?? []).join(", ")} (${r.otOtherBookingStatus ?? "submitted"}) — read only`
                          : r.otHours != null
                            ? `OT ${r.otHours}h — click to select; double-click to remove`
                            : otAvailable
                              ? "Select OT for assignment"
                              : "OT is not applicable to Payroll Employees"
                      }
                    >
                      {r.otSelected ? "✓" : r.otHours != null ? (r.otProjectColorKey || "OT").toUpperCase() : ""}
                    </button>
                  </td>
                  <td className="ot-hours-col">
                    <input
                      className="ot-hours-input"
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={12}
                      step={1}
                      value={r.otHoursInput}
                      disabled={!isOwner || !otAvailable || isLocked || r.otLocked || !r.otSelected}
                      onChange={(e) => setOtHoursInput(r.employeeId, e.target.value)}
                      aria-label={`OT hours for ${r.employee.name}`}
                      title="Whole OT hours from 1 to 12; enter 0 to clear existing OT"
                    />
                  </td>
                  <td>
                    <select
                      className="project-select"
                      value={r.projectId}
                      disabled={!isOwner || isLocked}
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
                      disabled={!isOwner || isLocked || !r.projectId}
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
                      className={`assign-btn ${r.selectedSlots.size === 0 && !r.otSelected ? "is-idle" : r.fullShiftDone ? "is-done" : "is-ready"}`}
                      disabled={
                        !isOwner ||
                        isLocked ||
                        (r.selectedSlots.size === 0 && !r.otSelected) ||
                        (!r.jobOrderId && !(r.otSelected && Number(r.otHoursInput) === 0 && r.otHours != null))
                      }
                      onClick={() => assignRowToSelected(r.employeeId)}
                    >
                      Assign
                    </button>
                  </td>
                  <td>
                    <input
                      className={`remarks-input ${otRemarksRequired && !r.remarks.trim() ? "remarks-input--required" : ""}`}
                      value={r.remarks}
                      disabled={!isOwner || isLocked}
                      placeholder={otRemarksRequired ? "Remarks required for OT…" : "Add note…"}
                      required={otRemarksRequired}
                      aria-required={otRemarksRequired}
                      onChange={(e) => setRemarks(r.employeeId, e.target.value)}
                    />
                  </td>
                </tr>
                {expanded && r.returnFeedback && (
                  <tr className="row-feedback">
                    <td colSpan={12}>
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
              <td colSpan={12}>
                <div className="add-dropdown">
                  <input
                    className="add-emp-input"
                    placeholder="+ Add employee… (search department roster)"
                    value={addQuery}
                    disabled={!isOwner}
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
          const otRemarksRequired =
            Boolean(r.remarksRequired) || (r.otSelected && Number(r.otHoursInput) > 0);
          const otAvailable = r.employee.employmentType === "CLMS";
          const otOnly = filledCount === 0 && (r.otHours ?? 0) > 0;
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
                  <div className="emp-name">
                    {fullName(r.employee.name)}
                    {r.isSelf && <span className="badge self-badge">You</span>}
                  </div>
                  <div className={`emp-status-chip status-${r.status.toLowerCase()}`}>
                    {statusLabel(r.status)}
                  </div>
                  {r.fullShiftDone && (
                    <div className="emp-status-chip status-assigned">✓ Assigned</div>
                  )}
                  <div className="emp-hours-meta">
                    {otOnly ? `OT ${r.otHours}h today · 0 overhead` : `${filledCount}/4 today`}
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
                  const slotLocked = isLocked || s.locked || Boolean(s.otherBookingSubmitted);
                  let cls = "ts-shift-chip";
                  let label = "";
                  if (selected) {
                    cls += " selected";
                    label = "✓";
                  } else if (s.jobOrderId != null) {
                    cls += ` assigned-${(colorKey || "n").toLowerCase()}`;
                    label = (colorKey || "•").toUpperCase();
                  } else if (s.bookedByOther) {
                    cls += ` booked-other assigned-${(s.otherProjectColorKey || "n").toLowerCase()}`;
                    label = (s.otherProjectColorKey || "•").toUpperCase();
                  }
                  if (s.bookedByOther && s.jobOrderId != null) cls += " slot-cell--conflict";
                  if (s.otherBookingSubmitted) cls += " booked-other--submitted";
                  if (slotLocked) cls += " slot-cell--locked";
                  return (
                    <button
                      key={s.shiftSlot}
                      type="button"
                      className={cls}
                      disabled={!isOwner || slotLocked || (s.jobOrderId != null && !isEditableForReassign(r.status))}
                      onClick={() => toggleSlotSelection(r.employeeId, s.shiftSlot)}
                      onDoubleClick={() => clearDraftSlot(r.employeeId, s.shiftSlot)}
                      aria-label={SHIFT_LABELS[s.shiftSlot].long}
                      title={
                        s.bookedByOther
                          ? `${SHIFT_LABELS[s.shiftSlot].long} · Allocated by Supervisor ${s.bookedBySupervisorNames?.join(" & ")}`
                          : SHIFT_LABELS[s.shiftSlot].long
                      }
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
                <span className="muted tiny">Overtime</span>
                <button
                  type="button"
                  className={`slot-cell ot-slot ${
                    r.otSelected
                      ? "selected"
                      : r.otHours != null
                        ? `assigned-${(r.otProjectColorKey || "n").toLowerCase()}`
                        : ""
                  } ${r.otBookedByOther ? "booked-other booked-other--submitted" : ""} ${r.otLocked ? "slot-cell--locked" : ""}`.trim()}
                  disabled={!isOwner || !otAvailable || isLocked || r.otLocked}
                  onClick={() => toggleOtSelection(r.employeeId)}
                  onDoubleClick={() => clearDraftOt(r.employeeId)}
                  title={
                    r.otBookedByOther
                      ? `OT ${r.otHours ?? 0}h booked by Supervisor ${(r.otBookedBySupervisorNames ?? []).join(", ")} (${r.otOtherBookingStatus ?? "submitted"}) — read only`
                      : r.otHours != null
                        ? `OT ${r.otHours}h — click to select; double-click to remove`
                        : otAvailable
                          ? "Select OT for assignment"
                          : "OT is not applicable to Payroll Employees"
                  }
                >
                  {r.otSelected ? "✓" : r.otHours != null ? (r.otProjectColorKey || "OT").toUpperCase() : ""}
                </button>
                <label className="ts-ot__hours">
                  <span>Hrs</span>
                  <input
                    className="ot-hours-input"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={12}
                    step={1}
                    value={r.otHoursInput}
                    disabled={!isOwner || !otAvailable || isLocked || r.otLocked || !r.otSelected}
                    onChange={(e) => setOtHoursInput(r.employeeId, e.target.value)}
                    aria-label={`OT hours for ${r.employee.name}`}
                  />
                </label>
              </div>
              <div className="ts-alloc">
                <label className="ts-field">
                  <span>Project</span>
                  <select
                    className="project-select"
                    value={r.projectId}
                    disabled={!isOwner || isLocked}
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
                    disabled={!isOwner || isLocked || !r.projectId}
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
                {r.slots.some(
                  (slot) => r.selectedSlots.has(slot.shiftSlot) && slot.jobOrderId != null && !slot.locked
                ) && (
                  <button
                    type="button"
                    className="btn btn-ghost ts-clear-selected"
                    disabled={!isOwner || isLocked}
                    onClick={() => clearSelectedDraftSlots(r.employeeId)}
                  >
                    Clear selected
                  </button>
                )}
                <button
                  type="button"
                  className="assign-btn"
                  disabled={
                    !isOwner ||
                    isLocked ||
                    (r.selectedSlots.size === 0 && !r.otSelected) ||
                    (!r.jobOrderId && !(r.otSelected && Number(r.otHoursInput) === 0 && r.otHours != null))
                  }
                  onClick={() => assignRowToSelected(r.employeeId)}
                >
                  Assign
                </button>
              </div>
              <label className="ts-field ts-field--full">
                <span>Remarks</span>
                <input
                  className={`remarks-input ${otRemarksRequired && !r.remarks.trim() ? "remarks-input--required" : ""}`}
                  value={r.remarks}
                  disabled={!isOwner || isLocked}
                  placeholder={otRemarksRequired ? "Remarks required for OT…" : "Add note…"}
                  required={otRemarksRequired}
                  aria-required={otRemarksRequired}
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
              disabled={!isOwner}
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
          <span className="legend-item">
            <span className="legend-swatch other-booking-swatch">↗</span>
            Allocated by another supervisor
          </span>
        </div>
        <p className="help-text">
          Bulk Assignment applies the chosen Project + Job Order to all amber (selected) slots in
          one click. The 4 slots per day are 1st Half (9a–11a, 11a–1p) and 2nd Half (2p–4p, 4p–6p).
          Full Shift selects all 4 empty slots for that employee; it freezes once the row is fully
          assigned. Click any cell to toggle its selection. Double-click a draft allocation to clear it.
          Max {maxDailyHours}h/day; overtime requires a Project, WBS / Job Order, and Remarks reason.
          On a holiday, OT may be assigned without selecting regular slots; that day has zero overhead.
        </p>
      </div>

      <div className="footer-actions">
        <button className="btn btn-secondary" onClick={saveDraft} disabled={!isOwner}>
          Save Draft
        </button>
        <button className="btn btn-primary" onClick={submit} disabled={!isOwner}>
          Submit for Approval
        </button>
      </div>

    </>
  );
}
