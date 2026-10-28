#!/usr/bin/env node
/**
 * Why will this Employee not transfer, and which days are holding it up?
 *
 *   docker compose -f infra/docker/compose.production.yml --env-file $envFile \
 *     exec api node apps/api/scripts/audit-transfer.mjs 40031999
 *
 * Read-only. Prints every day the transfer guard counts — its date, its status, the stage it sits in and who can
 * move it on — plus the days that do NOT block (a DRAFT is invisible to the guard, and that difference is the
 * most common reason an operator believes the employee is clean). Writes nothing.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const TIMESHEET_BLOCKING = ["SUBMITTED", "HOD_APPROVED", "PLANNING_RETURNED"];
const ALLOCATION_BLOCKING = ["SUBMITTED", "HOD_APPROVED"];

const STAGE = (kind, status) => {
  if (kind === "MY HOURS") {
    if (status === "SUBMITTED") return "with the Section HOD (Approvals -> Payroll Employees)";
    if (status === "HOD_APPROVED") return "with the Project Head (Approvals -> Payroll Employees)";
  } else {
    if (status === "SUBMITTED") return "with the Section HOD (Approvals -> Received from HOD)";
    if (status === "HOD_APPROVED") return "with the Project Head (Approvals -> Received from HOD)";
    if (status === "PLANNING_RETURNED") return "sent back by Planning - the supervisor must resubmit";
  }
  return status.toLowerCase();
};

const day = (value) => value.toISOString().slice(0, 10);
const age = (value) => Math.round((Date.now() - value.getTime()) / 86_400_000);

async function main() {
  const ecNo = (process.argv[2] ?? "").trim();
  if (!ecNo) {
    console.error("usage: node apps/api/scripts/audit-transfer.mjs <EC No>");
    process.exit(2);
  }
  const host = String(process.env.DATABASE_URL || "").replace(/^[a-z]+:\/\//i, "").split("@").pop()?.split("/")[0] ?? "(unset)";
  console.log(`database: ${host}   ecNo: ${ecNo}`);

  const employee = await prisma.employee.findFirst({
    where: { ecNo: { equals: ecNo, mode: "insensitive" } },
    select: {
      id: true, ecNo: true, name: true, employmentType: true, active: true,
      department: { select: { name: true } },
      sectionAssignment: { select: { section: { select: { name: true } } } },
      user: { select: { id: true, role: true, active: true } },
    },
  });
  if (!employee) {
    console.log("no such EC No in this database.");
    return;
  }
  console.log(
    `\n${employee.ecNo}  ${employee.name}  ${employee.employmentType}  ${employee.active ? "active" : "INACTIVE"}` +
      `  department: ${employee.department?.name ?? "<none>"}  section: ${employee.sectionAssignment?.section?.name ?? "<none>"}` +
      `  account: ${employee.user ? `${employee.user.role}${employee.user.active ? "" : " (inactive)"}` : "none"}`
  );

  const [timesheets, allocations] = await Promise.all([
    prisma.timesheetDay.findMany({
      where: { employeeId: employee.id },
      select: { workDate: true, status: true, remarks: true },
      orderBy: { workDate: "asc" },
    }),
    prisma.employeeAllocationDay.findMany({
      where: { employeeId: employee.id },
      select: { workDate: true, status: true, remarks: true },
      orderBy: { workDate: "asc" },
    }),
  ]);

  const blocking = [
    ...timesheets.filter((row) => TIMESHEET_BLOCKING.includes(row.status)).map((row) => ({ ...row, kind: "TIMESHEET" })),
    ...allocations.filter((row) => ALLOCATION_BLOCKING.includes(row.status)).map((row) => ({ ...row, kind: "MY HOURS" })),
  ].sort((a, b) => a.workDate - b.workDate);

  console.log(`\nOPEN DAYS THAT BLOCK THE TRANSFER: ${blocking.length}`);
  for (const row of blocking) {
    const remark = row.remarks ? `   remark: "${row.remarks.slice(0, 60)}"` : "";
    console.log(
      `  ${day(row.workDate)}  ${String(age(row.workDate)).padStart(3)}d old  ${row.kind.padEnd(9)} ${row.status.padEnd(16)} ${STAGE(row.kind, row.status)}${remark}`
    );
  }

  const notBlocking = [
    ...timesheets.filter((row) => !TIMESHEET_BLOCKING.includes(row.status)).map((row) => ({ ...row, kind: "TIMESHEET" })),
    ...allocations.filter((row) => !ALLOCATION_BLOCKING.includes(row.status)).map((row) => ({ ...row, kind: "MY HOURS" })),
  ];
  const byStatus = new Map();
  for (const row of notBlocking) {
    const key = `${row.kind} ${row.status}`;
    byStatus.set(key, (byStatus.get(key) ?? 0) + 1);
  }
  console.log("\nDAYS THAT DO NOT BLOCK (DRAFT and decided end-states are invisible to the guard):");
  if (byStatus.size === 0) console.log("  none");
  for (const [key, count] of [...byStatus.entries()].sort()) console.log(`  ${key}: ${count}`);

  // A future team selection is dropped by the transfer itself, not by the guard; worth seeing either way.
  const today = new Date(new Date().toISOString().slice(0, 10));
  const teamSelections = await prisma.dailyTeamSelection.count({
    where: { employeeId: employee.id, removedAt: null, workDate: { gte: today } },
  });
  console.log(`\nFUTURE TEAM SELECTIONS (removed by the transfer, they are not a blocker): ${teamSelections}`);
  console.log(
    blocking.length === 0
      ? "\nVERDICT: nothing open — the transfer should be accepted. If it is still refused, the refusal is a different code (read the message beside the form)."
      : `\nVERDICT: ${blocking.length} open day(s). Approve, reject or resubmit them, then transfer.`
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
