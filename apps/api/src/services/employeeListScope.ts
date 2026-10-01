/**
 * Who may see which Employees in the Admin panel's employee listing, and why the two halves are
 * SEPARATE questions.
 *
 * WHY THIS MODULE EXISTS
 *   The employee listing is served by ONE endpoint (`GET /employees` in routes/masters.ts) that three
 *   very different kinds of caller use, and the section filter that is right for one is wrong for
 *   another:
 *
 *     - SUPERVISOR  — needs his own Section only (the picker that builds his team).
 *     - HOD         — is a HEAD: he runs a Department, so the listing is department-wide, whether his
 *                     account is narrowed to one Section (a Section Head) or not (a Department HOD).
 *     - DEPT_HEAD   — same department-wide view, no approval rights anywhere else in the app.
 *
 *   The bug this fixes: a Section-scoped HOD saw only his own Section, so he could not see the people
 *   in the other Sections of the Department he is accountable for. He had to ask Admin.
 *
 * WHY `viewEmployees` IS A CAPABILITY OF ITS OWN
 *   A Department Head has the department-wide read view but NO employee registration — and he is
 *   refused by `POST /admin/employees` before the route ever runs. Gating the page on
 *   `manageEmployees` would therefore have hidden the screen from him entirely. A separate
 *   capability lets ONE page serve both: HOD keeps the registration form, Department Head sees the
 *   listing alone.
 *
 * Pure on purpose: no database, no environment, so the rule that decides a head's visibility is
 * unit-tested directly rather than inferred from a whole request.
 */

/** Roles that see the whole Department they belong to, regardless of any Section narrowing. */
export const DEPARTMENT_WIDE_EMPLOYEE_LIST_ROLES = ["HOD", "DEPT_HEAD"] as const;

/** Roles whose visibility can be narrowed to a set of Sections (the legacy single-Section column). */
export const SECTION_NARROWED_EMPLOYEE_LIST_ROLES = ["SUPERVISOR"] as const;

export type EmployeeListActor = {
  role: string;
  departmentId: number | null;
  /** The legacy single-Section scope. Used only by the Section-narrowed roles above. */
  sectionId: number | null;
};

export type EmployeeListScope =
  /** No Department filter at all. */
  | { kind: "ALL" }
  /** Every Section of this Department (or nothing, when the account has no Department). */
  | { kind: "DEPARTMENT"; departmentId: number }
  /** That Department AND exactly this Section. */
  | { kind: "DEPARTMENT_SECTION"; departmentId: number; sectionId: number }
  /** Nothing — the account has no usable scope. Never a wider scope than asked for. */
  | { kind: "NONE"; reason: string };

/** True when `role` gets the department-wide listing. */
export function seesWholeDepartment(role: string): boolean {
  return (DEPARTMENT_WIDE_EMPLOYEE_LIST_ROLES as readonly string[]).includes(role);
}

/**
 * The visibility of ONE account over the employee listing.
 *
 * The Department gate comes first and is absolute: a role that is confined to a Department resolves
 * to NONE when the account carries no Department — it must never widen to every department because
 * the mapping is missing.
 */
export function employeeListScopeFor(actor: EmployeeListActor): EmployeeListScope {
  if (seesWholeDepartment(actor.role)) {
    if (actor.departmentId == null) {
      return { kind: "NONE", reason: `${actor.role} has no Department mapping.` };
    }
    return { kind: "DEPARTMENT", departmentId: actor.departmentId };
  }
  if ((SECTION_NARROWED_EMPLOYEE_LIST_ROLES as readonly string[]).includes(actor.role)) {
    if (actor.departmentId == null || actor.sectionId == null) {
      return { kind: "NONE", reason: `${actor.role} has no Department/Section mapping.` };
    }
    return { kind: "DEPARTMENT_SECTION", departmentId: actor.departmentId, sectionId: actor.sectionId };
  }
  return { kind: "ALL" };
}

/**
 * The Prisma `employee` filter for a scope.
 *
 * `NONE` deliberately produces an impossible filter rather than an empty object: `{}` in Prisma
 * means EVERY row, so returning it for an unscoped head would leak the whole company instead of
 * failing closed. This is the same shape `hodEmployeeScopeSet` uses for the null-Department case.
 */
export function employeeListWhere(scope: EmployeeListScope): Record<string, unknown> {
  switch (scope.kind) {
    case "ALL":
      return {};
    case "DEPARTMENT":
      return { departmentId: scope.departmentId };
    case "DEPARTMENT_SECTION":
      return { departmentId: scope.departmentId, sectionAssignment: { sectionId: scope.sectionId } };
    default:
      return { id: -1 };
  }
}
