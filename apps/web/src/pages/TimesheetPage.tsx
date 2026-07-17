import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { HOUR_LABELS, HOUR_SLOTS } from "@workforce/shared";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { FilterBar, useWorkContext } from "../hooks/useWorkContext";
import "../styles/timesheet.css";

type Project = { id: number; name: string; wbsCode: string; colorKey: string; code: string };
type ShiftOption = { name: string; start: string; end: string; hourSlots: number[] };
type HourCell = {
  hourSlot: number;
  projectWbsId: number | null;
  project: { id: number; name: string; wbsCode: string; colorKey: string } | null;
  locked?: boolean;
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
  hours: HourCell[];
  filledHours: number;
  otherHours?: number;
  otherSlots?: number[];
  dayTotalHours?: number;
  exceedsLimit?: boolean;
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
  selectedSlots: Set<number>;
  projectId: number | "";
  editMode: EditMode;
};

function rowEditMode(r: { editMode?: EditMode }): EditMode {
  return r.editMode ?? "full";
}

function isApprovedDayStatus(status: string) {
  return status === "HOD_APPROVED" || status === "PM_APPROVED";
}

/** Distinct union of other supervisors' slots + this supervisor's current grid. */
function rowDayTotal(r: { hours: HourCell[]; otherSlots?: number[] }) {
  const localSlots = r.hours.filter((h) => h.projectWbsId != null).map((h) => h.hourSlot);
  return new Set([...(r.otherSlots ?? []), ...localSlots]).size;
}

function rowIsOverLimit(
  r: { hours: HourCell[]; otherSlots?: number[] },
  maxDailyHours: number
) {
  const localHours = r.hours.filter((h) => h.projectWbsId != null).length;
  if (localHours === 0) return false;
  return rowDayTotal(r) > maxDailyHours;
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

export function TimesheetPage() {
  const ctx = useWorkContext();
  const { user } = useAuth();
  const [params] = useSearchParams();
  const [rows, setRows] = useState<LocalRow[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [shifts, setShifts] = useState<ShiftOption[]>([]);
  const [bulkShiftName, setBulkShiftName] = useState("");
  const [bulkProjectId, setBulkProjectId] = useState<number | "">("");
  const [poolCandidates, setPoolCandidates] = useState<{ id: number; name: string }[]>([]);
  const [addQuery, setAddQuery] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [maxDailyHours, setMaxDailyHours] = useState(8);
  const [openReturns, setOpenReturns] = useState<OpenReturn[]>([]);

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
        projects: Project[];
        filled: number;
        total: number;
        maxDailyHours: number;
        shifts?: ShiftOption[];
        openReturns?: OpenReturn[];
      }>(`/timesheet?supervisor_id=${ctx.supervisorId}&date=${ctx.date}`);
      setProjects(data.projects);
      setMaxDailyHours(data.maxDailyHours ?? 8);
      setOpenReturns(data.openReturns ?? []);
      const nextShifts = data.shifts?.length
        ? data.shifts
        : [{ name: "GENERAL", start: "09:00", end: "17:00", hourSlots: [1, 2, 3, 4, 5, 6, 7, 8] }];
      setShifts(nextShifts);
      setBulkShiftName((prev) =>
        prev && nextShifts.some((s) => s.name === prev) ? prev : nextShifts[0]?.name || ""
      );
      setBulkProjectId((prev) => {
        if (prev && data.projects.some((p) => p.id === prev)) return prev;
        return data.projects[0]?.id ?? "";
      });
      setRows(
        data.rows.map((r) => {
          const assignedIds = r.hours.map((h) => h.projectWbsId).filter(Boolean) as number[];
          const dominant = assignedIds[0] || "";
          return {
            ...r,
            editMode: r.editMode ?? "full",
            selectedSlots: new Set<number>(),
            projectId: dominant,
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

  const filled = useMemo(() => rows.filter((r) => r.hours.some((h) => h.projectWbsId)).length, [rows]);

  const overtimeRows = useMemo(() => {
    return rows.filter((r) => rowIsOverLimit(r, maxDailyHours));
  }, [rows, maxDailyHours]);

  const clientWarnings = useMemo(() => {
    return overtimeRows.map((r) => {
      const total = rowDayTotal(r);
      const hasRemark = Boolean(r.remarks.trim());
      return {
        name: r.employee.name,
        total,
        hasRemark,
      };
    });
  }, [overtimeRows]);

  function toggleSlot(employeeId: number, slot: number) {
    setRows((prev) =>
      prev.map((r) => {
        if (r.employeeId !== employeeId) return r;
        const mode = rowEditMode(r);
        if (mode === "locked") return r;
        const cell = r.hours.find((h) => h.hourSlot === slot);
        if (cell?.locked) return r;
        // After approval: only empty slots may be selected for add-only fills
        if (mode === "addOnly" && cell?.projectWbsId != null && isApprovedDayStatus(r.status)) return r;
        const next = new Set(r.selectedSlots);
        if (next.has(slot)) next.delete(slot);
        else next.add(slot);
        return { ...r, selectedSlots: next };
      })
    );
  }

  function setProject(employeeId: number, projectId: number | "") {
    setRows((prev) =>
      prev.map((r) => {
        if (r.employeeId !== employeeId) return r;
        if (rowEditMode(r) === "locked") return r;
        return { ...r, projectId };
      })
    );
  }

  function setRemarks(employeeId: number, remarks: string) {
    setRows((prev) =>
      prev.map((r) => {
        if (r.employeeId !== employeeId) return r;
        if (rowEditMode(r) === "locked") return r;
        return { ...r, remarks };
      })
    );
  }

  function assignRow(employeeId: number) {
    setRows((prev) =>
      prev.map((r) => {
        if (r.employeeId !== employeeId) return r;
        const mode = rowEditMode(r);
        if (mode === "locked") return r;
        if (!r.projectId || r.selectedSlots.size === 0) return r;
        const project = projects.find((p) => p.id === r.projectId);
        if (!project) return r;
        const hours = r.hours.map((h) => {
          if (!r.selectedSlots.has(h.hourSlot)) return h;
          if (h.locked) return h;
          if (mode === "addOnly" && h.projectWbsId != null && isApprovedDayStatus(r.status)) return h;
          return {
            hourSlot: h.hourSlot,
            projectWbsId: project.id,
            project: {
              id: project.id,
              name: project.name,
              wbsCode: project.wbsCode,
              colorKey: project.colorKey,
            },
            locked: false,
          };
        });
        return { ...r, hours, selectedSlots: new Set() };
      })
    );
  }

  function clearRowHours(employeeId: number) {
    setRows((prev) =>
      prev.map((r) => {
        if (r.employeeId !== employeeId) return r;
        if (rowEditMode(r) !== "full") return r;
        return {
          ...r,
          projectId: "" as const,
          selectedSlots: new Set<number>(),
          hours: r.hours.map((h) => ({
            hourSlot: h.hourSlot,
            projectWbsId: null,
            project: null,
          })),
        };
      })
    );
  }

  function applyBulkToAll() {
    const shift = shifts.find((s) => s.name === bulkShiftName);
    const project = projects.find((p) => p.id === bulkProjectId);
    if (!shift || !project) {
      setError("Select a shift and project before applying.");
      return;
    }
    setError("");

    const anyTicks = rows.some((r) => r.selectedSlots.size > 0 && rowEditMode(r) !== "locked");

    if (anyTicks) {
      let taggedEmployees = 0;
      let taggedSlots = 0;
      const nextRows = rows.map((r) => {
        const mode = rowEditMode(r);
        if (mode === "locked" || r.selectedSlots.size === 0) return r;
        taggedEmployees += 1;
        const hours = r.hours.map((h) => {
          if (!r.selectedSlots.has(h.hourSlot)) return h;
          if (h.locked) return h;
          if (mode === "addOnly" && h.projectWbsId != null && isApprovedDayStatus(r.status)) return h;
          taggedSlots += 1;
          return {
            hourSlot: h.hourSlot,
            projectWbsId: project.id,
            project: {
              id: project.id,
              name: project.name,
              wbsCode: project.wbsCode,
              colorKey: project.colorKey,
            },
          };
        });
        return { ...r, projectId: project.id, hours, selectedSlots: new Set<number>() };
      });
      setRows(nextRows);
      setMessage(
        `Assigned ${project.name} to ${taggedSlots} selected hour slot(s) across ${taggedEmployees} employee(s). Existing tags left unchanged. Save Draft or Submit when ready.`
      );
      return;
    }

    // No ticks: fill all editable employees with the shift window (overwrite for full-edit rows only)
    const slotSet = new Set(shift.hourSlots);
    let applied = 0;
    const nextRows = rows.map((r) => {
      const mode = rowEditMode(r);
      if (mode === "locked") return r;
      if (mode === "addOnly") {
        applied += 1;
        return {
          ...r,
          projectId: project.id,
          selectedSlots: new Set<number>(),
          hours: r.hours.map((h) => {
            if (h.projectWbsId != null) return h;
            if (!slotSet.has(h.hourSlot)) return h;
            return {
              hourSlot: h.hourSlot,
              projectWbsId: project.id,
              project: {
                id: project.id,
                name: project.name,
                wbsCode: project.wbsCode,
                colorKey: project.colorKey,
              },
            };
          }),
        };
      }
      applied += 1;
      return {
        ...r,
        projectId: project.id,
        selectedSlots: new Set<number>(),
        hours: r.hours.map((h) => {
          if (!slotSet.has(h.hourSlot)) {
            return { hourSlot: h.hourSlot, projectWbsId: null, project: null };
          }
          return {
            hourSlot: h.hourSlot,
            projectWbsId: project.id,
            project: {
              id: project.id,
              name: project.name,
              wbsCode: project.wbsCode,
              colorKey: project.colorKey,
            },
          };
        }),
      };
    });
    setRows(nextRows);
    setMessage(
      `Applied ${shift.name} (${shift.hourSlots.length}h, ${shift.start}–${shift.end}) to ${applied} employee(s) on ${project.name}. Save Draft or Submit when ready.`
    );
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

  function buildPayload() {
    return {
      supervisorId: ctx.supervisorId,
      workDate: ctx.date,
      rows: rows.map((r) => ({
        employeeId: r.employeeId,
        remarks: r.remarks,
        hours: r.hours.map((h) => ({
          hourSlot: h.hourSlot,
          projectWbsId: h.projectWbsId,
        })),
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

    const missingRemarks = clientWarnings.filter((w) => !w.hasRemark);
    if (missingRemarks.length) {
      setError(
        `Daily limit is ${maxDailyHours}h. Enter a mandatory overtime reason in Remarks for: ${missingRemarks
          .map((w) => `${w.name} (${w.total}h)`)
          .join(", ")}`
      );
      return;
    }

    if (clientWarnings.length) {
      setWarning(
        `Warning: ${clientWarnings
          .map((w) => `${w.name} has ${w.total}h (limit ${maxDailyHours}h)`)
          .join("; ")}. Remarks will be visible to HOD on approval.`
      );
    }

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

  function assignState(r: LocalRow): "disabled" | "assign" | "warn" | "done" {
    if (rowEditMode(r) === "locked") return "disabled";
    const hasAssigned = r.hours.some((h) => h.projectWbsId);
    const hasSelected = r.selectedSlots.size > 0;
    if (hasSelected && !r.projectId) return "warn";
    if (hasSelected && r.projectId) return "assign";
    if (hasAssigned && !hasSelected) return "done";
    return "disabled";
  }

  function lockHint(r: LocalRow): string | null {
    const mode = rowEditMode(r);
    if (mode === "locked") {
      return "Approved — fully locked (24h add window expired). Only HOD/Project Head reject unlocks editing.";
    }
    if (mode === "addOnly") {
      return "Approved — within 24h you may fill empty slots only; saved slots cannot be changed.";
    }
    return null;
  }

  const addMatches = poolCandidates.filter(
    (e) =>
      addQuery.trim() &&
      (e.name.toLowerCase().includes(addQuery.toLowerCase()) || String(e.id).includes(addQuery))
  );

  const anyTicks = rows.some((r) => r.selectedSlots.size > 0 && rowEditMode(r) !== "locked");

  const bulkFillControls =
    user?.role === "SUPERVISOR" ? (
      <div className="bulk-fill">
        <div className="filter-field">
          <label>Shift</label>
          <select value={bulkShiftName} onChange={(e) => setBulkShiftName(e.target.value)}>
            {shifts.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name} ({s.start}–{s.end})
              </option>
            ))}
          </select>
        </div>
        <div className="filter-field">
          <label>Project</label>
          <select
            value={bulkProjectId}
            onChange={(e) => setBulkProjectId(e.target.value ? Number(e.target.value) : "")}
          >
            <option value="">Select...</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="filter-field bulk-fill__apply">
          <label className="bulk-fill__apply-label">&nbsp;</label>
          <button
            type="button"
            className="btn btn-secondary bulk-fill__btn"
            disabled={!bulkShiftName || !bulkProjectId || rows.length === 0}
            onClick={applyBulkToAll}
          >
            {anyTicks ? "Apply project to selected" : "Apply 8h to all"}
          </button>
        </div>
      </div>
    ) : undefined;

  return (
    <>
      <FilterBar
        {...ctx}
        bulkFill={bulkFillControls}
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
      {openReturns.length > 0 && (
        <div className="returns-panel">
          <div className="returns-panel__title">
            Sent back for correction ({openReturns.length})
          </div>
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

      <div className="timesheet-wrap ts-desktop-only">
        <table className="timesheet-table">
          <thead>
            <tr>
              <th className="emp-col">Employee</th>
              {HOUR_SLOTS.map((s) => (
                <th key={s}>{HOUR_LABELS[s]}</th>
              ))}
              <th>Project</th>
              <th>WBS</th>
              <th>Assign</th>
              <th>Remarks</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const project = projects.find((p) => p.id === r.projectId);
              const state = assignState(r);
              const localHours = r.hours.filter((h) => h.projectWbsId != null).length;
              const total = rowDayTotal(r);
              const over = rowIsOverLimit(r, maxDailyHours);
              const remarksMissing = over && !r.remarks.trim();
              const otherHours = (r.otherSlots ?? []).length;
              const isRejected = r.status === "REJECTED";
              const mode = rowEditMode(r);
              const hint = lockHint(r);
              const rowLocked = mode === "locked";
              return (
                <tr
                  key={r.employeeId}
                  className={`${over ? "row-over-limit" : ""} ${isRejected ? "row-rejected" : ""} ${
                    rowLocked ? "row-locked" : mode === "addOnly" ? "row-add-only" : ""
                  }`.trim()}
                >
                  <td className="emp-col">
                    <div className="emp-name">{r.employee.name}</div>
                    <div className={`emp-status-chip status-${r.status.toLowerCase()}`}>
                      {statusLabel(r.status)}
                    </div>
                    {mode !== "full" && (
                      <div className={`emp-status-chip status-edit-${mode}`}>
                        {mode === "locked" ? "Locked" : "Add empty only"}
                      </div>
                    )}
                    <div className="emp-hours-meta">
                      {total}h today
                      {otherHours > 0 ? ` (${localHours}h this sheet)` : ""}
                      {over ? ` · over ${maxDailyHours}h limit` : ""}
                    </div>
                    {hint && <div className="lock-hint">{hint}</div>}
                    {isRejected && r.returnFeedback && (
                      <div className="return-feedback">
                        <div className="return-feedback__label">
                          Feedback from {r.returnFeedback.by}
                          {r.returnFeedback.role === "PM" ? " (Project Head)" : r.returnFeedback.role === "HOD" ? " (HOD)" : ""}
                        </div>
                        <div className="return-feedback__text">
                          {r.returnFeedback.comment || "Correct and resubmit."}
                        </div>
                      </div>
                    )}
                    <div className="emp-actions">
                      <button
                        type="button"
                        disabled={mode !== "full"}
                        onClick={() => clearRowHours(r.employeeId)}
                      >
                        Clear
                      </button>
                      <button type="button" onClick={() => removeEmployee(r.employeeId)}>
                        Remove
                      </button>
                    </div>
                  </td>
                  {r.hours.map((h) => {
                    const selected = r.selectedSlots.has(h.hourSlot);
                    const color = h.project?.colorKey;
                    const slotLocked =
                      rowLocked || Boolean(h.locked) || (mode === "addOnly" && isApprovedDayStatus(r.status) && h.projectWbsId != null);
                    let cls = "hour-cell";
                    let label = "";
                    if (selected) {
                      cls += " selected";
                      label = "✓";
                    } else if (color) {
                      cls += ` assigned-${color}`;
                      label = color;
                    }
                    if (slotLocked) cls += " hour-cell--locked";
                    return (
                      <td key={h.hourSlot}>
                        <button
                          type="button"
                          className={cls}
                          disabled={slotLocked}
                          onClick={() => toggleSlot(r.employeeId, h.hourSlot)}
                          aria-label={`Hour ${HOUR_LABELS[h.hourSlot as 0]}`}
                        >
                          {label}
                        </button>
                      </td>
                    );
                  })}
                  <td>
                    <select
                      className="project-select"
                      value={r.projectId}
                      disabled={rowLocked}
                      onChange={(e) =>
                        setProject(r.employeeId, e.target.value ? Number(e.target.value) : "")
                      }
                    >
                      <option value="">Select...</option>
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input className="wbs-field" readOnly value={project?.wbsCode || ""} placeholder="—" />
                  </td>
                  <td>
                    <button
                      type="button"
                      className={`assign-btn ${state === "done" ? "done" : state === "warn" ? "warn" : ""}`}
                      disabled={rowLocked || state === "disabled" || state === "done"}
                      onClick={() => assignRow(r.employeeId)}
                    >
                      {state === "done"
                        ? "Assigned ✓"
                        : state === "warn"
                          ? "Assign ⚠"
                          : "Assign"}
                    </button>
                  </td>
                  <td>
                    <input
                      className={`remarks-input ${remarksMissing ? "remarks-required" : ""} ${over ? "remarks-ot" : ""}`}
                      value={r.remarks}
                      disabled={rowLocked}
                      placeholder={over ? "Mandatory OT reason for HOD…" : "Add note..."}
                      onChange={(e) => setRemarks(r.employeeId, e.target.value)}
                      required={over}
                    />
                    {remarksMissing && (
                      <div className="remarks-hint">Reason required before submit</div>
                    )}
                  </td>
                </tr>
              );
            })}
            <tr className="add-emp-row">
              <td colSpan={18}>
                <div className="add-dropdown">
                  <input
                    className="add-emp-input"
                    placeholder="+ Add employee... (search department roster)"
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

      {/* Phone: per-employee cards with hour chips */}
      <div className="ts-cards ts-mobile-only">
        {rows.map((r) => {
          const project = projects.find((p) => p.id === r.projectId);
          const state = assignState(r);
          const localHours = r.hours.filter((h) => h.projectWbsId != null).length;
          const total = rowDayTotal(r);
          const over = rowIsOverLimit(r, maxDailyHours);
          const remarksMissing = over && !r.remarks.trim();
          const otherHours = (r.otherSlots ?? []).length;
          const isRejected = r.status === "REJECTED";
          const mode = rowEditMode(r);
          const hint = lockHint(r);
          const rowLocked = mode === "locked";
          return (
            <article
              key={r.employeeId}
              className={`ts-card ${over ? "row-over-limit" : ""} ${isRejected ? "row-rejected" : ""} ${
                rowLocked ? "row-locked" : mode === "addOnly" ? "row-add-only" : ""
              }`.trim()}
            >
              <header className="ts-card__head">
                <div>
                  <div className="emp-name">{r.employee.name}</div>
                  <div className={`emp-status-chip status-${r.status.toLowerCase()}`}>
                    {statusLabel(r.status)}
                  </div>
                  {mode !== "full" && (
                    <div className={`emp-status-chip status-edit-${mode}`}>
                      {mode === "locked" ? "Locked" : "Add empty only"}
                    </div>
                  )}
                  <div className="emp-hours-meta">
                    {total}h today
                    {otherHours > 0 ? ` (${localHours}h this sheet)` : ""}
                    {over ? ` · over ${maxDailyHours}h limit` : ""}
                  </div>
                  {hint && <div className="lock-hint">{hint}</div>}
                </div>
                <div className="emp-actions">
                  <button
                    type="button"
                    disabled={mode !== "full"}
                    onClick={() => clearRowHours(r.employeeId)}
                  >
                    Clear
                  </button>
                  <button type="button" onClick={() => removeEmployee(r.employeeId)}>
                    Remove
                  </button>
                </div>
              </header>
              {isRejected && r.returnFeedback && (
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
              <div className="ts-hour-grid" role="group" aria-label="Hour slots">
                {r.hours.map((h) => {
                  const selected = r.selectedSlots.has(h.hourSlot);
                  const color = h.project?.colorKey;
                  const slotLocked =
                    rowLocked ||
                    Boolean(h.locked) ||
                    (mode === "addOnly" && isApprovedDayStatus(r.status) && h.projectWbsId != null);
                  let cls = "hour-cell ts-hour-chip";
                  let label = "";
                  if (selected) {
                    cls += " selected";
                    label = "✓";
                  } else if (color) {
                    cls += ` assigned-${color}`;
                    label = color;
                  }
                  if (slotLocked) cls += " hour-cell--locked";
                  return (
                    <button
                      key={h.hourSlot}
                      type="button"
                      className={cls}
                      disabled={slotLocked}
                      onClick={() => toggleSlot(r.employeeId, h.hourSlot)}
                      aria-label={`Hour ${HOUR_LABELS[h.hourSlot as 0]}`}
                    >
                      <span className="ts-hour-chip__label">{HOUR_LABELS[h.hourSlot as 0]}</span>
                      <span className="ts-hour-chip__value">{label || "·"}</span>
                    </button>
                  );
                })}
              </div>
              <div className="ts-card__controls">
                <label className="ts-field">
                  <span>Project</span>
                  <select
                    className="project-select"
                    value={r.projectId}
                    disabled={rowLocked}
                    onChange={(e) =>
                      setProject(r.employeeId, e.target.value ? Number(e.target.value) : "")
                    }
                  >
                    <option value="">Select...</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="ts-field">
                  <span>WBS</span>
                  <input className="wbs-field" readOnly value={project?.wbsCode || ""} placeholder="—" />
                </label>
                <button
                  type="button"
                  className={`assign-btn ${state === "done" ? "done" : state === "warn" ? "warn" : ""}`}
                  disabled={rowLocked || state === "disabled" || state === "done"}
                  onClick={() => assignRow(r.employeeId)}
                >
                  {state === "done" ? "Assigned ✓" : state === "warn" ? "Assign ⚠" : "Assign"}
                </button>
              </div>
              <label className="ts-field ts-field--full">
                <span>Remarks</span>
                <input
                  className={`remarks-input ${remarksMissing ? "remarks-required" : ""} ${over ? "remarks-ot" : ""}`}
                  value={r.remarks}
                  disabled={rowLocked}
                  placeholder={over ? "Mandatory OT reason for HOD…" : "Add note..."}
                  onChange={(e) => setRemarks(r.employeeId, e.target.value)}
                  required={over}
                />
                {remarksMissing && <div className="remarks-hint">Reason required before submit</div>}
              </label>
            </article>
          );
        })}
        <div className="ts-card ts-card--add">
          <div className="add-dropdown">
            <input
              className="add-emp-input"
              placeholder="+ Add employee... (search department roster)"
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

      <div className="legend-row">
        <div className="legend">
          {projects.map((p) => (
            <span key={p.id} className="legend-item">
              <span className="legend-swatch" style={{ background: `var(--project-${p.colorKey.toLowerCase()})` }}>
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
          Max {maxDailyHours}h per employee per day (all departments/projects). Overtime requires a Remarks reason
          visible to HOD on approval. Click hour cells to select, then assign a project — WBS auto-fills. Apply 8h
          fills everyone when nothing is ticked; if slots are ticked, it assigns the selected project only to those
          ticks. After HOD/Project Head approval, saved slots are locked; within 24h you may only fill empty slots.
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
    </>
  );
}
