/**
 * The arithmetic behind the three hero tiles on /portfolio, as PURE functions.
 *
 * WHY THIS IS ITS OWN MODULE
 *   The first version of the burn tile compared `burnPct > 100`, but the API sends burn as a RATIO
 *   — 1.109 means 111%. The result was a green "Within budget" pill on a portfolio that was 11%
 *   OVER budget, and a bar filled to 0.7% of its track. It looked plausible and was exactly wrong,
 *   which is the worst kind of wrong on a screen an operations chief acts on. Keeping the units in
 *   one tested place is what stops that recurring: the component renders these numbers, it does not
 *   compute them, and the test below pins the ratio/percent boundary.
 *
 * Burn arrives as a ratio everywhere in this app (`fmtPct(1.109) === "111%"`), and a ratio is what
 * these functions take and return.
 */

/** A RATIO, not a percentage: 0.75 is 75%, 1.109 is 111%. */
export type BurnRatio = number | null | undefined;

export type BurnTag = { text: string; tone: "bad" | "warn" | "good" };

export type BurnSummary = {
  /** False when there is no denominator — render "—", never a green verdict. */
  measurable: boolean;
  /** The ratio, clamped to 0 when not measurable. */
  ratio: number;
  /** Width of the fill as a percentage of the 0–1.5 track. */
  fillPct: number;
  /** True only ABOVE budget (>1.0), never at exactly budget. */
  over: boolean;
  /** True at or above 75% of budget. */
  warn: boolean;
  /** The pill beside the title, or null when there is nothing to judge. */
  tag: BurnTag | null;
};

/** The track spans 0..150% of budget, so budget (100%) sits two thirds along it. */
export const BURN_SCALE_MAX = 1.5;

/**
 * Classify a burn ratio.
 *
 * Deliberately NOT measurable when the ratio is absent or not finite: a missing denominator must
 * read as "not measurable", never fall through to the green branch. A green tile borrowed from
 * missing data is the defect this app already guards against elsewhere.
 */
export function burnSummary(burnPct: BurnRatio): BurnSummary {
  const measurable = typeof burnPct === "number" && Number.isFinite(burnPct);
  const ratio = measurable ? (burnPct as number) : 0;
  // Negative burn is not meaningful (it would imply negative bookings); floor at 0 so the fill can
  // never render outside its track.
  const clamped = Math.max(0, ratio);
  const fillPct = measurable ? Math.min(100, (clamped / BURN_SCALE_MAX) * 100) : 0;
  const over = measurable && ratio > 1;
  const warn = measurable && ratio >= 0.75;

  const tag: BurnTag | null = !measurable
    ? null
    : over
      ? { text: "Over budget", tone: "bad" }
      : warn
        ? { text: "75% or more used", tone: "warn" }
        : { text: "Within budget", tone: "good" };

  return { measurable, ratio, fillPct, over, warn, tag };
}

export type BandCounts = Record<string, number>;

export type HealthSummary = {
  /** Every job order counted, including the ones with no budget. */
  total: number;
  /** RED + AMBER + GREEN, i.e. the ones burn can actually speak about. */
  measurable: number;
  /** Whole-percent share of the scope that burn covers. 0 when the scope is empty. */
  measurableShare: number;
  /** Ordered counts for the bar segments and the legend. */
  order: Array<{ band: "RED" | "AMBER" | "GREEN" | "NOT_MEASURABLE"; count: number }>;
};

const BAND_ORDER = ["RED", "AMBER", "GREEN", "NOT_MEASURABLE"] as const;

/**
 * Roll the band counts up into the one story the health card tells.
 *
 * NOT_MEASURABLE is counted in `total` but deliberately NOT in `measurable`: it is its own row and
 * must never be folded into GREEN, because a green figure borrowed from missing data is a lie the
 * screen would be telling.
 *
 * The zero-denominator guard is load-bearing — an empty scope (or a filter that matches nothing)
 * must produce 0%, not NaN%, which would render as the literal text "NaN%" in the footnote.
 */
export function healthSummary(bands: BandCounts | undefined | null): HealthSummary {
  const count = (band: (typeof BAND_ORDER)[number]) => {
    const value = bands?.[band];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };

  const order = BAND_ORDER.map((band) => ({ band, count: count(band) }));
  const total = order.reduce((sum, entry) => sum + entry.count, 0);
  const measurable = order
    .filter((entry) => entry.band !== "NOT_MEASURABLE")
    .reduce((sum, entry) => sum + entry.count, 0);
  const measurableShare = total > 0 ? Math.round((measurable / total) * 100) : 0;

  return { total, measurable, measurableShare, order };
}
