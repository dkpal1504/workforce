import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import {
  assignmentNotice,
  changePending,
  deriveScopeSections,
  hodScopeFromPicked,
  scopeConsequence,
  findSelection,
  loginFor,
  parseSelection,
  roleChangeBlockers,
  roleTicks,
  rowKey,
  targetSummary,
  unblocksByApprovingOthers,
  scopeSelectionDiffers,
  type PersonRow,
} from "./roleAssignmentSelection";
import "../styles/supervisors.css";

type Role = "EMPLOYEE" | "SUPERVISOR" | "HOD" | "DEPT_HEAD" | "PM" | "ADMIN" | "HR" | "FINANCE";
type HodScope = "SECTION" | "DEPARTMENT";

/** The two row shapes the server sends: an account, and an Employee with no account yet. */
type AccountRow = {
  id: number; name: string; email: string; role: Role; active: boolean; self: boolean;
  employeeId: number | null;
  /** Work that would make the server refuse a role change, sent with the list. */
  blockers?: { pendingApprovals: number; returnedTimesheetDays: number };
  employee: { id: number; ecNo: string; name: string; active: boolean; employmentType: string;
    department: { id: number; name: string } | null;
    section: { id: number; name: string; departmentId: number } | null } | null;
  department: { id: number; name: string } | null;
  scopeSection: { id: number; name: string } | null;
  hodScope: HodScope | null;
  /** The Sections this account heads. EMPTY means the whole Department. */
  scopeSections?: number[];
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
    scopeSections: account.scopeSections ?? [],
    // The server's own counts for the guards, so a blocked move is explained BEFORE the click.
    blockers: account.blockers ?? { pendingApprovals: 0, returnedTimesheetDays: 0 },
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
    // An Employee that has no account cannot have a queue or owned timesheets: it has no role yet,
    // so no guard can fire. Stated explicitly rather than left undefined.
    blockers: { pendingApprovals: 0, returnedTimesheetDays: 0 },
  };
}

/** Local, instant filtering. The server already applies its own `search` for API callers. */
function matches(row: PersonRow, term: string): boolean {
  if (!term) return true;
  return [row.name, row.ecNo, row.currentRole, row.employmentType, row.designation, row.department?.name, row.section?.name]
    .some((value) => String(value ?? "").toLowerCase().includes(term));
}

/**
 * Tick the Sections a Section Head covers, or take the whole Department.
 *
 * WHY A CHECKBOX LIST AND NOT A SELECT: an HOD scope is now a SET, and a `<select multiple>` is
 * the wrong control for it — it hides the options, needs a modifier key to multi-pick, and reads
 * as a single choice to anyone who has not used one. The Department is chosen ONCE, above, so
 * every Section offered here already belongs to it: the same-department rule is enforced by the
 * shape of the form, not by a validation message.
 *
 * EXPORTED so the Employees (Payroll) screen renders the SAME control. Two paths that assign a
 * Section Head must not drift, or one of them writes a scope the other cannot read.
 */
export function HodSectionPicker({
  sections,
  picked,
  onToggle,
  onAll,
  disabled,
  busy,
  loadError,
}: {
  sections: { id: number; code: string; name: string }[];
  picked: number[];
  onToggle: (sectionId: number) => void;
  onAll: () => void;
  disabled: boolean;
  busy: boolean;
  /** Why `sections` is empty, when the fetch failed. Never swallowed. */
  loadError?: string;
}) {
  const locked = disabled || busy;
  const isAll = picked.length === 0;
  return (
    <div>
      <label style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 6 }}>
        <input type="checkbox" checked={isAll} disabled={locked} onChange={() => onAll()} />
        <span>
          <strong>All Sections of this Department</strong>
          <div className="muted">
            Approves timesheets from every Section, including Sections added later. This is what a
            Department HOD has.
          </div>
        </span>
      </label>
      <div style={{ marginLeft: 24, borderLeft: "2px solid var(--border-light)", paddingLeft: 12 }}>
        {sections.length === 0 ? (
          <p className={loadError ? "error-banner" : "muted"} style={{ margin: 0 }}>
            {loadError
              ? `The Sections for this Department could not be loaded: ${loadError}`
              : "No Sections are available for this Department yet."}
          </p>
        ) : (
          sections.map((section) => (
            <label key={section.id} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
              <input
                type="checkbox"
                checked={!isAll && picked.includes(section.id)}
                disabled={locked || isAll}
                onChange={() => onToggle(section.id)}
              />
              <span>
                {section.code} · {section.name}
              </span>
            </label>
          ))
        )}
      </div>
      {/* The consequence in plain words: the operator should not have to infer the ticks. */}
      <p className="muted" style={{ marginTop: 6, marginBottom: 0 }}>
        {scopeConsequence(picked, (id) => sections.find((s) => s.id === id)?.name ?? null)}
      </p>
    </div>
  );
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
  /** The Sections ticked for this account. The SET is the source of truth; the old scalar is derived below. */
  const [pickedSectionIds, setPickedSectionIds] = useState<number[]>([]);
  /** The chosen Department's Sections. A Department is picked ONCE, so the ticks cannot cross one. */
  const [sectionOptions, setSectionOptions] = useState<{ id: number; code: string; name: string }[]>([]);
  /** Why the Section list is empty, when it is. An empty list must never be silent. */
  const [sectionLoadError, setSectionLoadError] = useState("");
  // Derived, ONE direction only (set -> scalar). `changePending`/`assignmentNotice`/`targetSummary`
  // are already tested in terms of this scalar, so it is computed from the set rather than the set
  // being inferred from it — the mirror is the FIRST Section and cannot count them.
  const hodScope: HodScope = hodScopeFromPicked(pickedSectionIds);
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

  /**
   * Ticking a different role is the change; the current role is pre-ticked.
   *
   * This clears the error and the notice when the SELECTION changes, which is right — a message
   * about the previous person has no business on this one. What it must not do is wipe the
   * confirmation of the change that just happened: `apply()` reloads the list, the row object is
   * rebuilt, and without protection the notice was cleared in the same tick it was set, so a
   * successful change was announced and then silently withdrawn. `pending` is false right after a
   * successful apply, and a change that was refused leaves `pending` TRUE — so only the success
   * path (pending === false) keeps the notice.
   */
  useEffect(() => {
    setPickedRole(selected?.currentRole && SELECTABLE_ROLES.includes(selected.currentRole as Role)
      ? (selected.currentRole as Role)
      : "");
    setPickedSectionIds(selected ? deriveScopeSections(selected) : []);
    setError("");
    if (selected && changePending(selected, selected.currentRole ?? "", selected.hodScope ?? "SECTION")) setNotice("");
  }, [selected]);

  /** The Department whose Sections the tick list must offer: the row's own, from the Employee mapping. */
  const scopeDepartmentId = selected?.department?.id ?? null;

  // The Section list arrives AFTER the first render, so it is fetched whenever the Department
  // changes and cleared while it is unknown — a stale Department's Sections in the list would let
  // an operator tick a Section the API will refuse.
  useEffect(() => {
    let cancelled = false;
    if (scopeDepartmentId == null) { setSectionOptions([]); setSectionLoadError(""); return; }
    api<{ sections: { id: number; code: string; name: string }[] }>(`/sections?department_id=${scopeDepartmentId}`)
      .then((data) => {
        if (cancelled) return;
        setSectionOptions(data.sections ?? []);
        setSectionLoadError("");
      })
      // A failed fetch must SAY so. Swallowing it renders "No Sections are available for this
      // Department yet", which is a false statement about the database when the request simply
      // failed — and an operator reading it would go and create Sections that already exist.
      .catch((err) => {
        if (cancelled) return;
        setSectionOptions([]);
        setSectionLoadError(errorText(err));
      });
    return () => { cancelled = true; };
  }, [scopeDepartmentId]);

  const pending = changePending(selected, pickedRole, hodScope) ||
    (selected != null && pickedRole === "HOD" && selected.kind === "ACCOUNT" && scopeSelectionDiffers(selected, pickedSectionIds));
  /**
   * Work that will make the server refuse this move. Computed from the counts the API sends with the
   * list, so the operator is told BEFORE clicking — and, because the banner sits at the top of a long
   * page, the same sentence is repeated next to the Update button below.
   */
  const blockedReason = selected && pending ? roleChangeBlockers(selected, pickedRole) : null;
  const canApply = pending && !blockedReason;
  const alsoBlockedApprovers = selected ? unblocksByApprovingOthers(rows, selected.id, pickedRole) : 0;
  const ticks = useMemo(() => (selected ? roleTicks<Role>(selected, roles) : []), [selected, roles]);
  const pickerOptions = visibleRows.slice(0, PICKER_OPTION_LIMIT);

  async function apply() {
    if (!selected || !pickedRole) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const body = JSON.stringify({ role: pickedRole, ...(pickedRole === "HOD" ? { sectionIds: pickedSectionIds } : {}) });
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
                const disabled = busy || selected.self || !selected.active || !enabled || Boolean(blockedReason);
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
                <strong>Approval scope — which Sections may this person approve?</strong>
                <div className="muted" style={{ marginBottom: 8 }}>
                  Tick one or more Sections of {selected.department?.name ?? "this person's Department"}. Only
                  Sections of that Department can be ticked, and they are the Sections he may approve work
                  from — not a limit on where he records his own hours.
                </div>
                <HodSectionPicker
                  sections={sectionOptions}
                  picked={pickedSectionIds}
                  onToggle={(sectionId) =>
                    setPickedSectionIds((current) =>
                      current.includes(sectionId) ? current.filter((id) => id !== sectionId) : [...current, sectionId].sort((a, b) => a - b),
                    )
                  }
                  onAll={() => setPickedSectionIds((current) => (current.length === 0 ? (selected.section ? [selected.section.id] : []) : []))}
                  disabled={selected.self || !selected.active}
                  busy={busy}
                  loadError={sectionLoadError}
                />
              </div>
            )}

            {/* The reason a blocked move will be refused is repeated HERE, beside the button the
                operator actually pressed. The page's own banner is at the very top, far above this
                panel, so leaving the explanation only there is what made a refusal look like a
                change that never happened. */}
            {blockedReason && (
              <div className="error-banner" style={{ marginTop: 14 }}>{blockedReason}</div>
            )}
            {blockedReason && alsoBlockedApprovers > 0 && (
              <p className="muted" style={{ marginTop: 4 }}>
                An approval queue is held by Department/Section, not by the person, so some of those days may
                not be this account&apos;s own — there {alsoBlockedApprovers === 1 ? "is 1 other approver" : `are ${alsoBlockedApprovers} other approvers`} on
                this list whose queue could be cleared instead.
              </p>
            )}

            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 14, flexWrap: "wrap" }}>
              <button
                className="btn btn-primary"
                disabled={busy || !canApply}
                onClick={() => void apply()}
              >
                {busy ? "Updating…" : selected.kind === "EMPLOYEE" ? "Create login and assign" : "Update role"}
              </button>
              <button
                className="btn btn-ghost"
                disabled={busy}
                onClick={() => {
                  setPickedRole(selected.currentRole ? (selected.currentRole as Role) : "");
                  setPickedSectionIds(deriveScopeSections(selected));
                }}
              >
                Reset
              </button>
              <span className="muted">
                {selected.self
                  ? "You cannot change your own role."
                  : !selected.active
                  ? "Inactive accounts cannot be reassigned."
                  : blockedReason
                  ? "This change cannot be saved until the work above is cleared."
                  : selected.kind === "EMPLOYEE"
                  ? `This creates ${selected.name}'s login with the ${pickedRole || "selected"} role and the deployment's first password, which they must change at first login.`
                  : pending
                  ? `This moves ${selected.name} from ${selected.currentRole} to ${pickedRole}` +
                    (pickedRole === "HOD"
                      ? ` (${pickedSectionIds.length === 0 ? "every Section of the Department" : `Sections ${pickedSectionIds.map((id) => sectionOptions.find((s) => s.id === id)?.name ?? id).join(", ")}`})`
                      : "") +
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
