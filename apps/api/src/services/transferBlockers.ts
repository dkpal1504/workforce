/**
 * Why a department transfer is refused, in words the person doing the transfer can act on.
 *
 * The guard itself is right: a day in the approval chain is routed by the Department/Section it was SUBMITTED
 * under, so moving the employee mid-flight sends it to an approver who never saw the work. What was wrong was the
 * refusal: "Resolve or close open timesheets before transferring this Employee." — no count, no dates, no stage,
 * and no hint that a DRAFT day is not open at all. The user then has to ask which days and who to chase, which is
 * a question the screen can answer itself.
 */

/** Statuses that hold a TIMESHEET day in the chain. DRAFT and the approved/paid end states do not block. */
export const TRANSFER_BLOCKING_TIMESHEET_STATUSES = ["SUBMITTED", "HOD_APPROVED", "PLANNING_RETURNED"] as const;

/** Statuses that hold a MY HOURS day in the chain. DRAFT and REJECTED do not block. */
export const TRANSFER_BLOCKING_ALLOCATION_STATUSES = ["SUBMITTED", "HOD_APPROVED"] as const;

export type BlockingDayKind = "TIMESHEET" | "MY_HOURS";

export type BlockingDay = {
  kind: BlockingDayKind;
  /** `YYYY-MM-DD`, resolved from the day row. */
  workDate: string;
  status: string;
};

/**
 * Where a day is stuck and who can move it on. This is the half of the message the operator actually needs:
 * a date alone still leaves them asking "chase whom?".
 */
export function staleStageLabel(kind: BlockingDayKind, status: string): string {
  if (kind === "MY_HOURS") {
    if (status === "SUBMITTED") return "with the Section HOD — approve it in Approvals → Payroll Employees";
    if (status === "HOD_APPROVED") return "with the Project Head — approve it in Approvals → Payroll Employees";
    return status.toLowerCase();
  }
  if (status === "SUBMITTED") return "with the Section HOD — approve it in Approvals → Received from HOD";
  if (status === "HOD_APPROVED") return "with the Project Head — approve it in Approvals → Received from HOD";
  if (status === "PLANNING_RETURNED") return "sent back by Planning — the supervisor must correct and resubmit it";
  return status.toLowerCase();
}

function dayLabel(workDate: string): string {
  // 2026-10-21 -> 21-10-2026, the date format the timesheet screens print.
  const [year, month, day] = workDate.split("-");
  return `${day}-${month}-${year}`;
}

function kindLabel(kind: BlockingDayKind): string {
  return kind === "MY_HOURS" ? "My Hours" : "timesheet";
}

/**
 * ONE line, because the screen renders it in a banner: the count, the days, the stage, and how many are not shown.
 */
export function blockingDaysMessage(days: readonly BlockingDay[], shown = 4): string {
  if (days.length === 0) return "";
  const sorted = [...days].sort((a, b) => a.workDate.localeCompare(b.workDate));
  const listed = sorted.slice(0, shown).map(
    (day) => `${dayLabel(day.workDate)} ${kindLabel(day.kind)} (${staleStageLabel(day.kind, day.status)})`
  );
  const rest = sorted.length - listed.length;
  const noun = sorted.length === 1 ? "day is" : "days are";
  return (
    `${sorted.length} ${noun} still open, so the Employee cannot change Department: ` +
    listed.join("; ") +
    (rest > 0 ? `; and ${rest} more` : "") +
    `. Approve, reject or resubmit ${sorted.length === 1 ? "that day" : "those days"} first, then transfer.`
  );
}

/** Build the list from rows already filtered to the blocking statuses. */
export function blockingDaysOf(
  timesheetDays: readonly { workDate: Date | string; status: string }[],
  allocationDays: readonly { workDate: Date | string; status: string }[]
): BlockingDay[] {
  const iso = (value: Date | string): string =>
    typeof value === "string" ? value.slice(0, 10) : value.toISOString().slice(0, 10);
  return [
    ...timesheetDays.map((row) => ({ kind: "TIMESHEET" as const, workDate: iso(row.workDate), status: row.status })),
    ...allocationDays.map((row) => ({ kind: "MY_HOURS" as const, workDate: iso(row.workDate), status: row.status })),
  ];
}
