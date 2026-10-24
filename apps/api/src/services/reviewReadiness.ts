import type { JobOrderFacts } from "./portfolioReporting";

/**
 * Can this project be reviewed honestly yet?
 *
 * On day one the answer will be "not much": a project whose Job Orders have no planned window cannot be
 * judged against a plan, and a project with no quantity progress cannot be judged on progress at all. The
 * dashboard must open with that in words and with counts, because a reviewer who reads a blank S-curve as
 * "we are on plan" is the failure mode this panel exists to prevent.
 *
 * Each sentence carries the number that produced it and names the lever that fixes it.
 */
export type Readiness = {
  jobOrders: number;
  withoutPlan: number;
  withoutBudget: number;
  withoutBookings: number;
  withQuantityProgress: number;
  /** True when at least one Job Order has a measurable quantity series. */
  quantityProgressAvailable: boolean;
  /** 0..1 — the share of Job Orders the S-curve can place on a timeline. */
  planCoverage: number;
  /** Sentences to show verbatim. Empty means the data is good enough to review. */
  sentences: string[];
};

export function dataReadiness(facts: readonly JobOrderFacts[]): Readiness {
  const total = facts.length;
  const withoutPlan = facts.filter((row) => !row.plannedStartDate || !row.plannedEndDate).length;
  const withoutBudget = facts.filter((row) => !(row.budgetHours > 0)).length;
  const withoutBookings = facts.filter((row) => row.lastBooking === null).length;
  const withQuantityProgress = facts.filter((row) => row.measurableOnQuantity).length;
  const planCoverage = total ? Math.round(((total - withoutPlan) / total) * 10_000) / 10_000 : 0;

  const sentences: string[] = [];
  if (!total) {
    sentences.push(
      "This project has no Job Orders yet, so there is nothing to review. Add them under Master Data → Job orders."
    );
    return {
      jobOrders: 0,
      withoutPlan: 0,
      withoutBudget: 0,
      withoutBookings: 0,
      withQuantityProgress: 0,
      quantityProgressAvailable: false,
      planCoverage: 0,
      sentences,
    };
  }
  if (withoutPlan) {
    sentences.push(
      `${withoutPlan} of ${total} Job Order(s) have no planned start and end date, so the planned curve ` +
        `covers ${Math.round(planCoverage * 100)}% of them. They are not in the plan and cannot be judged ` +
        `against it — set the dates under Master Data → Job orders → schedule.`
    );
  }
  if (withoutBudget) {
    sentences.push(
      `${withoutBudget} of ${total} Job Order(s) have no budgeted hours, so burn cannot be measured for ` +
        `them. Set the budget under Master Data → Job orders → budget.`
    );
  }
  if (withoutBookings) {
    sentences.push(
      `${withoutBookings} of ${total} Job Order(s) have never been booked against, so there is no actual ` +
        `line to compare with the plan.`
    );
  }
  if (!withQuantityProgress) {
    sentences.push(
      "No Job Order on this project has an approved quantity progress series, so progress cannot be " +
        "judged: record progress under Job Order progress (HOD punches, PM approves)."
    );
  }
  return {
    jobOrders: total,
    withoutPlan,
    withoutBudget,
    withoutBookings,
    withQuantityProgress,
    quantityProgressAvailable: withQuantityProgress > 0,
    planCoverage,
    sentences,
  };
}
