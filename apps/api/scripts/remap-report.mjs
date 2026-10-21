#!/usr/bin/env node
/**
 * READ-ONLY. Where do the Job Orders of a moved section actually stand?
 *
 * This exists because the production stack has no `postgres` service and the API image has no `psql`,
 * so the honest way to look at the data from the server is a script that speaks to the same database
 * the application does. It writes nothing.
 *
 *   docker compose --env-file infra/docker/.env.production \
 *     -f infra/docker/compose.production.yml exec api \
 *     node apps/api/scripts/remap-report.mjs \
 *       --from-dept "Production - SEZ" --from-section PIPING \
 *       --to-dept "Production Outfitting - Piping - SEZ" --to-section OUTFITTING_PIPING
 *
 * It answers the three questions an operator actually has after a remap:
 *   1. what is still on the old pair;
 *   2. what is on the new pair;
 *   3. which Codes now exist more than once across sections (the signature of a later CSV upload that
 *      could not match a moved row and created a second one instead).
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function die(message) {
  console.error(`\n  ABORT: ${message}\n`);
  process.exit(1);
}
function line(label, value) {
  console.log(`  ${String(label).padEnd(46)} ${value}`);
}

async function findPair(deptName, sectionCode, side) {
  if (!deptName || !sectionCode) die(`--${side}-dept and --${side}-section are both required.`);
  const departments = await prisma.department.findMany({
    where: { name: { equals: deptName, mode: "insensitive" } },
    select: { id: true, name: true, active: true },
  });
  if (departments.length !== 1) die(`${side} department "${deptName}" matched ${departments.length} rows.`);
  const department = departments[0];
  const sections = await prisma.section.findMany({
    where: { departmentId: department.id, code: { equals: sectionCode, mode: "insensitive" } },
    select: { id: true, code: true, name: true, active: true },
  });
  if (sections.length !== 1) {
    die(`${side} section "${sectionCode}" matched ${sections.length} rows under "${department.name}".`);
  }
  return { department, section: sections[0] };
}

// ── --find <text>: what is the EXACT name, and what does that pair carry? ─────────────────────────
//
// A department name is typed from a screenshot far more often than copied, and one letter decides
// whether a move resolves to a row or to nothing. This mode answers "which department is it" with the
// database's own spelling, plus the load of every section under it, before anything else is composed.
const find = arg("find");
if (find !== null) {
  const like = `%${find}%`;
  const departments = await prisma.department.findMany({
    where: { OR: [{ name: { contains: find, mode: "insensitive" } }, { code: { contains: find, mode: "insensitive" } }] },
    select: {
      id: true, code: true, name: true, active: true,
      sections: {
        select: {
          id: true, code: true, name: true, active: true,
          _count: { select: { jobOrders: true } },
        },
        orderBy: { code: "asc" },
      },
    },
    orderBy: { id: "asc" },
  });
  console.log(`\n  DEPARTMENTS MATCHING "${find}"  (${departments.length})\n`);
  if (departments.length === 0) {
    console.log(`     none. Try a shorter fragment — "${find}" is matched as a substring, case-insensitively.\n`);
  }
  for (const d of departments) {
    console.log(`  #${d.id} ${d.name}  [${d.code}]${d.active ? "" : "  (inactive)"}`);
    for (const s of d.sections) {
      const entries = await prisma.timesheetEntry.count({ where: { sectionId: s.id } });
      const people = await prisma.employeeSectionAssignment.count({ where: { sectionId: s.id } });
      console.log(
        `       section #${String(s.id).padEnd(4)} ${String(s.code).padEnd(22)} ` +
          `${String(s.name).slice(0, 30).padEnd(31)} ${String(s._count.jobOrders).padStart(4)} job orders  ` +
          `${String(entries).padStart(6)} entries  ${String(people).padStart(4)} people` +
          `${s.active ? "" : "  (inactive)"}`
      );
    }
  }
  console.log("\n  Read-only: nothing was written.\n");
  await prisma.$disconnect();
  process.exit(0);
}

const from = await findPair(arg("from-dept"), arg("from-section"), "from");
const to = await findPair(arg("to-dept"), arg("to-section"), "to");

line("from", `${from.department.name} / ${from.section.code} (section ${from.section.id}, ${from.section.active ? "active" : "inactive"})`);
line("to", `${to.department.name} / ${to.section.code} (section ${to.section.id}, ${to.section.active ? "active" : "inactive"})`);

// Anything whose SECTION or DEPARTMENT still names the old pair. A half-moved row (new section, old
// department) is the shape that looks migrated on one screen and missing on the next.
const rows = await prisma.jobOrder.findMany({
  where: {
    OR: [
      { sectionId: from.section.id },
      { sectionId: to.section.id },
      { departmentId: from.department.id, sectionId: null },
      { departmentId: to.department.id, sectionId: null },
    ],
  },
  select: {
    id: true, code: true, name: true, createdAt: true,
    department: { select: { name: true, id: true } },
    section: { select: { code: true, id: true } },
    _count: { select: { timesheetEntries: true } },
  },
  orderBy: [{ sectionId: "asc" }, { id: "asc" }],
});

console.log("\n  JOB ORDERS — old pair, new pair, and rows with no section at all\n");
if (rows.length === 0) console.log("     (none)");
for (const o of rows) {
  const where =
    o.section?.id === from.section.id
      ? "OLD PAIR"
      : o.section?.id === to.section.id
        ? o.department?.id === to.department.id
          ? "new pair"
          : "NEW SECTION, OLD DEPARTMENT"
        : "no section";
  console.log(
    `     ${where.padEnd(26)} #${String(o.id).padEnd(5)} ${String(o.code).padEnd(10)} ` +
      `${String(o.name).slice(0, 32).padEnd(33)} ` +
      `${String(o.department?.name ?? "?").slice(0, 34).padEnd(35)} ${o.section?.code ?? "(none)".padEnd(18)} ` +
      `${String(o._count.timesheetEntries).padStart(5)} entries  ${o.createdAt.toISOString().slice(0, 10)}`
  );
}

const [oldOrders, newOrders, oldEntries, newEntries, oldPeople, newPeople] = await Promise.all([
  prisma.jobOrder.count({ where: { sectionId: from.section.id } }),
  prisma.jobOrder.count({ where: { sectionId: to.section.id } }),
  prisma.timesheetEntry.count({ where: { sectionId: from.section.id } }),
  prisma.timesheetEntry.count({ where: { sectionId: to.section.id } }),
  prisma.employeeSectionAssignment.count({ where: { sectionId: from.section.id } }),
  prisma.employeeSectionAssignment.count({ where: { sectionId: to.section.id } }),
]);

console.log("\n  TOTALS\n");
line("job orders on the old section", oldOrders);
line("job orders on the new section", newOrders);
line("timesheet entries on the old section", oldEntries);
line("timesheet entries on the new section", newEntries);
line("people assigned to the old section", oldPeople);
line("people assigned to the new section", newPeople);

// A Code that stands on the OLD pair and somewhere else as well is what a CSV upload leaves behind when
// it cannot match the moved row: uniqueness is scoped by project and organisation, not by code alone.
// Only the codes of these two sections are examined — repeating codes elsewhere in the plant are normal
// (recurring daily Job Orders) and would bury the signal.
const codesHere = await prisma.jobOrder.findMany({
  where: { OR: [{ sectionId: from.section.id }, { sectionId: to.section.id }] },
  select: { code: true },
  distinct: ["code"],
  orderBy: { code: "asc" },
});
const suspect = [];
for (const { code } of codesHere) {
  const total = await prisma.jobOrder.count({ where: { code } });
  if (total > 1) suspect.push(code);
}
if (suspect.length) {
  console.log("\n  A CODE OF THIS SECTION THAT ALSO EXISTS ELSEWHERE (a later upload may have left a twin)\n");
  for (const code of suspect.slice(0, 20)) {
    const where = await prisma.jobOrder.findMany({
      where: { code },
      select: { id: true, section: { select: { code: true } }, department: { select: { name: true } } },
      orderBy: { id: "asc" },
    });
    console.log(
      `     ${String(code).padEnd(10)} x${where.length}  ` +
        where.map((w) => `#${w.id} ${w.department?.name ?? "?"}/${w.section?.code ?? "-"}`).join("  |  ")
    );
  }
  if (suspect.length > 20) console.log(`     … and ${suspect.length - 20} more`);
} else {
  console.log("\n  No code of these two sections exists anywhere else — no upload left a twin.");
}

console.log("\n  Read-only: nothing was written.\n");
await prisma.$disconnect();
