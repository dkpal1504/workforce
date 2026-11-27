/**
 * HOD scope as a SET of department grants — the pure part of the multi-department picker.
 *
 * WHY THIS EXISTS: one HOD may head several Departments (the Sectional Head over Yardservice - EOU and
 * Yardservice - SEZ). The authority is `user_scope_departments` (one row per Department headed IN FULL)
 * plus `user_scope_sections` (named Sections). The screen used to offer ONE Department and a tick list of
 * its Sections, so the second plant could only be granted with a curl. These functions turn a checkbox
 * tree into the two request shapes the API accepts, and are separated from the component so the rules that
 * matter — one grant per Department, "whole" beats "named", an empty set is not a scope — are testable.
 */

/** One Department this account heads. `sectionIds: []` means the WHOLE Department. */
export type HodGrant = { departmentId: number; sectionIds: number[] };

export type GrantDepartment = {
  id: number;
  name: string;
  businessUnit?: string | null;
  functionGroup?: string | null;
  active?: boolean;
};

export type GrantSection = { id: number; code?: string; name: string; departmentId: number };

/** Order-insensitive, duplicate-free ids. */
function tidy(ids: readonly number[]): number[] {
  return [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))].sort((a, b) => a - b);
}

/** A copy with no duplicate Departments and no empty "named Sections" list pretending to be whole. */
export function normaliseGrants(grants: readonly HodGrant[]): HodGrant[] {
  const byDepartment = new Map<number, number[]>();
  for (const grant of grants) {
    if (!Number.isInteger(grant.departmentId) || grant.departmentId <= 0) continue;
    const existing = byDepartment.get(grant.departmentId);
    const sections = tidy(grant.sectionIds);
    if (existing === undefined) byDepartment.set(grant.departmentId, sections);
    // A whole-Department grant covers every Section, so a named list can never widen or shrink it.
    else if (existing.length > 0 && sections.length > 0) byDepartment.set(grant.departmentId, tidy([...existing, ...sections]));
    else byDepartment.set(grant.departmentId, []);
  }
  return [...byDepartment.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([departmentId, sectionIds]) => ({ departmentId, sectionIds }));
}

/**
 * The grants an account currently holds, as a checkbox tree can show them.
 *
 * Three shapes, matching the server's precedence: whole-Department rows first, then named Sections (each
 * folded into the grant of its own Department), and — when the account holds neither — its home Department
 * in full, which is what the server resolves for every existing single-Department HOD.
 */
export function grantsFromAccount(input: {
  homeDepartmentId: number | null;
  scopeDepartmentIds: readonly number[];
  scopeSectionIds: readonly number[];
  sections: readonly GrantSection[];
}): HodGrant[] {
  const grants: HodGrant[] = input.scopeDepartmentIds.map((departmentId) => ({ departmentId, sectionIds: [] }));
  const whole = new Set(grants.map((grant) => grant.departmentId));
  for (const sectionId of tidy(input.scopeSectionIds)) {
    const departmentId = input.sections.find((section) => section.id === sectionId)?.departmentId;
    if (departmentId == null || whole.has(departmentId)) continue;
    const existing = grants.find((grant) => grant.departmentId === departmentId);
    if (existing) existing.sectionIds = tidy([...existing.sectionIds, sectionId]);
    else grants.push({ departmentId, sectionIds: [sectionId] });
  }
  if (grants.length === 0 && input.homeDepartmentId != null) {
    grants.push({ departmentId: input.homeDepartmentId, sectionIds: [] });
  }
  return normaliseGrants(grants);
}

/** Tick / untick a whole Department. Unticking removes its grant entirely. */
export function toggleDepartment(grants: readonly HodGrant[], departmentId: number): HodGrant[] {
  const present = grants.some((grant) => grant.departmentId === departmentId);
  return normaliseGrants(present ? grants.filter((grant) => grant.departmentId !== departmentId) : [...grants, { departmentId, sectionIds: [] }]);
}

/** Choose between the whole Department and a named-Section scope for one granted Department. */
export function setGrantWhole(grants: readonly HodGrant[], departmentId: number, whole: boolean): HodGrant[] {
  return normaliseGrants(
    grants.map((grant) => (grant.departmentId === departmentId ? { departmentId, sectionIds: whole ? [] : grant.sectionIds } : grant))
  );
}

/** Tick / untick one Section inside a granted Department. The LAST tick cannot be removed — see problem(). */
export function toggleGrantSection(grants: readonly HodGrant[], departmentId: number, sectionId: number): HodGrant[] {
  return normaliseGrants(
    grants.map((grant) => {
      if (grant.departmentId !== departmentId) return grant;
      const present = grant.sectionIds.includes(sectionId);
      return {
        departmentId,
        sectionIds: present ? grant.sectionIds.filter((id) => id !== sectionId) : tidy([...grant.sectionIds, sectionId]),
      };
    })
  );
}

/** True when two grant sets are the same scope (used to decide whether anything changed). */
export function grantsDiffer(left: readonly HodGrant[], right: readonly HodGrant[]): boolean {
  const a = normaliseGrants(left);
  const b = normaliseGrants(right);
  if (a.length !== b.length) return true;
  return a.some((grant, index) => grant.departmentId !== b[index].departmentId || grant.sectionIds.join(",") !== b[index].sectionIds.join(","));
}

/**
 * Why this scope cannot be saved, or null. The server enforces the same rule; this is so the operator reads
 * the sentence BEFORE clicking, not in a banner at the top of a long page afterwards.
 */
export function grantsProblem(grants: readonly HodGrant[]): string | null {
  if (normaliseGrants(grants).length === 0) {
    return "Name at least one Department. An HOD with no Department matches nothing.";
  }
  return null;
}

/**
 * The body `PUT /admin/users/:id/role` and `/employees/:id/role` take: whole Departments, plus the named
 * Sections of Departments that are granted only in part. The server groups the named Sections under their
 * own Department and refuses one whose Department is not granted.
 */
export function roleScopePayload(grants: readonly HodGrant[]): { departmentIds: number[]; sectionIds: number[] } {
  const normalised = normaliseGrants(grants);
  return {
    departmentIds: normalised.map((grant) => grant.departmentId),
    sectionIds: tidy(normalised.flatMap((grant) => grant.sectionIds)),
  };
}

/** The body `PUT /admin/users/:id/hod-scope` takes — one entry per Department, `[]` = whole. */
export function scopeEndpointPayload(grants: readonly HodGrant[]): { grants: HodGrant[] } {
  return { grants: normaliseGrants(grants) };
}

/** A sentence an operator can check at a glance. */
export function grantsSummary(
  grants: readonly HodGrant[],
  departmentName: (id: number) => string,
  sectionName: (id: number) => string
): string {
  const normalised = normaliseGrants(grants);
  if (normalised.length === 0) return "No Department — this account will match nothing.";
  return normalised
    .map((grant) =>
      grant.sectionIds.length === 0
        ? `${departmentName(grant.departmentId)} (whole Department)`
        : `${departmentName(grant.departmentId)} (${grant.sectionIds.map(sectionName).join(", ")})`
    )
    .join(" · ");
}

/**
 * Group Departments by FUNCTION so the two plants of one function sit next to each other — which is the
 * whole point of the feature. Falls back to the Department name when the master data has no functionGroup
 * yet (a deployment that has not run the backfill).
 */
export function groupDepartmentsByFunction(departments: readonly GrantDepartment[]): { functionGroup: string; departments: GrantDepartment[] }[] {
  const groups = new Map<string, GrantDepartment[]>();
  for (const department of departments) {
    const key = (department.functionGroup ?? department.name).trim() || department.name;
    const list = groups.get(key);
    if (list) list.push(department);
    else groups.set(key, [department]);
  }
  const plantRank = (value: string | null | undefined) => (value === "EOU" ? 0 : value === "SEZ" ? 1 : 2);
  return [...groups.entries()]
    .map(([functionGroup, list]) => ({
      functionGroup,
      departments: [...list].sort(
        (a, b) => plantRank(a.businessUnit) - plantRank(b.businessUnit) || a.name.localeCompare(b.name)
      ),
    }))
    .sort((a, b) => a.functionGroup.localeCompare(b.functionGroup));
}
