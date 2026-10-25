#!/usr/bin/env node
/**
 * Read-only audit: does this database contain any of the DEMO data the review/demo seeders write?
 *
 * Run it on a production host BEFORE and AFTER a deploy, and before trusting a number on a review screen. It
 * writes nothing, so it is safe to run against the live database.
 *
 *   docker compose -f infra/docker/compose.production.yml exec api node apps/api/scripts/check-demo-data.mjs
 *
 * Exit code 0 = clean. Exit code 1 = demo rows were found (the list says which table and how many).
 *
 * What counts as demo data, and why each mark is the right one:
 *   timesheet_days.remarks            "DEMO-REVIEW-SEED"  (its entries cascade from the day)
 *   employee_allocation_days.remarks  "DEMO-REVIEW-SEED"  (its allocations cascade from the day)
 *   job_order_progress.remarks        "DEMO-REVIEW-SEED"
 *   job_order_messages.body           starts with "[DEMO]"
 * Real work can never carry these marks: they are written only by `demo-review-seed.mjs`, which refuses to run
 * with NODE_ENV=production or against a non-local DATABASE_URL.
 */
import { PrismaClient } from "@prisma/client";

const MARK = "DEMO-REVIEW-SEED";
const BODY_MARK = "[DEMO]";
const prisma = new PrismaClient();

const checks = [
  ["timesheet_days", () => prisma.timesheetDay.count({ where: { remarks: MARK } })],
  ["timesheet_entries (under a demo day)", () => prisma.timesheetEntry.count({ where: { timesheetDay: { remarks: MARK } } })],
  ["employee_allocation_days", () => prisma.employeeAllocationDay.count({ where: { remarks: MARK } })],
  ["employee_allocations (under a demo day)", () => prisma.employeeAllocation.count({ where: { allocationDay: { remarks: MARK } } })],
  ["job_order_progress", () => prisma.jobOrderProgress.count({ where: { remarks: MARK } })],
  ["job_order_messages", () => prisma.jobOrderMessage.count({ where: { body: { startsWith: BODY_MARK } } })],
];

async function main() {
  const url = String(process.env.DATABASE_URL || "");
  const host = url.replace(/^[a-z]+:\/\//i, "").split("@").pop()?.split("/")[0] ?? "(unset)";
  const database = url.split("/").pop() ?? "";
  console.log(`database: ${host}${database ? `/${database}` : ""} (NODE_ENV=${process.env.NODE_ENV ?? "unset"})`);

  let dirty = 0;
  for (const [label, count] of checks) {
    const found = await count();
    if (found > 0) dirty += found;
    console.log(`  ${found === 0 ? "clean " : "FOUND "} ${String(found).padStart(6)}  ${label}`);
  }

  // Informational: frozen packs are real data, not demo data. A fresh production box should have none yet.
  const snapshots = await prisma.reportSnapshot.count();
  console.log(`  ${String(snapshots).padStart(13)}  report_snapshot (informational, not a demo mark)`);

  if (dirty > 0) {
    console.error(
      `\nFAILED: ${dirty} demo row(s) are in this database. They came from apps/api/scripts/demo-review-seed.mjs, ` +
        `which is for development machines only. Remove them with demo-review-clear.mjs, and do not quote any ` +
        `number from a screen this database feeds until they are gone.`
    );
    process.exitCode = 1;
    return;
  }
  console.log("\nOK: no demo data in this database.");
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
