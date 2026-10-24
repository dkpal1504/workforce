/**
 * The manpower histogram: how many people were on a project in each bucket, and how many hours they gave
 * it. Two series that are NEVER added together into one number:
 *
 *   - CONTRACT hours come from the timesheet (what the project was charged),
 *   - PAYROLL hours come from `employee_allocations` ("My hours", what the man says he did).
 *
 * They measure different things and the app already refuses to conflate them; a review that summed them
 * would double the workforce on screen. A bucket with no data is marked `hasData: false` so the UI can say
 * "nothing booked this week" instead of drawing a confident zero bar.
 */

export type ManpowerBucket = { key: string; start: string; end: string };

/** One employee's hours on one day, from either series. */
export type ManpowerRow = { workDate: string; employeeId: number; hours: number };

export type ManpowerBucketRow = {
  key: string;
  start: string;
  end: string;
  /** Distinct people with a booking in this bucket — two slots of one man on one day is one head. */
  contractPeople: number;
  payrollPeople: number;
  /** Distinct people across both series, counted once. Never `contractPeople + payrollPeople`. */
  people: number;
  contractHours: number;
  payrollHours: number;
  /** True when either series had at least one row in the bucket. */
  hasData: boolean;
};

export type ManpowerHistogram = {
  buckets: ManpowerBucketRow[];
  peakPeople: number;
  peakKey: string | null;
  averagePeople: number;
  contractHours: number;
  payrollHours: number;
  /** People with any booking in the whole window, counted once. */
  headcount: number;
  /** The definition printed next to the chart. */
  definition: string;
};

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function buildHistogram(input: {
  buckets: readonly ManpowerBucket[];
  contractRows: readonly ManpowerRow[];
  payrollRows: readonly ManpowerRow[];
}): ManpowerHistogram {
  const buckets = input.buckets.map((bucket) => {
    const contract = input.contractRows.filter((row) => within(row.workDate, bucket));
    const payroll = input.payrollRows.filter((row) => within(row.workDate, bucket));
    const contractPeople = new Set(contract.map((row) => row.employeeId));
    const payrollPeople = new Set(payroll.map((row) => row.employeeId));
    return {
      key: bucket.key,
      start: bucket.start,
      end: bucket.end,
      contractPeople: contractPeople.size,
      payrollPeople: payrollPeople.size,
      people: new Set([...contractPeople, ...payrollPeople]).size,
      contractHours: round2(contract.reduce((sum, row) => sum + safeHours(row.hours), 0)),
      payrollHours: round2(payroll.reduce((sum, row) => sum + safeHours(row.hours), 0)),
      hasData: contract.length > 0 || payroll.length > 0,
    };
  });

  let peakPeople = 0;
  let peakKey: string | null = null;
  for (const bucket of buckets) {
    if (bucket.people > peakPeople) {
      peakPeople = bucket.people;
      peakKey = bucket.key;
    }
  }
  const averagePeople = buckets.length
    ? round2(buckets.reduce((sum, bucket) => sum + bucket.people, 0) / buckets.length)
    : 0;

  return {
    buckets,
    peakKey,
    peakPeople,
    averagePeople,
    contractHours: round2(buckets.reduce((sum, bucket) => sum + bucket.contractHours, 0)),
    payrollHours: round2(buckets.reduce((sum, bucket) => sum + bucket.payrollHours, 0)),
    headcount: new Set([...input.contractRows, ...input.payrollRows].map((row) => row.employeeId)).size,
    definition:
      "Head-count is distinct people with a booking in the bucket, counted once across the timesheet and " +
      "My hours series. Contract hours are what the project was charged; My hours are what the worker " +
      "recorded. The two series are shown side by side and are never added together.",
  };
}

function within(workDate: string, bucket: ManpowerBucket): boolean {
  const day = workDate.slice(0, 10);
  return day >= bucket.start.slice(0, 10) && day <= bucket.end.slice(0, 10);
}

function safeHours(value: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
