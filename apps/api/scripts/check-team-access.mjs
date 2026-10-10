#!/usr/bin/env node
/**
 * WHY A SUPERVISOR'S TIMESHEET SAVE IS REFUSED WITH
 * "Labour must be assigned to your team from a Section in your Department."
 *
 * `PUT /timesheet/day` authorises the WHOLE payload at once: every employee on the sheet for
 * that date must still be reachable by that supervisor. One row that fails takes the entire
 * save down — including the sheet of an unrelated employee the HOD sent back for correction,
 * which is what makes this feel like a bug in the correction flow rather than a data problem.
 *
 * The guard (`hasTeamAccess`, apps/api/src/routes/timesheet.ts) requires, for EVERY employee
 * in the payload, a `daily_team_selection` row where:
 *
 *   supervisorId = the sheet owner, workDate = the sheet's date, removedAt IS NULL,
 *   employee.departmentId = the SUPERVISOR's department, employee.employmentType = 'CLMS'
 *
 * ...plus, for the supervisor's OWN Employee row, that the row is in his department and active.
 *
 * This script evaluates those exact conditions against the live database and NAMES the rows
 * that break, so the cause is read off rather than guessed at. It only reads; it never writes.
 *
 *   docker compose --env-file infra/docker/.env.production \
 *     -f infra/docker/compose.production.yml exec api \
 *     node apps/api/scripts/check-team-access.mjs --supervisor-id=10 --date=2026-10-07
 *
 * Exit code 0 = the save would be authorised. 1 = it would be refused (the culprits are listed).
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const arg = (name) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : null;
};

const supervisorId = Number(arg("supervisor-id"));
const dateStr = String(arg("date") || "");
if (!Number.isInteger(supervisorId) || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
  console.log("usage: --supervisor-id=<id> --date=<YYYY-MM-DD>");
  process.exit(2);
}

// The date a timesheet row is keyed on, exactly as the route parses it.
const parseDateOnly = (value) => {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const workDate = parseDateOnly(dateStr);
const sameDay = (a, b) => a && b && a.getTime() === b.getTime();

// Rows the supervisor's page actually SENDS: a locked (already-approved) row is read-only
// context and is filtered out of the payload before the guard ever sees it.
const SENT_STATUSES = new Set(["DRAFT", "REJECTED", "FINAL_REJECTED", "PLANNING_RETURNED"]);

let refused = 0;
const line = (m) => console.log(`  ${m}`);

(async () => {
  const supervisor = await prisma.user.findUnique({
    where: { id: supervisorId },
    select: { id: true, name: true, role: true, active: true, departmentId: true, employeeId: true },
  });
  if (!supervisor) {
    console.log(`no user ${supervisorId}`);
    process.exit(1);
  }

  console.log(`supervisor ${supervisor.id} ${supervisor.name} role=${supervisor.role} active=${supervisor.active}`);
  console.log(`  department=${supervisor.departmentId} ownEmployee=${supervisor.employeeId}`);
  console.log(`sheet date ${dateStr}\n`);

  // supervisorDepartmentForActor: a SUPERVISOR acts only on his own sheet, and the department
  // comes from HIS User row. Null here is itself the error, before any employee is considered.
  const departmentId = supervisor.departmentId;
  if (departmentId == null) {
    console.log("VERDICT: REFUSED — the supervisor has no Department on his account.");
    process.exit(1);
  }
  if (supervisor.role !== "SUPERVISOR" && supervisor.role !== "ADMIN") {
    console.log(`VERDICT: REFUSED — role ${supervisor.role} cannot use the supervisor timesheet routes.`);
    process.exit(1);
  }

  const days = await prisma.timesheetDay.findMany({
    where: { taggedById: supervisorId, workDate },
    select: {
      id: true, status: true, employeeId: true,
      employee: {
        select: {
          name: true, employmentType: true, departmentId: true, active: true,
          sectionAssignment: { select: { section: { select: { id: true, name: true, departmentId: true, active: true } } } },
        },
      },
    },
  });

  if (!days.length) {
    console.log(`no timesheet rows for ${supervisor.name} on ${dateStr} — nothing to save.`);
    console.log("(If he is trying to correct a sheet returned by the HOD, check the DATE he is opening:");
    console.log(` the row must be tagged to him on THAT date, not on the date he originally booked.)`);
    await prisma.$disconnect();
    process.exit(0);
  }

  console.log(`${days.length} row(s) tagged to this supervisor on this date:`);
  const payload = days.filter((d) => SENT_STATUSES.has(d.status));
  for (const d of days) {
    const sent = SENT_STATUSES.has(d.status);
    const e = d.employee;
    const section = e.sectionAssignment?.section ?? null;
    const teamRow = await prisma.dailyTeamSelection.findFirst({
      where: { supervisorId, employeeId: d.employeeId, removedAt: null },
      orderBy: { workDate: "desc" },
      select: { workDate: true, source: true },
    });
    const onDate = teamRow && sameDay(teamRow.workDate, workDate);
    const isSelf = supervisor.employeeId === d.employeeId;

    const reasons = [];
    if (sent) {
      if (isSelf) {
        if (!e.active) reasons.push("own row is INACTIVE (the self path requires active)");
        if (e.departmentId !== departmentId) reasons.push(`own row department ${e.departmentId} != supervisor ${departmentId}`);
      } else {
        // The LEGACY rule's conditions, reported because they explain the message the supervisor
        // saw BEFORE this fix. They are no longer what decides the save (see the verdict below).
        if (e.employmentType !== "CLMS") reasons.push(`employmentType is ${e.employmentType}; the OLD rule required CLMS`);
        if (e.departmentId !== departmentId) reasons.push(`employee department ${e.departmentId} != supervisor ${departmentId}`);
        if (!teamRow) reasons.push("NO team row at all for this employee for this date");
        else if (!onDate) reasons.push(`team row exists but for ${teamRow.workDate.toISOString().slice(0, 10)}, not ${dateStr}`);
      }
    }

    console.log(`\n  day ${d.id} status=${d.status}${sent ? " (SENT in the save)" : " (locked, not sent)"}`);
    line(`employee ${d.employeeId} ${e.name}`);
    line(`type=${e.employmentType} dept=${e.departmentId} active=${e.active} section=${section ? `${section.id}:${section.name} (dept ${section.departmentId}${section.active ? "" : ", INACTIVE"})` : "NONE"}`);
    line(`team row: ${teamRow ? `${teamRow.workDate.toISOString().slice(0, 10)} source=${teamRow.source}` : "none"}${isSelf ? "  <- this is the supervisor himself" : ""}`);
    if (reasons.length) {
      for (const r of reasons) console.log(`    >>> would have refused UNDER THE OLD RULE: ${r}`);
    } else if (sent) {
      console.log("    ok — meets the old rule too");
    }
  }

  // TWO RULES, reported separately, because they answer different questions.
  //
  //   CAN IT BE SAVED NOW?  Every row here is a TimesheetDay ON THIS SHEET, and the sheet's own
  //     record now authorises it. So the only thing that can still refuse the save is the
  //     supervisor's OWN row failing its own check — a row of his own that is not in this
  //     Department or is inactive. Nothing else on the sheet can block it.
  //
  //   WHY WAS IT REFUSED BEFORE?  The old rule re-derived permission from TODAY's team list, so
  //     any row whose team row was gone, whose employment type had changed, or whose date had no
  //     team rows at all took the whole save down. That is the message being diagnosed.
  const blocking = [];
  const legacyBlocking = [];
  for (const d of payload) {
    const e = d.employee;
    const isSelf = supervisor.employeeId === d.employeeId;
    const teamRow = await prisma.dailyTeamSelection.findFirst({
      where: { supervisorId, employeeId: d.employeeId, removedAt: null },
      orderBy: { workDate: "desc" },
      select: { workDate: true },
    });
    // On this sheet, so recorded -> authorised. Only the self row carries a further check.
    if (isSelf && !(e.active && e.departmentId === departmentId)) {
      blocking.push(`employee ${d.employeeId} ${e.name} (own row)`);
    }
    const underOldRule = isSelf
      ? e.active && e.departmentId === departmentId
      : e.employmentType === "CLMS" && e.departmentId === departmentId && !!teamRow && sameDay(teamRow.workDate, workDate);
    if (!underOldRule) legacyBlocking.push(`employee ${d.employeeId} ${e.name}`);
  }
  refused = blocking.length;

  console.log(
    `\nVERDICT (this build): ${
      refused
        ? `STILL REFUSED — ${blocking.join(", ")}`
        : `the save is AUTHORISED (${payload.length} sent row(s) recorded on this sheet)`
    }`
  );

  if (legacyBlocking.length) {
    console.log(
      `\nWHY IT WAS REFUSED BEFORE THE FIX: ${legacyBlocking.length} of ${payload.length} row(s) failed the OLD rule,\n`
      + `  and that rule was all-or-nothing, so ONE of them refused the entire day's save — including\n`
      + `  the sheet of an unrelated employee the HOD sent back. Culprit(s):\n    ${legacyBlocking.join("\n    ")}\n`
      + `  This is the explanation of "Labour must be assigned to your team from a Section in your\n`
      + `  Department." Deploying the fix is the remedy — the sheet's own record now authorises these\n`
      + `  rows, so no hand-repair is needed.`
    );
  } else {
    console.log("\nNo row here failed the old rule either, so this sheet was never the cause of that message.");
  }

  console.log("\nIf a row IS still refused: it is the supervisor's own row, which must be in his Department");
  console.log("and active. Check that account's Employee link.");

  await prisma.$disconnect();
  process.exit(refused ? 1 : 0);
})();
