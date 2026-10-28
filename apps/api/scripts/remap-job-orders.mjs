#!/usr/bin/env node
/**
 * Move Job Orders to another Department / Section WITHOUT touching Project, WBS or Network.
 *
 *   docker compose -f infra/docker/compose.production.yml --env-file $envFile \
 *     exec api node apps/api/scripts/remap-job-orders.mjs apps/api/scripts/migrations/job-order-org-remap-2026-10.csv
 *
 * Reads a CSV (Project_Code, Job_Order, New_Department, New_Section; any other column is ignored), resolves every
 * name against the masters, prints what changes, and writes NOTHING unless `--apply` is passed.
 *
 * WHY A SCRIPT AND NOT THE SCREEN: `PUT /master-data/job-orders/:id/mapping` edits the WBS/Network pair only, and
 * the Job Order upload CREATES — an existing code is reported as "already exists" and skipped. There is no route
 * that moves a Job Order's Department/Section, so eleven rows across four projects would be eleven hand edits in
 * a form that does not offer the field.
 *
 * Refuses the whole run when ANY row cannot be resolved, so a half-applied list is impossible. Each applied row
 * writes one audit entry (`JOB_ORDER_ORG_REMAP`) carrying the previous and the next pair, and the actor is the
 * Admin whose account is used to run it.
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/** Minimal RFC-4180 reader: quotes, doubled quotes, CRLF, optional BOM. */
function parseCsv(text) {
  const clean = text.replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < clean.length; index += 1) {
    const char = clean[index];
    if (quoted) {
      if (char === '"' && clean[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === ",") { row.push(field); field = ""; continue; }
    if (char === "\r") continue;
    if (char === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += char;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

const norm = (value) => String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();

async function main() {
  const args = process.argv.slice(2);
  const csvPath = args.find((arg) => !arg.startsWith("--"));
  const apply = args.includes("--apply");
  if (!csvPath) {
    console.error("usage: node apps/api/scripts/remap-job-orders.mjs <mapping.csv> [--apply]");
    process.exit(2);
  }

  const host = String(process.env.DATABASE_URL || "").replace(/^[a-z]+:\/\//i, "").split("@").pop()?.split("/")[0] ?? "(unset)";
  console.log(`database: ${host}   mode: ${apply ? "APPLY" : "dry run (nothing written)"}`);
  console.log(`mapping:  ${csvPath}\n`);

  const table = parseCsv(readFileSync(csvPath, "utf8"));
  if (table.length < 2) {
    console.error("the mapping file has no data rows.");
    process.exit(2);
  }
  const header = table[0].map((cell) => norm(cell));
  const column = (name) => {
    const index = header.indexOf(name);
    if (index < 0) throw new Error(`missing column '${name}' (found: ${table[0].join(", ")})`);
    return index;
  };
  const col = {
    project: column("project_code"),
    jobOrder: column("job_order"),
    department: column("new_department"),
    section: column("new_section"),
  };

  const actor = await prisma.user.findFirst({
    where: { role: "ADMIN", active: true },
    select: { id: true, name: true },
    orderBy: { id: "asc" },
  });
  if (!actor) {
    console.error("no active ADMIN account to attribute the audit entries to.");
    process.exit(2);
  }

  const [projects, departments, sections] = await Promise.all([
    prisma.project.findMany({ select: { id: true, code: true, name: true } }),
    prisma.department.findMany({ select: { id: true, name: true, code: true, active: true } }),
    prisma.section.findMany({ select: { id: true, departmentId: true, name: true, code: true, active: true } }),
  ]);

  const problems = [];
  const plan = [];
  table.slice(1).forEach((cells, offset) => {
    const line = offset + 2;
    const projectCode = String(cells[col.project] ?? "").trim();
    const jobOrderCode = String(cells[col.jobOrder] ?? "").trim();
    const departmentName = String(cells[col.department] ?? "").trim();
    const sectionName = String(cells[col.section] ?? "").trim();

    const project = projects.find((row) => norm(row.code) === norm(projectCode));
    if (!project) { problems.push(`line ${line}: project '${projectCode}' not found`); return; }

    const departmentMatches = departments.filter((row) => norm(row.name) === norm(departmentName));
    if (departmentMatches.length !== 1) {
      problems.push(
        `line ${line}: department '${departmentName}' ${departmentMatches.length === 0 ? "does not exist" : "is ambiguous"} — create it in Master Data → Departments first`
      );
      return;
    }
    const department = departmentMatches[0];
    if (!department.active) { problems.push(`line ${line}: department '${department.name}' is inactive`); return; }

    const sectionMatches = sections.filter((row) => row.departmentId === department.id && norm(row.name) === norm(sectionName));
    if (sectionMatches.length !== 1) {
      problems.push(
        `line ${line}: section '${sectionName}' ${sectionMatches.length === 0 ? `does not exist in department '${department.name}'` : "is ambiguous"} — create it under that department first`
      );
      return;
    }
    const section = sectionMatches[0];
    if (!section.active) { problems.push(`line ${line}: section '${section.name}' is inactive`); return; }

    plan.push({
      line,
      projectCode: project.code,
      projectId: project.id,
      jobOrderCode,
      toDepartment: department,
      toSection: section,
    });
  });

  if (problems.length > 0) {
    console.error(`REFUSED — ${problems.length} row(s) cannot be resolved. Nothing was written.\n`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exitCode = 1;
    return;
  }

  // Resolve the Job Orders themselves and build the before/after table.
  const changes = [];
  for (const item of plan) {
    const jobOrder = await prisma.jobOrder.findFirst({
      where: { projectId: item.projectId, code: { equals: item.jobOrderCode, mode: "insensitive" } },
      select: {
        id: true, code: true, name: true,
        departmentId: true, sectionId: true,
        department: { select: { name: true } },
        section: { select: { name: true } },
        projectWbs: { select: { wbsCode: true } },
        network: { select: { code: true } },
      },
    });
    if (!jobOrder) {
      changes.push({ ...item, missing: true });
      continue;
    }
    const unchanged = jobOrder.departmentId === item.toDepartment.id && jobOrder.sectionId === item.toSection.id;
    changes.push({ ...item, jobOrder, unchanged });
  }

  const missing = changes.filter((row) => row.missing);
  if (missing.length > 0) {
    console.error(`REFUSED — ${missing.length} Job Order(s) not found under the project named. Nothing was written.\n`);
    for (const row of missing) console.error(`  ${row.projectCode} / ${row.jobOrderCode} (line ${row.line})`);
    process.exitCode = 1;
    return;
  }

  console.log("WHAT CHANGES (Project, WBS and Network stay exactly as they are)\n");
  for (const row of changes) {
    const from = `${row.jobOrder.department.name} / ${row.jobOrder.section?.name ?? "<none>"}`;
    const to = `${row.toDepartment.name} / ${row.toSection.name}`;
    console.log(
      `${row.projectCode} ${row.jobOrderCode.padEnd(7)} WBS ${row.jobOrder.projectWbs.wbsCode}  NET ${row.jobOrder.network.code}\n` +
        `    ${row.jobOrder.name.slice(0, 64)}\n` +
        `    ${from}  ->  ${to}${row.unchanged ? "   [already there]" : ""}`
    );
  }

  const toUpdate = changes.filter((row) => !row.unchanged);
  const ids = changes.map((row) => row.jobOrder.id);
  const [bookedEntries, openDays, allocationSlots] = await Promise.all([
    prisma.timesheetEntry.count({ where: { jobOrderId: { in: ids } } }),
    prisma.timesheetDay.count({
      where: { status: { in: ["SUBMITTED", "HOD_APPROVED", "PLANNING_RETURNED"] }, entries: { some: { jobOrderId: { in: ids } } } },
    }),
    prisma.employeeAllocation.count({ where: { jobOrderId: { in: ids } } }),
  ]);
  console.log(
    `\nIMPACT  ${toUpdate.length} of ${changes.length} Job Order(s) change.\n` +
      `        ${bookedEntries} booked timesheet slot(s) and ${allocationSlots} My Hours slot(s) reference them: reports attribute\n` +
      `        those hours to the Job Order's CURRENT Department/Section, so past bookings move with the work.\n` +
      `        ${openDays} day(s) are still in the approval chain on these Job Orders; their approval routing follows the\n` +
      `        EMPLOYEE's own Department/Section, so no queue changes hands.`
  );

  if (!apply) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply to make these changes.");
    return;
  }

  console.log(`\nAPPLYING as ${actor.name} (audit entries carry previous + next)\n`);
  for (const row of toUpdate) {
    const previous = {
      departmentId: row.jobOrder.departmentId,
      departmentName: row.jobOrder.department.name,
      sectionId: row.jobOrder.sectionId,
      sectionName: row.jobOrder.section?.name ?? null,
    };
    const next = {
      departmentId: row.toDepartment.id,
      departmentName: row.toDepartment.name,
      sectionId: row.toSection.id,
      sectionName: row.toSection.name,
    };
    await prisma.$transaction(async (tx) => {
      await tx.jobOrder.update({ where: { id: row.jobOrder.id }, data: { departmentId: next.departmentId, sectionId: next.sectionId } });
      await tx.auditLog.create({
        data: {
          userId: actor.id,
          action: "JOB_ORDER_ORG_REMAP",
          entityType: "job_order",
          entityId: String(row.jobOrder.id),
          metadata: JSON.stringify({
            projectCode: row.projectCode,
            jobOrderCode: row.jobOrderCode,
            wbsCode: row.jobOrder.projectWbs.wbsCode,
            networkCode: row.jobOrder.network.code,
            previous,
            next,
            via: "remap-job-orders.mjs",
          }),
        },
      });
    });
    console.log(`  moved  ${row.projectCode} ${row.jobOrderCode.padEnd(7)} ${previous.departmentName} / ${previous.sectionName} -> ${next.departmentName} / ${next.sectionName}`);
  }

  // Read back, because a write nobody verified is a claim.
  console.log("\nVERIFIED FROM THE DATABASE\n");
  for (const row of changes) {
    const after = await prisma.jobOrder.findUnique({
      where: { id: row.jobOrder.id },
      select: { code: true, department: { select: { name: true } }, section: { select: { name: true } }, projectWbs: { select: { wbsCode: true } }, network: { select: { code: true } } },
    });
    const expected = `${row.toDepartment.name} / ${row.toSection.name}`;
    const actual = `${after.department.name} / ${after.section?.name ?? "<none>"}`;
    console.log(`  ${actual === expected ? "OK    " : "WRONG "} ${row.projectCode} ${after.code.padEnd(7)} ${actual}   (WBS ${after.projectWbs.wbsCode}, NET ${after.network.code})`);
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
