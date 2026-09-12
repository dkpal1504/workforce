import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api/client";
import "../styles/supervisors.css";

type Department = { id: number; name: string; code: string; source?: string | null; active?: boolean };
type Section = { id: number; departmentId: number; code: string; name: string; source?: string; active?: boolean; department?: Department; costCenter?: CostCenter | null };
type CostCenter = { id: number; sectionId: number; code: string; name: string; active?: boolean; section?: Section };
type JobOrder = { id: number; code: string; name: string; departmentId: number | null; department?: Department | null; project?: { name: string } };
type Tab = "departments" | "sections" | "cost-centers" | "job-orders";

const inputStyle = { marginBottom: 0, minWidth: 180, maxWidth: 260 };

function errorText(e: unknown) {
  return e instanceof ApiError && e.payload && typeof e.payload === "object" && "error" in e.payload
    ? String((e.payload as { error: string }).error)
    : e instanceof Error ? e.message : "Request failed";
}

export function DepartmentsPage() {
  const [tab, setTab] = useState<Tab>("departments");
  const [departments, setDepartments] = useState<Department[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [costCenters, setCostCenters] = useState<CostCenter[]>([]);
  const [jobOrders, setJobOrders] = useState<JobOrder[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editor, setEditor] = useState<{ type: "department" | "section" | "cost-center"; item?: Department | Section | CostCenter } | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [d, s, c, j] = await Promise.all([
        api<{ departments: Department[] }>("/admin/departments"),
        api<{ sections: Section[] }>("/admin/sections"),
        api<{ costCenters: CostCenter[] }>("/admin/cost-centers"),
        api<{ jobOrders: JobOrder[] }>("/admin/job-orders"),
      ]);
      setDepartments(d.departments); setSections(s.sections); setCostCenters(c.costCenters); setJobOrders(j.jobOrders);
    } catch (e) { setError(errorText(e)); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setError("");
    try { await fn(); setEditor(null); await load(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }

  const q = search.trim().toLowerCase();
  const visible = useMemo(() => {
    const text = (parts: unknown[]) => parts.filter(Boolean).join(" ").toLowerCase().includes(q);
    if (tab === "departments") return departments.filter(x => text([x.code, x.name]));
    if (tab === "sections") return sections.filter(x => text([x.code, x.name, x.department?.name]));
    if (tab === "cost-centers") return costCenters.filter(x => text([x.code, x.name, x.section?.name, x.section?.department?.name]));
    return jobOrders.filter(x => text([x.code, x.name, x.project?.name, x.department?.name]));
  }, [tab, q, departments, sections, costCenters, jobOrders]);

  const labels: Record<Tab, string> = { departments: "Departments", sections: "Sections", "cost-centers": "Cost Centers", "job-orders": "Job Order Mapping" };
  return <>
    <div className="supervisors-toolbar">
      <div className="supervisors-actions" role="tablist" aria-label="Organisation masters">
        {(Object.keys(labels) as Tab[]).map(t => <button key={t} type="button" role="tab" aria-selected={tab === t} className={`btn ${tab === t ? "btn-primary" : "btn-ghost"}`} onClick={() => { setTab(t); setSearch(""); }}>{labels[t]}</button>)}
      </div>
      <div className="supervisors-actions">
        <input className="search-input" style={inputStyle} value={search} onChange={e => setSearch(e.target.value)} placeholder={`Search ${labels[tab].toLowerCase()}…`} />
        {tab !== "job-orders" && <button type="button" className="btn btn-primary" onClick={() => setEditor({ type: tab === "departments" ? "department" : tab === "sections" ? "section" : "cost-center" })}>+ Add {tab === "cost-centers" ? "Cost Center" : labels[tab].slice(0, -1)}</button>}
      </div>
    </div>
    <p className="muted" style={{ marginTop: 0 }}>Organisation path: Department → Section → Cost Center. Each section has at most one cost center. Job Orders can be remapped to a department.</p>
    {error && <div className="error-banner">{error}</div>}
    {loading ? <div className="loading-state">Loading organisation masters…</div> : visible.length === 0 ? <div className="empty-state">No {labels[tab].toLowerCase()} found.</div> :
      <table className="sup-table"><thead><tr>
        {tab !== "departments" && <th>{tab === "job-orders" ? "Job Order" : tab === "sections" ? "Section" : "Cost Center"}</th>}
        {tab === "departments" && <><th>Department</th><th>Code</th><th>Source</th></>}
        {tab === "sections" && <><th>Department</th><th>Cost Center</th><th>Status</th></>}
        {tab === "cost-centers" && <><th>Section</th><th>Department</th><th>Status</th></>}
        {tab === "job-orders" && <><th>Project</th><th>Mapped Department</th></>}
        <th style={{ textAlign: "right" }}>Actions</th>
      </tr></thead><tbody>
        {tab === "departments" && (visible as Department[]).map(x => <tr key={x.id}><td><strong>{x.name}</strong></td><td>{x.code}</td><td><span className={`badge badge--${x.source === "SYNC" ? "sync" : "manual"}`}>{x.source === "SYNC" ? "Sync" : "Manual"}</span></td><td><Actions onEdit={() => setEditor({ type: "department", item: x })} /></td></tr>)}
        {tab === "sections" && (visible as Section[]).map(x => <tr key={x.id}><td><strong>{x.code}</strong><div className="muted">{x.name}</div></td><td>{x.department?.name ?? departments.find(d => d.id === x.departmentId)?.name ?? "—"}</td><td>{x.costCenter ? `${x.costCenter.code} · ${x.costCenter.name}` : "Not mapped"}</td><td>{x.active === false ? "Inactive" : "Active"}</td><td><Actions onEdit={() => setEditor({ type: "section", item: x })} onDelete={() => run(() => api(`/admin/sections/${x.id}`, { method: "DELETE" }))} busy={busy} /></td></tr>)}
        {tab === "cost-centers" && (visible as CostCenter[]).map(x => <tr key={x.id}><td><strong>{x.code}</strong><div className="muted">{x.name}</div></td><td>{x.section?.name ?? sections.find(s => s.id === x.sectionId)?.name ?? "—"}</td><td>{x.section?.department?.name ?? departments.find(d => d.id === sections.find(s => s.id === x.sectionId)?.departmentId)?.name ?? "—"}</td><td>{x.active === false ? "Inactive" : "Active"}</td><td><Actions onEdit={() => setEditor({ type: "cost-center", item: x })} onDelete={() => run(() => api(`/admin/cost-centers/${x.id}`, { method: "DELETE" }))} busy={busy} /></td></tr>)}
        {tab === "job-orders" && (visible as JobOrder[]).map(x => <tr key={x.id}><td><strong>{x.code}</strong><div className="muted">{x.name}</div></td><td>{x.project?.name ?? "—"}</td><td><select aria-label={`Department for ${x.code}`} disabled={busy} value={x.departmentId ?? ""} onChange={e => run(() => api(`/admin/job-orders/${x.id}/remap`, { method: "PUT", body: JSON.stringify({ departmentId: e.target.value ? Number(e.target.value) : null }) }))}><option value="">— Select combined Department —</option>{departments.filter(d => d.active !== false && d.name.includes(" - ")).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></td><td><span className={x.department?.name.includes(" - ") ? "muted" : "badge badge--sync"}>{x.department?.name.includes(" - ") ? "Mapped" : "Needs remap"}</span></td></tr>)}
      </tbody></table>}
    {editor && <MasterModal type={editor.type} item={editor.item} departments={departments} sections={sections} busy={busy} onClose={() => setEditor(null)} onSave={(body) => { const id = editor.item?.id; const path = editor.type === "department" ? "/admin/departments" : editor.type === "section" ? "/admin/sections" : "/admin/cost-centers"; return run(() => api(id ? `${path}/${id}` : path, { method: id ? "PUT" : "POST", body: JSON.stringify(body) })); }} />}
  </>;
}

function Actions({ onEdit, onDelete, busy }: { onEdit: () => void; onDelete?: () => void; busy?: boolean }) {
  return <div className="sup-table__actions"><button type="button" className="btn btn-ghost btn-sm" onClick={onEdit}>Edit</button>{onDelete && <button type="button" disabled={busy} className="btn btn-danger btn-sm" onClick={() => window.confirm("Deactivate this master record?") && onDelete()}>Deactivate</button>}</div>;
}

function MasterModal({ type, item, departments, sections, busy, onClose, onSave }: { type: "department" | "section" | "cost-center"; item?: Department | Section | CostCenter; departments: Department[]; sections: Section[]; busy: boolean; onClose: () => void; onSave: (body: Record<string, unknown>) => void }) {
  const [name, setName] = useState(item?.name ?? ""); const [code, setCode] = useState(item?.code ?? "");
  const [departmentId, setDepartmentId] = useState(type === "section" && item ? String((item as Section).departmentId) : "");
  const [sectionId, setSectionId] = useState(type === "cost-center" && item ? String((item as CostCenter).sectionId) : "");
  const title = `${item ? "Edit" : "Add"} ${type === "cost-center" ? "Cost Center" : type[0].toUpperCase() + type.slice(1)}`;
  return <div className="modal-backdrop" onClick={onClose}><div className="modal" onClick={e => e.stopPropagation()}><div className="modal__header"><h2>{title}</h2><button type="button" className="modal__close" onClick={onClose}>×</button></div><form className="modal__body sup-form" onSubmit={e => { e.preventDefault(); if (!name.trim() || !code.trim()) return; onSave({ name: name.trim(), code: code.trim().toUpperCase(), ...(type === "section" ? { departmentId: Number(departmentId) } : {}), ...(type === "cost-center" ? { sectionId: Number(sectionId) } : {}) }); }}>
    <div className="sup-field"><label>Code</label><input required value={code} onChange={e => setCode(e.target.value)} autoFocus /></div>
    <div className="sup-field"><label>Name</label><input required value={name} onChange={e => setName(e.target.value)} /></div>
    {type === "section" && <div className="sup-field"><label>Department</label><select required value={departmentId} onChange={e => setDepartmentId(e.target.value)}><option value="">Select department</option>{departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></div>}
    {type === "cost-center" && <div className="sup-field"><label>Section (one cost center per section)</label><select required value={sectionId} onChange={e => setSectionId(e.target.value)}><option value="">Select section</option>{sections.map(s => <option key={s.id} value={s.id}>{s.department?.name ?? departments.find(d => d.id === s.departmentId)?.name} · {s.name}</option>)}</select></div>}
    <div className="modal__footer" style={{ padding: 0, borderTop: "none" }}><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Saving…" : "Save"}</button></div>
  </form></div></div>;
}
