/**
 * The LabourWorks attendance REGISTER — read, classified, and reduced to ONE fact per employee-day.
 *
 * PURE. No database, no SQL Server, no clock: the caller fetches rows, this module decides what they
 * mean. That separation is the whole reason the reconciliation script and (later) the settlement job
 * cannot disagree — both call `aggregateRegisterRows`, so the "before/after" the customer signs off is
 * computed by the same code that will stamp production.
 *
 * THE SOURCE'S VOCABULARY IS THE OPERATOR'S, AND IT IS AUTHORITATIVE (given 2026-10-23):
 *
 *   P      present on a working day                     -> regular work
 *   P/WO   present on a weekly off      (= OT)          -> non-working day, worked
 *   P/HL   present on a holiday         (= OT)          -> non-working day, worked
 *   A      absent on a working day                      -> absence, NOT a holiday
 *   A/HL   absent on a holiday                          -> the normal state of a man on a holiday
 *
 * THE TWO FACTS THAT MUST NEVER BE COLLAPSED:
 *
 *   1. WAS HE IN THE PLANT?  That is `OriginalStatus`, and only `OriginalStatus`. A row that exists
 *      proves nothing by itself — the register emits a row for a man who did not come in.
 *   2. HOW MANY HOURS?      That is `AcceptedManHrs` (falling back on the day's raw `ManHours` only to
 *      REPORT a discrepancy). NULL / 0.00 means zero accepted hours — NOT absence. A `P` row with 0
 *      hours is "present, hours not yet accepted", which is exactly the regularisation delay the
 *      Clocked Hours screen already chases. Reading it as absence would invent absences by the hundred
 *      and blank that chase list.
 *
 * A DAY TYPE IS NOT A CLASS. `dayType` answers "was this date a working day for the yard"; `class`
 * answers "what does one man's day look like". A weekly off is a non-working DAY; a man with `P/WO` on
 * it is WORKED_WEEKLY_OFF, which is why his hours are OT and not regular project hours.
 */

/** The closed status vocabulary reported by the view. Anything else is UNKNOWN, never "present". */
export const REGISTER_STATUS_CODES = ["P", "P/WO", "P/HL", "A", "A/HL"] as const;
export type RegisterStatusCode = (typeof REGISTER_STATUS_CODES)[number];
export type RegisterStatus = RegisterStatusCode | "UNKNOWN";

/** Was the DATE a working day for the yard? */
export type DayType = "WORKING" | "WEEKLY_OFF" | "HOLIDAY";

/** What does ONE employee's day look like, for reporting? */
export type AttendanceClass =
  | "WORKED"
  | "WORKED_WEEKLY_OFF"
  | "WORKED_HOLIDAY"
  | "ABSENT"
  | "OFF"
  | "UNVERIFIED";

/**
 * How a multi-row employee-day's accepted hours are combined.
 *
 * The register can hold more than one row per man per date (a split day; a night shift whose checkout
 * lands next morning — observed 3.15h + 14.55h for one worker-day). `SUM` is the default because that
 * is what the shipped reader already does with `ManHours` and it was confirmed against the live view.
 * `MAX` exists for the other possible shape (the day TOTAL repeated on each punch row); the
 * reconciliation script prints both, so the source's actual shape decides — not a guess in code.
 */
export type HoursAggregate = "SUM" | "MAX";

/**
 * One row exactly as the source returns it. `IsWeeklyOff` may arrive as 1/0, `true`/`false`, "Y"/"N"
 * or a string bit, because the view belongs to another team; `parseWeeklyOff` is the one conversion.
 */
export type RawRegisterRow = {
  workDate: string;
  idNo: string;
  isWeeklyOff: unknown;
  originalStatus: unknown;
  acceptedManHours: unknown;
  acceptedOt: unknown;
  rawManHours: unknown;
  /** Source rows summed into this one (the SQL already groups by IDNo; fixtures may not). */
  records?: number;
  /** COUNT(DISTINCT OriginalStatus) for the employee-day: > 1 is an anomaly worth reporting. */
  statusVariants?: number;
  /**
   * The view's own holiday flag (`isHoliday`, 1 = holiday). Present since 2026-10-23 and decisive: a
   * declared holiday is a FACT from the source, not something to infer from an `A` status.
   */
  isHoliday?: unknown;
};

/** One employee-day, decided. */
export type AttendanceDayFact = {
  workDate: string;
  idNo: string;
  /** The day's status, chosen by presence precedence when rows disagree (see `presenceRank`). */
  status: RegisterStatus;
  /** More than one distinct status was seen for this man-day. Reported, never averaged away. */
  mixedStatus: boolean;
  isWeeklyOff: boolean;
  dayType: DayType;
  attendanceClass: AttendanceClass;
  hoursAggregate: HoursAggregate;
  /** Hours under the chosen policy (sum of the day's records, or the repeated total). */
  acceptedManHours: number | null;
  /** Both shapes, always, so a reader can see whether the policy matters for this day. */
  acceptedManHoursSum: number | null;
  acceptedManHoursMax: number | null;
  distinctHourValues: number;
  acceptedOt: number | null;
  rawManHours: number | null;
  records: number;
  /**
   * The day's own status contradicts its day type (e.g. `P/WO` on a date the register does not mark
   * weekly off). Kept so the reconciliation can list it instead of silently picking a branch.
   */
  statusDayTypeConflict: boolean;
  /** The source's own holiday flag for this man-day. */
  isHoliday: boolean;
};

/** `1`, `"1"`, `true`, `"Y"`, `"yes"` -> true. Everything else, including null, -> false. */
export function parseWeeklyOff(value: unknown): boolean {
  if (value === true) return true;
  if (value === false || value == null) return false;
  if (typeof value === "number") return value === 1;
  const text = String(value).trim().toUpperCase();
  return text === "1" || text === "TRUE" || text === "Y" || text === "YES";
}

/** `" p/wo "` -> `"P/WO"`; an unrecognised word -> `"UNKNOWN"` (never silently present). */
export function normaliseRegisterStatus(value: unknown): RegisterStatus {
  const text = String(value ?? "").trim().toUpperCase().replace(/\s+/g, "").replace(/_/g, "/");
  const match = (REGISTER_STATUS_CODES as readonly string[]).find((code) => code === text);
  return (match as RegisterStatusCode | undefined) ?? "UNKNOWN";
}

/** Did this status mean the man was in the plant? Only the three `P*` codes do. */
export function isPresentStatus(status: RegisterStatus): boolean {
  return status === "P" || status === "P/WO" || status === "P/HL";
}

/**
 * Presence precedence for a man-day whose rows disagree: a present row wins, because presence is a
 * fact and the alternative (taking an absent row) would delete a day's work. `P/HL` and `P/WO` rank
 * above plain `P` so the non-working-day flavour survives to the class.
 */
export function presenceRank(status: RegisterStatus): number {
  switch (status) {
    case "P/HL":
      return 5;
    case "P/WO":
      return 4;
    case "P":
      return 3;
    case "A/HL":
      return 2;
    case "A":
      return 1;
    default:
      return 0;
  }
}

/**
 * The date's day type, from the rows themselves.
 *
 * HOLIDAY wins over WEEKLY_OFF when both apply (a holiday landing on a Sunday): both are non-working,
 * so only the LABEL is at stake, and the holiday is the more specific fact. No rows at all means the
 * caller is looking at a date the register did not cover — the flag `isWeeklyOff` is then all we have.
 */
export function dayTypeForStatuses(
  statuses: readonly RegisterStatus[],
  isWeeklyOff: boolean,
  isHoliday = false
): DayType {
  // The source's own flag wins over everything: it is the only signal that can be known BEFORE the day and
  // therefore the only one a booking screen could obey.
  if (isHoliday) return "HOLIDAY";
  const carriesHoliday = statuses.some((status) => status === "P/HL" || status === "A/HL");
  if (carriesHoliday) return "HOLIDAY";
  return isWeeklyOff ? "WEEKLY_OFF" : "WORKING";
}

/**
 * What one man's day looks like, for the reports.
 *
 * The matrix is deliberately explicit rather than computed, because every cell is a decision a reader
 * will argue with, and a wrong cell is exactly how "holiday hours" would leak back into regular hours.
 * Unknown statuses fail to UNVERIFIED — counted and disclosed, never quietly treated as work.
 */
export function classFor(dayType: DayType, status: RegisterStatus): AttendanceClass {
  if (status === "UNKNOWN") return "UNVERIFIED";
  if (dayType === "HOLIDAY") {
    if (status === "P/HL" || status === "P") return "WORKED_HOLIDAY";
    return "OFF"; // A/HL — the normal state of a man on a holiday.
  }
  if (dayType === "WEEKLY_OFF") {
    if (status === "P/WO" || status === "P") return "WORKED_WEEKLY_OFF";
    if (status === "P/HL") return "WORKED_HOLIDAY";
    return "OFF"; // A on a weekly off is still a day the yard did not work.
  }
  // WORKING
  if (status === "P") return "WORKED";
  if (status === "P/WO") return "WORKED_WEEKLY_OFF"; // status is authoritative: OT work.
  if (status === "P/HL") return "WORKED_HOLIDAY";
  return "ABSENT"; // A on a working day is a real absence.
}

/** A parseable non-negative number, or null. `"8,58"` is tolerated (the source writes a comma). */
export function parseHours(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value).trim().replace(",", ".");
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** Round to 2dp without producing `-0`, so a CSV never shows a sign the number does not have. */
export function round2(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

/** The hours a day contributes under a policy. NULL stays null (unknown), never coerced to 0. */
export function effectiveHours(
  sum: number | null,
  max: number | null,
  policy: HoursAggregate
): number | null {
  if (policy === "MAX") return max;
  return sum;
}

function addNullable(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return a + b;
}

function maxNullable(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.max(a, b);
}

/**
 * Group the source rows into exactly one fact per (date, idNo) and decide everything.
 *
 * Idempotent and order-independent: the same rows in any order produce the same facts, and the policy
 * does not change the STATUS or the day type — only the hours.
 */
export function aggregateRegisterRows(
  rows: readonly RawRegisterRow[],
  policy: HoursAggregate = "SUM"
): AttendanceDayFact[] {
  type Accum = {
    workDate: string;
    idNo: string;
    statuses: Set<RegisterStatus>;
    isWeeklyOff: boolean;
    isHoliday: boolean;
    sum: number | null;
    max: number | null;
    hourValues: Set<number>;
    ot: number | null;
    raw: number | null;
    records: number;
    variants: number;
  };

  const byKey = new Map<string, Accum>();
  for (const row of rows) {
    const idNo = String(row.idNo ?? "").trim().toUpperCase();
    if (!idNo) continue;
    const workDate = String(row.workDate ?? "").slice(0, 10);
    if (!workDate) continue;
    const key = `${workDate}|${idNo}`;
    let acc = byKey.get(key);
    if (!acc) {
      acc = {
        workDate,
        idNo,
        statuses: new Set(),
        isWeeklyOff: false,
        isHoliday: false,
        sum: null,
        max: null,
        hourValues: new Set(),
        ot: null,
        raw: null,
        records: 0,
        variants: 0,
      };
      byKey.set(key, acc);
    }
    acc.statuses.add(normaliseRegisterStatus(row.originalStatus));
    acc.isWeeklyOff = acc.isWeeklyOff || parseWeeklyOff(row.isWeeklyOff);
    acc.isHoliday = acc.isHoliday || parseWeeklyOff(row.isHoliday);
    const hours = parseHours(row.acceptedManHours);
    acc.sum = addNullable(acc.sum, hours);
    acc.max = maxNullable(acc.max, hours);
    if (hours != null) acc.hourValues.add(hours);
    acc.ot = addNullable(acc.ot, parseHours(row.acceptedOt));
    acc.raw = addNullable(acc.raw, parseHours(row.rawManHours));
    acc.records += Math.max(1, Number(row.records ?? 1));
    acc.variants = Math.max(acc.variants, Number(row.statusVariants ?? 0));
  }

  const facts: AttendanceDayFact[] = [];
  for (const acc of byKey.values()) {
    const statuses = [...acc.statuses];
    // Presence precedence; ties broken by the code order so the result is deterministic.
    const status = statuses.reduce<RegisterStatus>(
      (best, current) =>
        presenceRank(current) > presenceRank(best) ||
        (presenceRank(current) === presenceRank(best) && current > best)
          ? current
          : best,
      "UNKNOWN"
    );
    const dayType = dayTypeForStatuses(statuses, acc.isWeeklyOff, acc.isHoliday);
    const mixedStatus = statuses.filter((entry) => entry !== "UNKNOWN").length > 1 || acc.variants > 1;
    const statusDayTypeConflict =
      (status === "P/WO" && dayType !== "WEEKLY_OFF" && dayType !== "HOLIDAY") ||
      (status === "P/HL" && dayType !== "HOLIDAY") ||
      (status === "A/HL" && dayType !== "HOLIDAY");

    facts.push({
      workDate: acc.workDate,
      idNo: acc.idNo,
      status,
      mixedStatus,
      isWeeklyOff: acc.isWeeklyOff,
      dayType,
      attendanceClass: classFor(dayType, status),
      hoursAggregate: policy,
      acceptedManHours: effectiveHours(acc.sum, acc.max, policy),
      acceptedManHoursSum: acc.sum,
      acceptedManHoursMax: acc.max,
      distinctHourValues: acc.hourValues.size,
      acceptedOt: acc.ot,
      rawManHours: acc.raw,
      records: acc.records,
      statusDayTypeConflict,
      isHoliday: acc.isHoliday,
    });
  }

  // Deterministic order (date, then man) so a CSV diff between two runs is meaningful.
  return facts.sort((a, b) => (a.workDate < b.workDate ? -1 : a.workDate > b.workDate ? 1 : a.idNo.localeCompare(b.idNo)));
}

/** Hours actually clocked (0 when nothing was accepted — NOT absent, see the header). */
export function clockedHoursOf(fact: Pick<AttendanceDayFact, "acceptedManHours">): number {
  return fact.acceptedManHours ?? 0;
}

/**
 * Hours worked on a NON-WORKING day (weekly off / holiday).
 *
 * OT FIRST, then man-hours, never both added: on a `P/WO` / `P/HL` day the same hours can appear in
 * both columns, so adding them would double the figure. Capped at 24 for sanity, and a test pins the
 * cap — a night shift legitimately exceeds 8, but not a day.
 */
export function workedHoursOnOffDay(
  fact: Pick<AttendanceDayFact, "acceptedOt" | "acceptedManHours">
): number {
  const ot = fact.acceptedOt ?? 0;
  const man = fact.acceptedManHours ?? 0;
  const hours = ot > 0 ? ot : man;
  return round2(Math.min(hours, 24));
}

/**
 * Re-derive every man-day's type and class from the DATE's resolved type.
 *
 * WHY THIS EXISTS: `isHoliday` and `isWeeklyOff` are row-level flags, and on real data a handful of rows can
 * carry them on a day the yard worked. The first production run proved it — 26 Aug 2026 had 463 present,
 * 58 absent and NO holiday status at all, yet one flagged row declared the whole date a holiday and every
 * hour booked on it counted as holiday work.
 *
 * The yard's day type is a property of the DATE (resolved once, by majority — see `dateTypesFrom`); the
 * man's class is then simply his status on that date. Nothing here reads a row-level flag as if it were a
 * calendar.
 */
export function applyDateTypes(
  facts: readonly AttendanceDayFact[],
  dateTypes: ReadonlyMap<string, DayType>
): AttendanceDayFact[] {
  return facts.map((fact) => {
    const dayType = dateTypes.get(fact.workDate) ?? fact.dayType;
    const attendanceClass = classFor(dayType, fact.status);
    const statusDayTypeConflict =
      (fact.status === "P/WO" && dayType === "WORKING") ||
      (fact.status === "P/HL" && dayType !== "HOLIDAY") ||
      (fact.status === "A/HL" && dayType !== "HOLIDAY");
    return { ...fact, dayType, attendanceClass, statusDayTypeConflict };
  });
}

/** The sentence a report prints for one man-day, in the register's own words. */
export function registerStatusLabel(status: RegisterStatus): string {
  switch (status) {
    case "P":
      return "Present (working day)";
    case "P/WO":
      return "Present on weekly off (OT)";
    case "P/HL":
      return "Worked on holiday (OT)";
    case "A":
      return "Absent";
    case "A/HL":
      return "Holiday (no work)";
    default:
      return "Unknown status";
  }
}
