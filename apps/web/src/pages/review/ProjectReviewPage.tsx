import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";
import { ManpowerHistogram } from "../../components/review/ReviewCharts";
import { CurvePanel } from "../../components/review/CurvePanel";
import { EscalationAgeBars, SlowJobOrderTable } from "../../components/review/ReviewTables";
import type { ReviewPayload } from "./types";

type SnapshotRow = {
  id: number;
  kind: string;
  periodFrom: string;
  periodTo: string;
  revision: number;
  provisional: boolean;
  trigger: string;
  capturedAt: string;
  jobOrders: number;
  budgetHours: number;
  actualHours: number;
  burnPct: number | null;
  delayed: number;
  openEscalations: number;
  actionsOpen: number;
  actionsOverdue: number;
  headcountPeak: number;
};

type FrozenMeta = {
  id: number;
  revision: number;
  capturedAt: string;
  provisional: boolean;
  captureTrigger: string;
  periodFrom: string;
  periodTo: string;
};
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
  const { projectId, snapshotId } = useParams<{ projectId: string; snapshotId?: string }>();
  const { user } = useAuth();
  const canRun = Boolean(user?.capabilities.runProjectReview);
  const [snapshots, setSnapshots] = useState<SnapshotRow[]>([]);
  const [frozenMeta, setFrozenMeta] = useState<FrozenMeta | null>(null);
  const [freezing, setFreezing] = useState(false);
  const [freezeMessage, setFreezeMessage] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [payload, setPayload] = useState<ReviewPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The review window is the last MONTH by default (owner's instruction); 12 weeks is the alternative.
  const [kind, setKind] = useState<"WEEKLY" | "MONTHLY">("MONTHLY");
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
    const path = snapshotId
      ? `/review/snapshots/${snapshotId}`
      : `/review/projects/${projectId}/dashboard?${query}`;
    api<ReviewPayload & { frozenSnapshot?: FrozenMeta }>(path)
      .then((result) => {
        if (cancelled) return;
        setPayload(result);
        setFrozenMeta(result.frozenSnapshot ?? null);
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, query, snapshotId, reloadKey]);

  // The frozen history, so a reviewer can open last month's pack without leaving the screen.
  useEffect(() => {
    if (snapshotId) return;
    let cancelled = false;
    api<{ snapshots: SnapshotRow[] }>(`/review/projects/${projectId}/snapshots?limit=24`)
      .then((result) => {
        if (!cancelled) setSnapshots(result.snapshots);
      })
      .catch(() => {
        if (!cancelled) setSnapshots([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, snapshotId, reloadKey]);

  async function freeze(): Promise<void> {
    setFreezing(true);
    setFreezeMessage(null);
    try {
      const result = await api<{ created: boolean; snapshot: { id: number; revision: number; provisional: boolean } }>(
        `/review/projects/${projectId}/snapshots`,
        { method: "POST", body: JSON.stringify({ kind, from: payload?.period.start, to: payload?.period.end }) }
      );
      setFreezeMessage(
        result.created
          ? `Frozen as revision ${result.snapshot.revision}${result.snapshot.provisional ? " (provisional — the period has not ended)" : ""}.`
          : `Already frozen at revision ${result.snapshot.revision}; nothing had changed, so no new revision was written.`
      );
      setReloadKey((key) => key + 1);
    } catch (cause) {
      setFreezeMessage(cause instanceof Error ? cause.message : "Could not freeze this review.");
    } finally {
      setFreezing(false);
    }
  }

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
  const frozen = Boolean(frozenMeta);
  return (
    <section className="review-page">
      {frozen && frozenMeta ? (
        <div className="review-frozen-banner" role="status">
          <strong>Frozen snapshot r{frozenMeta.revision}</strong> · period {frozenMeta.periodFrom} to{" "}
          {frozenMeta.periodTo} · captured {new Date(frozenMeta.capturedAt).toLocaleString("en-GB")} ·{" "}
          {frozenMeta.provisional ? "PROVISIONAL (the period had not ended)" : "final"} · {frozenMeta.captureTrigger}.
          These numbers cannot change: this screen reads the frozen payload, not the live tables.
        </div>
      ) : null}
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
          {!frozen ? (
            <label>
              Period
              <select value={kind} onChange={(event) => setKind(event.target.value as "WEEKLY" | "MONTHLY")}>
                <option value="MONTHLY">Last one month</option>
                <option value="WEEKLY">Last 12 weeks</option>
              </select>
            </label>
          ) : null}
          {!frozen ? (
          <label>
            From
            <input type="date" value={from || payload.window.start} onChange={(event) => setFrom(event.target.value)} />
          </label>
          ) : null}
          {!frozen ? (
          <label>
            To
            <input type="date" value={to || payload.window.end} onChange={(event) => setTo(event.target.value)} />
          </label>
          ) : null}
          {!frozen && canRun ? (
            <button type="button" className="review-freeze" onClick={() => void freeze()} disabled={freezing}>
              {freezing ? "Freezing…" : "Freeze this review"}
            </button>
          ) : null}
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

      <CurvePanel payload={payload} />

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

      {freezeMessage ? <p className="review-freeze-note">{freezeMessage}</p> : null}

      {!frozen && snapshots.length ? (
        <section className="review-section">
          <h2>Frozen history</h2>
          <div className="review-table-wrap">
            <table className="review-table">
              <thead>
                <tr>
                  <th scope="col">Period</th>
                  <th scope="col" className="review-table__num">Rev</th>
                  <th scope="col">Captured</th>
                  <th scope="col">Trigger</th>
                  <th scope="col" className="review-table__num">Job Orders</th>
                  <th scope="col" className="review-table__num">Budget h</th>
                  <th scope="col" className="review-table__num">Actual h</th>
                  <th scope="col" className="review-table__num">Delayed</th>
                  <th scope="col" className="review-table__num">Escalations</th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {snapshots.map((row) => (
                  <tr key={row.id}>
                    <td>
                      {row.periodFrom} → {row.periodTo}
                      {row.provisional ? <span className="review-muted"> provisional</span> : null}
                    </td>
                    <td className="review-table__num">r{row.revision}</td>
                    <td>{new Date(row.capturedAt).toLocaleDateString("en-GB")}</td>
                    <td className="review-table__why">{row.trigger}</td>
                    <td className="review-table__num">{row.jobOrders}</td>
                    <td className="review-table__num">{row.budgetHours.toLocaleString("en-IN")}</td>
                    <td className="review-table__num">{row.actualHours.toLocaleString("en-IN")}</td>
                    <td className="review-table__num">{row.delayed || "—"}</td>
                    <td className="review-table__num">{row.openEscalations || "—"}</td>
                    <td>
                      <Link className="review-link" to={`/review/${projectId}/snapshot/${row.id}`}>
                        Open frozen
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="review-table__foot">
            A frozen snapshot never re-reads the live tables. Opening one shows exactly what the review saw on the
            day it was captured, which is what makes two packs from two months comparable.
          </p>
        </section>
      ) : null}

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
