#!/usr/bin/env node
/**
 * Finish the PIPING move: re-point any Job Order still standing on the OLD Department/Section pair.
 *
 * WHY THIS EXISTS SEPARATELY from remap-section.mjs. That script moves a whole section in one
 * transaction and then REFUSES to run again, because its precondition is "the new section must be
 * empty" — that guard is what stops two live sections being merged by accident. The consequence is
 * that anything which lands on the old pair AFTER a successful run cannot be fixed by re-running it:
 * the guard fires and the operator is left with job orders that "somehow did not migrate".
 *
 * Two things put work back on the old pair after the move, both ordinary:
 *
 *   - a Job Order CSV upload, whose file still names the old department/section (the upload resolves
 *     masters from the columns in the file and CREATES what it does not find);
 *   - a Job Order created by hand on the old pair, because the old section was deliberately left active.
 *
 * This script moves ONLY the Job Orders and Timesheet Entries of the named sections. It does not touch
 * people, scopes or approvals: if those still need moving, use remap-section.mjs, not this.
 *
 * DEFAULT IS A DRY RUN.
 *
 *   docker compose --env-file infra/docker/.env.production \
 *     -f infra/docker/compose.production.yml exec api \
 *     node apps/api/scripts/remap-leftovers.mjs \
 *       --from-dept "Production - SEZ" --from-section PIPING \
 *       --to-dept "Production Outfitting - Piping - SEZ" --to-section OUTFITTING_PIPING
 *
 * Add `--apply` to commit, `--rollback <auditId>` to undo one run.
 *
 * VERIFY BY SECTION ID, NEVER BY CODE: "PIPING" exists under more than one department, so a check
 * written as `where code = 'PIPING'` reports another department's work and reads as a failed move.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/**
 * A LIST argument, read the way a Windows operator actually types it.
 *
 * PowerShell treats an unquoted `H0005,H0006,H0007` as an ARRAY and passes three separate arguments, so
 * `arg("codes")` saw only the first one and moved one of three job orders. Reading every token up to the
 * next `--flag` accepts both shapes - `--codes a,b,c` and `--codes a b c` - and cannot silently truncate a
 * list again.
 */
function argList(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return [];
  const values = [];
  for (let j = i + 1; j < process.argv.length && !process.argv[j].startsWith("--"); j += 1) {
    values.push(...process.argv[j].split(","));
  }
  return values.map((v) => v.trim()).filter(Boolean);
}
const apply = process.argv.includes("--apply");
const rollbackId = arg("rollback");
const dryRunOnly = !apply;

function die(message) {
  console.error(`\n  ABORT: ${message}\n`);
  process.exit(1);
}
function line(label, value) {
  console.log(`  ${String(label).padEnd(46)} ${value}`);
}

async function findPair(deptName, sectionCode, side) {
  const departments = await prisma.department.findMany({
    where: { name: { equals: deptName, mode: "insensitive" } },
    select: { id: true, name: true },
  });
  if (departments.length !== 1) die(`${side} department "${deptName}" matched ${departments.length} rows.`);
  const department = departments[0];

  const sections = await prisma.section.findMany({
    where: { departmentId: department.id, code: { equals: sectionCode, mode: "insensitive" } },
    select: { id: true, code: true, name: true, departmentId: true },
  });
  if (sections.length !== 1) {
    die(`${side} section "${sectionCode}" matched ${sections.length} rows under "${department.name}".`);
  }
  return { department, section: sections[0] };
}

async function report(jobOrderIds, entryIds) {
  const perOrder = await prisma.jobOrder.findMany({
    where: { id: { in: jobOrderIds } },
    select: {
      id: true, code: true, name: true, createdAt: true,
      department: { select: { name: true } },
      section: { select: { code: true } },
      _count: { select: { timesheetEntries: true } },
    },
    orderBy: { id: "asc" },
  });
  for (const o of perOrder) {
    console.log(
      `     #${o.id} ${String(o.code).padEnd(10)} ${String(o.name).slice(0, 34).padEnd(35)} ` +
        `${o.department?.name ?? "?"} / ${o.section?.code ?? "(none)"}  ` +
        `${o._count.timesheetEntries} entries  created ${o.createdAt.toISOString().slice(0, 10)}`
    );
  }
  line("timesheet entries to re-point", entryIds.length);
}

// ── --rollback <auditId>: undo exactly what that run moved ─────────────────────────────────────────
//
// The undo lives in `audit_log`, not in a file beside the script: this runs inside a container with
// `docker compose exec`, and anything written to the container filesystem is gone the moment the
// container is recreated. A rollback that cannot be found is not a rollback.
if (rollbackId) {
  const audit = await prisma.auditLog.findUnique({ where: { id: Number(rollbackId) } });
  if (!audit || audit.action !== "SECTION_REMAP_LEFTOVERS") {
    die(`audit row ${rollbackId} is not a SECTION_REMAP_LEFTOVERS run.`);
  }
  const meta = JSON.parse(audit.metadata);
  if (meta.rolledBackAt) die(`audit row ${rollbackId} was already rolled back at ${meta.rolledBackAt}.`);

  const jobOrderIds = (meta.jobOrders || []).map((j) => j.id);
  const entryIds = meta.entries || [];
  console.log(`\n  ROLLING BACK audit ${rollbackId} — ${jobOrderIds.length} job order(s), ${entryIds.length} entries`);

  const result = await prisma.$transaction(async (tx) => {
    const out = {};
    out.jobOrders = (
      await tx.jobOrder.updateMany({
        where: { id: { in: jobOrderIds } },
        data: { departmentId: meta.from.departmentId, sectionId: meta.from.sectionId },
      })
    ).count;
    out.entries = entryIds.length
      ? (
          await tx.timesheetEntry.updateMany({
            where: { id: { in: entryIds } },
            data: { departmentId: meta.from.departmentId, sectionId: meta.from.sectionId },
          })
        ).count
      : 0;
    await tx.auditLog.update({
      where: { id: Number(rollbackId) },
      data: {
        metadata: JSON.stringify({
          ...meta,
          rolledBackAt: new Date().toISOString(),
          rolledBack: out,
        }),
      },
    });
    return out;
  });
  line("job orders restored to the old pair", result.jobOrders);
  line("entries restored to the old pair", result.entries);
  console.log("\n  Done. Nothing else was touched.\n");
  await prisma.$disconnect();
  process.exit(0);
}

// ── the move ──────────────────────────────────────────────────────────────────────────────────────
const from = await findPair(arg("from-dept"), arg("from-section"), "from");
const to = await findPair(arg("to-dept"), arg("to-section"), "to");
if (from.section.id === to.section.id) die("the source and the destination section are the same row.");

line("from", `${from.department.name} / ${from.section.code} (section ${from.section.id})`);
line("to", `${to.department.name} / ${to.section.code} (section ${to.section.id})`);

// ── optional scope: --codes H0005,H0006 --project ISN.001 ────────────────────────────────────────
//
// A WHOLE-SECTION move is the common case, but "these three job orders go, nothing else does" is a
// different instruction and must not be expressed as a section filter: the moment a fourth order
// appears on the same section, a section-wide run would take it along.
//
// The project matters because a job order CODE is unique only within its project (`(projectId, code)`);
// H0005 exists once here, but M4152 exists five times across the plant.
const codeList = argList("codes");
let projectId = null;
if (codeList.length) {
  const projectArg = arg("project");
  if (projectArg) {
    const projects = await prisma.project.findMany({
      where: { OR: [{ code: { equals: projectArg, mode: "insensitive" } }, { name: { equals: projectArg, mode: "insensitive" } }] },
      select: { id: true, code: true, name: true },
    });
    if (projects.length !== 1) die(`--project "${projectArg}" matched ${projects.length} projects.`);
    projectId = projects[0].id;
    line("project", `${projects[0].code} ${projects[0].name}`);
  }

  // Every named code must exist. A typo has to stop the run, not quietly move two of the three.
  const named = await prisma.jobOrder.findMany({
    where: { code: { in: codeList }, ...(projectId ? { projectId } : {}) },
    select: { id: true, code: true, sectionId: true, departmentId: true },
  });
  const missing = codeList.filter((c) => !named.some((n) => n.code === c));
  if (missing.length) die(`job order code(s) ${missing.join(", ")} not found${projectId ? " on that project" : ""}.`);
  if (named.length !== codeList.length) {
    die(
      `the code(s) ${named.map((n) => n.code).join(", ")} match ${named.length} rows for ${codeList.length} codes. ` +
        "Pass --project to say which one, or split the run."
    );
  }
  const alreadyThere = named.filter((n) => n.sectionId === to.section.id);
  if (alreadyThere.length) {
    line("already on the destination", alreadyThere.map((n) => `#${n.id} ${n.code}`).join(", "));
  }
  line("codes named", codeList.join(", "));
}

// A Job Order is on the old pair when EITHER column still says so: a half-moved row (new section, old
// department) is exactly the shape that reads as "migrated" in one screen and "missing" in another.
const onOldPair = {
  OR: [{ sectionId: from.section.id }, { departmentId: from.department.id, sectionId: from.section.id }],
};
const strays = await prisma.jobOrder.findMany({
  where: codeList.length
    ? { AND: [{ code: { in: codeList }, ...(projectId ? { projectId } : {}) }, onOldPair] }
    : onOldPair,
  select: { id: true },
  orderBy: { id: "asc" },
});
const jobOrderIds = strays.map((r) => r.id);

// Entries follow their job order. Re-pointing an entry whose job order is NOT moving would split one
// order's history across two sections, so only entries of the moving orders are considered.
const entryIds = jobOrderIds.length
  ? (
      await prisma.timesheetEntry.findMany({
        where: {
          jobOrderId: { in: jobOrderIds },
          OR: [{ sectionId: from.section.id }, { departmentId: from.department.id }],
        },
        select: { id: true },
      })
    ).map((r) => r.id)
  : [];

console.log("");
if (jobOrderIds.length === 0) {
  console.log("  NOTHING TO MOVE — no job order stands on the old pair.\n");
  console.log("  If a screen still shows one under the old department, the row is elsewhere:");
  console.log("  run the diagnostic in docs/plans/2026-10-21-remap-leftovers.md before guessing.\n");
  await prisma.$disconnect();
  process.exit(0);
}

line("job orders on the old pair", jobOrderIds.length);
await report(jobOrderIds, entryIds);

// The section-wide totals, so the operator sees the destination rather than trusting the verb.
const destOrders = await prisma.jobOrder.count({ where: { sectionId: to.section.id } });
const destEntries = await prisma.timesheetEntry.count({ where: { sectionId: to.section.id } });
const oldOrders = await prisma.jobOrder.count({ where: { sectionId: from.section.id } });
line("before: job orders on destination", destOrders);
line("before: job orders on old section", oldOrders);
line("before: entries on destination", destEntries);

if (dryRunOnly) {
  console.log("\n  This was a DRY RUN. Re-run the same command with --apply to commit it.\n");
  await prisma.$disconnect();
  process.exit(0);
}

// The move and its undo record are ONE transaction: an audit row written before the transaction would
// survive a failure and describe a move that never happened, and a rollback would then "restore" rows
// that were never changed.
const { moved, auditId } = await prisma.$transaction(async (tx) => {
  const out = {};
  out.jobOrders = (
    await tx.jobOrder.updateMany({
      where: { id: { in: jobOrderIds } },
      data: { departmentId: to.department.id, sectionId: to.section.id },
    })
  ).count;
  out.entries = entryIds.length
    ? (
        await tx.timesheetEntry.updateMany({
          where: { id: { in: entryIds } },
          data: { departmentId: to.department.id, sectionId: to.section.id },
        })
      ).count
    : 0;

  const audit = await tx.auditLog.create({
    data: {
      userId: null,
      action: "SECTION_REMAP_LEFTOVERS",
      entityType: "section",
      entityId: String(from.section.id),
      metadata: JSON.stringify({
        fromNames: { department: from.department.name, section: from.section.code },
        toNames: { department: to.department.name, section: to.section.code },
        from: { departmentId: from.department.id, sectionId: from.section.id },
        to: { departmentId: to.department.id, sectionId: to.section.id },
        moved: out,
        jobOrders: jobOrderIds.map((id) => ({ id })),
        entries: entryIds,
      }),
    },
    select: { id: true },
  });
  return { moved: out, auditId: audit.id };
});

// Read the result back by ID. A count coming out of updateMany is the report of an intention, not
// proof that the row now says what the screen needs it to say.
//
// WHAT "VERIFIED" MEANS DEPENDS ON THE INSTRUCTION. A section-wide run promises an empty old section; a
// --codes run promises that THOSE codes moved, and the old section is allowed to keep the rest. Asserting
// the section-wide promise after a scoped move reported VERIFY FAILED on a correct migration — a false
// alarm on top of a real one is the worst thing to hand an operator mid-run.
const afterOld = await prisma.jobOrder.count({ where: { sectionId: from.section.id } });
const afterDest = await prisma.jobOrder.count({ where: { sectionId: to.section.id } });
const stillOldDept = await prisma.jobOrder.count({
  where: { id: { in: jobOrderIds }, departmentId: from.department.id },
});
const named = codeList.length
  ? await prisma.jobOrder.findMany({
      where: { code: { in: codeList }, ...(projectId ? { projectId } : {}) },
      select: { code: true, sectionId: true },
    })
  : [];
const namedStillOld = named.filter((n) => n.sectionId !== to.section.id);

console.log("");
line("job orders moved", moved.jobOrders);
line("entries moved", moved.entries);
line("AFTER: job orders on old section", afterOld);
line("AFTER: job orders on destination", afterDest);
line("AFTER: moving orders still on old dept", stillOldDept);
if (codeList.length) {
  line("AFTER: named codes on the destination", `${named.length - namedStillOld.length} of ${named.length}`);
}
line("audit id (keep it — it is the undo)", `--rollback ${auditId}`);

const ok = codeList.length
  ? namedStillOld.length === 0 && named.length === codeList.length && stillOldDept === 0
  : afterOld === 0 && stillOldDept === 0 && afterDest === destOrders + moved.jobOrders;
console.log(
  ok
    ? codeList.length
      ? "\n  VERIFIED: every named job order now stands on the destination.\n"
      : "\n  VERIFIED: nothing is left on the old section.\n"
    : `\n  VERIFY FAILED: ${namedStillOld.map((n) => n.code).join(", ") || "the counts"} still do not match. ` +
        "Do NOT continue; inspect before anything else.\n"
);
if (!ok) process.exitCode = 1;
await prisma.$disconnect();