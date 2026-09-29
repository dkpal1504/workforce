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

/** One row of the picker, as returned by GET /api/admin/role-assignment. */
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
};

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
