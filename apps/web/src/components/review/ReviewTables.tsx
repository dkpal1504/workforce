import type { EscalationAgeSummary, SlowRanking } from "../../pages/review/types";

/**
 * The slowest Job Orders, with the reason beside the score.
 *
 * A reviewer argues with evidence, not with an index: every column is a component of the score, and the
 * "why" cell repeats them in words. Job Orders that cannot be judged at all are NOT silently omitted and
 * not ranked as though they were fine — they are counted in a grey line under the table, because a project
 * whose work has no plan and no booking is a data problem the review exists to surface.
 */
export function SlowJobOrderTable({ slowest }: { slowest: SlowRanking }) {
  if (!slowest.rows.length) {
    return (
      <div className="review-empty">
        <p>
          No Job Order on this project can be ranked: none has both a planned window and a booking, so there is
          nothing to be slow against.
        </p>
        {slowest.notMeasurable > 0 ? (
          <p className="review-empty__note">
            {slowest.notMeasurable} Job Order(s) have no plan and no booking, and are not judged either way.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <>
      <div className="review-table-wrap">
        <table className="review-table">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Job Order</th>
              <th scope="col">WBS</th>
              <th scope="col">Section</th>
              <th scope="col">Planned end</th>
              <th scope="col" className="review-table__num">Slip (d)</th>
              <th scope="col" className="review-table__num">Behind (%)</th>
              <th scope="col" className="review-table__num">Burn</th>
              <th scope="col" className="review-table__num">Qty</th>
              <th scope="col" className="review-table__num">Esc</th>
              <th scope="col" className="review-table__num">Score</th>
              <th scope="col">Why</th>
            </tr>
          </thead>
          <tbody>
            {slowest.rows.map((row, index) => (
              <tr key={row.jobOrderId}>
                <td>{index + 1}</td>
                <td>
                  <span className="review-table__code">{row.code}</span>
                  <span className="review-table__name">{row.displayName}</span>
                  <span className={`review-table__band review-table__band--${row.scheduleBand.toLowerCase()}`}>
                    {row.scheduleBand.replace("_", " ").toLowerCase()}
                  </span>
                </td>
                <td>{row.wbsCode}</td>
                <td>{row.sectionName ?? row.departmentName}</td>
                <td>{row.plannedEndDate ? row.plannedEndDate.slice(0, 10) : "—"}</td>
                <td className="review-table__num">{row.components.slipDays ? row.components.slipDays.toFixed(0) : "—"}</td>
                <td className="review-table__num">
                  {row.components.scheduleGapPct ? row.components.scheduleGapPct.toFixed(0) : "—"}
                </td>
                <td className="review-table__num">{row.burnPct === null ? "—" : `${Math.round(row.burnPct * 100)}%`}</td>
                <td className="review-table__num">{row.qtyPct === null ? "—" : `${Math.round(row.qtyPct * 100)}%`}</td>
                <td className="review-table__num">{row.components.openEscalations || "—"}</td>
                <td className="review-table__num review-table__score">{row.score.toFixed(1)}</td>
                <td className="review-table__why">{row.reasons.join("; ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="review-table__foot">
        {slowest.rows.length} of {slowest.ranked} measurable Job Order(s).{" "}
        {slowest.notMeasurable > 0
          ? `${slowest.notMeasurable} cannot be judged at all (no plan, no booking) and are not ranked — they are not "fine", they are unknown.`
          : "Every Job Order on this project could be judged."}
      </p>
    </>
  );
}

/** Five age buckets, then the oldest open escalations by name and age. */
export function EscalationAgeBars({ escalations }: { escalations: EscalationAgeSummary }) {
  const max = Math.max(1, ...escalations.buckets.map((bucket) => bucket.count));
  return (
    <div className="review-escalations">
      <div className="review-escalations__bars">
        {escalations.buckets.map((bucket) => (
          <div key={bucket.key} className="review-escalations__bucket">
            <span className="review-escalations__count">{bucket.count}</span>
            <div className="review-escalations__track">
              <div
                className={`review-escalations__fill review-escalations__fill--${bucket.key.replace(">", "over")}`}
                style={{ height: `${Math.max(bucket.count ? 8 : 0, (bucket.count / max) * 100)}%` }}
              />
            </div>
            <span className="review-escalations__label">{bucket.label}</span>
          </div>
        ))}
      </div>
      <p className="review-chart__caption">
        {escalations.total} open escalation(s) of {escalations.examined} raised
        {escalations.overdue ? `, ${escalations.overdue} past their due date` : ""}
        {escalations.acknowledgedUnanswered
          ? `, ${escalations.acknowledgedUnanswered} acknowledged but never answered — acknowledging is not answering`
          : ""}
        .
      </p>
      {escalations.oldest.length ? (
        <ul className="review-escalations__oldest">
          {escalations.oldest.map((row) => (
            <li key={row.id}>
              <span className="review-escalations__age">{row.ageDays.toFixed(0)}d</span>
              {row.jobOrderCode ?? `Job Order ${row.id}`}
              {row.overdue ? <span className="review-escalations__flag">overdue</span> : null}
              {row.acknowledgedUnanswered ? <span className="review-escalations__flag">no answer</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
