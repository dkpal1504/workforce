#!/usr/bin/env node
/**
 * CORRECT A PAYROLL EMPLOYEE'S ecNo (the employee code) AFTER A TYPO.
 *
 * WHY A SCRIPT: `Employee.ecNo` is the payroll login code itself. Nothing in
 * the UI edits it, and doing it with a bare `UPDATE employees SET ec_no = ...` leaves the
 * account half-renamed — see the four facts below. This script does the whole correction in ONE
 * transaction and refuses the cases that must not be corrected here at all.
 *
 * THE FOUR FACTS THAT MAKE A RENAME MORE THAN ONE COLUMN
 *   1. THE LOGIN CODE *IS* `Employee.ecNo`. `POST /api/auth/login` resolves the identifier with
 *      `findEmployeeByCanonicalEcNo()` (trimmed, CASE-INSENSITIVE), then loads the `User` by
 *      `employeeId`. So the value typed at the login screen is this column, and no other copy of
 *      the code is consulted on that path.
 *   2. THE `User.email` IS A DERIVED HANDLE (`<slug>@employee.local`, `uniqueEmployeeLoginEmail`).
 *      It is not consulted for an ecNo login, but it is the account's identity in admin listings
 *      and it is the value a future registration collides with. When it is still the derived
 *      handle for the OLD code it is renamed here; when the operator typed a REAL e-mail address
 *      at registration it is left alone (and reported).
 *   3. LABOURWORKS OWNS THE CODE OF A SYNCed ROW. The badge sync matches on the case-folded ecNo
 *      against `IDCardNo` and ends by sweeping every SYNC-owned employee the snapshot does not
 *      mention (disabling the login, `active = false`). Renaming a SYNC row therefore makes the
 *      next tick see the OLD code missing and the NEW code as a stranger. This script REFUSES a
 *      SYNC row unless the operator says `--force-source-owned`, and says what will happen.
 *   4. NOTHING ELSE NEEDS TO CHANGE. Timesheets, My Hours, team selections, approvals and
 *      allocations are keyed on `employeeId`, not on the code — the plan prints those counts so
 *      the operator can see that for themselves.
 *
 * USAGE (dry run first — it prints the whole plan and writes nothing)
 *   node apps/api/scripts/rename-employee-ecno.mjs --ecno=123 --to=40032501
 *   node apps/api/scripts/rename-employee-ecno.mjs --employee-id=496 --to=40032501 --reason="typo at registration"
 *   node apps/api/scripts/rename-employee-ecno.mjs --ecno=123 --to=40032501 --apply
 *
 * In production:
 *   docker compose --env-file infra/docker/.env.production -f infra/docker/compose.production.yml \
 *     exec api node apps/api/scripts/rename-employee-ecno.mjs --ecno=123 --to=40032501
 *
 * Exit code 0 = plan printed, or the rename was applied and verified. 1 = refused (the reason is
 * printed). 2 = bad arguments.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const arg = (name) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : null;
};
const flag = (name) => process.argv.slice(2).includes(`--${name}`);

/** Trim + collapse inner whitespace. The API's `canonicalEcNo`, so a plan matches what it stores. */
const canonicalEcNo = (value) => String(value ?? "").trim().replace(/\s+/g, " ");
/** Trim + collapse + upper-case. The comparison key the API uses for LOOKUP AND UNIQUENESS. */
const canonicalEcNoKey = (value) => canonicalEcNo(value).toLocaleUpperCase("en-US");
/** The derived handles an account may carry: `<slug>@employee.local` or `<slug>@sync.local`. */
const derivedSlug = (email) => {
  const m = /^([a-z0-9._-]+)(?:\.\d+)?@(employee|sync)\.local$/i.exec(String(email ?? ""));
  return m ? { slug: m[1], domain: m[2] } : null;
};
/** Exactly `uniqueEmployeeLoginEmail()`'s slug rule, so the new handle is the one a fresh registration would get. */
const slugOf = (ecNo) => ecNo.toLowerCase().replace(/[^a-z0-9._-]/g, "_") || "employee";

const ecNoArg = arg("ecno");
const idArg = arg("employee-id");
const toArg = arg("to");
const reason = (arg("reason") || "ecNo corrected after a registration typo").trim();
const apply = flag("apply");
const forceSourceOwned = flag("force-source-owned");

if ((!ecNoArg && !idArg) || !toArg) {
  console.log("usage: --ecno=<code> | --employee-id=<id>  --to=<correct code>  [--reason=\"...\"]  [--apply]");
  process.exit(2);
}

const refuse = (message) => {
  console.log(`\nREFUSED: ${message}`);
  process.exit(1);
};

(async () => {
  // ---- 1. Find the row the same way the login screen does --------------------------------
  let matches;
  if (idArg) {
    const byId = await prisma.employee.findUnique({ where: { id: Number(idArg) } });
    matches = byId ? [byId] : [];
  } else {
    const wanted = canonicalEcNoKey(ecNoArg);
    matches = (await prisma.employee.findMany()).filter((employee) => canonicalEcNoKey(employee.ecNo) === wanted);
  }
  if (matches.length === 0) refuse(`no Employee matches ${JSON.stringify(ecNoArg ?? `#${idArg}`)}.`);
  if (matches.length > 1) {
    refuse(
      `${matches.length} Employee rows match that code — the API would refuse the login too (ECNO_IDENTITY_CONFLICT). ` +
        `Resolve the duplicates first: ${matches.map((e) => `#${e.id} ${e.ecNo} (${e.name})`).join(", ")}`
    );
  }
  const employee = matches[0];

  // ---- 2. Validate the new code -----------------------------------------------------------
  const nextEcNo = canonicalEcNo(toArg);
  const nextKey = canonicalEcNoKey(nextEcNo);
  if (!nextKey) refuse("the corrected code is empty.");
  if (nextKey === canonicalEcNoKey(employee.ecNo)) refuse(`the row already carries ${JSON.stringify(employee.ecNo)} — nothing to correct.`);
  const all = await prisma.employee.findMany();
  const collision = all.find((e) => e.id !== employee.id && canonicalEcNoKey(e.ecNo) === nextKey);
  if (collision) {
    refuse(`Employee #${collision.id} ${collision.ecNo} (${collision.name}, ${collision.source}) already holds that code${collision.active ? "" : " (inactive)"}.`);
  }

  const linkedUser = await prisma.user.findUnique({ where: { employeeId: employee.id } });
  const handle = linkedUser ? derivedSlug(linkedUser.email) : null;
  const renameHandle = Boolean(
    linkedUser && handle && handle.slug === slugOf(canonicalEcNo(employee.ecNo)) && handle.domain === (employee.source === "SYNC" ? "sync" : "employee")
  );
  let nextHandle = null;
  if (renameHandle && linkedUser) {
    const base = slugOf(nextEcNo);
    nextHandle = `${base}@${handle.domain}.local`;
    for (let suffix = 1; await prisma.user.findUnique({ where: { email: nextHandle }, select: { id: true } }); suffix += 1) {
      nextHandle = `${base}.${suffix}@${handle.domain}.local`;
    }
  }

  // ---- 3. Everything else that references this person is keyed on the id, not the code ----
  const [timesheets, allocations, teamSelections, allocationsDays, progressRemarks] = await Promise.all([
    prisma.timesheetDay.count({ where: { employeeId: employee.id } }),
    prisma.employeeAllocationDay.count({ where: { employeeId: employee.id } }),
    prisma.dailyTeamSelection.count({ where: { employeeId: employee.id } }),
    prisma.employeeAllocation.count({ where: { employeeId: employee.id } }).catch(() => 0),
    prisma.jobOrderProgress.count({ where: { employeeId: employee.id } }).catch(() => 0),
  ]);

  const line = (m) => console.log(`  ${m}`);
  console.log(`\n${apply ? "APPLYING" : "PLAN (dry run — nothing is written)"}: employee code correction\n`);
  line(`employee          #${employee.id}  ${employee.ecNo}  →  ${nextEcNo}`);
  line(`who               ${employee.name} · ${employee.employmentType} · source=${employee.source} · ${employee.active ? "active" : "INACTIVE"}`);
  line(`login account     ${linkedUser ? `#${linkedUser.id} role=${linkedUser.role} email=${linkedUser.email}` : "none (no login yet)"}`);
  if (linkedUser && renameHandle) line(`login handle      ${linkedUser.email}  →  ${nextHandle}   (+ tokenVersion bump: the account signs in again)`);
  else if (linkedUser) line(`login handle      LEFT ALONE (${linkedUser.email} is not the derived handle for ${employee.ecNo})`);
  line(`unchanged by design  ${timesheets} timesheet day(s), ${allocations} My Hours day(s), ${teamSelections} team selection row(s), ${progressRemarks} progress remark(s) — all keyed on employeeId`);

  if (employee.source === "SYNC" && !forceSourceOwned) {
    console.log(
      "\nREFUSED: this row is SYNC-owned, so LabourWorks owns its code (IDCardNo). Renaming it here makes the next " +
        "badge sync see the OLD code missing (its absence sweep then disables the login) and the NEW code as a " +
        "stranger (ECNO_SOURCE_COLLISION). Correct it in LabourWorks instead, or re-run with --force-source-owned " +
        "if this row is no longer fed by the sync."
    );
    process.exit(1);
  }

  if (!apply) {
    console.log("\nRe-run with --apply to write this. The change is one transaction plus an audit row.");
    return;
  }

  // ---- 4. Write it: one transaction, then the audit row -----------------------------------
  await prisma.$transaction(async (tx) => {
    await tx.employee.update({ where: { id: employee.id }, data: { ecNo: nextEcNo } });
    if (linkedUser) {
      await tx.user.update({
        where: { id: linkedUser.id },
        data: {
          ...(renameHandle ? { email: nextHandle } : {}),
          tokenVersion: { increment: 1 },
        },
      });
    }
  });

  // A script has no request user, so the actor is null — the same shape create-first-admin.mjs
  // writes (`BOOTSTRAP_FIRST_ADMIN`). The reason is recorded so "who renamed this?" is answerable.
  await prisma.auditLog.create({
    data: {
      userId: null,
      action: "EMPLOYEE_ECNO_RENAME",
      entityType: "employee",
      entityId: String(employee.id),
      metadata: JSON.stringify({
        previous: employee.ecNo,
        next: nextEcNo,
        previousHandle: linkedUser?.email ?? null,
        nextHandle: renameHandle ? nextHandle : linkedUser?.email ?? null,
        source: employee.source,
        reason,
        via: "scripts/rename-employee-ecno.mjs",
      }),
    },
  });

  // ---- 5. Verify by re-running the LOGIN's own lookup ------------------------------------
  const after = await prisma.employee.findUnique({ where: { id: employee.id } });
  const byNewCode = (await prisma.employee.findMany()).filter((e) => canonicalEcNoKey(e.ecNo) === nextKey);
  const byOldCode = (await prisma.employee.findMany()).filter((e) => canonicalEcNoKey(e.ecNo) === canonicalEcNoKey(employee.ecNo));
  console.log("\nWROTE. Verification:");
  line(`stored            #${after.id} ecNo=${after.ecNo}`);
  line(`login finds       ${byNewCode.length} employee for "${nextEcNo}" (must be 1)`);
  line(`login finds       ${byOldCode.length} employee for "${employee.ecNo}" (must be 0)`);
  const handleAfter = await prisma.user.findUnique({ where: { employeeId: employee.id } });
  if (handleAfter) line(`account           #${handleAfter.id} email=${handleAfter.email} tokenVersion=${handleAfter.tokenVersion}`);
  line(`audit             EMPLOYEE_ECNO_RENAME on employee #${employee.id}`);
  if (byNewCode.length !== 1 || byOldCode.length !== 0) {
    console.log("\nUNEXPECTED RESULT — the lookups disagree with the write. Investigate before telling anyone the code is fixed.");
    process.exit(1);
  }
  console.log("\nDONE. The person now signs in with the corrected code and must log in again (sessions were re-issued).");
})()
  .catch((err) => {
    console.error("\nFAILED:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
