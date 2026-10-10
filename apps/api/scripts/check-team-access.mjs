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
        if (e.employmentType !== "CLMS") reasons.push(`employmentType is ${e.employmentType}; the guard requires CLMS`);
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
      for (const r of reasons) console.log(`    >>> BREAKS THE SAVE: ${r}`);
    } else if (sent) {
      console.log("    ok — this row authorises");
    }
  }

  // The guard is all-or-nothing over the payload, so ANY breaking row refuses the whole save.
  const breaking = [];
  for (const d of payload) {
    const e = d.employee;
    const isSelf = supervisor.employeeId === d.employeeId;
    const teamRow = await prisma.dailyTeamSelection.findFirst({
      where: { supervisorId, employeeId: d.employeeId, removedAt: null },
      orderBy: { workDate: "desc" },
      select: { workDate: true },
    });
    const ok = isSelf
      ? e.active && e.departmentId === departmentId
      : e.employmentType === "CLMS" && e.departmentId === departmentId && !!teamRow && sameDay(teamRow.workDate, workDate);
    if (!ok) breaking.push(`employee ${d.employeeId} ${e.name}`);
  }
  refused = breaking.length;

  console.log(
    `\nVERDICT: ${
      refused
        ? `REFUSED — ${refused} of ${payload.length} sent row(s) break the guard, and the guard is all-or-nothing:\n    ${breaking.join("\n    ")}`
        : `the save would be AUTHORISED (${payload.length} sent row(s), all reachable)`
    }\n`
  );

  console.log("What to do with a BREAKS THE SAVE row:");
  console.log("  employmentType != CLMS  -> the person has since been converted to payroll. Either remove his row");
  console.log("                             from this sheet, or have the HOD correct it before the conversion.");
  console.log("  department mismatch     -> an organisation transfer moved him. The transfer already ends his open");
  console.log("                             timesheets, so this row is genuinely out of the supervisor's scope.");
  console.log("  NO team row / wrong date-> the row was booked on a date he never had a team for (the HOD's 'Date mixup':");
  console.log("                             he opened the wrong date, so the team rows belong to the date he really worked).");
  console.log("                             Opening the Timesheet page for the correct date carries the previous day's");
  console.log("                             team forward and re-creates them.");

  await prisma.$disconnect();
  process.exit(refused ? 1 : 0);
})();
