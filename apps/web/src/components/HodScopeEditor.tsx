import type { GrantDepartment, GrantSection, HodGrant } from "../pages/hodScopeGrants";
import {
  grantsProblem,
  grantsSummary,
  groupDepartmentsByFunction,
  setGrantWhole,
  toggleDepartment,
  toggleGrantSection,
} from "../pages/hodScopeGrants";

/**
 * The approval scope of an HOD, as a set of DEPARTMENTS.
 *
 * WHY A DEPARTMENT LIST AND NOT ONE DROPDOWN: the yard runs two facilities, so one function is two
 * Departments (Yardservice - EOU, Yardservice - SEZ; the same for Safety, Civil, Health & Wellness and
 * Administration), and one person heads the function at both. The old control picked a Department and then
 * ticked its Sections, so the second plant could only be granted with a curl. Here every Department is
 * tickable, Departments are grouped by FUNCTION with the plants side by side, and each ticked Department
 * is either "whole" (the normal case — it also covers Sections the BadgeView sync adds later) or a named
 * set of its Sections.
 *
 * The component owns NO state: `grants` is the value, `onChange` the new value. That is what lets the two
 * screens that assign an HOD (Role Assignment and Employees → HOD Mapping) share one control and one
 * payload builder instead of drifting.
 */
export function HodScopeEditor({
  departments,
  sections,
  grants,
  onChange,
  disabled,
  busy,
  homeDepartmentId,
  loadError,
}: {
  departments: readonly GrantDepartment[];
  sections: readonly GrantSection[];
  grants: readonly HodGrant[];
  onChange: (next: HodGrant[]) => void;
  disabled?: boolean;
  busy?: boolean;
  /** The person's own Department, labelled so the operator can see where he physically sits. */
  homeDepartmentId?: number | null;
  /** Why the Department list could not be loaded, when it could not. Never swallowed. */
  loadError?: string;
}) {
  const locked = Boolean(disabled || busy);
  const groups = groupDepartmentsByFunction(departments);
  const granted = new Map(grants.map((grant) => [grant.departmentId, grant]));
  const problem = grantsProblem(grants);

  if (loadError) {
    return (
      <p className="error-banner" style={{ margin: 0 }}>
        The Departments and Sections could not be loaded: {loadError}
      </p>
    );
  }
  if (departments.length === 0) {
    return <p className="muted" style={{ margin: 0 }}>No Departments exist yet, so there is no scope to grant.</p>;
  }

  return (
    <div>
      <p className="muted" style={{ marginTop: 0, marginBottom: 10 }}>
        Tick every Department this person heads. One function can be two Departments (one per plant) — tick
        both and he covers EOU and SEZ on the same login. &ldquo;Whole Department&rdquo; also covers Sections
        the sync adds later; tick individual Sections only when he heads part of a Department.
      </p>

      {groups.map((group) => (
        <div key={group.functionGroup} style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 600, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--text-muted)" }}>
            {group.functionGroup}
            {group.departments.length > 1 && (
              <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}> · {group.departments.length} plants</span>
            )}
          </div>
          {group.departments.map((department) => {
            const grant = granted.get(department.id);
            const picked = grant !== undefined;
            const mySections = sections.filter((section) => section.departmentId === department.id);
            const whole = picked && grant.sectionIds.length === 0;
            return (
              <div
                key={department.id}
                style={{
                  marginTop: 6,
                  padding: "8px 10px",
                  borderRadius: 8,
                  border: picked ? "1px solid var(--primary)" : "1px solid var(--border-light)",
                  background: picked ? "var(--bg-elevated)" : "transparent",
                }}
              >
                <label style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: locked ? "not-allowed" : "pointer" }}>
                  <input
                    type="checkbox"
                    checked={picked}
                    disabled={locked}
                    onChange={() => onChange(toggleDepartment(grants, department.id))}
                    style={{ marginTop: 3 }}
                  />
                  <span>
                    <strong>{department.name}</strong>
                    {department.businessUnit ? <span className="muted"> · plant {department.businessUnit}</span> : null}
                    {homeDepartmentId === department.id ? <span className="muted"> · his home Department</span> : null}
                    {department.active === false ? <span className="muted"> · INACTIVE</span> : null}
                  </span>
                </label>

                {picked && (
                  <div style={{ marginLeft: 24, marginTop: 6 }}>
                    <label style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                      <input
                        type="radio"
                        name={`scope-${department.id}`}
                        checked={whole}
                        disabled={locked}
                        onChange={() => onChange(setGrantWhole(grants, department.id, true))}
                        style={{ marginTop: 3 }}
                      />
                      <span>
                        <strong>Whole Department</strong>
                        <div className="muted">Every Section, including Sections added later.</div>
                      </span>
                    </label>
                    <label style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 4 }}>
                      <input
                        type="radio"
                        name={`scope-${department.id}`}
                        checked={!whole}
                        disabled={locked || mySections.length === 0}
                        onChange={() => onChange(setGrantWhole(grants, department.id, false))}
                        style={{ marginTop: 3 }}
                      />
                      <span>
                        <strong>Sections of this Department only</strong>
                        <div className="muted">
                          {mySections.length === 0
                            ? "This Department has no Sections yet, so whole-Department is the only scope it can have."
                            : "Tick the Sections he approves work from."}
                        </div>
                      </span>
                    </label>

                    {!whole && mySections.length > 0 && (
                      <div style={{ marginLeft: 24, borderLeft: "2px solid var(--border-light)", paddingLeft: 12, marginTop: 6 }}>
                        {mySections.map((section) => (
                          <label key={section.id} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
                            <input
                              type="checkbox"
                              checked={grant.sectionIds.includes(section.id)}
                              disabled={locked}
                              onChange={() => onChange(toggleGrantSection(grants, department.id, section.id))}
                            />
                            <span>
                              {section.code ? `${section.code} · ` : ""}
                              {section.name}
                            </span>
                          </label>
                        ))}
                        {grant.sectionIds.length === 0 && (
                          <div className="muted">
                            No Section ticked — with none, the server reads this as the whole Department. Tick at
                            least one, or choose whole Department above.
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}

      <p style={{ margin: "8px 0 0" }}>
        <strong>Scope:</strong>{" "}
        <span className={problem ? "error-text" : "muted"}>
          {problem ??
            grantsSummary(
              grants,
              (id) => departments.find((department) => department.id === id)?.name ?? `Department ${id}`,
              (id) => sections.find((section) => section.id === id)?.name ?? `Section ${id}`
            )}
        </span>
      </p>
    </div>
  );
}
