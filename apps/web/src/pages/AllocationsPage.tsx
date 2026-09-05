import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { todayDateString } from "../utils/date";
import "../styles/allocations.css";

type JobOrder = { id: number; code: string; name: string; status: string };
type Project = { id: number; code: string; name: string; colorKey: string; jobOrders: JobOrder[] };
type Allocation = {
  id: number;
  workDate: string;
  status: string;
  employee: { id: number; name: string; ecNo: string; grade: string | null; department: { name: string } | null };
  project: { id: number; name: string; colorKey: string };
  jobOrder: { id: number; code: string; name: string } | null;
  allocatedBy: { id: number; name: string };
};
type EmployeeOption = { id: number; name: string; ecNo: string };

const emptyForm = {
  employeeId: "" as string,
  workDate: todayDateString(),
  projectId: "" as string,
  jobOrderId: "" as string,
};

/**
 * Payroll manhour allocation (CR#2) — self-service for employees with logins;
 * HOD / Project Planning / ADMIN / HR can allocate for others (role-gated at
 * the API). Project is MANDATORY, Work Order is optional, and OT is not
 * applicable to payroll — this screen has no OT affordance at all.
 */
export function AllocationsPage() {
  const { user } = useAuth();
  const canAllocateOthers = Boolean(user && ["HOD", "PM", "ADMIN", "HR"].includes(user.role));

  const [allocations, setAllocations] = useState<Allocation[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState(emptyForm);
  const [formErr, setFormErr] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [dateFilter, setDateFilter] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [a, p] = await Promise.all([
        api<{ allocations: Allocation[]; note?: string }>("/allocations"),
        api<{ projects: Project[] }>("/projects"),
      ]);
      setAllocations(a.allocations);
      if (a.note) setNotice(a.note);
      setProjects(p.projects.filter((pr) => pr.jobOrders?.length || true));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load allocations");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Admins/HOD see an employee picker (allocate-for-others); others allocate to self.
  useEffect(() => {
    if (!canAllocateOthers) return;
    api<{ employees: EmployeeOption[] }>(`/employees`)
      .then((d) => setEmployees(d.employees))
      .catch(() => setEmployees([]));
  }, [canAllocateOthers]);

  const selectedProject = useMemo(
    () => projects.find((p) => String(p.id) === form.projectId) ?? null,
    [projects, form.projectId]
  );

  const visible = useMemo(() => {
    if (!dateFilter) return allocations;
    return allocations.filter((a) => a.workDate.slice(0, 10) === dateFilter);
  }, [allocations, dateFilter]);

  async function submit() {
    const errs: Record<string, string> = {};
    if (canAllocateOthers && !form.employeeId) errs.employeeId = "Select an employee.";
    if (!form.workDate) errs.workDate = "Date is required.";
    if (!form.projectId) errs.projectId = "Project is required.";
    setFormErr(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    setError("");
    try {
      await api("/allocations", {
        method: "PUT",
        body: JSON.stringify({
          employeeId: form.employeeId ? Number(form.employeeId) : undefined,
          workDate: form.workDate,
          projectId: Number(form.projectId),
          jobOrderId: form.jobOrderId ? Number(form.jobOrderId) : null,
        }),
      });
      setNotice("");
      setForm({ ...emptyForm, workDate: form.workDate, employeeId: form.employeeId });
      await load();
    } catch (e) {
      const msg =
        e instanceof ApiError && typeof e.payload === "object" && e.payload && "error" in e.payload
          ? String((e.payload as { error: string }).error)
          : e instanceof Error
            ? e.message
            : "Failed to save allocation";
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    setError("");
    try {
      await api(`/allocations/${id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete allocation");
    }
  }

  return (
    <>
      <section className="alloc-card">
        <header className="alloc-card__head">
          <h2>{canAllocateOthers ? "Allocate Manhours" : "My Allocations"}</h2>
          <p className="muted">
            {canAllocateOthers
              ? "Assign payroll employee hours to a project. Work order is optional — project is mandatory. OT does not apply to payroll employees."
              : "Assign your own hours to a project. Work order is optional — project is mandatory. OT does not apply to payroll employees."}
          </p>
        </header>

        {notice && <div className="alloc-note">{notice}</div>}
        {error && <div className="error-banner">{error}</div>}

        <div className="alloc-form">
          {canAllocateOthers && (
            <label className={`alloc-field ${formErr.employeeId ? "alloc-field--error" : ""}`}>
              <span>Employee</span>
              <select value={form.employeeId} onChange={(e) => setForm((f) => ({ ...f, employeeId: e.target.value }))}>
                <option value="">Select employee…</option>
                {employees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.name} ({emp.ecNo})
                  </option>
                ))}
              </select>
              {formErr.employeeId && <span className="field-error">{formErr.employeeId}</span>}
            </label>
          )}
          <label className={`alloc-field ${formErr.workDate ? "alloc-field--error" : ""}`}>
            <span>Date</span>
            <input type="date" value={form.workDate} onChange={(e) => setForm((f) => ({ ...f, workDate: e.target.value }))} />
            {formErr.workDate && <span className="field-error">{formErr.workDate}</span>}
          </label>
          <label className={`alloc-field ${formErr.projectId ? "alloc-field--error" : ""}`}>
            <span>Project *</span>
            <select
              value={form.projectId}
              onChange={(e) => setForm((f) => ({ ...f, projectId: e.target.value, jobOrderId: "" }))}
            >
              <option value="">Select project…</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            {formErr.projectId && <span className="field-error">{formErr.projectId}</span>}
          </label>
          <label className="alloc-field">
            <span>Work Order (optional)</span>
            <select
              value={form.jobOrderId}
              disabled={!selectedProject}
              onChange={(e) => setForm((f) => ({ ...f, jobOrderId: e.target.value }))}
            >
              <option value="">{selectedProject ? "None / not applicable" : "Pick a project first"}</option>
              {(selectedProject?.jobOrders ?? []).map((j) => (
                <option key={j.id} value={j.id}>
                  {j.code} - {j.name}
                </option>
              ))}
            </select>
          </label>
          <div className="alloc-form__action">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={submit}>
              {busy ? "Saving…" : "Allocate Hours"}
            </button>
          </div>
        </div>
      </section>

      <div className="alloc-list-head">
        <h3>Recent Allocations</h3>
        <input
          type="date"
          value={dateFilter}
          onChange={(e) => setDateFilter(e.target.value)}
          aria-label="Filter by date"
          className="alloc-date-filter"
        />
        {dateFilter && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDateFilter("")}>
            Clear
          </button>
        )}
      </div>

      {loading && <div className="loading-state">Loading allocations…</div>}

      {!loading && visible.length === 0 && (
        <div className="empty-state">No allocations yet. Add your hours above.</div>
      )}

      {/* Desktop table */}
      {!loading && visible.length > 0 && (
        <table className="alloc-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Employee</th>
              <th>Project</th>
              <th>Work Order</th>
              <th>Allocated By</th>
              <th style={{ textAlign: "right" }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((a) => (
              <tr key={a.id}>
                <td>{a.workDate.slice(0, 10)}</td>
                <td>
                  <strong>{a.employee.name}</strong>
                  <div className="muted tiny">
                    {a.employee.ecNo}
                    {a.employee.grade ? ` · ${a.employee.grade}` : ""}
                    {a.employee.department?.name ? ` · ${a.employee.department.name}` : ""}
                  </div>
                </td>
                <td>
                  <span className="alloc-proj-dot" style={{ background: `var(--project-${a.project.colorKey.toLowerCase()})` }} />
                  {a.project.name}
                </td>
                <td>{a.jobOrder ? `${a.jobOrder.code} - ${a.jobOrder.name}` : "—"}</td>
                <td>{a.allocatedBy.name}</td>
                <td>
                  <div className="alloc-row-actions">
                    <button type="button" className="btn btn-danger btn-sm" onClick={() => remove(a.id)}>
                      Remove
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Mobile cards */}
      {!loading && visible.length > 0 && (
        <div className="alloc-cards">
          {visible.map((a) => (
            <article key={a.id} className="alloc-item">
              <header>
                <strong>{a.employee.name}</strong>
                <span className="muted tiny">{a.workDate.slice(0, 10)}</span>
              </header>
              <div className="alloc-item__body">
                <span className="alloc-proj-dot" style={{ background: `var(--project-${a.project.colorKey.toLowerCase()})` }} />
                {a.project.name}
                {a.jobOrder && <div className="muted tiny">WO: {a.jobOrder.code} - {a.jobOrder.name}</div>}
                <div className="muted tiny">By {a.allocatedBy.name}</div>
              </div>
              <button type="button" className="btn btn-danger btn-sm" onClick={() => remove(a.id)}>
                Remove
              </button>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
