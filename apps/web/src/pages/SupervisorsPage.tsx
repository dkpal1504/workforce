import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api/client";
import "../styles/supervisors.css";

type Department = { id: number; name: string };
type Supervisor = {
  id: number;
  name: string;
  email: string;
  role: string;
  source: "SYNC" | "MANUAL";
  idCardNo: string | null;
  departmentId: number | null;
  department: { id: number; name: string } | null;
  createdAt?: string;
};
type Pin = { idCardNo: string; createdAt: string };

type Modal =
  | { kind: "create" }
  | { kind: "edit"; sup: Supervisor }
  | { kind: "convert"; sup: Supervisor }
  | { kind: "delete"; sup: Supervisor }
  | null;

type FormErrors = Partial<Record<"name" | "email" | "password" | "idCardNo" | "departmentId", string>>;

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

export function SupervisorsPage() {
  const [supervisors, setSupervisors] = useState<Supervisor[]>([]);
  const [pins, setPins] = useState<Set<string>>(new Set());
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState<"ALL" | "SYNC" | "MANUAL">("ALL");
  const [modal, setModal] = useState<Modal>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [supRes, pinRes, deptRes] = await Promise.all([
        api<{ supervisors: Supervisor[] }>("/supervisors"),
        api<{ pins: Pin[] }>("/supervisors/pins"),
        api<{ departments: Department[] }>("/departments"),
      ]);
      setSupervisors(supRes.supervisors);
      setPins(new Set(pinRes.pins.map((p) => p.idCardNo)));
      setDepartments(deptRes.departments);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load supervisors");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return supervisors.filter((s) => {
      if (sourceFilter !== "ALL" && s.source !== sourceFilter) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        (s.idCardNo ?? "").toLowerCase().includes(q) ||
        s.email.toLowerCase().includes(q)
      );
    });
  }, [supervisors, search, sourceFilter]);

  const pinned = (s: Supervisor) => (s.idCardNo ? pins.has(s.idCardNo) : false);

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
          {supervisors.length} supervisor{supervisors.length === 1 ? "" : "s"} ·{" "}
          {[...supervisors].filter((s) => s.source === "MANUAL").length} manual ·{" "}
          {[...supervisors].filter((s) => s.source === "SYNC").length} sync
        </span>
        <div className="supervisors-actions">
          <input
            className="search-input"
            style={{ marginBottom: 0, minWidth: 180, maxWidth: 260 }}
            placeholder="Search name, ID card, email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search supervisors"
          />
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value as "ALL" | "SYNC" | "MANUAL")}
            aria-label="Filter by source"
            style={{
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
              padding: "0 11px",
              background: "var(--bg-elevated)",
              color: "var(--text)",
              minHeight: 42,
            }}
          >
            <option value="ALL">All sources</option>
            <option value="MANUAL">Manual (front-end managed)</option>
            <option value="SYNC">Sync (BadgeView)</option>
          </select>
          <button type="button" className="btn btn-primary" onClick={() => setModal({ kind: "create" })}>
            + Register Supervisor
          </button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {loading && <div className="loading-state">Loading supervisors…</div>}

      {!loading && filtered.length === 0 && (
        <div className="empty-state">
          No supervisors found. Register a manual supervisor or sync data from BadgeView to populate the list.
        </div>
      )}

      {/* Table — desktop */}
      {!loading && filtered.length > 0 && (
        <table className="sup-table">
          <thead>
            <tr>
              <th>Supervisor</th>
              <th>ID Card / Emp Code</th>
              <th>Source</th>
              <th>Department</th>
              <th>Status</th>
              <th style={{ textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((s) => (
              <tr key={s.id} className={s.source === "SYNC" ? "sup-row--readonly" : ""}>
                <td>
                  <strong>{s.name}</strong>
                  <div style={{ color: "var(--text-muted)", fontSize: 12 }}>{s.email}</div>
                </td>
                <td>{s.idCardNo ?? "—"}</td>
                <td>
                  {s.source === "MANUAL" ? (
                    <span className="badge badge--manual">Manual</span>
                  ) : (
                    <span className="badge badge--sync">Sync</span>
                  )}
                </td>
                <td>{s.department?.name ?? "—"}</td>
                <td>
                  {pinned(s) && <span className="badge badge--pin">★ Pinned</span>}
                  {s.source === "SYNC" && !pinned(s) && <span className="badge badge--sync">No login</span>}
                </td>
                <td>
                  <div className="sup-table__actions">
                    {s.source === "MANUAL" ? (
                      <>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setModal({ kind: "edit", sup: s })}>
                          Edit
                        </button>
                        <button type="button" className="btn btn-danger btn-sm" onClick={() => setModal({ kind: "delete", sup: s })}>
                          Delete
                        </button>
                      </>
                    ) : (
                      <>
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setModal({ kind: "convert", sup: s })}>
                          Convert to manual
                        </button>
                        {pinned(s) && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            disabled={busy}
                            onClick={() => run(() => api(`/supervisors/${s.idCardNo}/pin`, { method: "DELETE" }))}
                          >
                            Unpin
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Cards — tablet & mobile */}
      {!loading && filtered.length > 0 && (
        <div className="sup-list">
          {filtered.map((s) => (
            <div key={s.id} className={`sup-card ${s.source === "SYNC" ? "sup-card--readonly" : ""}`}>
              <div className={`sup-card__avatar ${s.source === "SYNC" ? "sup-card__avatar--sync" : ""}`}>
                {initials(s.name)}
              </div>
              <div className="sup-card__body">
                <div className="sup-card__top">
                  <span className="sup-card__name">{s.name}</span>
                  {s.source === "MANUAL" ? (
                    <span className="badge badge--manual">Manual</span>
                  ) : (
                    <span className="badge badge--sync">Sync</span>
                  )}
                  {pinned(s) && <span className="badge badge--pin">★ Pinned</span>}
                </div>
                <div className="sup-card__sub">
                  <span>ID: {s.idCardNo ?? "—"}</span>
                  <span>{s.email}</span>
                  <span>{s.department?.name ?? "No dept"}</span>
                </div>
                <div className="sup-card__actions">
                  {s.source === "MANUAL" ? (
                    <>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setModal({ kind: "edit", sup: s })}>
                        Edit
                      </button>
                      <button type="button" className="btn btn-danger btn-sm" onClick={() => setModal({ kind: "delete", sup: s })}>
                        Delete
                      </button>
                    </>
                  ) : (
                    <>
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setModal({ kind: "convert", sup: s })}>
                        Convert to manual
                      </button>
                      {pinned(s) && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={busy}
                          onClick={() => run(() => api(`/supervisors/${s.idCardNo}/pin`, { method: "DELETE" }))}
                        >
                          Unpin
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {modal && (
        <ModalShell
          title={
            modal.kind === "create"
              ? "Register Supervisor"
              : modal.kind === "edit"
                ? `Edit ${modal.sup.name}`
                : modal.kind === "convert"
                  ? `Convert to Manual Login`
                  : `Delete ${modal.sup.name}?`
          }
          onClose={() => setModal(null)}
        >
          {modal.kind === "create" && (
            <CreateForm
              departments={departments}
              busy={busy}
              onDone={(fn) => run(fn)}
              onCancel={() => setModal(null)}
            />
          )}
          {modal.kind === "edit" && (
            <EditForm sup={modal.sup} departments={departments} busy={busy} onDone={(fn) => run(fn)} />
          )}
          {modal.kind === "convert" && (
            <ConvertForm sup={modal.sup} departments={departments} busy={busy} onDone={(fn) => run(fn)} />
          )}
          {modal.kind === "delete" && (
            <DeleteForm
              sup={modal.sup}
              busy={busy}
              onConfirm={() =>
                run(() => api(`/supervisors/${modal.sup.id}`, { method: "DELETE" }))
              }
              onCancel={() => setModal(null)}
            />
          )}
        </ModalShell>
      )}
    </>
  );
}

function ModalShell({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <h2>{title}</h2>
          <button type="button" className="modal__close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="modal__body">{children}</div>
      </div>
    </div>
  );
}

function useFieldErrors() {
  const [errors, setErrors] = useState<FormErrors>({});
  const setError = (field: keyof FormErrors, msg?: string) =>
    setErrors((prev) => ({ ...prev, [field]: msg }));
  const validate = (
    fields: { name: string; email: string; idCardNo: string; password: string; departmentId: string }
  ) => {
    const errs: FormErrors = {};
    if (!fields.name.trim()) errs.name = "Name is required";
    if (!fields.email.trim()) errs.email = "Email is required";
    else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(fields.email.trim())) errs.email = "Enter a valid email";
    if (fields.idCardNo && !fields.idCardNo.trim()) errs.idCardNo = "ID card / employee code is required";
    if ("password" in fields && fields.password && fields.password.length < 6) {
      errs.password = "Password must be at least 6 characters";
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };
  return { errors, setError, validate };
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`sup-field ${error ? "sup-field--error" : ""}`}>
      <label>{label}</label>
      {children}
      {error && <span className="field-error">{error}</span>}
    </div>
  );
}

function CreateForm({
  departments,
  busy,
  onDone,
  onCancel,
}: {
  departments: Department[];
  busy: boolean;
  onDone: (fn: () => Promise<unknown>) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [idCardNo, setIdCardNo] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const { errors, setError, validate } = useFieldErrors();

  async function submit() {
    if (!validate({ name, email, idCardNo, password, departmentId })) return;
    await onDone(() =>
      api("/supervisors", {
        method: "POST",
        body: JSON.stringify({
          name,
          email,
          password,
          idCardNo,
          departmentId: departmentId ? Number(departmentId) : null,
        }),
      })
    );
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
      <Field label="Full name" error={errors.name}>
        <input value={name} onChange={(e) => { setName(e.target.value); setError("name"); }} autoFocus />
      </Field>
      <Field label="Email (login)" error={errors.email}>
        <input type="email" value={email} onChange={(e) => { setEmail(e.target.value); setError("email"); }} />
      </Field>
      <Field label="Password" error={errors.password}>
        <input type="password" value={password} onChange={(e) => { setPassword(e.target.value); setError("password"); }} autoComplete="new-password" />
      </Field>
      <Field label="ID card / employee code" error={errors.idCardNo}>
        <input value={idCardNo} onChange={(e) => { setIdCardNo(e.target.value); setError("idCardNo"); }} placeholder="e.g. WK-1042" />
      </Field>
      <Field label="Department">
        <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
          <option value="">— No department —</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
      </Field>
      <p className="sup-form__note">
        This creates a manual (front-end managed) login account. It is never touched by the twice-daily BadgeView sync.{" "}
        If this person already exists as a sync-managed supervisor, the save will prompt you to convert instead.
      </p>
      <div className="modal__footer" style={{ padding: 0, borderTop: "none" }}>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? "Saving…" : "Register Supervisor"}
        </button>
      </div>
    </form>
  );
}

function EditForm({
  sup,
  departments,
  busy,
  onDone,
}: {
  sup: Supervisor;
  departments: Department[];
  busy: boolean;
  onDone: (fn: () => Promise<unknown>) => void;
}) {
  const [name, setName] = useState(sup.name);
  const [email, setEmail] = useState(sup.email);
  const [password, setPassword] = useState("");
  const [departmentId, setDepartmentId] = useState(sup.departmentId ? String(sup.departmentId) : "");
  const { errors, setError, validate } = useFieldErrors();

  async function submit() {
    if (!validate({ name, email, idCardNo: sup.idCardNo ?? "", password, departmentId })) return;
    const body: Record<string, unknown> = { name, email, departmentId: departmentId ? Number(departmentId) : null };
    if (password) body.password = password;
    await onDone(() => api(`/supervisors/${sup.id}`, { method: "PUT", body: JSON.stringify(body) }));
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
      <Field label="Full name" error={errors.name}>
        <input value={name} onChange={(e) => { setName(e.target.value); setError("name"); }} autoFocus />
      </Field>
      <Field label="Email (login)" error={errors.email}>
        <input type="email" value={email} onChange={(e) => { setEmail(e.target.value); setError("email"); }} />
      </Field>
      <Field label="Password (leave blank to keep current)" error={errors.password}>
        <input type="password" value={password} onChange={(e) => { setPassword(e.target.value); setError("password"); }} autoComplete="new-password" />
      </Field>
      <Field label="Department">
        <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
          <option value="">— No department —</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
      </Field>
      <div className="modal__footer" style={{ padding: 0, borderTop: "none" }}>
        <button type="button" className="btn btn-ghost" onClick={() => onDone(() => Promise.resolve())}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? "Saving…" : "Save Changes"}
        </button>
      </div>
    </form>
  );
}

function ConvertForm({
  sup,
  departments,
  busy,
  onDone,
}: {
  sup: Supervisor;
  departments: Department[];
  busy: boolean;
  onDone: (fn: () => Promise<unknown>) => void;
}) {
  const [email, setEmail] = useState(sup.email || "");
  const [password, setPassword] = useState("");
  const [departmentId, setDepartmentId] = useState(sup.departmentId ? String(sup.departmentId) : "");
  const { errors, setError, validate } = useFieldErrors();

  async function submit() {
    if (!validate({ name: sup.name, email, idCardNo: sup.idCardNo ?? "", password, departmentId })) return;
    await onDone(() =>
      api(`/supervisors/${sup.id}/convert`, {
        method: "POST",
        body: JSON.stringify({ password, email, departmentId: departmentId ? Number(departmentId) : null }),
      })
    );
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
      <p className="sup-form__note" style={{ background: "var(--primary-soft)", color: "var(--primary-ink)", borderColor: "color-mix(in srgb, var(--primary) 28%, transparent)" }}>
        Promoting <strong>{sup.name}</strong> ({sup.idCardNo ?? "no ID"}) to a manual login account. They will be able to
        authenticate and will be pinned as a supervisor so the next sync keeps them as one.
      </p>
      <Field label="Email (login)" error={errors.email}>
        <input type="email" value={email} onChange={(e) => { setEmail(e.target.value); setError("email"); }} autoFocus />
      </Field>
      <Field label="Set password" error={errors.password}>
        <input type="password" value={password} onChange={(e) => { setPassword(e.target.value); setError("password"); }} autoComplete="new-password" />
      </Field>
      <Field label="Department">
        <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
          <option value="">— No department —</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
      </Field>
      <div className="modal__footer" style={{ padding: 0, borderTop: "none" }}>
        <button type="button" className="btn btn-ghost" onClick={() => onDone(() => Promise.resolve())}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy || !password}>
          {busy ? "Converting…" : "Convert to Manual Login"}
        </button>
      </div>
    </form>
  );
}

function DeleteForm({
  sup,
  busy,
  onConfirm,
  onCancel,
}: {
  sup: Supervisor;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <p style={{ margin: 0, lineHeight: 1.6 }}>
        This will permanently remove <strong>{sup.name}</strong> ({sup.email}) as a manual supervisor and revoke their
        login access. This action is audited. Are you sure?
      </p>
      <div className="modal__footer" style={{ padding: "16px 0 0", borderTop: "none" }}>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn btn-danger" disabled={busy} onClick={onConfirm}>
          {busy ? "Deleting…" : "Delete Supervisor"}
        </button>
      </div>
    </>
  );
}
