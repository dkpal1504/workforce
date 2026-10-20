#!/usr/bin/env node
/**
 * Move ONE Section's work — job orders, historical timesheet attribution, and the people and
 * accounts that belong to it — from an old Department/Section pair to a new one.
 *
 * WHY A SCRIPT AND NOT FOUR `UPDATE`s: five tables describe the same organisational fact, and moving
 * four of them leaves a graph that looks migrated and is not. The failure modes are quiet ones:
 *
 *   - a job order moved without its timesheet history splits one section's work across two reports for
 *     ever;
 *   - history moved without the HOD's scope strands every new submission, because routing sends a
 *     sheet to the Section Head of the tagger's section and there is now no head for it;
 *   - people moved without their department breaks the team pool: a supervisor can only draw labour
 *     from sections of HIS department, so a supervisor left behind sees an empty team.
 *
 * WHAT IT DOES NOT DO: it never deletes a department or a section, never rewrites `approvals` (who
 * signed a sheet stays who signed it), and never touches payroll figures — hours and employees are
 * unchanged, only the department/section attribution moves.
 *
 * THE SNAPSHOT CAVEAT, STATED PLAINLY: `timesheet_entries.department_id / section_id` is a SNAPSHOT
 * taken when the hours were booked, frozen on purpose so a later master-data remap does not move
 * approved history. This script exists to OVERRIDE that intent for one deliberate case, so it prints
 * exactly how many approved rows will change organisation before it touches anything.
 *
 * DEFAULT IS A DRY RUN. `--apply` is required to write.
 *
 *   docker compose --env-file infra/docker/.env.production \
 *     -f infra/docker/compose.production.yml exec api \
 *     node apps/api/scripts/remap-section.mjs \
 *       --old-dept "Production - SEZ" --old-section PIPING \
 *       --new-dept "Production Outfitting - Piping - SEZ" --new-section OUTFITTING_PIPING
 *
 * Add `--apply` to the same command to commit it, in one transaction.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const apply = process.argv.includes("--apply");
const rollbackId = arg("rollback");
const deactivateOld = process.argv.includes("--deactivate-old-section");
const dryRunOnly = !apply;

const oldDeptName = arg("old-dept");
const oldSectionCode = arg("old-section");
const newDeptName = arg("new-dept");
const newSectionCode = arg("new-section");

function die(message) {
  console.error(`\n  ABORT: ${message}\n`);
  process.exit(1);
}
function line(label, value) {
  console.log(`  ${String(label).padEnd(42)} ${value}`);
}

async function findPair(deptName, sectionCode, side) {
  const departments = await prisma.department.findMany({
    where: { name: { equals: deptName, mode: "insensitive" } },
    select: { id: true, name: true, active: true },
  });
  if (departments.length === 0) die(`${side} department "${deptName}" does not exist.`);
  if (departments.length > 1) die(`${side} department "${deptName}" is ambiguous (${departments.length} rows).`);
  const department = departments[0];

  const sections = await prisma.section.findMany({
    where: { departmentId: department.id, code: { equals: sectionCode, mode: "insensitive" } },
    select: { id: true, code: true, name: true, active: true },
  });
  if (sections.length === 0) die(`${side} section "${sectionCode}" does not exist under "${department.name}".`);
  if (sections.length > 1) die(`${side} section "${sectionCode}" is ambiguous.`);
  return { department, section: sections[0] };
}

// ── --rollback <auditId>: undo exactly what that run moved ─────────────────────────────────────────
if (rollbackId) {
  const audit = await prisma.auditLog.findUnique({ where: { id: Number(rollbackId) } });
  if (!audit || audit.action !== "SECTION_REMAP") die(`audit row ${rollbackId} is not a SECTION_REMAP.`);
  const meta = JSON.parse(audit.metadata);
  if (meta.rolledBackAt) die(`audit row ${rollbackId} was already rolled back at ${meta.rolledBackAt}.`);

  const back = meta.from;
  const there = meta.to;
  const jobOrderIds = meta.moved?.ids?.jobOrders ?? [];
  const entryIds = meta.moved?.ids?.entries ?? [];
  // These live at the TOP level of the metadata, not under `moved` — reading the wrong path is how a
  // rollback silently moves zero people while reporting success.
  const employeeIds = meta.employeeIds ?? [];
  const userIds = meta.userIds ?? [];

  console.log(`\nROLLING BACK audit ${rollbackId} — ${jobOrderIds.length} job orders, ${entryIds.length} entries, ${employeeIds.length} people`);
  console.log(`  ${meta.toNames.department} / ${meta.toNames.section}  ->  ${meta.fromNames.department} / ${meta.fromNames.section}\n`);

  if (!apply) {
    console.log("  This was a DRY RUN. Re-run with --rollback <id> --apply to undo it.\n");
    await prisma.$disconnect();
    process.exit(0);
  }

  const undone = await prisma.$transaction(async (tx) => {
    const out = {};
    out.jobOrders = (await tx.jobOrder.updateMany({ where: { id: { in: jobOrderIds } }, data: { departmentId: back.departmentId, sectionId: back.sectionId } })).count;
    out.entries = (await tx.timesheetEntry.updateMany({ where: { id: { in: entryIds } }, data: { departmentId: back.departmentId, sectionId: back.sectionId } })).count;
    out.employees = (await tx.employee.updateMany({ where: { id: { in: employeeIds } }, data: { departmentId: back.departmentId } })).count;
    out.assignments = (await tx.employeeSectionAssignment.updateMany({ where: { employeeId: { in: employeeIds }, sectionId: there.sectionId }, data: { sectionId: back.sectionId } })).count;
    out.overrides = (await tx.employeeOrganisationOverride.updateMany({ where: { employeeId: { in: employeeIds }, sectionId: there.sectionId }, data: { departmentId: back.departmentId, sectionId: back.sectionId } })).count;
    out.users = (await tx.user.updateMany({ where: { id: { in: userIds }, departmentId: there.departmentId }, data: { departmentId: back.departmentId } })).count;
    out.userMirror = (await tx.user.updateMany({ where: { id: { in: userIds }, sectionId: there.sectionId }, data: { sectionId: back.sectionId } })).count;
    out.scopeSections = 0;
    for (const userId of userIds) {
      const removed = await tx.userScopeSection.deleteMany({ where: { userId, sectionId: there.sectionId } });
      if (removed.count > 0) {
        await tx.userScopeSection.upsert({
          where: { userId_sectionId: { userId, sectionId: back.sectionId } },
          create: { userId, sectionId: back.sectionId },
          update: {},
        });
        out.scopeSections += 1;
      }
    }
    await tx.auditLog.update({
      where: { id: Number(rollbackId) },
      data: { metadata: JSON.stringify({ ...meta, rolledBackAt: new Date().toISOString(), undone: out }) },
    });
    return out;
  }, { timeout: 120_000 });

  console.log("  UNDONE");
  for (const [key, value] of Object.entries(undone)) line(key, value);
  console.log(`\n  Only the ${employeeIds.length} people this run moved were moved back — anybody who joined the\n  new section afterwards stayed there.\n`);
  await prisma.$disconnect();
  process.exit(0);
}

const oldSide = await findPair(oldDeptName, oldSectionCode, "OLD");
const newSide = await findPair(newDeptName, newSectionCode, "NEW");

if (oldSide.section.id === newSide.section.id) die("The old and new section are the same row.");
if (oldSide.department.id === newSide.department.id && oldSide.section.id === newSide.section.id) {
  die("Nothing to do: the mapping points at itself.");
}

const oldSectionId = oldSide.section.id;
const newSectionId = newSide.section.id;
const oldDepartmentId = oldSide.department.id;
const newDepartmentId = newSide.department.id;


console.log(`\n${apply ? "APPLYING" : "DRY RUN — nothing will be written"}`);
line("from", `${oldSide.department.name} / ${oldSide.section.code} (#${oldSectionId})`);
line("to  ", `${newSide.department.name} / ${newSide.section.code} (#${newSectionId})`);

// ── what is there now ───────────────────────────────────────────────────────────────────────────────
const [
  jobOrders,
  entriesByStatus,
  employeesOnOldSection,
  usersWithOldScope,
  allocations,
  progressRows,
  delegations,
  overrides,
  costCentres,
  jobOrdersOnNewSection,
  entriesOnNewSection,
  entriesNullSectionWithOldJobOrder,
] = await Promise.all([
  prisma.jobOrder.count({ where: { sectionId: oldSectionId } }),
  prisma.timesheetEntry.groupBy({ by: ["status"], where: { sectionId: oldSectionId }, _count: { _all: true } }),
  prisma.employeeSectionAssignment.findMany({
    where: { sectionId: oldSectionId },
    select: { employeeId: true, source: true, employee: { select: { name: true, ecNo: true, departmentId: true } } },
  }),
  prisma.userScopeSection.findMany({
    where: { sectionId: oldSectionId },
    select: { userId: true, user: { select: { name: true, role: true, departmentId: true, sectionId: true } } },
  }),
  prisma.employeeAllocation.count({ where: { sectionId: oldSectionId } }),
  prisma.jobOrderProgress.count({ where: { sectionId: oldSectionId } }),
  prisma.hodDelegation.count({ where: { sectionId: oldSectionId } }),
  prisma.employeeOrganisationOverride.count({ where: { sectionId: oldSectionId } }),
  prisma.costCenter.count({ where: { sectionId: oldSectionId } }),
  prisma.jobOrder.count({ where: { sectionId: newSectionId } }),
  prisma.timesheetEntry.count({ where: { sectionId: newSectionId } }),
  prisma.timesheetEntry.count({
    where: { sectionId: null, jobOrder: { sectionId: oldSectionId } },
  }),
]);

// An employee can be on the old section without an assignment row if only the department is stale.
const employeesOnOldDepartmentOnly = await prisma.employee.count({
  where: { departmentId: oldDepartmentId, sectionAssignment: { is: null } },
});

console.log("\n  CURRENT STATE");
line("job orders on the old section", jobOrders);
for (const row of entriesByStatus) line(`  timesheet entries ${row.status}`, row._count._all);
line("timesheet entries (total)", entriesByStatus.reduce((sum, row) => sum + row._count._all, 0));
line("employees assigned to the old section", employeesOnOldSection.length);
line("  of which their assignment came from SYNC", employeesOnOldSection.filter((row) => row.source === "SYNC").length);
line("  of which MANUAL", employeesOnOldSection.filter((row) => row.source === "MANUAL").length);
line("accounts scoped to the old section", usersWithOldScope.length);
line("allocations", allocations);
line("quantity progress rows", progressRows);
line("HOD delegations", delegations);
line("organisation overrides", overrides);
line("cost centres", costCentres);

console.log("\n  TARGET MUST BE EMPTY (this script never merges two live sections)");
line("job orders already on the new section", jobOrdersOnNewSection);
line("timesheet entries already on the new section", entriesOnNewSection);

if (entriesNullSectionWithOldJobOrder > 0) {
  console.log(
    `\n  NOTE: ${entriesNullSectionWithOldJobOrder} timesheet entr(ies) have NO section but point at a job order` +
      ` of the old section. They are outside this remap (there is no section to move); review them separately.`
  );
}
if (employeesOnOldDepartmentOnly > 0) {
  console.log(
    `\n  NOTE: ${employeesOnOldDepartmentOnly} employee(s) sit in the old department with no section assignment.` +
      ` This remap leaves them alone — they are not this section's people.`
  );
}

if (jobOrdersOnNewSection > 0 || entriesOnNewSection > 0) {
  die(
    "the new section already carries job orders or timesheet entries. Merging two live sections is a " +
      "different decision with different consequences; refuse to guess."
  );
}
if (jobOrders === 0 && entriesByStatus.length === 0 && employeesOnOldSection.length === 0) {
  console.log("\n  Nothing to move — the old section is already empty. Exiting.\n");
  await prisma.$disconnect();
  process.exit(0);
}

if (dryRunOnly) {
  console.log("\n  This was a DRY RUN. Re-run the same command with --apply to commit it.\n");
  await prisma.$disconnect();
  process.exit(0);
}

// ── the move, in ONE transaction ────────────────────────────────────────────────────────────────────
const result = await prisma.$transaction(
  async (tx) => {
    const moved = {};

    // WHAT MOVED IS RECORDED BY ID, not by section. A rollback that re-derives "everything on the new
    // section" would drag back people who arrived there from CLMS after this remap — that is not an
    // undo, it is a second change.
    const jobOrderIds = (await tx.jobOrder.findMany({ where: { sectionId: oldSectionId }, select: { id: true } })).map((r) => r.id);
    const entryIds = (await tx.timesheetEntry.findMany({ where: { sectionId: oldSectionId }, select: { id: true } })).map((r) => r.id);
    moved.ids = { jobOrders: jobOrderIds, entries: entryIds };

    // 1. The live master: every job order of the old section.
    moved.jobOrders = (
      await tx.jobOrder.updateMany({
        where: { id: { in: jobOrderIds } },
        data: { departmentId: newDepartmentId, sectionId: newSectionId },
      })
    ).count;

    // 2. The history: every timesheet entry attributed to the old section, whatever its status.
    moved.entries = (
      await tx.timesheetEntry.updateMany({
        where: { id: { in: entryIds } },
        data: { departmentId: newDepartmentId, sectionId: newSectionId },
      })
    ).count;

    // 3. The people: their department and their section assignment.
    const employeeIds = employeesOnOldSection.map((row) => row.employeeId);
    moved.ids.employees = employeeIds;
    moved.employees = (
      await tx.employee.updateMany({
        where: { id: { in: employeeIds } },
        data: { departmentId: newDepartmentId },
      })
    ).count;
    moved.assignments = (
      await tx.employeeSectionAssignment.updateMany({
        where: { sectionId: oldSectionId },
        data: { sectionId: newSectionId },
      })
    ).count;

    // 3b. An override that pinned somebody to the old section must follow, or the next sync and the
    //     override disagree and the person bounces between organisations.
    moved.overrides = (
      await tx.employeeOrganisationOverride.updateMany({
        where: { sectionId: oldSectionId },
        data: { departmentId: newDepartmentId, sectionId: newSectionId },
      })
    ).count;

    // 4. The accounts: the HOD whose scope is the old section, and anybody whose own employee row moved.
    moved.scopeSections = 0;
    for (const row of usersWithOldScope) {
      await tx.userScopeSection.deleteMany({ where: { userId: row.userId, sectionId: oldSectionId } });
      await tx.userScopeSection.upsert({
        where: { userId_sectionId: { userId: row.userId, sectionId: newSectionId } },
        create: { userId: row.userId, sectionId: newSectionId },
        update: {},
      });
      moved.scopeSections += 1;
    }

    const userIdsFromEmployees = await tx.user.findMany({
      where: { employeeId: { in: employeeIds } },
      select: { id: true },
    });
    const userIds = [...new Set([...usersWithOldScope.map((row) => row.userId), ...userIdsFromEmployees.map((row) => row.id)])];
    moved.users = (
      await tx.user.updateMany({
        where: { id: { in: userIds }, departmentId: oldDepartmentId },
        data: { departmentId: newDepartmentId },
      })
    ).count;
    moved.userMirror = (
      await tx.user.updateMany({
        where: { id: { in: userIds }, sectionId: oldSectionId },
        data: { sectionId: newSectionId },
      })
    ).count;

    // 5. The old section: kept, but retired, so it stops appearing in pickers. Never deleted — history
    //    may still reference it and a deletion would cascade through rows nobody meant to touch.
    if (deactivateOld) {
      await tx.section.update({ where: { id: oldSectionId }, data: { active: false } });
      moved.oldSectionDeactivated = 1;
    }

    await tx.auditLog.create({
      data: {
        userId: null,
        action: "SECTION_REMAP",
        entityType: "section",
        entityId: String(oldSectionId),
        metadata: JSON.stringify({
          fromNames: { department: oldSide.department.name, section: oldSide.section.code },
          toNames: { department: newSide.department.name, section: newSide.section.code },
          moved,
          deactivatedOldSection: deactivateOld,
          employeeIds,
          userIds,
          from: { departmentId: oldDepartmentId, sectionId: oldSectionId },
          to: { departmentId: newDepartmentId, sectionId: newSectionId },
        }),
      },
    });

    return moved;
  },
  { timeout: 120_000 }
);

console.log("\n  MOVED");
for (const [key, value] of Object.entries(result)) {
  if (key === "ids") continue; // recorded in the audit row, not worth printing as [object Object]
  line(key, value);
}

// ── proof, read back outside the transaction ────────────────────────────────────────────────────────
const [leftJobOrders, leftEntries, leftEmployees, leftScopes] = await Promise.all([
  prisma.jobOrder.count({ where: { sectionId: oldSectionId } }),
  prisma.timesheetEntry.count({ where: { sectionId: oldSectionId } }),
  prisma.employeeSectionAssignment.count({ where: { sectionId: oldSectionId } }),
  prisma.userScopeSection.count({ where: { sectionId: oldSectionId } }),
]);

console.log("\n  LEFT BEHIND ON THE OLD SECTION (must be zero)");
line("job orders", leftJobOrders);
line("timesheet entries", leftEntries);
line("employee assignments", leftEmployees);
line("account scopes", leftScopes);

const clean = leftJobOrders === 0 && leftEntries === 0 && leftEmployees === 0 && leftScopes === 0;
console.log(
  clean
    ? "\n  OK — the old section is empty. It is still ACTIVE; deactivate it once the screen looks right,\n" +
        "  or re-run with --deactivate-old-section.\n"
    : "\n  INCOMPLETE — something still points at the old section. Do not deactivate it; investigate first.\n"
);

// The one thing a script cannot fix.
const synced = employeesOnOldSection.filter((row) => row.source === "SYNC");
if (synced.length > 0) {
  console.log(
    `  WARNING: ${synced.length} of the moved people had their section from CLMS (source=SYNC) and no\n` +
      `  organisation override. The next badge sync will put them back unless CLMS itself is corrected:\n` +
      synced.map((row) => `    - ${row.employee.ecNo}  ${row.employee.name}`).join("\n") +
      "\n  Either fix them in CLMS, or pin them with an employee_organisation_overrides row.\n"
  );
}

await prisma.$disconnect();
process.exit(clean ? 0 : 1);
