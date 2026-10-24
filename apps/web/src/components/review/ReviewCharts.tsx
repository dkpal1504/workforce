import { bandCentres, bars, compactNumber, linePath, scaleLinear, ticks, yDomain } from "../../pages/review/reviewChart";
import type { SCurve } from "../../pages/review/types";

/**
 * Planned against actual, cumulative.
 *
 * The planned line is DASHED and its caption says, in words, that it is derived from planned windows rather
 * than an imported baseline — a reviewer must never mistake an even spread for a plan somebody wrote. When
 * nothing could be plotted the chart says so instead of drawing a flat zero, which would read as "on plan".
 */
export function SCurveChart({ curve }: { curve: SCurve }) {
  const width = 760;
  const height = 240;
  const padding = { left: 56, right: 16, top: 16, bottom: 34 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  if (curve.empty || !curve.points.length) {
    return (
      <div className="review-chart review-chart--empty" role="img" aria-label="S-curve unavailable">
        <p className="review-chart__empty">
          Nothing to plot: no Job Order on this project has both a planned window and a booking, so there is
          neither a planned line nor an actual one.
        </p>
      </div>
    );
  }

  const domain = yDomain([curve.points.map((point) => point.plannedCum), curve.points.map((point) => point.actualCum)]);
  const y = scaleLinear(domain.min, domain.max, plotHeight, 0);
  const x = scaleLinear(0, Math.max(1, curve.points.length - 1), 0, plotWidth);
  const plannedPath = linePath(curve.points.map((point) => point.plannedCum), x, y, plotWidth);
  const actualPath = linePath(curve.points.map((point) => point.actualCum), x, y, plotWidth);
  const gridValues = ticks(domain.min, domain.max, 4);
  const labelEvery = Math.ceil(curve.points.length / 6);

  return (
    <div className="review-chart">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="review-chart__svg"
        role="img"
        aria-label="Planned and actual cumulative hours"
      >
        <g transform={`translate(${padding.left},${padding.top})`}>
          {gridValues.map((value) => (
            <g key={value}>
              <line x1={0} x2={plotWidth} y1={y(value)} y2={y(value)} className="review-chart__grid" />
              <text x={-10} y={y(value)} textAnchor="end" dominantBaseline="middle" className="review-chart__tick">
                {compactNumber(value)}
              </text>
            </g>
          ))}
          <path d={plannedPath} className="review-chart__planned" />
          <path d={actualPath} className="review-chart__actual" />
          {curve.points.map((point, index) =>
            index % labelEvery === 0 ? (
              <text
                key={point.key}
                x={x(index)}
                y={plotHeight + 18}
                textAnchor="middle"
                className="review-chart__tick"
              >
                {point.start.slice(5)}
              </text>
            ) : null
          )}
        </g>
      </svg>
      <ul className="review-chart__legend">
        <li>
          <span className="review-chart__swatch review-chart__swatch--planned" /> Planned (derived)
        </li>
        <li>
          <span className="review-chart__swatch review-chart__swatch--actual" /> Actual booked hours
        </li>
      </ul>
      {curve.assumptions.map((line) => (
        <p key={line} className="review-chart__caption">
          {line}
        </p>
      ))}
    </div>
  );
}

/**
 * People per bucket, as two series that are never summed: contract hours (what the project was charged) and
 * My hours (what the worker recorded). The head-count line is distinct people, counted once.
 */
export function ManpowerHistogram({ histogram }: { histogram: import("../../pages/review/types").ManpowerHistogram }) {
  const width = 760;
  const height = 200;
  const padding = { left: 48, right: 12, top: 12, bottom: 30 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  if (!histogram.buckets.length) {
    return <p className="review-chart__empty">No period to draw.</p>;
  }

  const max = Math.max(...histogram.buckets.flatMap((bucket) => [bucket.contractHours, bucket.payrollHours]), 1);
  const contractBars = bars(histogram.buckets.map((bucket) => bucket.contractHours), plotWidth, plotHeight, max, 0.3);
  const payrollBars = bars(histogram.buckets.map((bucket) => bucket.payrollHours), plotWidth, plotHeight, max, 0.3);
  const slot = plotWidth / histogram.buckets.length;
  const centres = bandCentres(histogram.buckets.length, plotWidth);

  return (
    <div className="review-chart">
      <svg viewBox={`0 0 ${width} ${height}`} className="review-chart__svg" role="img" aria-label="Manpower by period">
        <g transform={`translate(${padding.left},${padding.top})`}>
          {ticks(0, max, 3).map((value) => (
            <g key={value}>
              <line
                x1={0}
                x2={plotWidth}
                y1={plotHeight - (value / max) * plotHeight}
                y2={plotHeight - (value / max) * plotHeight}
                className="review-chart__grid"
              />
              <text
                x={-8}
                y={plotHeight - (value / max) * plotHeight}
                textAnchor="end"
                dominantBaseline="middle"
                className="review-chart__tick"
              >
                {compactNumber(value)}
              </text>
            </g>
          ))}
          {contractBars.map((rect, index) => (
            <rect
              key={`c-${histogram.buckets[index].key}`}
              x={Math.max(0, rect.x - rect.width / 2)}
              y={rect.y}
              width={rect.width}
              height={rect.height}
              className="review-chart__bar review-chart__bar--contract"
            >
              <title>
                {`${histogram.buckets[index].start} — contract ${histogram.buckets[index].contractHours} h, ` +
                  `${histogram.buckets[index].contractPeople} people`}
              </title>
            </rect>
          ))}
          {payrollBars.map((rect, index) => (
            <rect
              key={`p-${histogram.buckets[index].key}`}
              x={Math.min(plotWidth - rect.width, rect.x + rect.width / 2)}
              y={rect.y}
              width={rect.width}
              height={rect.height}
              className="review-chart__bar review-chart__bar--payroll"
            >
              <title>
                {`${histogram.buckets[index].start} — My hours ${histogram.buckets[index].payrollHours} h, ` +
                  `${histogram.buckets[index].payrollPeople} people`}
              </title>
            </rect>
          ))}
          {centres.map((centre, index) =>
            index % Math.ceil(centres.length / 6) === 0 ? (
              <text key={histogram.buckets[index].key} x={centre} y={plotHeight + 18} textAnchor="middle" className="review-chart__tick">
                {histogram.buckets[index].start.slice(5)}
              </text>
            ) : null
          )}
          {slot === 0 ? null : null}
        </g>
      </svg>
      <ul className="review-chart__legend">
        <li>
          <span className="review-chart__swatch review-chart__swatch--contract" /> Contract hours (timesheet)
        </li>
        <li>
          <span className="review-chart__swatch review-chart__swatch--payroll" /> My hours (worker-recorded)
        </li>
      </ul>
      <p className="review-chart__caption">
        Peak {histogram.peakPeople} {histogram.peakPeople === 1 ? "person" : "people"}
        {histogram.peakKey ? ` in the period starting ${histogram.peakKey.slice(5)}` : ""}, average{" "}
        {histogram.averagePeople}, {histogram.headcount} distinct {histogram.headcount === 1 ? "person" : "people"} in
        the window. {histogram.definition}
      </p>
    </div>
  );
}
