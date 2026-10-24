/**
 * "Not booked" — the men on the CLMS roster who have no sheet at all on a date, for a date range.
 *
 * WHY IT EXISTS: the timesheet-coverage report already says WHICH employee-days are unfilled, but it
 * answers in employee-days (17,832 of them in a month), which is the right unit for exposure and the wrong
 * one for a review meeting: nobody reads 17,832 rows. This module folds the same facts per PERSON —
 * how many days he was unbooked, the longest run, and what that costs at his category rate — so the
 * question "who is being paid while on nobody's team?" has a face and a figure.
 *
 * ROSTER: `employmentType: "CLMS"` only. Payroll staff are paid by allocation rather than by timesheet, so
 * they are deliberately outside this report until the allocation side gets its own version.
 *
 * The arithmetic is here, and only here, because "longest run" and "cost" are the two numbers a reader will
 * argue with; keeping them pure makes them quotable back to whoever asked.
 */

export type NotBookedPerson = {
  id: number;
  ecNo: string;
  name: string;
  department: string;
  section: string;
  category: string;
  /** Days in the range with no sheet at all. */
  notBookedDays: number;
  /** Days in the range, so the reader can see the denominator (a 30-day month, not "the month"). */
  rangeDays: number;
  firstDay: string;
  lastDay: string;
  /** Longest run of consecutive unbooked days — the pattern, rather than a scatter of odd days. */
  longestRun: number;
  /** The run still going on the last day of the range; 0 when he was booked on that day. */
  runAtEnd: number;
  hours: number;
  cost: number;
};

export type NotBookedReport = {
  from: string;
  to: string;
  rangeDays: number;
  maxDailyHours: number;
  people: NotBookedPerson[];
  totals: {
    roster: number;
    peopleWithAnyGap: number;
    notBookedDays: number;
    hours: number;
    cost: number;
  };
  notes: string[];
};

/** Every `YYYY-MM-DD` from `from` to `to`, inclusive. */
export function eachDay(from: string, to: string): string[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const days: string[] = [];
  for (let at = start; at <= end; at += 86_400_000) days.push(new Date(at).toISOString().slice(0, 10));
  return days;
}

export function summariseNotBooked(input: {
  from: string;
  to: string;
  /**
   * The dates this report divides by. Defaults to every calendar day, but a caller that has the settled
   * work calendar passes the WORKING days instead — a Sunday is not a day anybody failed to book.
   */
  days?: string[];
  maxDailyHours: number;
  people: Array<{
    id: number;
    ecNo: string;
    name: string;
    department: string;
    section: string;
    category: string;
  }>;
  /** Dates with a sheet, per employee id. A date absent from the set is a day with no sheet. */
  booked: Map<number, Set<string>>;
  rateFor: (category: string) => number;
}): NotBookedReport {
  const days = input.days ?? eachDay(input.from, input.to);
  const people: NotBookedPerson[] = [];

  for (const person of input.people) {
    const had = input.booked.get(person.id) ?? new Set<string>();
    const missing: string[] = [];
    let run = 0;
    let longest = 0;
    for (const day of days) {
      if (had.has(day)) {
        run = 0;
        continue;
      }
      missing.push(day);
      run += 1;
      if (run > longest) longest = run;
    }
    if (missing.length === 0) continue;

    const hours = missing.length * input.maxDailyHours;
    people.push({
      ...person,
      notBookedDays: missing.length,
      rangeDays: days.length,
      firstDay: missing[0],
      lastDay: missing[missing.length - 1],
      longestRun: longest,
      runAtEnd: run,
      hours,
      cost: hours * input.rateFor(person.category),
    });
  }

  people.sort(
    (a, b) =>
      b.notBookedDays - a.notBookedDays ||
      b.longestRun - a.longestRun ||
      a.department.localeCompare(b.department) ||
      a.name.localeCompare(b.name)
  );

  const totals = {
    roster: input.people.length,
    peopleWithAnyGap: people.length,
    notBookedDays: people.reduce((acc, p) => acc + p.notBookedDays, 0),
    hours: people.reduce((acc, p) => acc + p.hours, 0),
    cost: people.reduce((acc, p) => acc + p.cost, 0),
  };

  return {
    from: input.from,
    to: input.to,
    rangeDays: days.length,
    maxDailyHours: input.maxDailyHours,
    people,
    totals,
    notes: [
      `Counts the CLMS roster only (${totals.roster} people): payroll staff are paid by allocation, not by timesheet, and are not in this report.`,
      "A day with ANY sheet counts as booked, whatever its status — a draft is a man who was on somebody's team and has not been approved yet, not a man nobody picked.",
      `Idle hours are ${input.maxDailyHours} per unbooked day (the contractual day), costed at each person's category rate.`,
      "Longest run is the pattern to look at: scattered single days are usually shift rotation, a run of ten is a man nobody is booking.",
    ],
  };
}

/** The CSV's rows, header first — one line per person, in the order the screen shows them. */
export function notBookedCsv(report: NotBookedReport): string[][] {
  const header = [
    "EC No",
    "Employee",
    "Department",
    "Section",
    "Category",
    "Not booked (days)",
    "Days in range",
    "First unbooked",
    "Last unbooked",
    "Longest run (days)",
    "Run at end (days)",
    "Idle hours",
    "Idle cost",
  ];
  return [
    header,
    ...report.people.map((p) => [
      p.ecNo,
      p.name,
      p.department,
      p.section,
      p.category,
      String(p.notBookedDays),
      String(p.rangeDays),
      p.firstDay,
      p.lastDay,
      String(p.longestRun),
      String(p.runAtEnd),
      String(p.hours),
      p.cost.toFixed(2),
    ]),
  ];
}
