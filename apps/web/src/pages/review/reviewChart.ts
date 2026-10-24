/**
 * The arithmetic behind the review charts.
 *
 * There is no chart library in this app and none may be added, so every line and bar is drawn from these
 * helpers. They are pure and tested because a chart that lies is worse than a chart that is missing: a
 * mis-scaled S-curve would tell a review meeting that a project is ahead of plan.
 */

export type Scale = (value: number) => number;

/** A linear map from a data domain to a pixel range. A zero-width domain collapses to the range start. */
export function scaleLinear(
  domainMin: number,
  domainMax: number,
  rangeMin: number,
  rangeMax: number
): Scale {
  const span = domainMax - domainMin;
  if (!Number.isFinite(span) || span === 0) return () => rangeMin;
  return (value: number) => {
    if (!Number.isFinite(value)) return rangeMin;
    const clamped = Math.min(domainMax, Math.max(domainMin, value));
    return rangeMin + ((clamped - domainMin) / span) * (rangeMax - rangeMin);
  };
}

/** Round tick marks a reader can hold in their head: 1, 2, 2.5 or 5 times a power of ten. */
export function ticks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || count < 1) return [];
  if (max === min) return [min];
  const step = niceStep((max - min) / count);
  const first = Math.ceil(min / step) * step;
  const values: number[] = [];
  for (let value = first; value <= max + step / 1000; value += step) {
    values.push(Math.round(value * 1000) / 1000);
    if (values.length > 20) break;
  }
  return values;
}

function niceStep(raw: number): number {
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
  const normalised = raw / magnitude;
  const step = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 2.5 ? 2.5 : normalised <= 5 ? 5 : 10;
  return step * magnitude;
}

/**
 * The y-domain for a planned-vs-actual chart: it must contain BOTH lines, and it must start at 0 — a
 * cumulative-hours chart that starts anywhere else exaggerates every difference on it.
 */
export function yDomain(series: ReadonlyArray<readonly number[]>): { min: number; max: number } {
  let max = 0;
  for (const values of series) {
    for (const value of values) {
      if (Number.isFinite(value) && value > max) max = value;
    }
  }
  // A flat zero project still needs a readable axis, not a degenerate one.
  const top = max > 0 ? max * 1.05 : 1;
  return { min: 0, max: Math.ceil(top) };
}

/** An SVG path for a cumulative line, in pixel space. Empty input draws nothing rather than a dot at 0,0. */
export function linePath(
  values: readonly number[],
  x: Scale,
  y: Scale,
  width: number
): string {
  if (!values.length) return "";
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  return values
    .map((value, index) => `${index === 0 ? "M" : "L"}${round(x(index * step))},${round(y(value))}`)
    .join(" ");
}

/** x positions for a category axis: the CENTRE of each bucket, so a bar and its tick agree. */
export function bandCentres(count: number, width: number): number[] {
  if (count <= 0) return [];
  const slot = width / count;
  return Array.from({ length: count }, (_, index) => round(slot * index + slot / 2));
}

/** Bar rectangles for a histogram. A zero value gets zero height, which is honest, not invisible. */
export function bars(
  values: readonly number[],
  width: number,
  height: number,
  max: number,
  gapRatio = 0.18
): Array<{ x: number; y: number; width: number; height: number }> {
  if (!values.length || width <= 0 || height <= 0) return [];
  const slot = width / values.length;
  const barWidth = Math.max(1, slot * (1 - gapRatio));
  const top = max > 0 ? max : 1;
  return values.map((value, index) => {
    const safe = Number.isFinite(value) && value > 0 ? value : 0;
    const barHeight = (safe / top) * height;
    return {
      x: round(slot * index + (slot - barWidth) / 2),
      y: round(height - barHeight),
      width: round(barWidth),
      height: round(barHeight),
    };
  });
}

/** "12.4k" for an axis label — a reviewer reads thousands, not six digits. */
export function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return "–";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${trim(value / 1_000_000)}M`;
  if (abs >= 1_000) return `${trim(value / 1_000)}k`;
  return trim(value);
}

function trim(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
