import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import {
  assignmentNotice,
  changePending,
  findSelection,
  loginFor,
  parseSelection,
  roleTicks,
  rowKey,
  targetSummary,
  type PersonRow,
} from "./roleAssignmentSelection";
import "../styles/supervisors.css";

type Role = "EMPLOYEE" | "SUPERVISOR" | "HOD" | "DEPT_HEAD" | "PM" | "ADMIN" | "HR" | "FINANCE";
type HodScope = "SECTION" | "DEPARTMENT";

/** The two row shapes the server sends: an account, and an Employee with no account yet. */
type AccountRow = {
  id: number; name: string; email: string; role: Role; active: boolean; self: boolean;
  employeeId: number | null;
  employee: { id: number; ecNo: string; name: string; active: boolean; employmentType: string;
    department: { id: number; name: string } | null;
    section: { id: number; name: string; departmentId: number } | null } | null;
  department: { id: number; name: string } | null;
  scopeSection: { id: number; name: string } | null;
  hodScope: HodScope | null;
};

type EmployeeRow = {
  id: number; ecNo: string; name: string; designation: string; category: string;
  employmentType: string; source: string;
  department: { id: number; name: string } | null;
  section: { id: number; code: string; name: string; departmentId: number } | null;
  creatableRoles: string[];
};

type Payload = { roles: Role[]; users: AccountRow[]; employees: EmployeeRow[]; employeesTruncated: boolean };

const ROLE_LABELS: Record<Role, string> = {
  EMPLOYEE: "Employee (My Hours)",
  SUPERVISOR: "Supervisor (captures team timesheets)",
  HOD: "HOD (approves own Section)",
  DEPT_HEAD: "Department Head (department-wide view, no approval)",
  PM: "Project Head (approves across Departments)",
  ADMIN: "Admin (full access)",
  HR: "HR (registration screens)",
  FINANCE: "Finance (approved summary)",
};

/** What the person will be able to do once this role is ticked. */
const ROLE_EFFECT: Record<Role, string> = {
  EMPLOYEE: "Lands on My Hours and records only their own hours.",
  SUPERVISOR: "Lands on Select Team, picks contract labour from their Department, and fills the team timesheet.",
  HOD: "Lands on HOD Approvals for the Department/Section taken from their Employee mapping.",
  DEPT_HEAD:
    "Lands on Summary and sees approved hours for every Section of their Department; does not approve timesheets.",
  PM: "Lands on Project Head Approvals across all Departments.",
  ADMIN: "Full access, including this panel.",
  HR: "Registration screens (employees, supervisors, CSV).",
  FINANCE: "Read-only approved summary.",
};

/**
 * Why an Employee with no account is offered fewer roles. The SERVER decides this (it sends
 * `creatableRoles` and, per refused role, the sentence to show); the panel only explains the
 * one rule that is not per-row, so an operator understands the shape of the list at a glance.
 */
const CREATION_POLICY_NOTE =
  "Contract (blue-collar) employees can be given Employee or Supervisor. HOD and Department Head need a payroll " +
  "(white-collar) Employee; PM, HR, Finance and Admin are not Employee roles at all.";

/** Cap on rendered picker options: a filtered select stays usable, an unfiltered 5000-row one does not. */
const PICKER_OPTION_LIMIT = 200;

/** The roles this panel can tick, used to sanity-check an account's stored role before pre-ticking it. */
const SELECTABLE_ROLES: Role[] = ["EMPLOYEE", "SUPERVISOR", "HOD", "DEPT_HEAD", "PM", "ADMIN", "HR", "FINANCE"];

function errorText(error: unknown): string {
  if (error instanceof ApiError && error.payload && typeof error.payload === "object" && "error" in error.payload) {
    return String((error.payload as { error: unknown }).error);
  }
  return error instanceof Error ? error.message : "Request failed";
}

function accountToRow(account: AccountRow): PersonRow {
  return {
    kind: "ACCOUNT",
    id: account.id,
    name: account.name,
    ecNo: account.employee?.ecNo ?? null,
    currentRole: account.role,
    employmentType: account.employee?.employmentType ?? null,
    designation: null,
    department: account.employee?.department ?? account.department,
    section: account.employee?.section ?? account.scopeSection,
    active: account.active,
    self: account.self,
    creatableRoles: [],
    roleRefusals: {},
    hodScope: account.hodScope,
  };
}

function employeeToRow(employee: EmployeeRow, roleRefusals: Record<string, string>): PersonRow {
  return {
    kind: "EMPLOYEE",
    id: employee.id,
    name: employee.name,
    ecNo: employee.ecNo,
    currentRole: null,
    employmentType: employee.employmentType,
    designation: employee.designation,
    department: employee.department,
    section: employee.section,
    active: true,
    self: false,
    creatableRoles: employee.creatableRoles,
    roleRefusals,
    hodScope: null,
  };
}

/** Local, instant filtering. The server already applies its own `search` for API callers. */
function matches(row: PersonRow, term: string): boolean {
  if (!term) return true;
  return [row.name, row.ecNo, row.currentRole, row.employmentType, row.designation, row.department?.name, row.section?.name]
    .some((value) => String(value ?? "").toLowerCase().includes(term));
}

export function RoleAssignmentPage() {
  const { user } = useAuth();
  const [roles, setRoles] = useState<Role[]>([]);
  /** Every role's refusal reason for an account-less Employee, keyed by role then employee. */
  const [refusalsByEmployee, setRefusalsByEmployee] = useState<Record<number, Record<string, string>>>({});
  const [rows, setRows] = useState<PersonRow[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [selectedKey, setSelectedKey] = useState("");
  const [pickedRole, setPickedRole] = useState<Role | "">("");
  const [hodScope, setHodScope] = useState<HodScope>("SECTION");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<Payload>("/admin/role-assignment");
      setRoles(data.roles);
      // The API refuses a role per Employee with its own sentence; the panel shows the
      // server's wording rather than inventing a second copy of the policy.
      const refusals: Record<number, Record<string, string>> = {};
      for (const employee of data.employees) {
        const map: Record<string, string> = {};
        for (const role of data.roles) {
          if (employee.creatableRoles.includes(role)) continue;
          map[role] =
            (role === "HOD" || role === "DEPT_HEAD") && employee.employmentType !== "PAYROLL"
              ? `${role} needs a payroll (white-collar) Employee. ${employee.name} is contract labour, so they can be an Employee or a Supervisor.`
              : `${role} is not created from an Employee record. Create the account first, then assign the role here.`;
        }
        refusals[employee.id] = map;
      }
      setRefusalsByEmployee(refusals);
      setRows([
        ...data.users.map(accountToRow),
        ...data.employees.map((employee) => employeeToRow(employee, refusals[employee.id] ?? {})),
      ]);
      setTruncated(data.employeesTruncated);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const term = search.trim().toLowerCase();
  const visibleRows = useMemo(() => rows.filter((row) => matches(row, term)), [rows, term]);
  const selected = useMemo(() => findSelection(rows, selectedKey), [rows, selectedKey]);

  // Keep the selection honest when a reload removes the person (e.g. their account was created
  // elsewhere), so the panel can never act on a row that is no longer in the list.
  useEffect(() => {
    if (selectedKey && !findSelection(rows, selectedKey)) setSelectedKey("");
  }, [rows, selectedKey]);

  // Ticking a different role is the change; the current role is pre-ticked.
  useEffect(() => {
    setPickedRole(selected?.currentRole && SELECTABLE_ROLES.includes(selected.currentRole as Role)
      ? (selected.currentRole as Role)
      : "");
    setHodScope(selected?.hodScope ?? "SECTION");
    setError("");
    setNotice("");
  }, [selected]);

  const pending = changePending(selected, pickedRole, hodScope);
  const ticks = useMemo(() => (selected ? roleTicks<Role>(selected, roles) : []), [selected, roles]);
  const pickerOptions = visibleRows.slice(0, PICKER_OPTION_LIMIT);

  async function apply() {
    if (!selected || !pickedRole) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const body = JSON.stringify({ role: pickedRole, ...(pickedRole === "HOD" ? { hodScope } : {}) });
      // An Employee with no account is addressed by Employee id and has the account CREATED;
      // an existing account is re-roled by User id. Two routes, one set of rules behind them.
      const path = selected.kind === "EMPLOYEE" ? `/admin/employees/${selected.id}/role` : `/admin/users/${selected.id}/role`;
      const result = await api<{ accountCreated: boolean; firstPassword?: string }>(path, { method: "PUT", body });
      setNotice(assignmentNotice(selected, pickedRole, hodScope, result.accountCreated, result.firstPassword ?? ""));
      setPickedRole("");
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const accountCount = rows.filter((row) => row.kind === "ACCOUNT").length;
  const noLoginCount = rows.filter((row) => row.kind === "EMPLOYEE").length;

  return (
    <>
      <div className="supervisors-toolbar">
        <p className="muted" style={{ margin: 0 }}>
          Every person on the rolls is listed: {accountCount} with a login and {noLoginCount} without one. Picking
          someone who has no login yet and ticking Employee or Supervisor creates that login in the same click — they
          sign in with their EC No. Department and Section are always inherited from the person&apos;s Employee
          mapping, never re-selected here.
        </p>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="alloc-note">{notice}</div>}
      {truncated && (
        <div className="error-banner">
          This list hit its server limit, so it may be incomplete. Use the search box to narrow it down.
        </div>
      )}

      <div className="panel" style={{ marginTop: 12 }}>
        <div className="panel__header">
          <span>1 · Select a person</span>
          <span className="panel__count">
            {visibleRows.length} of {rows.length} people
          </span>
        </div>
        <div className="panel__body">
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
            <label className="filter-field" style={{ minWidth: 320 }}>
              <span>Employee / account</span>
              <select
                value={selectedKey}
                onChange={(event) => setSelectedKey(event.target.value)}
              >
                <option value="">Select a person…</option>
                {pickerOptions.map((row) => (
                  <option key={rowKey(row.kind, row.id)} value={rowKey(row.kind, row.id)}>
                    {row.ecNo ? `${row.ecNo} · ` : ""}
                    {row.name} — {row.kind === "ACCOUNT" ? row.currentRole : "no login yet"}
                    {row.employmentType ? ` (${row.employmentType})` : ""}
                    {row.department?.name ? ` · ${row.department.name}` : ""}
                    {row.active ? "" : " · INACTIVE"}
                  </option>
                ))}
                {visibleRows.length > pickerOptions.length && (
                  <option value="" disabled>
                    …and {visibleRows.length - pickerOptions.length} more — search to narrow the list
                  </option>
                )}
              </select>
            </label>
            <label className="filter-field" style={{ minWidth: 220 }}>
              <span>Search</span>
              <input
                className="search-input"
                value={search}
                placeholder="Name, EC No, department or section…"
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <button type="button" className="btn btn-secondary" disabled={loading} onClick={() => void load()}>
              {loading ? "Loading…" : "Reload"}
            </button>
          </div>

          {selected && (
            <div className="alloc-note" style={{ marginTop: 12 }}>
              <div>{targetSummary(selected)}</div>
              <div className="muted" style={{ marginTop: 4 }}>
                {selected.kind === "EMPLOYEE"
                  ? `Signs in with EC No ${loginFor(selected)} once the login exists.`
                  : `Login ${loginFor(selected)}`}
              </div>
              {selected.self && (
                <div className="muted" style={{ marginTop: 4 }}>
                  This is your own account, so its role cannot be changed here.
                </div>
              )}
              {!selected.active && (
                <div className="muted" style={{ marginTop: 4 }}>
                  This account is inactive. Reactivate it before assigning a role.
                </div>
              )}
              {selected.kind === "EMPLOYEE" && <div className="muted" style={{ marginTop: 4 }}>{CREATION_POLICY_NOTE}</div>}
            </div>
          )}
        </div>
      </div>

      {selected && (
        <div className="panel" style={{ marginTop: 16 }}>
          <div className="panel__header">
            <span>2 · Tick the role to assign</span>
            <span className="panel__count">
              {pickedRole || "none"}
              {selected.kind === "EMPLOYEE" ? " · creates the login" : ""}
            </span>
          </div>
          <div className="panel__body">
            <div style={{ display: "grid", gap: 8 }}>
              {ticks.map(({ role, enabled, reason }) => {
                const current = role === selected.currentRole;
                const picked = role === pickedRole;
                const disabled = busy || selected.self || !selected.active || !enabled;
                return (
                  <label
                    key={role}
                    style={{
                      display: "flex", gap: 10, alignItems: "flex-start",
                      padding: "8px 10px", borderRadius: 8,
                      border: picked ? "1px solid var(--primary)" : "1px solid var(--border-light)",
                      background: picked ? "var(--bg-elevated)" : "transparent",
                      opacity: enabled ? 1 : 0.6,
                      cursor: disabled ? "not-allowed" : "pointer",
                    }}
                  >
                    <input
                      type="radio"
                      name="role"
                      checked={picked}
                      disabled={disabled}
                      onChange={() => setPickedRole(role)}
                      style={{ marginTop: 3 }}
                    />
                    <span>
                      <strong>{ROLE_LABELS[role] ?? role}</strong>
                      {current && <span className="muted"> · current role</span>}
                      <div className="muted">{ROLE_EFFECT[role] ?? ""}</div>
                      {/* A role this Employee cannot have is LISTED with the reason, never hidden:
                          "why can he not be an HOD?" is the question the operator is asking. */}
                      {!enabled && <div className="muted">{reason}</div>}
                    </span>
                  </label>
                );
              })}
            </div>

            {pickedRole === "HOD" && (
              <div className="panel" style={{ marginTop: 12, padding: 12, border: "1px solid var(--border-light)", borderRadius: 8 }}>
                <strong>HOD scope</strong>
                <div className="muted" style={{ marginBottom: 8 }}>
                  Section-level approves only its own Section. Department-level sees approved hours for every
                  Section of its Department and (as HOD) may approve in any of them.
                </div>
                {(["SECTION", "DEPARTMENT"] as HodScope[]).map((scope) => (
                  <label key={scope} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
                    <input
                      type="radio"
                      name="hodScope"
                      checked={hodScope === scope}
                      disabled={busy || selected.self || !selected.active}
                      onChange={() => setHodScope(scope)}
                    />
                    <span>
                      {scope === "SECTION" ? "Section" : "Department"}
                      <span className="muted">
                        {scope === "SECTION"
                          ? ` — ${selected.section?.name ?? "the Employee's Section, or department-wide if they have none"}`
                          : ` — all Sections of ${selected.department?.name ?? "the Department"}`}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            )}

            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 14, flexWrap: "wrap" }}>
              <button
                className="btn btn-primary"
                disabled={busy || !pending}
                onClick={() => void apply()}
              >
                {busy ? "Updating…" : selected.kind === "EMPLOYEE" ? "Create login and assign" : "Update role"}
              </button>
              <button
                className="btn btn-ghost"
                disabled={busy}
                onClick={() => setPickedRole(selected.currentRole ? (selected.currentRole as Role) : "")}
              >
                Reset
              </button>
              <span className="muted">
                {selected.self
                  ? "You cannot change your own role."
                  : !selected.active
                  ? "Inactive accounts cannot be reassigned."
                  : selected.kind === "EMPLOYEE"
                  ? `This creates ${selected.name}'s login with the ${pickedRole || "selected"} role and the deployment's first password, which they must change at first login.`
                  : pending
                  ? `This moves ${selected.name} from ${selected.currentRole} to ${pickedRole}` +
                    (pickedRole === "HOD" ? ` (${hodScope === "DEPARTMENT" ? "Department-wide" : "Section"})` : "") +
                    " and revokes their current sessions."
                  : "Tick a different role to enable the update."}
              </span>
            </div>
          </div>
        </div>
      )}

      {!selected && !loading && (
        <div className="empty-state" style={{ marginTop: 16 }}>
          {rows.length ? "Select a person to assign a role." : "No people on the rolls were returned."}
        </div>
      )}
      {selected?.self && user?.id === selected.id && null}
    </>
  );
}
