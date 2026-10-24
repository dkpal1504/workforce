import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import type { ReviewProjectsResponse } from "./types";
import "../../styles/review.css";

/**
 * The Review home: every project this account may review, in the order the PM team codes them.
 *
 * The scope line is not decoration. An HOD reading one department, or a Project Manager reading three
 * assigned projects, must be able to see WHY the list is as short as it is — otherwise an empty list looks
 * like missing data and gets reported as a bug.
 */
export function ReviewHomePage() {
  const [data, setData] = useState<ReviewProjectsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<ReviewProjectsResponse>("/review/projects")
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <section className="review-page">
        <h1>Review</h1>
        <p className="review-error">Could not load the review list: {error}</p>
      </section>
    );
  }
  if (!data) {
    return (
      <section className="review-page">
        <h1>Review</h1>
        <p className="review-muted">Loading…</p>
      </section>
    );
  }

  return (
    <section className="review-page">
      <header className="review-page__head">
        <div>
          <h1>Review</h1>
          <p className="review-muted">
            Project review, held against frozen hours. Scope: <strong>{data.scope.description}</strong>
          </p>
        </div>
      </header>

      {!data.scope.ok ? (
        <p className="review-empty__note">{data.scope.description}</p>
      ) : data.projects.length === 0 ? (
        <p className="review-empty__note">
          No project is in scope for this account. A Project Manager sees the projects assigned to them; an HOD
          or Department Head sees the projects their department works on.
        </p>
      ) : (
        <div className="review-table-wrap">
          <table className="review-table">
            <thead>
              <tr>
                <th scope="col">Project</th>
                <th scope="col">Departments</th>
                <th scope="col" className="review-table__num">Job Orders</th>
                <th scope="col" className="review-table__num">Budget h</th>
                <th scope="col" className="review-table__num">Actual h</th>
                <th scope="col" className="review-table__num">Burn</th>
                <th scope="col" className="review-table__num">Delayed</th>
                <th scope="col" className="review-table__num">No plan</th>
                <th scope="col" className="review-table__num">Escalations</th>
                <th scope="col" className="review-table__num">Actions</th>
                <th scope="col">Last frozen</th>
              </tr>
            </thead>
            <tbody>
              {data.projects.map((project) => (
                <tr key={project.id}>
                  <td>
                    <Link className="review-link" to={`/review/${project.id}`}>
                      {project.code}
                    </Link>
                    <span className="review-table__name">{project.name}</span>
                  </td>
                  <td className="review-table__why">{project.departmentNames.join(", ") || "—"}</td>
                  <td className="review-table__num">{project.jobOrders}</td>
                  <td className="review-table__num">{project.budgetHours.toLocaleString("en-IN")}</td>
                  <td className="review-table__num">{project.actualHours.toLocaleString("en-IN")}</td>
                  <td className="review-table__num">{project.burnPct === null ? "—" : `${Math.round(project.burnPct * 100)}%`}</td>
                  <td className="review-table__num">{project.delayed || "—"}</td>
                  <td className="review-table__num">{project.notScheduled || "—"}</td>
                  <td className="review-table__num">{project.openEscalations || "—"}</td>
                  <td className="review-table__num">
                    {project.actionsOpen || "—"}
                    {project.actionsOverdue ? <span className="review-late">{project.actionsOverdue} late</span> : null}
                  </td>
                  <td>{project.lastSnapshot ? `r${project.lastSnapshot.revision} · ${project.lastSnapshot.asOf.slice(0, 10)}` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
