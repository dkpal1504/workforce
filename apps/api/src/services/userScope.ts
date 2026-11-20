/**
 * The section scope a user may act within, and the rules for WRITING it.
 *
 * Pure on purpose: the sections are passed in as data so the rules are unit-tested without a
 * database. The router layer loads the rows and applies the result.
 *
 * THE RULE THAT MATTERS: every Section in a grant must belong to THAT GRANT'S Department. An HOD may
 * hold several Departments (home plant + a granted second one — see services/hodScope.ts), so the old
 * "one Department only" rule is now "one Department PER GRANT": a cross-Department Section is still
 * refused unless its own Department is granted, and that refusal happens HERE, because a UI-only check
 * is not a check.
 */

import type { ScopeRefusal } from "./userScopeTypes";

export type { ScopeRefusal };

/** Dedupe + order, so the legacy mirror and the stored rows are deterministic. */
export function normaliseSectionIds(ids: readonly number[]): number[] {
  return [...new Set(ids)].sort((a, b) => a - b);
}

/**
 * The legacy `User.sectionId` mirror: the FIRST section, or `null` for department-wide.
 *
 * Kept in sync on every write so un-converted call sites (and an API-only rollback) keep their exact
 * previous behaviour. `null` here means "the whole department", which is also what an EMPTY set
 * means — the two representations have to agree or a rollback changes who can approve.
 */
export function legacySectionId(ids: readonly number[]): number | null {
  return normaliseSectionIds(ids)[0] ?? null;
}

/**
 * The narrowing section ids for a query filter.
 *
 * An EMPTY array means department-wide, and the CALLER must then drop the section filter entirely
 * rather than filter on nothing — `{ in: [] }` matches no rows, which is the opposite of the
 * intent. See `hodEmployeeScopeSet`, which encapsulates that distinction.
 */
export function scopeSectionIds(ids: readonly number[]): number[] {
  return normaliseSectionIds(ids);
}

export type HodGrantRequest = {
  /** The Department this grant covers. */
  departmentId: number;
  /** EMPTY = the whole Department. Otherwise exactly these Sections, each of WHICH MUST be in it. */
  sectionIds: number[];
};

/**
 * Why a set of grants cannot be saved, or null when they can.
 *
 * This replaces "every Section must be in the user's ONE Department" with "every Section must be in
 * ITS OWN grant's Department". That distinction is what lets one HOD head Yardservice - EOU (whole
 * Department) and Yardservice - SEZ (whole Department, or three named Sections) without letting a
 * Section from an ungranted Department slip in — the same fail-closed property as before.
 *
 * Overlap is refused rather than resolved: a Department that is BOTH whole and partial makes "which
 * grant approved this day" unanswerable, and a whole-Department grant already covers every Section.
 */
export function validateHodGrants(
  grants: readonly HodGrantRequest[],
  departments: readonly { id: number; active: boolean }[],
  sections: readonly { id: number; departmentId: number; active: boolean }[],
  labels: { departmentName?: (id: number) => string | undefined; sectionName?: (id: number) => string | undefined } = {}
): ScopeRefusal | null {
  if (grants.length === 0) {
    return {
      code: "SCOPE_REQUIRED",
      error: "Name at least one Department for this HOD. An HOD with no Department matches nothing.",
    };
  }
  const departmentById = new Map(departments.map((department) => [department.id, department]));
  const sectionById = new Map(sections.map((section) => [section.id, section]));
  const seenDepartments = new Set<number>();

  for (const grant of grants) {
    const departmentName = labels.departmentName?.(grant.departmentId) ?? `Department ${grant.departmentId}`;
    if (!Number.isInteger(grant.departmentId) || grant.departmentId <= 0) {
      return { code: "DEPARTMENT_REQUIRED", error: "Every grant needs a Department id." };
    }
    if (seenDepartments.has(grant.departmentId)) {
      return {
        code: "SCOPE_DEPARTMENT_OVERLAP",
        error:
          `${departmentName} appears twice. A Department is either granted in full or by named Sections, never both — ` +
          "the whole-Department grant already covers every Section.",
      };
    }
    seenDepartments.add(grant.departmentId);

    const department = departmentById.get(grant.departmentId);
    if (!department) return { code: "DEPARTMENT_NOT_FOUND", error: `${departmentName} does not exist.` };
    if (!department.active) {
      return { code: "DEPARTMENT_INACTIVE", error: `${departmentName} is inactive. Activate it or choose another.` };
    }

    for (const sectionId of normaliseSectionIds(grant.sectionIds)) {
      const section = sectionById.get(sectionId);
      const sectionLabel = labels.sectionName?.(sectionId) ?? `Section ${sectionId}`;
      if (!section) return { code: "SECTION_NOT_FOUND", error: `${sectionLabel} does not exist.` };
      if (section.departmentId !== grant.departmentId) {
        return {
          code: "SECTION_NOT_IN_GRANTED_DEPARTMENT",
          error: `${sectionLabel} belongs to another Department. Name it under its own grant, or grant that Department too.`,
        };
      }
      if (!section.active) {
        return { code: "SECTION_INACTIVE", error: `${sectionLabel} is inactive. Activate it or choose another.` };
      }
    }
  }
  return null;
}

/**
 * Why a scope cannot be saved, or null when it can.
 *
 * An empty set is always valid: it means every Section of the user's Department.
 */
export function validateScopeSections(
  departmentId: number | null,
  sectionIds: readonly number[],
  sections: readonly { id: number; departmentId: number; active: boolean }[]
): ScopeRefusal | null {
  const wanted = normaliseSectionIds(sectionIds);
  if (wanted.length === 0) return null; // department-wide
  if (departmentId == null) {
    return {
      code: "DEPARTMENT_REQUIRED",
      error: "A Section scope needs a Department. Set the Department first.",
    };
  }
  const byId = new Map(sections.map((section) => [section.id, section]));
  for (const id of wanted) {
    const section = byId.get(id);
    if (!section) {
      return { code: "SECTION_NOT_FOUND", error: `Section ${id} does not exist.` };
    }
    if (section.departmentId !== departmentId) {
      return {
        code: "SECTION_NOT_IN_DEPARTMENT",
        error:
          `Section ${id} belongs to another Department. A Section Head can only cover Sections of ` +
          "their own Department.",
      };
    }
    if (!section.active) {
      return { code: "SECTION_INACTIVE", error: `Section ${id} is inactive. Activate it or choose another.` };
    }
  }
  return null;
}
