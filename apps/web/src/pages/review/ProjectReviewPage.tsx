import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../../api/client";
import { SCurveChart, ManpowerHistogram } from "../../components/review/ReviewCharts";
import { EscalationAgeBars, SlowJobOrderTable } from "../../components/review/ReviewTables";
import type { ReviewPayload } from "./types";
import "../../styles/review.css";

/**
 * One project's review dashboard: the numbers a review meeting is actually held over.
 *
 * Every figure comes from ONE server assembly (`buildReviewPayload`), so what this screen shows is what a
 * frozen pack will show. The two lines that matter most are the ones a reader might otherwise invent: the
 * S-curve's caption (the planned line is DERIVED from planned windows, and covers N of M Job Orders) and the
 * readiness panel (what could not be judged at all).
 */
export function ProjectReviewPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [payload, setPayload] = useState<ReviewPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<"WEEKLY" | "MONTHLY">("WEEKLY");
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");

  const query = useMemo(() => {
    const params = new URLSearchParams({ kind });
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    return params.toString();
  }, [kind, from, to]);

  useEffect(() => {
    let cancelled = false;
    setPayload(null);
    setError(null);
    api<ReviewPayload>(`/review/projects/${projectId}/dashboard?${query}`)
      .then((result) => {
        if (!cancelled) setPayload(result);
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, query]);

  if (error) {
    return (
      <section className="review-page">
        <Link className="review-link" to="/review">
          ← Review
        </Link>
        <p className="review-error">
          {error === "PROJECT_NOT_FOUND"
            ? "This project is not in your review scope."
            : `Could not load the review: ${error}`}
        </p>
      </section>
    );
  }
  if (!payload) {
    return (
      <section className="review-page">
        <Link className="review-link" to="/review">
          ← Review
        </Link>
        <p className="review-muted">Loading…</p>
      </section>
    );
  }

  const pulse = payload.pulse;
  return (
    <section className="review-page">
      <header className="review-page__head">
        <div>
          <Link className="review-link" to="/review">
            ← Review
          </Link>
          <h1>
            {payload.project.code} · {payload.project.name}
          </h1>
          <p className="review-muted">
            {payload.period.label}
            {payload.period.provisional ? " · period not finished, these are provisional" : ""} ·{" "}
            {payload.project.departmentName ?? "no department"} · PM {payload.project.projectManager ?? "unassigned"}
          </p>
        </div>
        <div className="review-period">
          <label>
            Period
            <select value={kind} onChange={(event) => setKind(event.target.value as "WEEKLY" | "MONTHLY")}>
              <option value="WEEKLY">Last 12 weeks</option>
              <option value="MONTHLY">Last 30 days</option>
            </select>
          </label>
          <label>
            From
            <input type="date" value={from || payload.window.start} onChange={(event) => setFrom(event.target.value)} />
          </label>
          <label>
            To
            <input type="date" value={to || payload.window.end} onChange={(event) => setTo(event.target.value)} />
          </label>
        </div>
      </header>

      <div className="review-pulse">
        <figure>
          <figcaption>Job Orders</figcaption>
          <strong>{pulse.jobOrders}</strong>
        </figure>
        <figure>
          <figcaption>Budgeted hours</figcaption>
          <strong>{pulse.budgetHours.toLocaleString("en-IN")}</strong>
        </figure>
        <figure>
          <figcaption>Booked hours</figcaption>
          <strong>{pulse.actualHours.toLocaleString("en-IN")}</strong>
          <span>{pulse.burnPct === null ? "burn not measurable" : `${Math.round(pulse.burnPct * 100)}% of budget`}</span>
        </figure>
        <figure>
          <figcaption>Delayed / at risk</figcaption>
          <strong>
            {pulse.delayed} <span className="review-muted">/ {pulse.atRisk}</span>
          </strong>
          <span>{pulse.notScheduled} with no plan</span>
        </figure>
        <figure>
          <figcaption>Open escalations</figcaption>
          <strong>{pulse.openEscalations}</strong>
          <span>{pulse.escalationsOver30} over 30 days</span>
        </figure>
        <figure>
          <figcaption>Actions</figcaption>
          <strong>{pulse.actionsOpen}</strong>
          <span>{pulse.actionsOverdue} overdue</span>
        </figure>
        <figure>
          <figcaption>Peak manpower</figcaption>
          <strong>{pulse.headcountPeak}</strong>
          <span>distinct people in a period</span>
        </figure>
      </div>

      {payload.readiness.sentences.length ? (
        <div className="review-readiness">
          <h2>What cannot be judged yet</h2>
          <ul>
            {payload.readiness.sentences.map((sentence) => (
              <li key={sentence}>{sentence}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <section className="review-section">
        <h2>S-curve — planned against actual hours</h2>
        <SCurveChart curve={payload.sCurve} />
      </section>

      <section className="review-section">
        <h2>Slowest Job Orders</h2>
        <SlowJobOrderTable slowest={payload.slowest} />
      </section>

      <section className="review-section">
        <h2>Manpower</h2>
        <ManpowerHistogram histogram={payload.manpower} />
      </section>

      <section className="review-section">
        <h2>Open escalations by age</h2>
        <EscalationAgeBars escalations={payload.escalations} />
      </section>

      <section className="review-section">
        <h2>Attendance grounding</h2>
        <p className={payload.attendance.grounding ? "review-attendance" : "review-muted"}>
          {payload.attendance.note}
        </p>
      </section>

      <details className="review-definitions">
        <summary>How these numbers are defined</summary>
        <dl>
          <dt>Booked hours</dt>
          <dd>{payload.definitions.hoursNote}</dd>
          <dt>Manpower</dt>
          <dd>{payload.definitions.manpowerNote}</dd>
          <dt>S-curve basis</dt>
          <dd>{payload.definitions.curveBasis}</dd>
          <dt>Overdue</dt>
          <dd>{payload.definitions.overdueRule}</dd>
          <dt>Carry-forward</dt>
          <dd>{payload.definitions.carryRule}</dd>
          <dt>Slow score weights</dt>
          <dd>
            {Object.entries(payload.definitions.slowWeights)
              .map(([key, weight]) => `${key} ×${weight}`)
              .join(", ")}
          </dd>
          <dt>Escalation age buckets</dt>
          <dd>{payload.definitions.ageBuckets.map((bucket) => bucket.label).join(", ")}</dd>
        </dl>
      </details>
    </section>
  );
}
