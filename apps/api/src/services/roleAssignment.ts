/**
 * Role assignment rules (ADMIN-only).
 *
 * One active role per account: an Admin moves a person between roles, and the
 * account's Department/Section are inherited from the payroll or CLMS Employee it
 * is already linked to — the Admin never re-selects them.
 *
 * Pure on purpose: every guard is decided from data passed in, so the rules are
 * unit-tested without a database. The route layer loads the counts and applies the
 * returned `update`.
 */
import { legacySectionId, normaliseSectionIds, validateScopeSections } from "./userScope";

export const ASSIGNABLE_ROLES = ["EMPLOYEE", "SUPERVISOR", "HOD", "DEPT_HEAD", "PM", "ADMIN", "HR", "FINANCE", "COO"] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

/** Roles that capture a team and fill timesheets for contract (CLMS) labour. */
export const CAPTURE_ROLES: string[] = ["SUPERVISOR"];
/** Roles that approve, so outstanding approval work blocks a move off them. */
export const APPROVER_ROLES: string[] = ["HOD", "PM", "ADMIN"];
/** Roles that need to be linked to a person (they report on or act for real labour). */
export const EMPLOYEE_LINKED_ROLES: string[] = ["EMPLOYEE", "SUPERVISOR", "HOD", "DEPT_HEAD", "PM"];
/**
 * Organisation-wide roles: they read or administer the WHOLE organisation and act for no single
 * person, so they need no Employee record and ALWAYS get `sectionId = null`. The COO belongs here
 * for the same reason as ADMIN/HR/FINANCE — it is the operations dashboard role, scoped to the
 * entire portfolio, never to one Department or Section.
 */
export const ORGANISATION_WIDE_ROLES: string[] = ["ADMIN", "HR", "FINANCE", "COO"];

export type RoleTargetEmployee = {
  id: number;
  active: boolean;
  employmentType: string;
  departmentId: number;
} | null;

/**
 * How wide an HOD scope is.
 *   SECTION    - the existing behaviour: the Section of the linked Employee.
 *   DEPARTMENT - whole-Department oversight: every Section under its Department.
 * Both are role HOD; only the stored Section scope differs, which is exactly the
 * distinction the approval and summary scopes already key off.
 */
export type HodScope = "SECTION" | "DEPARTMENT";

export function isHodScope(value: unknown): value is HodScope {
  return value === "SECTION" || value === "DEPARTMENT";
}

export type RoleTarget = {
  id: number;
  name: string;
  role: string;
  active: boolean;
  /** The account's stored Section scope; null means a Department-level HOD. */
  currentSectionId: number | null;
  /**
   * The Sections the account ALREADY heads. EMPTY means department-wide (which is what
   * `currentSectionId === null` means) — the set and the scalar must always agree.
   */
  currentSectionIds: readonly number[];
  employeeId: number | null;
  employee: RoleTargetEmployee;
  /** The linked Employee's Section assignment, if any. */
  sectionAssignment: { sectionId: number; sectionActive: boolean; sectionDepartmentId: number } | null;
};

export type OpenWorkload = {
  /**
   * Timesheet days returned to this account for rework (PLANNING_RETURNED) — the
   * only timesheet state that needs a supervisor to still be a supervisor. Already
   * SUBMITTED/approved days are owned by the approver, not by this role, so they
   * must NOT block a move or nobody with any history could ever be reassigned.
   */
  returnedTimesheetDays: number;
  /** Days waiting in the approval queue this role must action (see route). */
  pendingApprovals: number;
};

export type RoleChangePlan =
  | {
      ok: true;
      update: {
        role: AssignableRole;
        departmentId: number | null;
        /** The Sections an HOD heads. EMPTY = the whole Department. Always [] for other roles. */
        sectionIds: number[];
        /** The legacy mirror: the first of `sectionIds`, or null. */
        sectionId: number | null;
      };
    }
  | { ok: false; code: string; error: string };

export function isAssignableRole(role: unknown): role is AssignableRole {
  return typeof role === "string" && (ASSIGNABLE_ROLES as readonly string[]).includes(role);
}

/**
 * An Employee record as Role Assignment sees it, whether or not it already has an account.
 *
 * `ecNo` is nullable because a hand-created row can lack one, and every role that signs in
 * with an EC No would then be unreachable — a login nobody can use is worse than a refusal.
 */
export type RoleSourceEmployee = {
  id: number;
  ecNo: string | null;
  name: string;
  active: boolean;
  employmentType: string;
  departmentId: number;
};

/**
 * Roles that may be CREATED for an Employee that has no account yet.
 *
 * Deliberately narrower than ASSIGNABLE_ROLES:
 *  - EMPLOYEE and SUPERVISOR are the two roles a payroll OR contract employee can hold with
 *    no extra data: both sign in with the EC No and both are scoped to the Department on the
 *    Employee record. This is what makes a blue-collar (CLMS) worker selectable as a
 *    Supervisor.
 *  - HOD and DEPT_HEAD add approval power and are PAYROLL-only, for the same reason
 *    `POST /api/admin/hods` refuses a CLMS worker (`INVALID_EMPLOYEE`): an approver scope is
 *    an organisation mapping a contract row does not reliably carry.
 *  - PM, HR, FINANCE and ADMIN are not Employee roles at all (they are organisation-wide
 *    logins), so they are never created from an Employee record. That account is created
 *    first and then re-roled here — which is what a promoted payroll employee already does.
 */
export function creatableRolesFor(employee: RoleSourceEmployee): AssignableRole[] {
  if (!employee.active || !employee.ecNo) return [];
  return employee.employmentType === "PAYROLL"
    ? ["EMPLOYEE", "SUPERVISOR", "HOD", "DEPT_HEAD"]
    : ["EMPLOYEE", "SUPERVISOR"];
}

/**
 * Why an Employee may not be given `requestedRole` as a NEW account, or null when it may.
 *
 * Refusals name the rule and the next step, because every one of these is a real
 * conversation at the yard gate ("he is contract labour, he cannot be an HOD") rather than a
 * silent no-op. A role that IS creatable still has to pass `planRoleChange` for its scope.
 */
export function refusalForRoleCreation(
  employee: RoleSourceEmployee,
  requestedRole: unknown
): { code: string; error: string } | null {
  if (!isAssignableRole(requestedRole)) {
    return { code: "INVALID_ROLE", error: `Role must be one of ${ASSIGNABLE_ROLES.join(", ")}.` };
  }
  if (!employee.active) {
    return {
      code: "EMPLOYEE_INACTIVE",
      error: `${employee.name} is an inactive Employee. Reactivate the Employee before creating a login for them.`,
    };
  }
  if (!employee.ecNo) {
    return {
      code: "EMPLOYEE_ECNO_REQUIRED",
      error: `${employee.name} has no EC No, so no login can be created. Correct the Employee record first.`,
    };
  }
  if (creatableRolesFor(employee).includes(requestedRole)) return null;
  if ((requestedRole === "HOD" || requestedRole === "DEPT_HEAD") && employee.employmentType !== "PAYROLL") {
    return {
      code: "ROLE_REQUIRES_PAYROLL_EMPLOYEE",
      error:
        `${requestedRole} needs a payroll (white-collar) Employee. ${employee.name} is contract labour, ` +
        "so they can be a Supervisor or an Employee — register them as a payroll Employee first for anything above that.",
    };
  }
  return {
    code: "ROLE_NOT_CREATABLE_FOR_EMPLOYEE",
    error:
      `${requestedRole} is not created from an Employee record: that account is organisation-wide. ` +
      "Create the account first, then assign the role here.",
  };
}

/**
 * The RoleTarget for an Employee that has no account YET.
 *
 * Its only purpose is that the FIRST assignment goes through the same `planRoleChange` as
 * every later one, so HOD scope, Department inheritance and the guard rails cannot drift
 * into a second implementation. `id` is negative on purpose: it can never collide with a
 * real User id, so the Admin can never be mistaken for the target of their own click.
 */
export function roleTargetForNewAccount(
  employee: RoleSourceEmployee,
  sectionAssignment: { sectionId: number; sectionActive: boolean; sectionDepartmentId: number } | null
): RoleTarget {
  return {
    id: -employee.id,
    name: employee.name,
    role: "NONE",
    active: employee.active,
    currentSectionId: null,
    // A brand-new account heads nothing yet; the requested set is applied by the route.
    currentSectionIds: [],
    employeeId: employee.id,
    employee: {
      id: employee.id,
      active: employee.active,
      employmentType: employee.employmentType,
      departmentId: employee.departmentId,
    },
    sectionAssignment,
  };
}

/**
 * The section SET a request is asking for, before any scope is VALIDATED.
 *
 * Kept separate from validation on purpose: a malformed request must be refused early (a
 * `sectionIds: "abc"` is not "already has the role"), while the scope rules run where they
 * always have — after the workload guards — so error precedence does not move.
 *
 * Three inputs are accepted, in order:
 *   `sectionIds: number[]`   the API. EMPTY means department-wide.
 *   `hodScope`               DEPRECATED alias, kept for one release so an in-flight client
 *                            cannot silently lose its scope.
 *   neither                  today's behaviour: the Employee's own Section, or department-wide
 *                            when they have no assignment.
 */
function projectHodSectionIds(
  options: {
    hodScope?: unknown;
    sectionIds?: unknown;
    sections?: readonly { id: number; departmentId: number; active: boolean }[];
  },
  target: RoleTarget
): { ok: true; sectionIds: number[] } | { ok: false; code: string; error: string } {
  if (options.hodScope !== undefined && !isHodScope(options.hodScope)) {
    return { ok: false, code: "INVALID_HOD_SCOPE", error: "HOD scope must be SECTION or DEPARTMENT." };
  }
  if (options.sectionIds !== undefined) {
    if (!Array.isArray(options.sectionIds)) {
      return { ok: false, code: "INVALID_HOD_SCOPE", error: "sectionIds must be an array of Section ids. Send [] for every Section of the Department." };
    }
    const ids = options.sectionIds.map((value) => Number(value));
    if (ids.some((id) => !Number.isInteger(id) || id <= 0)) {
      return { ok: false, code: "INVALID_HOD_SCOPE", error: "sectionIds must contain Section ids only." };
    }
    return { ok: true, sectionIds: normaliseSectionIds(ids) };
  }
  if (options.hodScope === "DEPARTMENT") return { ok: true, sectionIds: [] };
  if (options.hodScope === "SECTION") {
    // The alias could only ever name the Employee's one Section, and an Employee with none was
    // an ERROR here (`!target.sectionAssignment` used to fall through to department-wide only
    // when hodScope was absent). Keeping the refusal stops the alias quietly widening a scope.
    if (!target.sectionAssignment) {
      return { ok: false, code: "INVALID_HOD_SCOPE", error: "A SECTION scope needs the Employee to have a Section assignment. Assign one, or send sectionIds." };
    }
    return { ok: true, sectionIds: [target.sectionAssignment.sectionId] };
  }
  return { ok: true, sectionIds: target.sectionAssignment ? [target.sectionAssignment.sectionId] : [] };
}

/** Two section sets are the same scope, order-insensitively. */
function sameSectionSets(a: readonly number[], b: readonly number[]): boolean {
  const left = normaliseSectionIds(a);
  const right = normaliseSectionIds(b);
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/**
 * Decide whether `actorId` may move `target` to `requestedRole`, and what the
 * account's organisation scope becomes. Returns a refusal code rather than
 * throwing so the route can map it straight to an HTTP status.
 */
export function planRoleChange(
  actorId: number,
  target: RoleTarget,
  requestedRole: unknown,
  workload: OpenWorkload,
  options: {
    /** DEPRECATED: use `sectionIds`. */
    hodScope?: unknown;
    /** The Sections an HOD heads. EMPTY = every Section of the Employee's Department. */
    sectionIds?: unknown;
    /** The candidate Sections, so the same-department rule is checked here and not only in the UI. */
    sections?: readonly { id: number; departmentId: number; active: boolean }[];
  } = {},
): RoleChangePlan {
  if (!isAssignableRole(requestedRole)) {
    return { ok: false, code: "INVALID_ROLE", error: `Role must be one of ${ASSIGNABLE_ROLES.join(", ")}.` };
  }
  if (!target.active) {
    return { ok: false, code: "ACCOUNT_INACTIVE", error: "This account is inactive. Reactivate it before changing its role." };
  }
  // Guard rail: an Admin must not change their own role, or a single click could
  // remove the last Admin's access to this panel.
  if (target.id === actorId) {
    return { ok: false, code: "SELF_ROLE_CHANGE", error: "You cannot change your own role. Ask another Admin." };
  }
  // A malformed section request is refused before anything else is judged: reporting it as
  // "already has the role" would be a lie about a request that was never understood.
  const hodRequest = requestedRole === "HOD" ? projectHodSectionIds(options, target) : null;
  if (hodRequest && !hodRequest.ok) return hodRequest;
  // A role change with no scope change is a no-op (an HOD moving Section -> Department
  // is NOT one: same role, different scope, so it must be allowed through).
  // For an HOD the resulting scope is the SET; every other role keeps a null Section.
  // The comparison is between SETS, not scalars: `[103, 210]` and `[210, 103]` are the same
  // scope, and comparing the legacy mirror would call a reordering a change (and the reverse).
  const resultingSectionIds = hodRequest?.ok ? hodRequest.sectionIds : [];
  const resultingSectionId = requestedRole === "HOD"
    ? legacySectionId(resultingSectionIds)
    : (ORGANISATION_WIDE_ROLES.includes(requestedRole) || requestedRole === "DEPT_HEAD")
      ? null
      : requestedRole === "SUPERVISOR" || requestedRole === "PM" ? null
        : target.sectionAssignment?.sectionId ?? null;
  const scopeOnlyChange =
    target.role === "HOD" && requestedRole === "HOD" && !sameSectionSets(target.currentSectionIds, resultingSectionIds);
  if (target.role === requestedRole && !scopeOnlyChange) {
    return { ok: false, code: "NO_CHANGE", error: `This account already has the ${requestedRole} role.` };
  }

  // Moving off an approver leaves work stranded in a queue nobody owns.
  if (target.role !== requestedRole && APPROVER_ROLES.includes(target.role) && workload.pendingApprovals > 0) {
    return {
      ok: false,
      code: "OPEN_APPROVALS",
      error: `This account has ${workload.pendingApprovals} pending approval(s). Clear them or arrange cover before changing the role.`,
    };
  }
  // Moving off a capturing role would strand timesheets that were sent back for
  // rework, because only a supervisor can resubmit them.
  if (CAPTURE_ROLES.includes(target.role) && workload.returnedTimesheetDays > 0) {
    return {
      ok: false,
      code: "OPEN_TIMESHEETS",
      error: `This account has ${workload.returnedTimesheetDays} timesheet(s) returned for correction. Resolve them before changing the role.`,
    };
  }

  const employee = target.employee;

  // Operational roles capture work for real people, so they need an active linked
  // Employee. The pay type does not matter: a payroll employee and a contract
  // (CLMS) supervisor are equally assignable.
  if (EMPLOYEE_LINKED_ROLES.includes(requestedRole)) {
    if (target.employeeId == null || !employee) {
      return {
        ok: false,
        code: "EMPLOYEE_REQUIRED",
        error: `${requestedRole} needs an Employee record. Link this account to an Employee first.`,
      };
    }
    if (!employee.active) {
      return { ok: false, code: "EMPLOYEE_INACTIVE", error: "The linked Employee is inactive. Reactivate it before assigning this role." };
    }
  }

  // HOD is scoped to exactly one Department + Section: take both from the
  // Employee's existing mapping (never from the request) so the panel cannot
  // create a scope the person does not actually belong to. Section is optional —
  // an Employee still awaiting a Section assignment is treated as a
  // Department-wide HOD in that Department.
  // A Department Head is the department-wide view WITHOUT approval rights: same
  // Department as the linked Employee, deliberately no Section scope.
  if (requestedRole === "DEPT_HEAD") {
    return { ok: true, update: { role: "DEPT_HEAD", departmentId: employee!.departmentId, sectionIds: [], sectionId: null } };
  }

  if (requestedRole === "HOD") {
    // A Department-wide HOD still needs a Department: an EMPTY set with no Department would be
    // an approver scoped to everything, which is the one reading this must never produce.
    const departmentId = employee!.departmentId;
    if (departmentId == null) {
      return { ok: false, code: "INVALID_HOD_SCOPE", error: "The linked Employee has no Department. Correct the mapping first." };
    }
    const wanted = (hodRequest as { ok: true; sectionIds: number[] }).sectionIds;
    // Validation follows the INPUT, and the two inputs carry their own evidence:
    //   an explicit `sectionIds`      is checked against the candidate Sections the caller loaded,
    //                                 which is what makes the same-department rule real;
    //   an INHERITED scope (no option) copies the Employee's own assignment, already validated;
    //   the DEPRECATED alias          is exactly that inherited single Section.
    // Checking the inherited cases against `options.sections` would refuse every pre-existing
    // caller that does not pass a candidate list, which is precisely this change's regression risk.
    const isInherited = options.sectionIds === undefined;
    if (isInherited) {
      if (wanted.length === 1 && target.sectionAssignment) {
        const assignment = target.sectionAssignment;
        if (!assignment.sectionActive || assignment.sectionDepartmentId !== departmentId) {
          return {
            ok: false,
            code: "INVALID_HOD_SCOPE",
            error: "The Employee's Section is inactive or belongs to another Department. Correct the mapping first.",
          };
        }
      }
    } else {
      // The same-department rule is enforced HERE as well as in the UI, because a UI-only check
      // is not a check. An inactive or foreign Section is named in the refusal.
      const refusal = validateScopeSections(departmentId, wanted, options.sections ?? []);
      if (refusal) return { ok: false, code: refusal.code, error: refusal.error };
    }
    return {
      ok: true,
      update: {
        role: "HOD",
        departmentId,
        sectionIds: normaliseSectionIds(wanted),
        sectionId: legacySectionId(wanted),
      },
    };
  }

  // SUPERVISOR is authorised at Department level (like every existing supervisor):
  // the Department comes from the linked Employee, and the Section picker on the
  // capture screen offers that Department's Sections.
  if (requestedRole === "SUPERVISOR") {
    return { ok: true, update: { role: "SUPERVISOR", departmentId: employee!.departmentId, sectionIds: [], sectionId: null } };
  }

  if (requestedRole === "EMPLOYEE" || requestedRole === "PM") {
    return { ok: true, update: { role: requestedRole, departmentId: employee!.departmentId, sectionIds: [], sectionId: null } };
  }

  // ADMIN / HR / FINANCE / COO are organisation-wide and need no Employee linkage. A linked
  // Employee's Department is kept only as a display fact; the Section scope is always null
  // because these roles are never narrowed below the whole organisation.
  return { ok: true, update: { role: requestedRole, departmentId: employee?.departmentId ?? null, sectionIds: [], sectionId: null } };
}
