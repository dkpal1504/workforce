import { useEffect, useMemo, useState } from "react";
import { api } from "../../api/client";
import { SCurveChart } from "./ReviewCharts";
import type { ReviewPayload, SCurve, WbsCurveRow } from "../../pages/review/types";

type Level = "PROJECT" | "WBS" | "JOB_ORDER";

const LEVELS: Array<{ key: Level; label: string; hint: string }> = [
  { key: "PROJECT", label: "Project", hint: "The whole project: every WBS and every Job Order together." },
  { key: "WBS", label: "WBS", hint: "One WBS element at a time, with every WBS compared underneath." },
  { key: "JOB_ORDER", label: "Job Order", hint: "A single Job Order: its own budget across its own window." },
];

/**
 * The S-curve panel, with its three levels.
 *
 * A segment control rather than tabs, deliberately: the level is a property of THIS chart — a lens on the
 * same numbers — not a different screen. Switching level keeps the period, the pulse and the readiness above
 * it in view, which is what a meeting needs; tabs would navigate away and lose the argument in progress.
 *
 * The project and WBS curves travel in the payload (a WBS list is small and bounded). A Job Order curve is
 * fetched when chosen, because a project may hold hundreds and the screen draws one.
 */
export function CurvePanel({ payload }: { payload: ReviewPayload }) {
  const [level, setLevel] = useState<Level>("PROJECT");
  const [wbsId, setWbsId] = useState<number | null>(null);
  const [jobOrderId, setJobOrderId] = useState<number | null>(null);
  const [jobOrderCurve, setJobOrderCurve] = useState<{
    jobOrder: { id: number; code: string; name: string; wbsCode: string; budgetHours: number };
    curve: SCurve;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Worst variance first: a review opens on the part that is furthest behind its own plan.
  const wbsSorted = useMemo(
    () => [...payload.wbsCurves].sort((a, b) => a.variance - b.variance || a.wbsCode.localeCompare(b.wbsCode)),
    [payload.wbsCurves]
  );
  const selectedWbs: WbsCurveRow | null =
    wbsSorted.find((row) => row.wbsId === wbsId) ?? wbsSorted[0] ?? null;

  const jobOrders = payload.jobOrderIndex;
  const selectedJobOrderId = jobOrderId ?? payload.slowest.rows[0]?.jobOrderId ?? jobOrders[0]?.id ?? null;

  useEffect(() => {
    if (level !== "JOB_ORDER" || !selectedJobOrderId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api<{ jobOrder: { id: number; code: string; name: string; wbsCode: string; budgetHours: number }; curve: SCurve }>(
      `/review/projects/${payload.project.id}/curve?jobOrderId=${selectedJobOrderId}&from=${payload.period.start}&to=${payload.period.end}`
    )
      .then((result) => {
        if (!cancelled) setJobOrderCurve(result);
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [level, selectedJobOrderId, payload.project.id, payload.period.start, payload.period.end]);

  const active = LEVELS.find((entry) => entry.key === level) as (typeof LEVELS)[number];

  return (
    <section className="review-section">
      <div className="review-section__head">
        <h2>S-curve — planned against actual hours</h2>
        <div className="review-switch" role="group" aria-label="Curve level">
          {LEVELS.map((entry) => (
            <button
              key={entry.key}
              type="button"
              className={entry.key === level ? "review-switch__button review-switch__button--on" : "review-switch__button"}
              aria-pressed={entry.key === level}
              onClick={() => setLevel(entry.key)}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>
      <p className="review-muted review-section__hint">{active.hint}</p>

      {level === "PROJECT" ? <SCurveChart curve={payload.sCurve} /> : null}

      {level === "WBS" ? (
        wbsSorted.length ? (
          <div className="review-wbs">
            <label className="review-picker">
              WBS element
              <select
                value={selectedWbs?.wbsId ?? ""}
                onChange={(event) => setWbsId(Number(event.target.value))}
              >
                {wbsSorted.map((row) => (
                  <option key={row.wbsId} value={row.wbsId}>
                    {row.wbsCode} · planned {row.budgetHours.toLocaleString("en-IN")} h · variance{" "}
                    {row.variance.toFixed(0)} h
                  </option>
                ))}
              </select>
            </label>
            {selectedWbs ? <SCurveChart curve={selectedWbs.curve} /> : null}
            <div className="review-table-wrap">
              <table className="review-table">
                <thead>
                  <tr>
                    <th scope="col">WBS</th>
                    <th scope="col" className="review-table__num">Share</th>
                    <th scope="col" className="review-table__num">Planned h</th>
                    <th scope="col" className="review-table__num">Planned to date</th>
                    <th scope="col" className="review-table__num">Actual</th>
                    <th scope="col" className="review-table__num">Variance</th>
                    <th scope="col" className="review-table__num">Job Orders</th>
                  </tr>
                </thead>
                <tbody>
                  {wbsSorted.map((row) => (
                    <tr
                      key={row.wbsId}
                      className={row.wbsId === selectedWbs?.wbsId ? "review-table__row--selected" : undefined}
                      onClick={() => setWbsId(row.wbsId)}
                    >
                      <td>
                        <span className="review-table__code">{row.wbsCode}</span>
                        {row.jobOrdersScheduled === 0 ? (
                          <span className="review-table__name">no planned window — not in the plan</span>
                        ) : null}
                      </td>
                      <td className="review-table__num">{Math.round(row.share * 100)}%</td>
                      <td className="review-table__num">{row.budgetHours.toLocaleString("en-IN")}</td>
                      <td className="review-table__num">{row.plannedToDate.toLocaleString("en-IN")}</td>
                      <td className="review-table__num">{row.actualToDate.toLocaleString("en-IN")}</td>
                      <td className={row.variance < 0 ? "review-table__num review-late" : "review-table__num"}>
                        {row.variance > 0 ? "+" : ""}
                        {row.variance.toLocaleString("en-IN")}
                      </td>
                      <td className="review-table__num">
                        {row.jobOrders}
                        <span className="review-muted"> ({row.jobOrdersScheduled} planned)</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="review-table__foot">
              Variance is actual minus planned at the end of the window: negative means the element is behind
              its own share of the plan. Shares come from the WBS weights, so the rows add up to the project
              curve above rather than competing with it.
            </p>
          </div>
        ) : (
          <p className="review-chart__empty">This project has no WBS elements yet.</p>
        )
      ) : null}

      {level === "JOB_ORDER" ? (
        jobOrders.length ? (
          <div className="review-wbs">
            <label className="review-picker">
              Job Order
              <select
                value={selectedJobOrderId ?? ""}
                onChange={(event) => setJobOrderId(Number(event.target.value))}
              >
                {jobOrders.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.code} · {row.wbsCode} · {row.budgetHours.toLocaleString("en-IN")} h
                    {row.scheduled ? "" : " · no plan"}
                  </option>
                ))}
              </select>
            </label>
            {loading ? <p className="review-muted">Loading the Job Order curve…</p> : null}
            {error ? <p className="review-error">Could not load that curve: {error}</p> : null}
            {!loading && !error && jobOrderCurve ? (
              <>
                <p className="review-muted">
                  {jobOrderCurve.jobOrder.code} · {jobOrderCurve.jobOrder.wbsCode} · budget{" "}
                  {jobOrderCurve.jobOrder.budgetHours.toLocaleString("en-IN")} h
                </p>
                <SCurveChart curve={jobOrderCurve.curve} />
              </>
            ) : null}
            {!loading && !error && !jobOrderCurve ? <p className="review-muted">Choose a Job Order.</p> : null}
          </div>
        ) : (
          <p className="review-chart__empty">This project has no Job Orders yet.</p>
        )
      ) : null}
    </section>
  );
}
