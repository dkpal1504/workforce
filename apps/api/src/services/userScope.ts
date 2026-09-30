/**
 * The section scope a user may act within, and the rules for WRITING it.
 *
 * Pure on purpose: the sections are passed in as data so the rules are unit-tested without a
 * database. The router layer loads the rows and applies the result.
 *
 * THE RULE THAT MATTERS: every section in a scope must belong to the user's OWN department. An
 * HOD is single-Department by design (the user's own simplification), so a cross-department
 * section has to be refused — and refused HERE, because a UI-only check is not a check.
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
