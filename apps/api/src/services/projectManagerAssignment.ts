/**
 * Project Manager assignment — the DECISION, as a pure function.
 *
 * The router cannot be unit-tested in this repo (the suite collects `src/services/*.test.ts` and no
 * test opens a database), so every refusal and every create/reuse branch lives here, where it is
 * tested. The route only reads the two rows, calls this, and performs what it is told.
 *
 * RULES, each with its own test:
 *
 *  - The target must be a REAL, ACTIVE project. An assignment to an inactive project is a scope
 *    nobody can see: it reads as "assigned" on the panel and yields an empty dashboard.
 *  - The account must be REAL, ACTIVE, and hold the PROJECT_MANAGER role. The last one matters:
 *    an assignment on an Admin or an HOD would be inert (`reportScopeFor` consults assignments only
 *    for PROJECT_MANAGER), so allowing it would create a row that looks like access and grants
 *    none. The refusal names the next step instead.
 *  - An ACTIVE assignment is a conflict (409), never a silent second row.
 *  - A REVOKED assignment is REUSED, not duplicated: the unique pair is the history line, and
 *    re-assigning the same person to the same project rewrites that line's status. Two rows for one
 *    pair would make "who managed this project" ambiguous and the unique constraint would refuse it
 *    anyway.
 *  - Revocation is idempotent-safe: revoking an already-revoked row is `ALREADY_REVOKED`, so an
 *    operator who double-clicks gets a sentence rather than a second audit row that rewrites the
 *    original decision date.
 */

export type AssignmentProject = { id: number; code: string; name: string; active: boolean };

export type AssignmentUser = {
  id: number;
  name: string;
  role: string;
  active: boolean;
};

export type ExistingAssignment = { id: number; status: string } | null;

export type AssignmentPlan =
  | { ok: true; action: "create" | "reactivate"; projectId: number; userId: number }
  | { ok: false; code: string; error: string };

function refuse(code: string, error: string): AssignmentPlan {
  return { ok: false, code, error };
}

/**
 * What to do for `(project, user)`, given whatever row already exists for that pair.
 *
 * The caller loads `existing` with `findUnique({ projectId_userId })`; passing `null` means the pair
 * has never been assigned.
 */
export function planAssignment(input: {
  project: AssignmentProject | null;
  user: AssignmentUser | null;
  existing: ExistingAssignment;
}): AssignmentPlan {
  const { project, user, existing } = input;

  if (!project) {
    return refuse("PROJECT_NOT_FOUND", "That project does not exist. Reload the panel and pick it again.");
  }
  if (!project.active) {
    return refuse(
      "PROJECT_INACTIVE",
      `${project.code} ${project.name} is inactive. A manager cannot be assigned to an inactive project — reactivate the project first if this is wrong.`
    );
  }
  if (!user) {
    return refuse("USER_NOT_FOUND", "That account does not exist. Reload the panel and pick it again.");
  }
  if (!user.active) {
    return refuse("ACCOUNT_INACTIVE", `${user.name}'s account is inactive, so there is nobody to give this project to.`);
  }
  if (user.role !== "PROJECT_MANAGER") {
    return refuse(
      "ROLE_NOT_PROJECT_MANAGER",
      `${user.name} does not hold the Project Manager role (currently ${user.role}). ` +
        "Give the account the Project Manager role on Role Assignment first — an assignment only scopes that role, it does not grant it."
    );
  }

  if (existing) {
    if (existing.status === "active") {
      return refuse("ALREADY_ASSIGNED", `${user.name} already manages ${project.code} ${project.name}.`);
    }
    return { ok: true, action: "reactivate", projectId: project.id, userId: user.id };
  }

  return { ok: true, action: "create", projectId: project.id, userId: user.id };
}

export type RevocationPlan =
  | { ok: true }
  | { ok: false; code: string; error: string };

/** May this assignment be revoked? A missing row and a revoked row are different sentences. */
export function planRevocation(existing: ExistingAssignment): RevocationPlan {
  if (!existing) {
    return { ok: false, code: "ASSIGNMENT_NOT_FOUND", error: "That assignment does not exist." };
  }
  if (existing.status === "revoked") {
    return {
      ok: false,
      code: "ALREADY_REVOKED",
      error: "This assignment is already revoked. The history line keeps the date it was revoked.",
    };
  }
  return { ok: true };
}
