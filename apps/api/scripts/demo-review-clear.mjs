#!/usr/bin/env node
/**
 * Removes everything `demo-review-seed.mjs` wrote, using the marks it left behind plus the manifest it wrote.
 *
 *   node apps/api/scripts/demo-review-clear.mjs --manifest /path/to/review-demo-manifest-<ts>.json
 *   node apps/api/scripts/demo-review-clear.mjs --mark-only          # no manifest: marks only
 *
 * What it does, in order (children before parents, so no foreign key complains):
 *   - deletes the demo timesheet days (their entries cascade)
 *   - deletes the demo progress rows
 *   - deletes the demo conversation messages, then any thread left empty
 *   - restores each Job Order's planned window and each WBS's weight from the manifest
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";

const MARK = "DEMO-REVIEW-SEED";
const BODY_MARK = "[DEMO]";
const prisma = new PrismaClient();

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] ?? null;
};
const manifestPath = flag("--manifest");
const dryRun = args.includes("--dry-run");

const manifest = manifestPath ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;

async function main() {
  const days = await prisma.timesheetDay.count({ where: { remarks: MARK } });
  const progress = await prisma.jobOrderProgress.count({ where: { remarks: MARK } });
  const messages = await prisma.jobOrderMessage.count({ where: { body: { startsWith: BODY_MARK } } });
  console.log(`found: ${days} demo timesheet day(s), ${progress} demo progress row(s), ${messages} demo message(s)`);
  if (dryRun) {
    console.log("dry run: nothing was deleted.");
    return;
  }

  // Entries belong to a day, so deleting the day takes its entries with it (onDelete: Cascade).
  // My hours: the allocation day cascades to its allocations, exactly like the timesheet day does.
  const removedAllocationDays = await prisma.employeeAllocationDay.deleteMany({ where: { remarks: MARK } });
  const removedDays = await prisma.timesheetDay.deleteMany({ where: { remarks: MARK } });
  const afterEntries = await prisma.timesheetEntry.count({
    where: { timesheetDay: { remarks: MARK } },
  });
  const removedProgress = await prisma.jobOrderProgress.deleteMany({ where: { remarks: MARK } });

  const demoMessages = await prisma.jobOrderMessage.findMany({
    where: { body: { startsWith: BODY_MARK } },
    select: { id: true, threadId: true },
  });
  const threadIds = [...new Set(demoMessages.map((row) => row.threadId))];
  const removedMessages = await prisma.jobOrderMessage.deleteMany({
    where: { id: { in: demoMessages.map((row) => row.id) } },
  });
  // A thread that held nothing but demo messages is noise; one that holds real messages is left alone.
  let removedThreads = 0;
  for (const threadId of threadIds) {
    const left = await prisma.jobOrderMessage.count({ where: { threadId } });
    if (left === 0) {
      await prisma.jobOrderThread.delete({ where: { id: threadId } });
      removedThreads += 1;
    }
  }

  let restoredOrders = 0;
  for (const row of manifest?.jobOrders ?? []) {
    await prisma.jobOrder.update({
      where: { id: row.id },
      data: {
        plannedStartDate: row.previous?.plannedStartDate ? new Date(row.previous.plannedStartDate) : null,
        plannedEndDate: row.previous?.plannedEndDate ? new Date(row.previous.plannedEndDate) : null,
      },
    });
    restoredOrders += 1;
  }
  let restoredWeights = 0;
  for (const row of manifest?.wbs ?? []) {
    await prisma.projectWbs.update({
      where: { id: row.id },
      data: { plannedWeight: row.previousWeight ?? null },
    });
    restoredWeights += 1;
  }

  console.log(
    `removed: ${removedDays.count} day(s) (−${afterEntries} entries left), ${removedProgress.count} progress row(s), ` +
      `${removedMessages.count} message(s), ${removedThreads} empty thread(s), ${removedAllocationDays.count} allocation day(s)`
  );
  console.log(`restored: ${restoredOrders} Job Order window(s), ${restoredWeights} WBS weight(s)`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
