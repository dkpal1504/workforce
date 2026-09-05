import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api/client";
import "../styles/supervisors.css";

type Department = {
  id: number;
  name: string;
  code: string;
  source?: string | null; // SYNC (auto-created by BadgeView) | MANUAL
};

type Modal =
  | { kind: "create" }
  | { kind: "edit"; dept: Department }
  | null;

/**
 * Department management (CR#2) — ADMIN/HR gated at the API.
 * Lists sync-auto-created vs manual departments; add/edit. Editing a
 * sync-created department promotes it to MANUAL so the sync stops owning it
 * (the no-clobber invariant the team locked).
 */
export function DepartmentsPage() {
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [modal, setModal] = useState<Modal>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api<{ departments: Department[] }>("/admin/departments");
      setDepartments(res.departments);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load departments");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return departments;
    return departments.filter(
      (d) => d.name.toLowerCase().includes(q) || d.code.toLowerCase().includes(q)
    );
  }, [departments, search]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
      setModal(null);
      return true;
    } catch (e) {
      const msg =
        e instanceof ApiError && typeof e.payload === "object" && e.payload && "error" in e.payload
          ? String((e.payload as { error: string }).error)
          : e instanceof Error
            ? e.message
            : "Request failed";
      setError(msg);
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="supervisors-toolbar">
        <span className="supervisors-toolbar__count">
          {departments.length} departments ·{" "}
          {departments.filter((d) => d.source === "SYNC").length} auto-created ·{" "}
          {departments.filter((d) => d.source !== "SYNC").length} manual
        </span>
        <div className="supervisors-actions">
          <input
            className="search-input"
            style={{ marginBottom: 0, minWidth: 180, maxWidth: 260 }}
            placeholder="Search name or code…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search departments"
          />
          <button type="button" className="btn btn-primary" onClick={() => setModal({ kind: "create" })}>
            + Add Department
          </button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {loading && <div className="loading-state">Loading departments…</div>}

      {!loading && filtered.length === 0 && (
        <div className="empty-state">No departments found.</div>
      )}

      {/* Desktop table */}
      {!loading && filtered.length > 0 && (
        <table className="sup-table">
          <thead>
            <tr>
              <th>Department</th>
              <th>Code</th>
              <th>Source</th>
              <th style={{ textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((d) => (
              <tr key={d.id}>
                <td>
                  <strong>{d.name}</strong>
                </td>
                <td>{d.code}</td>
                <td>
                  {d.source === "SYNC" ? (
                    <span className="badge badge--sync">Auto-created (Sync)</span>
                  ) : (
                    <span className="badge badge--manual">Manual</span>
                  )}
                </td>
                <td>
                  <div className="sup-table__actions">
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setModal({ kind: "edit", dept: d })}>
                      Edit
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Mobile/tablet cards */}
      {!loading && filtered.length > 0 && (
        <div className="sup-list">
          {filtered.map((d) => (
            <div key={d.id} className="sup-card">
              <div className="sup-card__body">
                <div className="sup-card__top">
                  <span className="sup-card__name">{d.name}</span>
                  {d.source === "SYNC" ? (
                    <span className="badge badge--sync">Auto-created (Sync)</span>
                  ) : (
                    <span className="badge badge--manual">Manual</span>
                  )}
                </div>
                <div className="sup-card__sub">
                  <span>Code: {d.code}</span>
                </div>
                <div className="sup-card__actions">
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setModal({ kind: "edit", dept: d })}>
                    Edit
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {modal && (
        <div className="modal-backdrop" onClick={() => setModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal__header">
              <h2>{modal.kind === "create" ? "Add Department" : `Edit ${modal.dept.name}`}</h2>
              <button type="button" className="modal__close" aria-label="Close" onClick={() => setModal(null)}>
                ×
              </button>
            </div>
            <div className="modal__body">
              <DeptForm
                dept={modal.kind === "edit" ? modal.dept : null}
                busy={busy}
                onSubmit={(name, code) =>
                  run(() =>
                    modal.kind === "create"
                      ? api("/admin/departments", { method: "POST", body: JSON.stringify({ name, code }) })
                      : api(`/admin/departments/${modal.dept.id}`, { method: "PUT", body: JSON.stringify({ name, code }) })
                  )
                }
                onCancel={() => setModal(null)}
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function DeptForm({
  dept,
  busy,
  onSubmit,
  onCancel,
}: {
  dept: Department | null;
  busy: boolean;
  onSubmit: (name: string, code: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(dept?.name ?? "");
  const [code, setCode] = useState(dept?.code ?? "");
  const [err, setErr] = useState("");

  function submit() {
    if (!name.trim()) return setErr("Name is required.");
    if (!code.trim()) return setErr("Code is required.");
    setErr("");
    onSubmit(name.trim(), code.trim().toUpperCase());
  }

  return (
    <form
      className="sup-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      noValidate
    >
      <div className={`sup-field ${err && !name.trim() ? "sup-field--error" : ""}`}>
        <label>Name</label>
        <input value={name} onChange={(e) => { setName(e.target.value); setErr(""); }} autoFocus />
      </div>
      <div className={`sup-field ${err && !code.trim() ? "sup-field--error" : ""}`}>
        <label>Code</label>
        <input value={code} onChange={(e) => { setCode(e.target.value); setErr(""); }} placeholder="e.g. HULLPROD" />
      </div>
      {dept?.source === "SYNC" && (
        <p className="sup-form__note">
          This department was auto-created by the BadgeView sync. Editing it will make it
          <strong> manually managed</strong> — future sync runs will stop overwriting it.
        </p>
      )}
      {err && <span className="field-error">{err}</span>}
      <div className="modal__footer" style={{ padding: 0, borderTop: "none" }}>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? "Saving…" : dept ? "Save Changes" : "Add Department"}
        </button>
      </div>
    </form>
  );
}
