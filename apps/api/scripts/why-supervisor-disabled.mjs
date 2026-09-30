#!/usr/bin/env node
/**
 * Why is this Supervisor DISABLED? A read-only triage for the Admin panel's "Disabled" rows.
 *
 * WHAT "Disabled" MEANS
 *   The Supervisors list shows `Disabled` when `User.active === false`. For a CLMS supervisor that
 *   state is written by the LabourWorks sync, not by anyone in this app: when the source row
 *   reports `IsTerminated`, the sync sets `employee.active = false`, `user.active = false`, and
 *   cancels any pending credential ("Employee terminated.").
 *
 * WHY THAT MATTERS BEFORE ANY "Activate" BUTTON
 *   `PUT /api/supervisors/:id { active: true }` refuses a CLMS-owned supervisor with
 *   `409 CLMS_SYNC_OWNED`, and even if it did not, the next sync tick would revert it — the
 *   production schedule is twice daily (`BADGEVIEW_SYNC_CRON=0 6,18 * * *`). So the useful first
 *   step is not a button, it is knowing WHICH of these are genuinely terminated and which are a
 *   source-data problem.
 *
 * WHAT IT REPORTS, per disabled supervisor
 *   - ownership: SYNC/CLMS (the sync controls it) or MANUAL (this app controls it)
 *   - the employee's `active` and `terminatedAt`, and when the sync last wrote the row
 *   - the organisation mapping, so you can see whether the Section still expects this person
 *   - whether a credential is queued, and whether one was cancelled as "terminated"
 *   - what the NEXT sync run will do to this row
 *
 * READ-ONLY. It writes nothing and is safe to run against production.
 *
 *   docker compose --env-file infra/docker/.env.production \
 *     -f infra/docker/compose.production.yml exec api \
 *     node apps/api/scripts/why-supervisor-disabled.mjs
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function fmt(date) {
  if (!date) return "—";
  const iso = new Date(date).toISOString().replace("T", " ").slice(0, 16);
  return `${iso} UTC`;
}

async function main() {
  const disabled = await prisma.user.findMany({
    where: { role: "SUPERVISOR", active: false },
    select: {
      id: true,
      name: true,
      email: true,
      active: true,
      source: true,
      departmentId: true,
      department: { select: { name: true } },
      employee: {
        select: {
          id: true,
          ecNo: true,
          name: true,
          active: true,
          source: true,
          employmentType: true,
          lastSyncedAt: true,
          terminatedAt: true,
          natureOfWork: true,
          department: { select: { name: true } },
          sectionAssignment: { select: { section: { select: { name: true, departmentId: true } } } },
        },
      },
      credentialDeliveries: {
        select: { status: true, purpose: true, lastError: true, createdAt: true, sentAt: true },
        orderBy: { createdAt: "desc" },
        take: 3,
      },
    },
    orderBy: { name: "asc" },
  });

  const total = await prisma.user.count({ where: { role: "SUPERVISOR" } });
  const disabledSync = disabled.filter((u) => u.source === "SYNC" || u.employee?.employmentType === "CLMS");
  const disabledManual = disabled.filter((u) => !(u.source === "SYNC" || u.employee?.employmentType === "CLMS"));

  console.log(`Supervisors: ${total} total, ${disabled.length} DISABLED\n`);
  console.log(`  sync-controlled (CLMS) : ${disabledSync.length}  <- the sync decides these`);
  console.log(`  app-controlled (MANUAL): ${disabledManual.length}  <- this app can already re-enable these\n`);

  for (const user of disabled) {
    const syncOwned = user.source === "SYNC" || user.employee?.employmentType === "CLMS";
    const section = user.employee?.sectionAssignment?.section ?? null;
    const pending = user.credentialDeliveries.find((d) => d.status === "PENDING" || d.status === "PROCESSING");
    const cancelledTerminated = user.credentialDeliveries.find((d) => d.status === "CANCELLED" && /terminated/i.test(d.lastError ?? ""));

    console.log(`──────────────────────────────────────────────────────────────`);
    console.log(`${user.name}  (user #${user.id})`);
    console.log(`  ecNo            : ${user.employee?.ecNo ?? "not linked"}`);
    console.log(`  ownership       : ${syncOwned ? "LABOURWORKS (CLMS/SYNC)" : "APP (manual)"}`);
    console.log(`  account active  : ${user.active}`);
    console.log(`  employee active : ${user.employee ? user.employee.active : "n/a"}`);
    console.log(`  terminated at   : ${fmt(user.employee?.terminatedAt)}`);
    console.log(`  last synced     : ${fmt(user.employee?.lastSyncedAt)}`);
    console.log(`  NatureOfWork    : ${user.employee?.natureOfWork ?? "—"}`);
    console.log(`  organisation    : ${user.department?.name ?? "—"} / ${section ? section.name : "no section"}`);
    console.log(`  credential      : ${pending ? `PENDING (${pending.purpose})` : cancelledTerminated ? "cancelled — \"Employee terminated.\"" : user.credentialDeliveries[0] ? user.credentialDeliveries[0].status : "none queued"}`);

    if (syncOwned) {
      console.log(`  NEXT SYNC WILL  : keep this account disabled while LabourWorks reports IsTerminated.`);
      console.log(`                    An in-app activation is REFUSED (409 CLMS_SYNC_OWNED) and would be`);
      console.log(`                    reverted at the next tick (${"0 6,18 * * *"} = 06:00/18:00) anyway.`);
      console.log(`  TO FIX          : correct the record in LabourWorks, or decide that this app should`);
      console.log(`                    override CLMS lifecyle for named people.`);
    } else {
      console.log(`  NEXT SYNC WILL  : leave it alone — no CLMS row owns this account.`);
      console.log(`  TO FIX          : PUT /api/supervisors/${user.id} { "active": true } already works.`);
    }
  }

  if (!disabled.length) console.log("No disabled supervisors. Nothing to triage.");

  console.log(`\nSUMMARY: ${disabledSync.length} disabled because LabourWorks says so, ` +
    `${disabledManual.length} disabled inside this app.`);
  console.log(`A blanket "Activate" button cannot fix the first group; see the notes on each row.`);

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error("[why-supervisor-disabled] failed:", error instanceof Error ? error.message : error);
  await prisma.$disconnect();
  process.exit(1);
});
