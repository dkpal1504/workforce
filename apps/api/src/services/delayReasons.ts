/**
 * Delay causes — the eight codes, who may pick one, and the one aggregation everything reads.
 *
 * PURE. The point of this module is that a sentence like "material is 41% of the delays this quarter"
 * is computed by a function a test can hand three rows to, not by a query nobody can re-run. The server
 * calls it with rows it has already scoped; the screen calls nothing.
 *
 * Codes are fixed and never rewritten. A label may be reworded; if `MATERIAL` became `MATERIAL_SHORTAGE`
 * next year, every previous quarter would quietly stop meaning the same thing.
 */

export type DelayReasonCode =
  | "MANPOWER"
  | "MATERIAL"
  | "DRAWING"
  | "PERMIT"
  | "EQUIPMENT"
  | "WEATHER"
  | "CLIENT_HOLD"
  | "REWORK";

/** The seed, in the order the chips appear. Mirrors the migration exactly. */
export const DELAY_REASONS: ReadonlyArray<{ code: DelayReasonCode; label: string }> = [
  { code: "MANPOWER", label: "Manpower shortage" },
  { code: "MATERIAL", label: "Material not available" },
  { code: "DRAWING", label: "Drawing / design hold" },
  { code: "PERMIT", label: "Permit or access" },
  { code: "EQUIPMENT", label: "Equipment" },
  { code: "WEATHER", label: "Weather" },
  { code: "CLIENT_HOLD", label: "Client hold" },
  { code: "REWORK", label: "Rework" },
];

const BY_CODE = new Map(DELAY_REASONS.map((reason) => [reason.code, reason]));

export function isDelayReason(value: unknown): value is DelayReasonCode {
  return typeof value === "string" && BY_CODE.has(value as DelayReasonCode);
}

export function reasonLabel(code: string | null | undefined): string | null {
  if (!isDelayReason(code)) return null;
  return BY_CODE.get(code)!.label;
}

/**
 * Who may stamp a cause.
 *
 * The owner is the person accountable for the work, and a PM may speak for him — the same fact either
 * way. A supervisor may not: he books hours, he does not explain the schedule. ADMIN is included because
 * it administers every screen, not because it knows the site.
 */
export function canChooseReason(input: { role: string; isOwner: boolean }): boolean {
  if (input.isOwner) return true;
  return input.role === "PM" || input.role === "PROJECT_MANAGER" || input.role === "ADMIN";
}

export type ReasonRow = {
  reasonCode: string | null;
  raisedAt: Date;
  closedAt: Date | null;
};

export type ReasonTally = {
  code: string;
  label: string;
  count: number;
  /** Share of the rows that carry a KNOWN code; 0 when there are none. Rounded to whole percent. */
  share: number;
  /** Mean days a report of this cause has been open (closed rows stop at their close). */
  averageOpenDays: number;
};

export type ReasonSummary = {
  /** Rows that could be counted — i.e. carry a known code. The denominator of every share. */
  total: number;
  byReason: ReasonTally[];
  /** Rows with no code, or an unknown one. Reported, never silently folded into a percentage. */
  uncoded: number;
};

const DAY = 86_400_000;
const round1 = (value: number) => Math.round(value * 10) / 10;

/**
 * Count, share and age by cause.
 *
 * `now` is a parameter, not `Date.now()`: an ageing figure that changes between the test and the screen
 * is not a figure. Ages are measured to closure where there is one, and to `now` where there is not.
 */
export function summariseReasons(rows: ReadonlyArray<ReasonRow>, now: Date): ReasonSummary {
  const buckets = new Map<string, { count: number; openDays: number }>();
  let total = 0;
  let uncoded = 0;

  for (const row of rows) {
    if (!isDelayReason(row.reasonCode)) {
      uncoded += 1;
      continue;
    }
    total += 1;
    const end = row.closedAt ?? now;
    const days = Math.max(0, (end.getTime() - row.raisedAt.getTime()) / DAY);
    const bucket = buckets.get(row.reasonCode) ?? { count: 0, openDays: 0 };
    bucket.count += 1;
    bucket.openDays += days;
    buckets.set(row.reasonCode, bucket);
  }

  const byReason: ReasonTally[] = [...buckets.entries()]
    .map(([code, bucket]) => ({
      code,
      label: reasonLabel(code) ?? code,
      count: bucket.count,
      share: total === 0 ? 0 : Math.round((bucket.count / total) * 100),
      averageOpenDays: round1(bucket.openDays / bucket.count),
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  return { total, byReason, uncoded };
}

/** The top `n` causes, for the drawer's mini-panel. */
export function topReasons(summary: ReasonSummary, n = 3): ReasonTally[] {
  return summary.byReason.slice(0, Math.max(0, n));
}

export type InsightPeriod = "quarter" | "month" | "year";

export function isInsightPeriod(value: unknown): value is InsightPeriod {
  return value === "quarter" || value === "month" || value === "year";
}

/**
 * The calendar window a period name means, as [from, to].
 *
 * Calendar, not "last 90 days": a quarter that slides is a quarter nobody can reconcile with a board
 * pack. `to` is the end of the CURRENT period, so a month-to-date figure is the current month, not the
 * last complete one — the sentence says "this month", and that is what it means.
 */
export function periodRange(period: InsightPeriod, now: Date): { from: Date; to: Date } {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  if (period === "month") {
    return { from: new Date(Date.UTC(year, month, 1)), to: new Date(Date.UTC(year, month + 1, 1) - 1) };
  }
  if (period === "year") {
    return { from: new Date(Date.UTC(year, 0, 1)), to: new Date(Date.UTC(year + 1, 0, 1) - 1) };
  }
  const quarterStart = Math.floor(month / 3) * 3;
  return {
    from: new Date(Date.UTC(year, quarterStart, 1)),
    to: new Date(Date.UTC(year, quarterStart + 3, 1) - 1),
  };
}

const PERIOD_LABEL: Record<InsightPeriod, string> = {
  quarter: "this quarter",
  month: "this month",
  year: "this year",
};

/**
 * The one sentence above the chart.
 *
 * Deterministic, and deliberately shy: below five reports it refuses to rank causes, because "100% of
 * delays were weather" off two rows is a claim the data cannot carry. The sample size is always printed,
 * so a reader can discount it.
 */
export function insightSentence(summary: ReasonSummary, period: InsightPeriod = "quarter"): string {
  const when = PERIOD_LABEL[period];
  if (summary.total === 0) {
    return `Nothing reported ${when}. Causes appear here once owners start recording them.`;
  }
  if (summary.total < 5) {
    return `Only ${summary.total} delay${summary.total === 1 ? "" : "s"} reported ${when} — too few to rank causes.`;
  }

  const first = summary.byReason[0];
  const slowest = [...summary.byReason].sort((a, b) => b.averageOpenDays - a.averageOpenDays)[0];
  const head = `${first.label} is the largest cause ${when}: ${first.share}% of ${summary.total} reported delays`;

  // Only claim "slowest to close" when it is a different cause and the gap is real (a day or more).
  if (slowest.code !== first.code && slowest.averageOpenDays - first.averageOpenDays >= 1) {
    return `${head}. ${slowest.label} stays open longest (avg ${slowest.averageOpenDays.toFixed(1)} days).`;
  }
  return `${head}, with an average of ${first.averageOpenDays.toFixed(1)} days open.`;
}
