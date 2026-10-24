#!/usr/bin/env node
/**
 * DEMO DATA — dev machines only. Never run against production.
 *
 * Fills the two projects with the most Job Orders (excluding the Non-Project row) with the execution evidence a
 * project review needs to be judged on: planned windows, weekly quantity progress, booked hours, and a few
 * escalations of different ages. The point is to see the review screen with real-looking numbers, not to prove
 * anything about the yard.
 *
 * EVERYTHING IT WRITES IS MARKED, and `demo-review-clear.mjs` removes it:
 *   - timesheet_days.remarks = 'DEMO-REVIEW-SEED'   (entries cascade from the day)
 *   - job_order_progress.remarks = 'DEMO-REVIEW-SEED'
 *   - job_order_messages.body starts with '[DEMO]'
 *   - job_orders.planned_start/end and project_wbs.planned_weight are restored to their previous values
 *     (recorded in the manifest the script writes)
 *
 * Usage:
 *   node apps/api/scripts/demo-review-seed.mjs --projects 2 --employees 12 --weeks 8
 *   node apps/api/scripts/demo-review-seed.mjs --dry-run
 */
import { PrismaClient } from "@prisma/client";

const MARK = "DEMO-REVIEW-SEED";
const BODY_MARK = "[DEMO]";
const prisma = new PrismaClient();

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1] ?? fallback;
};
const dryRun = args.includes("--dry-run");
const projectCount = Math.max(1, Math.min(5, Number(flag("--projects", 2))));
const employeeCount = Math.max(4, Math.min(30, Number(flag("--employees", 12))));
const weeks = Math.max(2, Math.min(26, Number(flag("--weeks", 8))));

const DAY = 86_400_000;
const startOfDay = (value) => new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
const iso = (value) => value.toISOString().slice(0, 10);
const addDays = (value, days) => new Date(value.getTime() + days * DAY);
const round = (value, places = 2) => Math.round(value * 10 ** places) / 10 ** places;

/** Deterministic pseudo-randomness: the same seed gives the same demo twice, so a demo can be repeated. */
function seeded(seed) {
  let state = seed % 2147483647;
  if (state <= 0) state += 2147483646;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

function guardEnvironment() {
  if (String(process.env.NODE_ENV || "").toLowerCase() === "production") {
    console.error("REFUSED: this script writes demo data and must never run with NODE_ENV=production.");
    process.exit(1);
  }
  const url = String(process.env.DATABASE_URL || "");
  const host = url.replace(/^[a-z]+:\/\//i, "").split("@").pop()?.split("/")[0] ?? "";
  const local = /^(localhost|127\.0\.0\.1|host\.docker\.internal)(:\d+)?$/.test(host);
  if (!local) {
    console.error(`REFUSED: DATABASE_URL host is "${host}", which is not a local database. Demo data belongs on a dev box.`);
    process.exit(1);
  }
}

async function main() {
  guardEnvironment();
  const today = startOfDay(new Date());

  const projects = await prisma.project.findMany({
    where: { isNonProject: false, active: true },
    select: { id: true, code: true, name: true, _count: { select: { jobOrders: true } } },
    orderBy: { jobOrders: { _count: "desc" } },
    take: projectCount,
  });
  if (!projects.length) throw new Error("no project with Job Orders");

  console.log(`${dryRun ? "DRY RUN — " : ""}seeding ${projects.length} project(s): ${projects.map((p) => `${p.code} (${p._count.jobOrders})`).join(", ")}`);
  const manifest = { seededAt: new Date().toISOString(), mark: MARK, projects: [], jobOrders: [], wbs: [] };

  for (const project of projects) {
    const rand = seeded(project.id * 7919 + 13);
    const jobOrders = await prisma.jobOrder.findMany({
      where: { projectId: project.id },
      select: {
        id: true,
        code: true,
        budgetedHours: true,
        budgetedQuantity: true,
        plannedStartDate: true,
        plannedEndDate: true,
        departmentId: true,
        sectionId: true,
        projectWbsId: true,
      },
      orderBy: { code: "asc" },
    });

    // ---------- 1. planned windows ----------
    // A review is only interesting when the portfolio is MIXED: some work finished, some running late, some on
    // plan, some not started. One flat rule would draw one flat story.
    const windows = jobOrders.map((order, index) => {
      const bucket = index % 20;
      if (bucket >= 18) return { ...order, plan: null, kind: "NO_PLAN", pace: 0 }; // 10% deliberately unplanned
      if (bucket < 5) {
        // Finished inside the window and finished clean: the work is closed, the sheet agrees.
        const start = addDays(today, -120 - Math.floor(rand() * 30));
        return { ...order, plan: { start, end: addDays(today, -20 - Math.floor(rand() * 20)) }, kind: "CLOSED", pace: 1 };
      }
      if (bucket < 8) {
        // Past its end with work still outstanding: the row a review exists to find.
        const start = addDays(today, -140 - Math.floor(rand() * 30));
        return { ...order, plan: { start, end: addDays(today, -10 - Math.floor(rand() * 15)) }, kind: "CLOSED_LATE", pace: 0.7 + rand() * 0.2 };
      }
      if (bucket < 15) {
        // Running: the calendar is 45–85% through the window, so the planned line has real work behind it and
        // the actual line can legitimately sit either side of it.
        const windowDays = 100 + Math.floor(rand() * 40);
        const elapsedFraction = 0.45 + rand() * 0.4;
        const elapsed = Math.round(windowDays * elapsedFraction);
        const start = addDays(today, -elapsed);
        return { ...order, plan: { start, end: addDays(start, windowDays) }, kind: "RUNNING", pace: 0.55 + rand() * 0.5 };
      }
      return { ...order, plan: { start: addDays(today, 10 + Math.floor(rand() * 20)), end: addDays(today, 90 + Math.floor(rand() * 40)) }, kind: "UPCOMING", pace: 0 };
    });

    for (const order of windows) {
      manifest.jobOrders.push({
        id: order.id,
        code: order.code,
        previous: { plannedStartDate: order.plannedStartDate, plannedEndDate: order.plannedEndDate },
      });
    }
    if (!dryRun) {
      for (const order of windows) {
        await prisma.jobOrder.update({
          where: { id: order.id },
          data: {
            plannedStartDate: order.plan ? order.plan.start : null,
            plannedEndDate: order.plan ? order.plan.end : null,
          },
        });
      }
    }
    const plannedCount = windows.filter((order) => order.plan).length;
    console.log(`  ${project.code}: ${plannedCount}/${windows.length} Job Orders planned ` +
      `(${windows.filter((o) => o.kind === "CLOSED").length} closed, ${windows.filter((o) => o.kind === "CLOSED_LATE").length} closed late, ` +
      `${windows.filter((o) => o.kind === "RUNNING").length} running, ${windows.filter((o) => o.kind === "UPCOMING").length} upcoming, ` +
      `${windows.filter((o) => o.kind === "NO_PLAN").length} unplanned)`);

    // ---------- 2. WBS weights ----------
    // Proportional to each WBS's share of the project's budgeted hours, so the WBS-level curves are meaningful
    // and the weightage rule is visible instead of theoretical.
    const wbsRows = await prisma.projectWbs.findMany({
      where: { projectId: project.id },
      select: { id: true, wbsCode: true, plannedWeight: true },
    });
    const budgetByWbs = new Map();
    for (const order of jobOrders) {
      budgetByWbs.set(order.projectWbsId, (budgetByWbs.get(order.projectWbsId) ?? 0) + order.budgetedHours);
    }
    const budgetValues = wbsRows.map((node) => budgetByWbs.get(node.id) ?? 0).filter((value) => value > 0);
    const averageWbsBudget = budgetValues.length
      ? budgetValues.reduce((sum, value) => sum + value, 0) / budgetValues.length
      : 1;
    for (const node of wbsRows) {
      manifest.wbs.push({ id: node.id, wbsCode: node.wbsCode, previousWeight: node.plannedWeight });
      // A WBS whose Job Orders carry no budget still exists and still does work: it takes the average weight
      // rather than a rounding speck, which is the same rule the curve applies to an unweighted node.
      const budget = budgetByWbs.get(node.id) ?? 0;
      const weight = round(budget > 0 ? budget : averageWbsBudget, 2);
      if (!dryRun) await prisma.projectWbs.update({ where: { id: node.id }, data: { plannedWeight: weight } });
    }
    console.log(`  ${project.code}: ${wbsRows.length} WBS weighted by budget share`);

    // ---------- 3. weekly quantity progress ----------
    const punchedBy = (await prisma.user.findFirst({ where: { role: "PM" }, select: { id: true } })) ??
      (await prisma.user.findFirst({ where: { role: "ADMIN" }, select: { id: true } }));
    const approvedBy = await prisma.user.findFirst({ where: { role: "ADMIN" }, select: { id: true } });
    const progressRows = [];
    for (const order of windows) {
      if (!order.plan || order.plan.start > today) continue;
      // An achieved rate per Job Order: 0.55–1.05 of the plan. Below 1 is behind, above is ahead.
      const pace = order.pace || 0.8;
      const windowDays = Math.max(1, (order.plan.end - order.plan.start) / DAY);
      const target = order.budgetedQuantity > 0 ? order.budgetedQuantity : 100;
      for (let dayOffset = 0; dayOffset <= windowDays; dayOffset += 7) {
        const date = addDays(order.plan.start, dayOffset);
        if (date > today) break;
        const elapsed = (date - order.plan.start) / DAY;
        const fraction = Math.min(1, (elapsed / windowDays) * pace);
        progressRows.push({
          jobOrderId: order.id,
          progressDate: date,
          cumulativeQuantity: round(target * fraction, 3),
          revisionNo: 1,
          sectionId: order.sectionId,
          status: "APPROVED",
          punchedById: punchedBy.id,
          approvedById: approvedBy?.id ?? null,
          approvedAt: addDays(date, 2),
          remarks: MARK,
        });
      }
    }
    if (!dryRun && progressRows.length) {
      await prisma.jobOrderProgress.createMany({ data: progressRows, skipDuplicates: true });
    }
    console.log(`  ${project.code}: ${progressRows.length} approved progress row(s)`);

    // ---------- 4. booked hours ----------
    // Four shift slots a day is one man-day of eight hours, which is how the timesheet model counts hours.
    const departments = [...new Set(jobOrders.map((order) => order.departmentId))];
    const employees = await prisma.employee.findMany({
      where: { active: true, departmentId: { in: departments } },
      select: { id: true, departmentId: true },
      orderBy: { id: "asc" },
      take: employeeCount,
    });
    const supervisor = await prisma.user.findFirst({
      where: { role: "SUPERVISOR", active: true },
      select: { id: true },
    });
    const tagger = supervisor ?? punchedBy;
    const runningOrders = windows.filter((order) => order.plan && order.plan.start <= today && order.plan.end >= addDays(today, -weeks * 7));
    const bookableOrders = runningOrders.length ? runningOrders : windows.filter((order) => order.plan);
    // Weight the choice by REMAINING budget (budget × what is left to do), so a nearly finished Job Order stops
    // attracting hours. Choosing uniformly produced rows at 5,600% burn, which is not a review signal, it is a
    // seeding artefact.
    const weights = bookableOrders.map((order) => {
      const remaining = Math.max(0, (1 - Math.min(1, order.pace || 0.8))) * Math.max(1, order.budgetedHours);
      return remaining > 0 ? remaining : Math.max(1, order.budgetedHours) * 0.05;
    });
    const totalWeight = weights.reduce((sum, value) => sum + value, 0);
    // A Job Order that has already been charged a little more than its budget stops attracting hours. Without
    // this, a 5-hour Job Order could absorb a month of crew time and show 5,600% burn — a seeding artefact
    // wearing the costume of a finding.
    const assignedHours = new Map();
    const isFull = (order) => {
      const cap = Math.max(4, order.budgetedHours * 1.1);
      return (assignedHours.get(order.id) ?? 0) >= cap;
    };
    const pickOrder = (roll) => {
      let target = roll * totalWeight;
      for (let index = 0; index < bookableOrders.length; index++) {
        target -= weights[index];
        if (target <= 0 && !isFull(bookableOrders[index])) return bookableOrders[index];
      }
      const open = bookableOrders.filter((order) => !isFull(order));
      return open.length ? open[Math.floor(roll * open.length)] : bookableOrders[bookableOrders.length - 1];
    };

    const workDays = [];
    for (let offset = weeks * 7 - 1; offset >= 0; offset--) {
      const day = addDays(today, -offset);
      if (day.getUTCDay() === 0) continue; // Sunday: the yard's weekly off
      if (iso(day) === "2026-10-02" || iso(day) === "2026-10-20") continue; // the two real holidays
      workDays.push(day);
    }

    let dayRows = 0;
    let entryRows = 0;
    for (let index = 0; index < employees.length; index++) {
      const employee = employees[index];
      for (const day of workDays) {
        // Not everybody works every day: a fifth of the man-days are simply absent.
        if (rand() < 0.18) continue;
        const order = pickOrder(rand());
        // Ten per cent of the hours stay SUBMITTED, so the unapproved-aging signal has something to age.
        const status = rand() < 0.1 ? "SUBMITTED" : "PM_APPROVED";
        if (dryRun) {
          dayRows += 1;
          entryRows += 4;
          continue;
        }
        const timesheetDay = await prisma.timesheetDay.upsert({
          where: { employeeId_workDate_taggedById: { employeeId: employee.id, workDate: day, taggedById: tagger.id } },
          update: { remarks: MARK },
          create: {
            employeeId: employee.id,
            workDate: day,
            taggedById: tagger.id,
            status,
            remarks: MARK,
          },
          select: { id: true },
        });
        await prisma.timesheetEntry.createMany({
          data: ["am1", "am2", "pm1", "pm2"].map((slot) => ({
            timesheetDayId: timesheetDay.id,
            employeeId: employee.id,
            workDate: day,
            shiftSlot: slot,
            projectId: project.id,
            projectWbsId: order.projectWbsId,
            jobOrderId: order.id,
            departmentId: order.departmentId,
            sectionId: order.sectionId,
            taggedById: tagger.id,
            status,
          })),
          skipDuplicates: true,
        });
        // My hours: the worker's own view of the same day. One slot of two hours, which is how the allocation
        // grid counts a shift, so the two series are comparable without being added together.
        const allocationDay = await prisma.employeeAllocationDay.upsert({
          where: { employeeId_workDate: { employeeId: employee.id, workDate: day } },
          update: { remarks: MARK },
          create: {
            employeeId: employee.id,
            workDate: day,
            status: "HOD_APPROVED",
            remarks: MARK,
            submittedAt: day,
            approvedAt: addDays(day, 1),
          },
          select: { id: true },
        });
        await prisma.employeeAllocation.createMany({
          data: [
            {
              allocationDayId: allocationDay.id,
              employeeId: employee.id,
              workDate: day,
              shiftSlot: "am1",
              projectId: project.id,
              projectWbsId: order.projectWbsId,
              jobOrderId: order.id,
              departmentId: order.departmentId,
              sectionId: order.sectionId,
              allocatedById: tagger.id,
            },
          ],
          skipDuplicates: true,
        });
        assignedHours.set(order.id, (assignedHours.get(order.id) ?? 0) + 8);
        dayRows += 1;
        entryRows += 4;
      }
    }
    console.log(`  ${project.code}: ${dayRows} man-day(s), ${entryRows} shift-slot entr(ies) on ${bookableOrders.length} Job Order(s) over ${workDays.length} working day(s)`);

    // ---------- 5. escalations of different ages ----------
    // A review always asks "what is stuck and for how long", and the age buckets need real ages to show.
    const escalationPlan = [
      { ageDays: 44, dueInDays: -30, acknowledged: false, answered: false },
      { ageDays: 17, dueInDays: -3, acknowledged: true, answered: false },
      { ageDays: 8, dueInDays: 2, acknowledged: false, answered: false },
      { ageDays: 3, dueInDays: 5, acknowledged: false, answered: true },
    ];
    // Re-running the seed must not stack a second set of escalations on the first.
    if (!dryRun) {
      const stale = await prisma.jobOrderMessage.findMany({
        where: { body: { startsWith: BODY_MARK }, thread: { jobOrder: { projectId: project.id } } },
        select: { id: true, threadId: true },
      });
      if (stale.length) {
        await prisma.jobOrderMessage.deleteMany({ where: { id: { in: stale.map((row) => row.id) } } });
        for (const threadId of [...new Set(stale.map((row) => row.threadId))]) {
          const left = await prisma.jobOrderMessage.count({ where: { threadId } });
          if (left === 0) await prisma.jobOrderThread.delete({ where: { id: threadId } }).catch(() => {});
        }
        console.log(`  ${project.code}: cleared ${stale.length} demo message(s) from an earlier run`);
      }
    }
    const author = await prisma.user.findFirst({ where: { role: "PM" }, select: { id: true, name: true, email: true } });
    const hod = await prisma.user.findFirst({ where: { role: "HOD" }, select: { id: true, name: true, email: true } });
    let escalationRows = 0;
    for (let index = 0; index < escalationPlan.length; index++) {
      const plan = escalationPlan[index];
      const order = jobOrders[(index * 11) % jobOrders.length];
      const createdAt = addDays(today, -plan.ageDays);
      if (dryRun) {
        escalationRows += 1;
        continue;
      }
      const thread = await prisma.jobOrderThread.upsert({
        where: { jobOrderId: order.id },
        update: {},
        create: { jobOrderId: order.id, status: "OPEN", openedById: author?.id ?? null, lastMessageById: author?.id ?? null, lastMessageAt: createdAt },
        select: { id: true },
      });
      const lastSeq = await prisma.jobOrderMessage.aggregate({ where: { threadId: thread.id }, _max: { seq: true } });
      const seq = (lastSeq._max.seq ?? 0) + 1;
      await prisma.jobOrderMessage.create({
        data: {
          threadId: thread.id,
          seq,
          kind: "ESCALATION",
          authorUserId: author?.id ?? null,
          authorEmail: author?.email ?? "pm@demo.local",
          authorName: author?.name ?? "Demo PM",
          authorRole: "PM",
          body: `${BODY_MARK} Material not received for ${order.code}; the crew is waiting. Please clear by the due date.`,
          escalationDueAt: addDays(today, plan.dueInDays),
          acknowledgedAt: plan.acknowledged ? addDays(createdAt, 1) : null,
          acknowledgedByEmail: plan.acknowledged ? hod?.email ?? null : null,
          createdAt,
        },
      });
      if (plan.answered) {
        await prisma.jobOrderMessage.create({
          data: {
            threadId: thread.id,
            seq: seq + 1,
            kind: "REPLY",
            authorUserId: hod?.id ?? null,
            authorEmail: hod?.email ?? "hod@demo.local",
            authorName: hod?.name ?? "Demo HOD",
            authorRole: "HOD",
            body: `${BODY_MARK} Material received on site; the crew is back on the Job Order.`,
            createdAt: addDays(createdAt, 1),
          },
        });
      }
      escalationRows += 1;
    }
    console.log(`  ${project.code}: ${escalationRows} escalation(s) aged 3–44 days`);
    manifest.projects.push({ id: project.id, code: project.code });
  }

  const manifestPath = `/home/dilippal/.hermes/cache/scratch/review-demo-manifest-${Date.now()}.json`;
  if (!dryRun) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(`\nmanifest written to ${manifestPath}`);
    console.log(`to remove this demo data: node apps/api/scripts/demo-review-clear.mjs --manifest ${manifestPath}`);
  } else {
    console.log("\ndry run: nothing was written.");
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
