/**
 * The ONE way a day is printed in this application: `dd-mm-yyyy`.
 *
 * WHY THIS IS A MODULE OF ITS OWN: the screens used `toLocaleDateString()`, which follows the
 * BROWSER's locale — an en-US machine printed `10/16/2026`, an en-GB one `16/10/2026`, and a machine
 * with a different short-date setting something else again. Two people looking at the same report
 * therefore read two different dates, and a date quoted over the phone could be read either way round.
 * The yard writes the day first, so the day comes first here, unconditionally.
 *
 * WHY UTC: every date this app stores is a DAY held at UTC midnight (a booking, a progress punch, a
 * planned window). Reading it with the LOCAL getters would push it back a day for anyone west of UTC —
 * a booking made on the 1st would print as the 31st. The UTC parts are the day that was entered.
 *
 * A value the parser cannot read is returned UNCHANGED rather than swallowed: a date that arrives in a
 * shape nobody expected should be visible and wrong-looking, not silently replaced by a dash.
 */
export function formatDay(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  const day = String(parsed.getUTCDate()).padStart(2, "0");
  const month = String(parsed.getUTCMonth() + 1).padStart(2, "0");
  return `${day}-${month}-${parsed.getUTCFullYear()}`;
}

/**
 * A stored INSTANT (an approval, a revision, a check timestamp) as `dd-mm-yyyy HH:mm`.
 *
 * WHY THIS EXISTS BESIDE `formatDay`: a day and an instant are different facts. A booking/progress
 * day is stored at UTC midnight, so `formatDay` reads it in UTC and never shifts. An instant is a
 * moment in time, so it is read in the operator's own zone — printing 07:30 UTC as "13:00" is
 * correct for a yard in IST, and printing it as "07:30" beside a local date would be a lie about
 * which day it happened on.
 *
 * It replaces `toLocaleString()`, which reordered the date per machine (US `10/16/2026`, GB
 * `16/10/2026`) — the exact defect `formatDay` was created to remove, still present in every
 * timestamp.
 */
export function formatStamp(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  const day = String(parsed.getDate()).padStart(2, "0");
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const hours = String(parsed.getHours()).padStart(2, "0");
  const minutes = String(parsed.getMinutes()).padStart(2, "0");
  return `${day}-${month}-${parsed.getFullYear()} ${hours}:${minutes}`;
}
