/**
 * Pure rules for the Role Assignment panel.
 *
 * Kept out of the page because three things here are easy to get wrong and expensive to get
 * wrong in the browser:
 *  - the person picker now holds TWO kinds of row (an account, and an Employee with no
 *    account yet) in one list, so the selection value has to encode which kind it is;
 *  - "did the Admin actually change something" decides whether the Update button is live,
 *    and an Employee row has no current role at all;
 *  - the sentence the operator reads back at the gate (which identifier, which password).
 *
 * The ROLE policy is deliberately NOT duplicated here: the API sends `creatableRoles` and a
 * per-role refusal sentence, so the panel can never offer a role the API would then reject.
 */

export type PersonKind = "ACCOUNT" | "EMPLOYEE";

/**
 * One row of the picker, as returned by GET /api/admin/role-assignment.
 */
export type PersonRow = {
  kind: PersonKind;
  id: number;
  name: string;
  ecNo: string | null;
  /** The role the account already holds; null for an Employee that has no account. */
  currentRole: string | null;
  employmentType: string | null;
  designation: string | null;
  department: { id: number; name: string } | null;
  section: { id: number; name: string } | null;
  active: boolean;
  self: boolean;
  /** For an EMPLOYEE row: the roles this screen may CREATE for them. */
  creatableRoles: string[];
  /** For an EMPLOYEE row: the server's own reason per refused role. */
  roleRefusals: Record<string, string>;
  hodScope: "SECTION" | "DEPARTMENT" | null;
  /**
   * The Sections this account heads, as the server stores them. EMPTY means the whole Department.
   *
   * `hodScope` alone cannot express this: it reads SECTION for ANY non-null mirror, so a Head of
   * two Sections would look like a Head of one and the panel would silently narrow him on the
   * next save.
   */
  scopeSections?: number[];
  /**
   * Work the SERVER says would block the change — computed from the same numbers its guards use.
   *
   * WHY THE PANEL NEEDS THESE
   *   The API refuses a move with `OPEN_APPROVALS` / `OPEN_TIMESHEETS` and a readable sentence, but
   *   that sentence is only seen AFTER the click, as a banner at the very top of the page while the
   *   Update button is far below it. A blocked move therefore looks exactly like a change that did
   *   not happen: the operator clicks, nothing visibly moves, and the person still shows the old
   *   role. That is the reported bug ("I reassign an HOD as an Employee and he is always shown as
   *   HOD"). With the counts here the refusal is explained BEFORE the click, and the reason stays
   *   beside the button afterwards.
   */
  blockers: { pendingApprovals: number; returnedTimesheetDays: number };
};

/** The blockers a row carries, defaulted for a row from an older payload or a test fixture. */
function blockersOf(row: PersonRow): { pendingApprovals: number; returnedTimesheetDays: number } {
  return { pendingApprovals: row.blockers?.pendingApprovals ?? 0, returnedTimesheetDays: row.blockers?.returnedTimesheetDays ?? 0 };
}

/** Roles that must not be left while approval work is still queued to them (mirrors APPROVER_ROLES). */
const APPROVER_ROLES: string[] = ["HOD", "PM", "ADMIN"];
/** Roles that must not be left while timesheets they own are back for correction. */
const CAPTURE_ROLES: string[] = ["SUPERVISOR"];


export function rowKey(kind: PersonKind, id: number): string {
  return `${kind}:${id}`;
}

/**
 * Decode a picker value. An empty or malformed value means "nobody selected" rather than
 * throwing, and never silently resolves to the first person in the list.
 */
export function parseSelection(value: string): { kind: PersonKind; id: number } | null {
  const [kind, rawId] = String(value ?? "").split(":");
  if (kind !== "ACCOUNT" && kind !== "EMPLOYEE") return null;
  const id = Number(rawId);
  return Number.isInteger(id) && id > 0 ? { kind, id } : null;
}

export function findSelection(rows: PersonRow[], value: string): PersonRow | null {
  const parsed = parseSelection(value);
  if (!parsed) return null;
  return rows.find((row) => row.kind === parsed.kind && row.id === parsed.id) ?? null;
}

/**
 * Work that will make the server REFUSE this move, explained before the click.
 *
 * Mirrors `planRoleChange` exactly, including the fact that these guards fire only when the ROLE
 * actually changes — raising an HOD's scope from Section to Department is the same role and is
 * never blocked by a queue. Returns null when the move is clear, so the caller can tell
 * "no blockers" from "not checked".
 *
 * A reason is a sentence, because it is shown verbatim beside the button and under the role tick.
 */
export function roleChangeBlockers(row: PersonRow, pickedRole: string): string | null {
  if (!row || !pickedRole) return null;
  if (row.kind !== "ACCOUNT") return null; // No role yet, so no queue and no owned timesheets.
  if (pickedRole === row.currentRole) return null; // Same role: scope-only moves are never blocked.
  const blockers = blockersOf(row);
  if (APPROVER_ROLES.includes(row.currentRole ?? "") && blockers.pendingApprovals > 0) {
    return `Blocked: ${blockers.pendingApprovals} timesheet day(s) are still waiting in this account's approval queue. They must be approved, sent back, or covered (Approvals → arrange cover / delegations) before the role can change.`;
  }
  if (CAPTURE_ROLES.includes(row.currentRole ?? "") && blockers.returnedTimesheetDays > 0) {
    return `Blocked: ${blockers.returnedTimesheetDays} timesheet(s) this account submitted were returned for correction. They must be resubmitted or resolved before the role can change.`;
  }
  return null;
}

/** Is this exact move allowed right now? The inverse of `roleChangeBlockers`, for the button. */
export function roleChangeAllowed(row: PersonRow, pickedRole: string): boolean {
  return changePending(row, pickedRole, row.hodScope ?? "SECTION") && roleChangeBlockers(row, pickedRole) === null;
}

/**
 * Work the operator could clear to unblock the move, counted across the whole list.
 *
 * `targetId` is excluded: an approver's queue is keyed on department+section, not on the person, so
 * the days the server counts for a Section HOD can legitimately include days tagged by ANOTHER
 * approver of the same section. Telling the operator "clear the queue" is only useful if it also
 * says whether any of that work is actually theirs.
 */
export function unblocksByApprovingOthers(rows: PersonRow[], targetId: number, pickedRole: string): number {
  const reason = roleChangeBlockers(rows.find((row) => row.id === targetId) ?? ({} as PersonRow), pickedRole);
  if (!reason || !/approval queue/.test(reason)) return 0;
  return rows.filter((row) => row.kind === "ACCOUNT" && row.id !== targetId && APPROVER_ROLES.includes(row.currentRole ?? "")).length;
}

/** The identifier the person will actually sign in with. EC No for every role offered here. */
export function loginFor(row: PersonRow): string {
  if (row.currentRole && !["EMPLOYEE", "SUPERVISOR", "HOD", "DEPT_HEAD", "PM"].includes(row.currentRole)) {
    return row.ecNo ? row.ecNo : "their e-mail address";
  }
  return row.ecNo ?? (row.currentRole ? "their e-mail address" : "—");
}

/**
 * Is there a real change to apply?
 *
 * An Employee with no account always has one (they are about to GET the role), so a picked
 * role there is never a no-op — unlike an account, where re-picking its own role changes
 * nothing and the API answers NO_CHANGE.
 */
export function changePending(
  row: PersonRow | null,
  pickedRole: string,
  pickedScope: "SECTION" | "DEPARTMENT"
): boolean {
  if (!row || !pickedRole || row.self || !row.active) return false;
  if (row.kind === "EMPLOYEE") return true;
  if (pickedRole !== row.currentRole) return true;
  return pickedRole === "HOD" && pickedScope !== (row.hodScope ?? "SECTION");
}

/** Roles the tick list enables for this row, and the server's reason for each disabled one. */
export function roleTicks<T extends string>(
  row: PersonRow,
  assignableRoles: T[]
): { role: T; enabled: boolean; reason: string | null }[] {
  return assignableRoles.map((role) => {
    if (row.kind === "ACCOUNT") return { role, enabled: true, reason: null };
    const enabled = row.creatableRoles.includes(role);
    return {
      role,
      enabled,
      reason: enabled ? null : row.roleRefusals[role] ?? `Not available for ${row.name}.`,
    };
  });
}

/** The line above the tick list, which differs because the two rows do different things. */
export function targetSummary(row: PersonRow): string {
  const where = [row.department?.name, row.section?.name].filter(Boolean).join(" · ");
  const who = [row.ecNo, row.name, row.designation, row.employmentType].filter(Boolean).join(" · ");
  const state = row.kind === "EMPLOYEE"
    ? "no login yet — assigning a role creates one"
    : `currently ${row.currentRole}${row.hodScope ? ` (${row.hodScope === "DEPARTMENT" ? "Department-level" : "Section-level"})` : ""}`;
  return [who, where, state].filter(Boolean).join(" — ");
}

/**
 * What the operator reads after a successful assignment. A created account names the login and
 * the first password, because that is the whole point of the action: the person is standing at
 * the gate and has to be told what to type.
 */
export function assignmentNotice(
  row: PersonRow,
  role: string,
  scope: "SECTION" | "DEPARTMENT",
  accountCreated: boolean,
  firstPassword: string
): string {
  const roleText = role + (role === "HOD" ? ` (${scope === "DEPARTMENT" ? "Department-wide, no Section" : "Section-scoped"})` : "");
  if (accountCreated) {
    return `${row.name} is now ${roleText}, and a login was created. They sign in with EC No ${row.ecNo} and the first password ${firstPassword}, and must set their own password at that first login.`;
  }
  return `${row.name} is now ${roleText}. Their sessions were revoked, so they take the new screens on their next login.`;
}

/**
 * The Sections the panel should PRE-TICK for an account.
 *
 * An account migrated before this feature has no rows, and its scope is then whatever its legacy
 * mirror says — the exact fallback `requireAuth` applies, restated here so the panel and the API
 * can never disagree about what a half-migrated account covers.
 */
export function deriveScopeSections(row: Pick<PersonRow, "hodScope" | "scopeSections" | "section">): number[] {
  if (row.scopeSections && row.scopeSections.length > 0) return [...row.scopeSections].sort((a, b) => a - b);
  if (row.hodScope === "DEPARTMENT") return [];
  return row.section ? [row.section.id] : [];
}

/**
 * The legacy scope word for a picked SET. One direction only: set -> scalar.
 *
 * It exists so the already-tested `changePending` / `assignmentNotice` / `targetSummary` keep
 * working unchanged. Deriving the SET from this scalar would be the bug — the mirror is the
 * first Section, so it cannot tell a two-Section Head from a one-Section Head.
 */
export function hodScopeFromPicked(sectionIds: readonly number[]): "SECTION" | "DEPARTMENT" {
  return sectionIds.length === 0 ? "DEPARTMENT" : "SECTION";
}

/**
 * Does this picked SET differ from what the account already has?
 *
 * Order-insensitive and compared as SETS, mirroring the API's own NO_CHANGE guard: re-ticking the
 * same Sections in a different order is not a change, and dropping one from the middle IS.
 */
export function scopeSelectionDiffers(row: Pick<PersonRow, "hodScope" | "scopeSections" | "section">, pickedIds: readonly number[]): boolean {
  const current = deriveScopeSections(row);
  const next = [...new Set(pickedIds)].sort((a, b) => a - b);
  return current.length !== next.length || current.some((id, index) => id !== next[index]);
}

/**
 * The sentence beside the tick list: what these ticks will actually do.
 *
 * The operator should not have to infer it. A department-wide scope is stated in words rather
 * than shown as an empty list, because "nothing ticked" reads as "nothing selected yet".
 */
export function scopeConsequence(
  sectionIds: readonly number[],
  names: (id: number) => string | null
): string {
  if (sectionIds.length === 0) return "Approves timesheets from every Section of this Department.";
  const labels = [...sectionIds].sort((a, b) => a - b).map((id) => names(id) ?? `Section ${id}`);
  return `Approves timesheets from ${labels.join(" and ")}.`;
}