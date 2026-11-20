/**
 * An approver's AUTHORITY as a set of grants: which Departments an HOD heads, and — inside a
 * Department — either every Section or a named list.
 *
 * Pure on purpose: no `prisma` import, so every rule here is unit-tested
 * (`hodScope.test.ts`) instead of being proved on a live queue.
 *
 * WHY A SET OF GRANTS RATHER THAN A DEPARTMENT + SECTION LIST
 * The one-Department model (`User.departmentId` + `UserScopeSection`) cannot express "he heads
 * Yardservice - EOU AND Yardservice - SEZ": a plant is only a suffix on Department, so two plants
 * are two Departments, and one scalar cannot be two things. A grant set is the same authority the
 * old pair described when it holds exactly one grant, which is why every existing account keeps its
 * exact behaviour with no backfill — see `hodScopeFromRows`.
 *
 * The shape is deliberately the OLD shape repeated:
 *   { departmentId, sectionIds: [] }  -> the whole Department (unchanged semantics: `[]` = all Sections)
 *   { departmentId, sectionIds: [8] } -> exactly those Sections of that Department
 */

import { normaliseSectionIds } from "./userScope";

/** One Department this account heads. `sectionIds` EMPTY means every Section of that Department. */
export type HodGrant = { departmentId: number; sectionIds: readonly number[] };

/** Every Department an approver heads. EMPTY grants match nothing (fail closed). */
export type HodScope = { grants: readonly HodGrant[] };

/** A scope with no authority at all — matches nothing. */
export const EMPTY_HOD_SCOPE: HodScope = { grants: [] };

/**
 * The single-Department scope of an account that has never been given a second one.
 *
 * This is the compatibility keystone: every legacy caller (`hodRoutingScope(departmentId,
 * sectionIds)` and friends) is expressed through it, so there is exactly one implementation of the
 * matching rule and no second, drifting copy.
 */
export function hodScopeFromLegacy(
  departmentId: number | null,
  sectionIds: readonly number[]
): HodScope {
  if (departmentId == null) return EMPTY_HOD_SCOPE;
  return { grants: [{ departmentId, sectionIds: normaliseSectionIds(sectionIds) }] };
}

/**
 * The scope an account ACTUALLY has, from the rows the database holds.
 *
 * Precedence, and why it is this order:
 *   1. `user_scope_departments` rows are whole-Department grants.
 *   2. `user_scope_sections` rows are named Sections, grouped by the DEPARTMENT EACH SECTION BELONGS
 *      TO (not by the account's `departmentId` — that assumption is exactly what this change removes).
 *      A Department that already has a whole-Department grant is SKIPPED here: the write path refuses
 *      that overlap (`SCOPE_DEPARTMENT_OVERLAP`), but a stale row must not double-count.
 *   3. NO rows anywhere -> today's meaning of "this Department and every Section of it", from the
 *      legacy scalar. That is what makes the migration zero-touch for existing accounts.
 *
 * `legacySectionId` is only consulted in step 3, mirroring how `middleware/auth.ts` has always
 * treated the scalar: rows win, the mirror is a fallback.
 */
export function hodScopeFromRows(input: {
  departmentId: number | null;
  legacySectionId: number | null;
  departmentGrants: readonly number[];
  sectionRows: readonly { sectionId: number; departmentId: number }[];
}): HodScope {
  const wholeDepartments = [...new Set(input.departmentGrants)].filter((id) => Number.isInteger(id) && id > 0);
  const namedByDepartment = new Map<number, number[]>();
  for (const row of input.sectionRows) {
    if (wholeDepartments.includes(row.departmentId)) continue; // whole wins; never double-count
    const current = namedByDepartment.get(row.departmentId) ?? [];
    current.push(row.sectionId);
    namedByDepartment.set(row.departmentId, current);
  }

  if (wholeDepartments.length === 0 && namedByDepartment.size === 0) {
    return hodScopeFromLegacy(input.departmentId, input.legacySectionId != null ? [input.legacySectionId] : []);
  }

  const grants: HodGrant[] = [
    ...wholeDepartments.map((departmentId) => ({ departmentId, sectionIds: [] as number[] })),
    ...[...namedByDepartment.entries()].map(([departmentId, sectionIds]) => ({
      departmentId,
      sectionIds: normaliseSectionIds(sectionIds),
    })),
  ];
  return { grants: grants.sort((left, right) => left.departmentId - right.departmentId) };
}

/** Two scopes confer the same authority, order-insensitively. Drives the NO_CHANGE guard. */
export function sameHodScope(left: HodScope, right: HodScope): boolean {
  if (left.grants.length !== right.grants.length) return false;
  const key = (grant: HodGrant) =>
    `${grant.departmentId}:${normaliseSectionIds(grant.sectionIds).join(",")}`;
  const leftKeys = left.grants.map(key).sort();
  const rightKeys = right.grants.map(key).sort();
  return leftKeys.every((value, index) => value === rightKeys[index]);
}

/** The Departments in the scope, for pickers, filters and export headers. Sorted, deduped. */
export function hodScopeDepartmentIds(scope: HodScope): number[] {
  return [...new Set(scope.grants.map((grant) => grant.departmentId))].sort((a, b) => a - b);
}

/** Every Section the scope names explicitly. Empty when every grant is whole-Department. */
export function hodScopeNamedSectionIds(scope: HodScope): number[] {
  return normaliseSectionIds(scope.grants.flatMap((grant) => [...grant.sectionIds]));
}

/**
 * A scope in words, for audit rows and refusal messages: "Yardservice - EOU (all Sections);
 * Yardservice - SEZ (Operation, Maintenance)".
 *
 * Never prints ids alone: an operator reading an audit trail knows the yard's names, not Section 45.
 */
export function describeHodScope(
  scope: HodScope,
  departmentName: (id: number) => string | undefined,
  sectionName: (id: number) => string | undefined
): string {
  if (scope.grants.length === 0) return "no Department (matches nothing)";
  return scope.grants
    .map((grant) => {
      const department = departmentName(grant.departmentId) ?? `Department ${grant.departmentId}`;
      if (grant.sectionIds.length === 0) return `${department} (all Sections)`;
      const sections = grant.sectionIds
        .map((id) => sectionName(id) ?? `Section ${id}`)
        .join(", ");
      return `${department} (${sections})`;
    })
    .join("; ");
}
