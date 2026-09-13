// Dev cleanup: remove test employees created while verifying the HOD flow.
// Removes ONLY the ecNos listed as arguments, and refuses to touch anything else.
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });
require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

(async () => {
  const targets = process.argv.slice(2);
  if (!targets.length) { console.error("usage: node cleanup-test-employees.cjs <ecNo> [...]"); process.exit(1); }
  if (!String(process.env.DATABASE_URL || "").startsWith("file:")) {
    console.error("Refusing to run outside the local SQLite dev database."); process.exit(1);
  }
  for (const ecNo of targets) {
    const emp = await prisma.employee.findFirst({
      where: { ecNo },
      include: { user: true, sectionAssignment: true,
        timesheetDays: { select: { id: true } }, timesheetEntries: { select: { id: true } },
        employeeAllocationDays: { select: { id: true } }, employeeAllocations: { select: { id: true } },
        teamSelections: { select: { id: true } }, conflicts: { select: { id: true } }, attendanceFeed: { select: { id: true } } },
    });
    if (!emp) { console.log(`${ecNo}: not found, skipped`); continue; }
    const blockers = {
      timesheetDays: emp.timesheetDays.length, timesheetEntries: emp.timesheetEntries.length,
      allocationDays: emp.employeeAllocationDays.length, allocations: emp.employeeAllocations.length,
      teamSelections: emp.teamSelections.length, conflicts: emp.conflicts.length, attendance: emp.attendanceFeed.length,
    };
    const dependent = Object.values(blockers).some((n) => n > 0);
    await prisma.$transaction(async (tx) => {
      if (emp.user) {
        await tx.credentialDelivery.deleteMany({ where: { userId: emp.user.id } });
        await tx.user.delete({ where: { id: emp.user.id } });
      }
      await tx.employeeSectionAssignment.deleteMany({ where: { employeeId: emp.id } });
      await tx.employeeAllocationApproval.deleteMany({ where: { allocationDay: { employeeId: emp.id } } });
      await tx.employeeAllocation.deleteMany({ where: { employeeId: emp.id } });
      await tx.employeeAllocationDay.deleteMany({ where: { employeeId: emp.id } });
      await tx.employeeOrganisationOverride.deleteMany({ where: { employeeId: emp.id } });
      await tx.supervisorOverride.deleteMany({ where: { employeeId: emp.id } });
      await tx.dailyTeamSelection.deleteMany({ where: { employeeId: emp.id } });
      if (dependent) {
        // Keep operational history: soft-depart instead of deleting the Employee row.
        await tx.employee.update({ where: { id: emp.id }, data: { active: false, terminatedAt: new Date() } });
      } else {
        await tx.employee.delete({ where: { id: emp.id } });
      }
    });
    console.log(`${ecNo}: user+assignments removed; employee ${dependent ? "soft-departed (has timesheet history " + JSON.stringify(blockers) + ")" : "deleted"}`);
  }
  await prisma.$disconnect();
})().catch(async (e) => { console.error("FAILED:", e.message); await prisma.$disconnect(); process.exit(1); });
