/**
 * What the Conversations search box looks for.
 *
 * The box used to match a Job Order's own code and name, plus its Project's NAME. A planner does not think
 * that way: they think "show me every conversation under CSR.008", and the project's code is the thing on
 * the screen next to the Job Order, because that is what the project is called everywhere else in the app.
 * Searching CSR.008 therefore matched nothing, and typing a project id matched nothing at all.
 *
 * So a Project is searchable by CODE, by NAME and — when the term is a whole number — by its id. Matching the
 * Project returns its Job Orders' threads, which is the answer the question was asking for.
 *
 * CASE: sensitivity is deliberate and matches the Job Order search this extends. `mode: "insensitive"` is a
 * PostgreSQL-only option in Prisma and the development database can be SQLite (see routes/admin.ts, which
 * makes the same choice for the same reason), so codes are matched as they are stored — upper case.
 */

/** One leaf filter on a Job Order. `project` is a to-one relation, so Prisma's shorthand applies. */
export type JobOrderSearchFilter =
  | { code: { contains: string } }
  | { name: { contains: string } }
  | { project: { code: { contains: string } } }
  | { project: { name: { contains: string } } }
  | { projectId: number };

/**
 * The leaves for one search term.
 *
 * A digit-only term is a PROJECT ID, and only that. Job Order codes in this yard all carry a letter prefix
 * (M4122, B1008, H1001), so "5" is never a Job Order — but as a raw substring it matched M4152, B5014 and half
 * the yard, which reads as a broken search. A number therefore matches the project id (and, harmlessly, a
 * project whose name or code literally contains it) and nothing else. To find Job Order M4152, type M4152.
 *
 * Returns `[]` for a blank term: callers then omit the OR entirely, because `OR: []` matches nothing in Prisma
 * and would turn an empty search box into an empty screen.
 */
export function jobOrderSearchFilters(term: string): JobOrderSearchFilter[] {
  const value = term.trim();
  if (!value) return [];

  if (/^\d+$/.test(value)) {
    const id = Number(value);
    // Only the id. Even a project CODE containing the digit is wrong here: "5" also matched CSR.005 while
    // answering for project 5, which is the same noise in a smaller dose.
    return Number.isSafeInteger(id) && id > 0 ? [{ projectId: id }] : [];
  }

  return [
    { code: { contains: value } },
    { name: { contains: value } },
    { project: { code: { contains: value } } },
    { project: { name: { contains: value } } },
  ];
}

/**
 * The same leaves, one level up: a THREAD is matched through its Job Order.
 *
 * A thread has no project of its own; the project belongs to the Job Order it hangs from, so every leaf is
 * wrapped rather than duplicated. Keeping one list of leaves is what stops the two search boxes drifting —
 * they are the same question asked of two tables.
 */
export function threadSearchFilters(term: string) {
  return jobOrderSearchFilters(term).map((filter) => ({ jobOrder: filter }));
}
