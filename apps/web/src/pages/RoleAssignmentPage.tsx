import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import "../styles/supervisors.css";

type Role = "EMPLOYEE" | "SUPERVISOR" | "HOD" | "DEPT_HEAD" | "PM" | "ADMIN" | "HR" | "FINANCE";

type EmployeeRef = {
  id: number;
  ecNo: string;
  name: string;
  active: boolean;
  employmentType: string;
  department: { id: number; name: string } | null;
  section: { id: number; name: string; departmentId: number } | null;
};

type HodScope = "SECTION" | "DEPARTMENT";

type Account = {
  id: number;
  name: string;
  email: string;
  role: Role;
  active: boolean;
  self: boolean;
  employeeId: number | null;
  employee: EmployeeRef | null;
  department: { id: number; name: string } | null;
  scopeSection: { id: number; name: string } | null;
  /** For an HOD: whether it is scoped to one Section or the whole Department. */
  hodScope: HodScope | null;
};

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
 * The identifier that ACTUALLY works for a role, which is not always the EC number:
 * `EMPLOYEE`, `SUPERVISOR`, `HOD`, `DEPT_HEAD` and `PM` authenticate with their EC number, while
 * `ADMIN`, `HR` and `FINANCE` authenticate with their e-mail address
 * (`usesEcNoLogin` in the API's defaultLoginCredentials). Showing the EC number for an account
 * that is being moved to ADMIN would name a login that no longer works - the mistake this column
 * used to invite.
 */
function loginIdentifierFor(role: string, ecNo: string | null, email: string): string {
  const byEcNo = ["EMPLOYEE", "SUPERVISOR", "HOD", "DEPT_HEAD", "PM"].includes(role);
  return byEcNo ? ecNo ?? email : email;
}

export function RoleAssignmentPage() {
  const { user } = useAuth();
  const [roles, setRoles] = useState<Role[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedId, setSelectedId] = useState<number | "">("");
  const [pickedRole, setPickedRole] = useState<Role | "">("");
  const [hodScope, setHodScope] = useState<HodScope>("SECTION");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function load(term = search) {
    setLoading(true);
    try {
      const data = await api<{ roles: Role[]; users: Account[] }>(
        `/admin/role-assignment${term.trim() ? `?search=${encodeURIComponent(term.trim())}` : ""}`
      );
      setRoles(data.roles);
      setAccounts(data.users);
      setSelectedId((current) => (data.users.some((u) => u.id === current) ? current : ""));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load accounts.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = useMemo(
    () => accounts.find((account) => account.id === selectedId) ?? null,
    [accounts, selectedId]
  );

  // Ticking a different role is the change; the current role is pre-ticked.
  useEffect(() => {
    setPickedRole(selected ? selected.role : "");
    setHodScope(selected?.hodScope ?? "SECTION");
    setError("");
    setNotice("");
  }, [selected]);

  const changePending = Boolean(
    selected &&
    pickedRole &&
    (pickedRole !== selected.role || (pickedRole === "HOD" && hodScope !== (selected.hodScope ?? "SECTION")))
  );

  async function apply() {
    if (!selected || !pickedRole) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await api(`/admin/users/${selected.id}/role`, {
        method: "PUT",
        body: JSON.stringify({ role: pickedRole, ...(pickedRole === "HOD" ? { hodScope } : {}) }),
      });
      setNotice(
        `${selected.name} is now ${pickedRole}` +
          (pickedRole === "HOD" ? ` (${hodScope === "DEPARTMENT" ? "Department-wide, no Section" : "Section-scoped"})` : "") +
          `. Their sessions were revoked, so they take the new screens on their next login.`
      );
      setPickedRole("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not assign the role.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="supervisors-toolbar">
        <p className="muted" style={{ margin: 0 }}>
          Tick a role and update. Department and Section are inherited from the person&apos;s existing
          Employee mapping — nothing is re-selected here. Payroll employees and contract supervisors are
          both assignable.
        </p>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="alloc-note">{notice}</div>}

      <div className="panel" style={{ marginTop: 12 }}>
        <div className="panel__header">
          <span>1 · Select a person</span>
          <span className="panel__count">{accounts.length} accounts</span>
        </div>
        <div className="panel__body">
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
            <label className="filter-field" style={{ minWidth: 320 }}>
              <span>Employee / account</span>
              <select
                value={selectedId}
                onChange={(event) => setSelectedId(event.target.value ? Number(event.target.value) : "")}
              >
                <option value="">Select a person…</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.employee?.ecNo ? `${account.employee.ecNo} · ` : ""}
                    {account.name} — {account.role}
                    {account.employee?.employmentType ? ` (${account.employee.employmentType})` : ""}
                    {account.active ? "" : " · INACTIVE"}
                  </option>
                ))}
              </select>
            </label>
            <label className="filter-field" style={{ minWidth: 220 }}>
              <span>Search</span>
              <input
                className="search-input"
                value={search}
                placeholder="Name, ecNo or email…"
                onChange={(event) => setSearch(event.target.value)}
                onBlur={() => void load(search)}
                onKeyDown={(event) => { if (event.key === "Enter") void load(search); }}
              />
            </label>
            <button type="button" className="btn btn-secondary" disabled={loading} onClick={() => void load(search)}>
              {loading ? "Loading…" : "Search"}
            </button>
          </div>

          {selected && (
            <div className="alloc-note" style={{ marginTop: 12 }}>
              <div>
                <strong>{selected.name}</strong> · login {loginIdentifierFor(selected.role, selected.employee?.ecNo ?? null, selected.email)} ·{" "}
                {selected.employee?.employmentType ?? "no Employee record"} · currently{" "}
                <strong>{selected.role}</strong>
              </div>
              <div className="muted" style={{ marginTop: 4 }}>
                Department: {selected.employee?.department?.name ?? selected.department?.name ?? "—"} · Section:{" "}
                {selected.employee?.section?.name ?? selected.scopeSection?.name ?? "not assigned"}
                {selected.role === "HOD" && (
                  <> · <strong>{selected.hodScope === "DEPARTMENT" ? "Department-level HOD" : "Section-level HOD"}</strong></>
                )}
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
            </div>
          )}
        </div>
      </div>

      {selected && (
        <div className="panel" style={{ marginTop: 16 }}>
          <div className="panel__header">
            <span>2 · Tick the role to assign</span>
            <span className="panel__count">{pickedRole || "none"}</span>
          </div>
          <div className="panel__body">
            <div style={{ display: "grid", gap: 8 }}>
              {roles.map((role) => {
                const active = role === selected.role;
                const picked = role === pickedRole;
                return (
                  <label
                    key={role}
                    style={{
                      display: "flex", gap: 10, alignItems: "flex-start",
                      padding: "8px 10px", borderRadius: 8,
                      border: picked ? "1px solid var(--primary)" : "1px solid var(--border-light)",
                      background: picked ? "var(--bg-elevated)" : "transparent",
                      cursor: selected.self || !selected.active ? "not-allowed" : "pointer",
                    }}
                  >
                    <input
                      type="radio"
                      name="role"
                      checked={picked}
                      disabled={selected.self || !selected.active || busy}
                      onChange={() => setPickedRole(role)}
                      style={{ marginTop: 3 }}
                    />
                    <span>
                      <strong>{ROLE_LABELS[role]}</strong>
                      {active && <span className="muted"> · current role</span>}
                      <div className="muted">{ROLE_EFFECT[role]}</div>
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
                          ? ` — ${selected.employee?.section?.name ?? "the Employee's Section"}`
                          : ` — all Sections of ${selected.employee?.department?.name ?? "the Department"}`}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            )}

            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 14, flexWrap: "wrap" }}>
              <button
                className="btn btn-primary"
                disabled={busy || !changePending || selected.self || !selected.active}
                onClick={() => void apply()}
              >
                {busy ? "Updating…" : "Update role"}
              </button>
              <button className="btn btn-ghost" disabled={busy} onClick={() => setPickedRole(selected.role)}>
                Reset
              </button>
              <span className="muted">
                {selected.self
                  ? "You cannot change your own role."
                  : !selected.active
                  ? "Inactive accounts cannot be reassigned."
                  : changePending
                  ? `This moves ${selected.name} from ${selected.role} to ${pickedRole}` +
                    (pickedRole === "HOD" ? ` (${hodScope === "DEPARTMENT" ? "Department-wide" : "Section"})` : "") +
                    ` and revokes their current sessions.` +
                    (loginIdentifierFor(pickedRole, selected.employee?.ecNo ?? null, selected.email) !==
                    loginIdentifierFor(selected.role, selected.employee?.ecNo ?? null, selected.email)
                      ? ` They will sign in with ${loginIdentifierFor(pickedRole, selected.employee?.ecNo ?? null, selected.email)} from now on.`
                      : "")
                  : "Tick a different role to enable the update."}
              </span>
            </div>
          </div>
        </div>
      )}

      {!selected && !loading && <div className="empty-state" style={{ marginTop: 16 }}>Select a person to assign a role.</div>}
      {selected?.self && user?.id === selected.id && null}
    </>
  );
}
