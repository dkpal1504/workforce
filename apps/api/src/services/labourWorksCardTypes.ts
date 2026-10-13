/**
 * The LabourWorks `[Card Type]` populations that make up our contract (CLMS) workforce.
 *
 * WHY THIS IS ONE EXPORTED LIST AND NOT A LITERAL INSIDE EACH QUERY: three places have to select the
 * SAME population — the sync's snapshot query, the `sourceTerminatedForEcNo()` probe behind the
 * operator's Activate lever (both in `badgeViewSync.ts`), and the `diagnose-supervisor-source.mjs`
 * triage script. When they disagree, an operator is told "LabourWorks does not report this person"
 * by a tool that asked the wrong question, which is the worst possible triage answer: it sends
 * someone to fix a data problem that does not exist. So the LIST is data here and every SQL clause
 * is built from it; the script imports it from `dist/` rather than keeping a copy.
 *
 * WHY BOTH TYPES: `ASSOCIATES` and `ASSOCIATE SEZ` are both contract associates in LabourWorks. The
 * original query named only `ASSOCIATES`, so the whole SEZ population was invisible to this app: no
 * Employee row, no login, no place in any picker, team, approval queue or report. Add a type to this
 * list only with the same kind of evidence — the list is the app's definition of who the contract
 * workforce IS, and the completeness guard (`BADGEVIEW_SYNC_MIN_RATIO`) does not protect against a
 * list that is too NARROW.
 *
 * THE VALUES ARE MATCHED EXACTLY, as SQL Server holds them (`=`, case-insensitive by collation).
 * A value that is not spelled exactly as the source spells it silently selects nothing, so the
 * list is pinned by a test rather than typed twice.
 */
export const LABOURWORKS_CARD_TYPES = ["ASSOCIATES", "ASSOCIATE SEZ"] as const;

export type LabourWorksCardType = (typeof LABOURWORKS_CARD_TYPES)[number];

/**
 * The `[Card Type]` predicate for the snapshot query, plus the values to bind to its parameters.
 *
 * `IN (@cardType0, @cardType1)` rather than a hand-written `= @a OR = @b`: the OR form has to be
 * parenthesised the moment another predicate is added to the same WHERE (a missing pair of brackets
 * widens the query instead of narrowing it, and nothing about the result would look wrong).
 *
 * The parameters are returned in the SAME ORDER as `values` so the caller can bind value[i] to
 * `@cardType<i>` without re-implementing the naming rule — binding a value to the wrong parameter is
 * not detectable from the outside, it just selects the wrong population.
 */
export function cardTypeFilter(): { where: string; values: string[] } {
  const values = [...LABOURWORKS_CARD_TYPES];
  const parameters = values.map((_value, index) => `@cardType${index}`);
  return { where: `[Card Type] IN (${parameters.join(", ")})`, values };
}

/** The list as prose for a log line or a screen, so the printed words cannot outlive the list. */
export function cardTypesLabel(): string {
  return LABOURWORKS_CARD_TYPES.join(" or ");
}
