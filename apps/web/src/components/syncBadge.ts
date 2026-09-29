/**
 * Pure rules for the Admin "Last refreshed" badge.
 *
 * Kept out of the component because three things here must be right in front of an operator:
 *  - the timestamp is rendered in a NAMED timezone in the text, never as a bare clock time.
 *    The API returns ISO-8601 UTC; a bare "00:30" is what makes a 06:00 IST run look like it
 *    never happened, which is the exact confusion this badge exists to remove.
 *  - "never refreshed" and "refreshed but stale" are different sentences. The first is a
 *    setup problem, the second is a timing one.
 *  - a disabled schedule must NOT read as a fault. It is a configuration state, and dressing
 *    it up as OVERDUE sends the operator hunting for a bug that is not there.
 *
 * No clock is read here: the age comes from the API so the badge and the server cannot
 * disagree about what "now" is.
 */

export type SyncState = "NEVER" | "FAILED" | "OVERDUE" | "FRESH";

export type SyncRun = {
  action: string;
  trigger: string;
  at: string;
  ok: boolean | null;
  error: string | null;
};

export type SyncStatus = {
  source: string;
  enabled: boolean;
  cron: string;
  schedule: { runsPerDay: number; maxGapHours: number; overdueAfterHours: number } | null;
  nowUtc: string;
  lastRefreshAt: string | null;
  ageHours: number | null;
  overdueAfterHours: number | null;
  state: SyncState;
  lastRun: SyncRun | null;
  recentRuns: SyncRun[];
  openExceptions: number;
};

/** The timezone the badge renders and names. One constant, so the label and the clock agree. */
export const BADGE_TIMEZONE = "Asia/Kolkata";
const BADGE_TZ_LABEL = "IST";

/**
 * Month names are spelled out rather than taken from `Intl`.
 *
 * `Intl.DateTimeFormat` abbreviates September as "Sept" under en-GB and "Sep" under en-US, and
 * the ICU data varies with the Node build — so the badge text would change with an unrelated
 * runtime upgrade. The date parts still come from `Intl` (that is what makes the timezone
 * conversion correct); only the label is fixed here.
 */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "29 Sep 2026, 15:26 IST" — the zone is IN the string, never implied. */
export function formatRefreshedAt(iso: string | null, timeZone = BADGE_TIMEZONE): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "2-digit",
    month: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const month = MONTHS[Number(get("month")) - 1] ?? "";
  const zone = timeZone === BADGE_TIMEZONE ? ` ${BADGE_TZ_LABEL}` : ` ${timeZone}`;
  return `${get("day")} ${month} ${get("year")}, ${get("hour")}:${get("minute")}${zone}`;
}

/**
 * "just now" / "12m ago" / "1h 30m ago" / "2d 4h ago" — an age a human reads at a glance.
 *
 * Everything is derived from ONE rounded minute count. Subtracting the whole-hour part from
 * the float first (`ageHours - Math.floor(ageHours)`) loses a minute to binary floating point:
 * 23.9 - 23 is 0.8999999999999986, which floors to 53 instead of 54.
 */
export function describeAge(ageHours: number | null): string {
  if (ageHours == null) return "no data yet";
  const totalMinutes = Math.round(ageHours * 60);
  if (totalMinutes < 1) return "just now";
  if (totalMinutes < 60) return `${totalMinutes}m ago`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return minutes ? `${hours}h ${minutes}m ago` : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  const remainder = hours % 24;
  return remainder ? `${days}d ${remainder}h ago` : `${days}d ago`;
}

/** How the badge should look. `muted` is not a fault: it is "not configured to run". */
export type SyncTone = "ok" | "warn" | "bad" | "muted";

export type SyncBadge = { headline: string; detail: string; tone: SyncTone };

/**
 * The badge text.
 *
 * The precedence is: not enabled, then never, then failed, then overdue, then fresh. Disabled
 * comes first because with the schedule off, "overdue" is guaranteed and meaningless — the
 * operator needs to know the run is not supposed to be happening at all.
 */
export function syncBadge(status: SyncStatus, timeZone = BADGE_TIMEZONE): SyncBadge {
  const cadence = status.schedule;
  const cadenceText = cadence
    ? `Runs ${cadence.runsPerDay === 1 ? "once" : `${cadence.runsPerDay} times`} a day (\`${status.cron}\`)`
    : `Schedule \`${status.cron}\` could not be read, so no staleness alarm is applied`;
  const refreshed = formatRefreshedAt(status.lastRefreshAt, timeZone);

  if (!status.enabled) {
    return {
      headline: refreshed ? `Last refreshed: ${refreshed}` : "Never refreshed",
      detail: `The scheduled refresh is switched off (BADGEVIEW_SYNC_ENABLED=false). ${refreshed ? describeAge(status.ageHours) : "Load the roster with a one-shot run."}`,
      tone: "muted",
    };
  }
  if (!refreshed || status.state === "NEVER") {
    return {
      headline: "Never refreshed",
      detail: `No roster has ever arrived from ${status.source}. Run the sync once, then this shows the time.`,
      tone: "bad",
    };
  }
  if (status.state === "FAILED") {
    return {
      headline: `Last refreshed: ${refreshed}`,
      detail: status.lastRun?.error
        ? `The last run failed: ${status.lastRun.error}`
        : "The last run failed. Check the API log for the reason.",
      tone: "bad",
    };
  }
  if (status.state === "OVERDUE") {
    return {
      headline: `Last refreshed: ${refreshed}`,
      detail: `Overdue — ${describeAge(status.ageHours)}, and a run is expected within ${status.overdueAfterHours}h. ${cadenceText}.`,
      tone: "warn",
    };
  }
  return {
    headline: `Last refreshed: ${refreshed}`,
    detail: `On time — ${describeAge(status.ageHours)}. ${cadenceText}.`,
    tone: "ok",
  };
}

/** The one-line "who last triggered it" note, so schedule vs button is never guessed. */
export function lastTriggerNote(status: SyncStatus): string {
  if (!status.lastRun) return "No run has been recorded yet.";
  const verdict = status.lastRun.ok === false ? "failed" : status.lastRun.ok === true ? "succeeded" : "ended";
  const when = formatRefreshedAt(status.lastRun.at, BADGE_TIMEZONE);
  const exceptions = status.openExceptions > 0 ? ` ${status.openExceptions} row(s) could not be imported.` : "";
  return `Last run ${verdict} — triggered by ${status.lastRun.trigger}${when ? ` on ${when}` : ""}.${exceptions}`;
}
