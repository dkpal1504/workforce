import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api/client";
import "../styles/supervisors.css";

/**
 * Project Managers — which ACCOUNT manages which Projects.
 *
 * This panel decides the SCOPE of the dashboard for one role and nothing else. It does not give
 * anyone the role (Role Assignment does that, and the API refuses an assignment to an account that
 * does not hold it), and it grants no approval or edit rights — the Project Manager's screen is
 * read-only by design.
 *
 * TWO STATES ARE STATED, NEVER HIDDEN:
 *  - a project with no manager is listed with "No manager assigned", because that is the gap this
 *    panel exists to surface;
 *  - when no account holds the Project Manager role yet, the picker says so AND names the next step
 *    (Role Assignment). An empty dropdown would read as a broken control.
 *
 * The history block keeps revoked assignments visible: "who managed this project last quarter" is a
 * question an administrator asks, and the API never deletes a row.
 */

type Assignment = {
  assignmentId: number;
  userId: number;
  name: string;
  login: string;
  accountActive: boolean;
  status: string;
  assignedAt: string;
  assignedBy: string | null;
  revokedAt: string | null;
  note: string | null;
};

type ProjectRow = {
  id: number;
  code: string;
  name: string;
  active: boolean;
  isNonProject: boolean;
  managers: Assignment[];
};

type HistoryRow = {
  id: number;
  projectId: number;
  userId: number;
  userName: string;
  login: string;
  status: string;
  assignedAt: string;
  assignedBy: string | null;
  revokedAt: string | null;
  note: string | null;
};

type Payload = {
  projects: ProjectRow[];
  assignments: HistoryRow[];
  eligibleUsers: Array<{ id: number; name: string; login: string; active: boolean }>;
};

function errorText(error: unknown): string {
  return error instanceof ApiError && error.payload && typeof error.payload === "object" && "error" in error.payload
    ? String((error.payload as { error: unknown }).error)
    : error instanceof Error ? error.message : "Request failed";
}

const dateText = (value: string | null): string => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("en-GB");
};

export function ProjectManagersPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [projectId, setProjectId] = useState<string>("");
  const [userId, setUserId] = useState<string>("");
  const [note, setNote] = useState("");
  const [showHistory, setShowHistory] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(await api<Payload>("/admin/project-managers"));
    } catch (e) {
      // A swallowed failure must not render as "no projects exist" — name it.
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<string>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      setNotice(await action());
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const projects = data?.projects ?? [];
  const eligible = data?.eligibleUsers ?? [];
  const activeCount = useMemo(
    () => (data?.assignments ?? []).filter((row) => row.status === "active").length,
    [data]
  );
  const unmanaged = useMemo(() => projects.filter((row) => row.managers.every((m) => m.status !== "active")), [projects]);

  async function assign() {
    if (!projectId || !userId) {
      setError("Pick a project and an account first.");
      return;
    }
    await run(async () => {
      const result = await api<{ action: string }>("/admin/project-managers", {
        method: "POST",
        body: JSON.stringify({ projectId: Number(projectId), userId: Number(userId), note: note.trim() || undefined }),
      });
      setNote("");
      return result.action === "reactivate"
        ? "Assignment re-activated. The manager's dashboard picks it up on the next load."
        : "Project assigned. The manager's dashboard picks it up on the next load.";
    });
  }

  async function revoke(assignmentId: number, managerName: string) {
    await run(async () => {
      await api(`/admin/project-managers/${assignmentId}`, { method: "DELETE" });
      return `${managerName}'s assignment is revoked. The history line keeps the date it ended.`;
    });
  }

  return (
    <>
      <div className="supervisors-toolbar">
        <div className="supervisors-actions">
          <span className="muted">
            {activeCount} active assignment{activeCount === 1 ? "" : "s"} · {unmanaged.length} project
            {unmanaged.length === 1 ? "" : "s"} with no manager
          </span>
        </div>
        <div className="supervisors-actions">
          <button type="button" className={`btn ${showHistory ? "btn-primary" : "btn-ghost"}`} onClick={() => setShowHistory((v) => !v)}>
            {showHistory ? "Hide history" : "Show history"}
          </button>
        </div>
      </div>

      <p className="muted" style={{ marginTop: 0 }}>
        A Project Manager reads only the Projects listed here — every WBS element, Network and Job Order
        beneath them, across Departments. The role itself is granted on <Link to="/role-assignment">Role Assignment</Link>;
        this panel only scopes it.
      </p>

      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="alloc-note">{notice}</div>}

      {eligible.length === 0 ? (
        <div className="empty-state">
          No account holds the <strong>Project Manager</strong> role yet, so there is nobody to assign.
          Give an employee that role on <Link to="/role-assignment">Role Assignment</Link> first.
        </div>
      ) : (
        <div className="supervisors-toolbar" style={{ alignItems: "flex-end" }}>
          <div className="supervisors-actions">
            <label>
              Project
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)} disabled={busy}>
                <option value="">Select a project…</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.code} · {project.name}
                    {project.active ? "" : " (inactive)"}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Manager
              <select value={userId} onChange={(e) => setUserId(e.target.value)} disabled={busy}>
                <option value="">Select an account…</option>
                {eligible.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name} ({account.login}){account.active ? "" : " — inactive"}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Note (optional)
              <input value={note} onChange={(e) => setNote(e.target.value)} disabled={busy} placeholder="Handover, cover…" />
            </label>
          </div>
          <div className="supervisors-actions">
            <button type="button" className="btn btn-primary" onClick={() => void assign()} disabled={busy}>
              {busy ? "Saving…" : "Assign manager"}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="loading-state">Loading projects and assignments…</div>
      ) : projects.length === 0 ? (
        <div className="empty-state">No project exists yet. Create one on Project master first.</div>
      ) : (
        <table className="sup-table">
          <thead>
            <tr>
              <th>Project</th>
              <th>Managers</th>
              <th style={{ textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((project) => {
              const active = project.managers.filter((manager) => manager.status === "active");
              return (
                <tr key={project.id}>
                  <td>
                    <div className="sup-cell-strong">
                      {project.code} · {project.name}
                    </div>
                    <div className="muted">
                      {project.isNonProject ? "Non-project / standing work" : "Commercial project"}
                      {project.active ? "" : " · inactive"}
                    </div>
                  </td>
                  <td>
                    {active.length === 0 ? (
                      <span className="muted">No manager assigned</span>
                    ) : (
                      active.map((manager) => (
                        <div key={manager.assignmentId}>
                          {manager.name} <span className="muted">({manager.login})</span>
                          {manager.accountActive ? "" : <span className="muted"> · account inactive</span>}
                          <div className="muted">
                            since {dateText(manager.assignedAt)}
                            {manager.assignedBy ? ` · by ${manager.assignedBy}` : ""}
                            {manager.note ? ` · ${manager.note}` : ""}
                          </div>
                        </div>
                      ))
                    )}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {active.map((manager) => (
                      <button
                        key={manager.assignmentId}
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={busy}
                        onClick={() => void revoke(manager.assignmentId, manager.name)}
                      >
                        Revoke {manager.name}
                      </button>
                    ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {showHistory ? (
        <section className="panel" style={{ marginTop: 18 }}>
          <div className="panel__header">
            <span>Assignment history</span>
            <span className="panel__count">{data?.assignments.length ?? 0}</span>
          </div>
          {(data?.assignments ?? []).length === 0 ? (
            <div className="empty-state">No assignment has been made yet.</div>
          ) : (
            <table className="sup-table">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Manager</th>
                  <th>Status</th>
                  <th>From</th>
                  <th>To</th>
                  <th>By</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {(data?.assignments ?? []).map((row) => {
                  const project = projects.find((candidate) => candidate.id === row.projectId);
                  return (
                    <tr key={row.id}>
                      <td>{project ? `${project.code} · ${project.name}` : `Project ${row.projectId}`}</td>
                      <td>
                        {row.userName} <span className="muted">({row.login})</span>
                      </td>
                      <td>{row.status === "active" ? "Active" : "Revoked"}</td>
                      <td>{dateText(row.assignedAt)}</td>
                      <td>{dateText(row.revokedAt)}</td>
                      <td>{row.assignedBy ?? "—"}</td>
                      <td>{row.note ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      ) : null}
    </>
  );
}
