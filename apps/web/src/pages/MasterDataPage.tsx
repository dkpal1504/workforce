import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api/client";
import "../styles/supervisors.css";
import "./MasterDataPage.css";

/* ============================================================================
   Project / WBS / UoM / Network maintenance.

   One tab per master. Every field carries an example as help text, taken from the
   UoM master for UoM rows and from literal placeholders elsewhere, so a user can
   never guess wrong. A duplicate is reported with the server's own message, which
   names the row it collided with.

   A master row that other tables reference is DEACTIVATED, never deleted: the
   foreign keys and the frozen attribution snapshots on booked hours must survive.
   ============================================================================ */

type Tab = "project" | "wbs" | "uom" | "network";

type WbsRow = {
  id: number;
  projectId: number;
  wbsCode: string;
  name: string | null;
  sortOrder: number;
  active: boolean;
  _count?: { jobOrders: number };
};

type NetworkRow = {
  id: number;
  projectId: number;
  code: string;
  name: string | null;
  source: string;
  active: boolean;
  _count?: { jobOrders: number };
};

type ProjectRow = {
  id: number;
  code: string;
  name: string;
  colorKey: string;
  isNonProject: boolean;
  sortOrder: number;
  active: boolean;
  wbsRows: WbsRow[];
  networks: NetworkRow[];
  _count?: { jobOrders: number; timesheetEntries: number };
};

type UomRow = {
  id: number;
  code: string;
  name: string;
  example: string | null;
  active: boolean;
  helpText?: string;
  _count?: { jobOrders: number };
};

type EditorState =
  | { type: "project"; item?: ProjectRow }
  | { type: "wbs"; item?: WbsRow }
  | { type: "uom"; item?: UomRow }
  | { type: "network"; item?: NetworkRow };

/** Literal placeholder examples for the fields the UoM master cannot speak for. */
const PROJECT_CODE_EXAMPLE = "PRJ-A";
const PROJECT_NAME_EXAMPLE = "Project A";
const COLOR_KEY_EXAMPLE = "A";
const WBS_CODE_EXAMPLE = "A.HULL.0010.100";
const WBS_NAME_EXAMPLE = "Hull structure";
const UOM_CODE_EXAMPLE = "NOS";
const UOM_EXAMPLE_FALLBACK = "Count of pieces, e.g. 12 spools";
const NETWORK_CODE_EXAMPLE = "SAP-NW-91001";
const NETWORK_NAME_EXAMPLE = "Hull networks";

const TAB_LABELS: Record<Tab, string> = { project: "Project", wbs: "WBS", uom: "UoM", network: "Network" };

function errorText(e: unknown) {
  return e instanceof ApiError && e.payload && typeof e.payload === "object" && "error" in e.payload
    ? String((e.payload as { error: string }).error)
    : e instanceof Error ? e.message : "Request failed";
}

/** The on-screen help string of a UoM code, read from the UoM master itself. */
function uomExampleFor(rows: UomRow[], code: string): string {
  const target = code.trim().toUpperCase();
  const row = rows.find((candidate) => candidate.code.toUpperCase() === target);
  const example = (row?.example ?? "").trim();
  if (example) return example;
  const fallback = (rows.find((candidate) => candidate.code.toUpperCase() === UOM_CODE_EXAMPLE)?.example ?? rows[0]?.example ?? "").trim();
  return fallback || UOM_EXAMPLE_FALLBACK;
}

export function MasterDataPage() {
  const [tab, setTab] = useState<Tab>("project");
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [uom, setUom] = useState<UomRow[]>([]);
  const [projectFilter, setProjectFilter] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editor, setEditor] = useState<EditorState | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [projectData, uomData] = await Promise.all([
        api<{ projects: ProjectRow[] }>("/master-data/projects"),
        api<{ uom: UomRow[] }>("/master-data/uom"),
      ]);
      setProjects(projectData.projects);
      setUom(uomData.uom);
      setProjectFilter((current) => current || String(projectData.projects[0]?.id ?? ""));
    } catch (e) { setError(errorText(e)); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setError("");
    try { await fn(); setEditor(null); await load(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }

  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const selectedProject = projectFilter ? projectById.get(Number(projectFilter)) : undefined;

  const allWbs = useMemo(
    () => projects.flatMap((project) => project.wbsRows.map((row) => ({ ...row, project }))),
    [projects]
  );
  const allNetworks = useMemo(
    () => projects.flatMap((project) => project.networks.map((row) => ({ ...row, project }))),
    [projects]
  );

  const q = search.trim().toLowerCase();
  const matches = (...parts: Array<string | number | null | undefined>) =>
    parts.filter((part) => part != null).join(" ").toLowerCase().includes(q);

  const visibleProjects = useMemo(
    () => projects.filter((project) => matches(project.code, project.name, project.colorKey)),
    [projects, q]
  );
  const visibleWbs = useMemo(
    () => allWbs.filter((row) => String(row.projectId) === projectFilter && matches(row.wbsCode, row.name, row.project.name, row.project.code)),
    [allWbs, projectFilter, q]
  );
  const visibleUom = useMemo(() => uom.filter((row) => matches(row.code, row.name, row.example)), [uom, q]);
  const visibleNetworks = useMemo(
    () => allNetworks.filter((row) => String(row.projectId) === projectFilter && matches(row.code, row.name, row.source, row.project.name, row.project.code)),
    [allNetworks, projectFilter, q]
  );

  const needsProject = tab === "wbs" || tab === "network";
  const addLabel = tab === "wbs" ? "WBS row" : TAB_LABELS[tab];
  const counts = { project: visibleProjects.length, wbs: visibleWbs.length, uom: visibleUom.length, network: visibleNetworks.length };

  function deactivatePath(type: Tab, id: number) {
    if (type === "project") return `/master-data/projects/${id}/deactivate`;
    if (type === "wbs") return `/master-data/wbs/${id}/deactivate`;
    if (type === "uom") return `/master-data/uom/${id}/deactivate`;
    return `/master-data/networks/${id}/deactivate`;
  }

  function activatePath(type: Tab, id: number) {
    return deactivatePath(type, id).replace("/deactivate", "/activate");
  }

  return <>
    <div className="supervisors-toolbar">
      <div className="supervisors-actions" role="tablist" aria-label="Master data">
        {(Object.keys(TAB_LABELS) as Tab[]).map((candidate) => (
          <button
            key={candidate}
            type="button"
            role="tab"
            aria-selected={tab === candidate}
            className={`btn ${tab === candidate ? "btn-primary" : "btn-ghost"}`}
            onClick={() => { setTab(candidate); setSearch(""); }}
          >
            {TAB_LABELS[candidate]}
          </button>
        ))}
      </div>
      <div className="supervisors-actions">
        {needsProject && (
          <select
            aria-label="Project"
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            style={{ minWidth: 200 }}
            disabled={projects.length === 0}
          >
            {projects.length === 0 && <option value="">No project yet</option>}
            {projects.map((project) => (
              <option key={project.id} value={project.id}>{project.colorKey} · {project.code} · {project.name}</option>
            ))}
          </select>
        )}
        <input className="search-input" style={{ marginBottom: 0, minWidth: 180, maxWidth: 260 }} value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Search ${TAB_LABELS[tab].toLowerCase()}…`} />
        <button
          type="button"
          className="btn btn-primary"
          disabled={needsProject && !selectedProject}
          title={needsProject && !selectedProject ? "Select a project first" : undefined}
          onClick={() => setEditor({ type: tab })}
        >
          + Add {addLabel}
        </button>
      </div>
    </div>

    <p className="muted" style={{ marginTop: 0 }}>
      {tab === "project" && `A project is the commercial container. Its colour key is the short token shown on Timesheet Entry, unique across all projects (example: ${COLOR_KEY_EXAMPLE}). A WBS row and its Networks live inside it.`}
      {tab === "wbs" && `A WBS row groups Job Orders inside one project. The WBS number (example: ${WBS_CODE_EXAMPLE}) is unique inside the project, not globally.`}
      {tab === "uom" && "Unit of measure, with the example string that is shown as help text wherever a quantity is entered."}
      {tab === "network" && `A Network is scoped to one project. Codes are maintained by hand (example: ${NETWORK_CODE_EXAMPLE}); SAP-fed networks arrive from the ERP feed and are read-only here.`}
    </p>

    {error && !editor && <div className="error-banner" role="alert">{error}</div>}
    {loading ? <div className="loading-state">Loading master data…</div> : counts[tab] === 0 ? (
      <div className="empty-state">
        {needsProject && !selectedProject ? "Select a project to see its rows." : `No ${addLabel.toLowerCase()} rows found.`}
      </div>
    ) : (
      <table className="sup-table">
        <thead>
          {tab === "project" && <tr><th>Colour key</th><th>Project</th><th>WBS / Networks</th><th>Job Orders</th><th>Status</th><th style={{ textAlign: "right" }}>Actions</th></tr>}
          {tab === "wbs" && <tr><th>WBS number</th><th>Project</th><th>Job Orders</th><th>Status</th><th style={{ textAlign: "right" }}>Actions</th></tr>}
          {tab === "uom" && <tr><th>Code</th><th>Name</th><th>Example (on-screen help)</th><th>Job Orders</th><th>Status</th><th style={{ textAlign: "right" }}>Actions</th></tr>}
          {tab === "network" && <tr><th>Network code</th><th>Project</th><th>Source</th><th>Job Orders</th><th>Status</th><th style={{ textAlign: "right" }}>Actions</th></tr>}
        </thead>
        <tbody>
          {tab === "project" && visibleProjects.map((row) => (
            <tr key={row.id}>
              <td><span className="badge badge--manual md-color-key">{row.colorKey}</span></td>
              <td><strong>{row.code}</strong><div className="muted">{row.name}{row.isNonProject ? " · standing / non-project row" : ""}</div></td>
              <td>{row.wbsRows.length} WBS · {row.networks.length} network{row.networks.length === 1 ? "" : "s"}</td>
              <td>{row._count?.jobOrders ?? 0}</td>
              <td>{row.active ? "Active" : "Inactive"}</td>
              <td><Actions busy={busy} active={row.active} onEdit={() => setEditor({ type: "project", item: row })} onToggle={() => run(() => api(deactivatePath("project", row.id), { method: "POST" }))} onActivate={() => run(() => api(activatePath("project", row.id), { method: "POST" }))} /></td>
            </tr>
          ))}
          {tab === "wbs" && visibleWbs.map((row) => (
            <tr key={row.id}>
              <td><strong>{row.wbsCode}</strong>{row.name && <div className="muted">{row.name}</div>}</td>
              <td>{row.project.code} · {row.project.name}</td>
              <td>{row._count?.jobOrders ?? 0}</td>
              <td>{row.active ? "Active" : "Inactive"}</td>
              <td><Actions busy={busy} active={row.active} onEdit={() => setEditor({ type: "wbs", item: row })} onToggle={() => run(() => api(deactivatePath("wbs", row.id), { method: "POST" }))} onActivate={() => run(() => api(activatePath("wbs", row.id), { method: "POST" }))} /></td>
            </tr>
          ))}
          {tab === "uom" && visibleUom.map((row) => (
            <tr key={row.id}>
              <td><strong>{row.code}</strong></td>
              <td>{row.name}</td>
              <td>{row.example ?? <span className="muted">No example yet</span>}</td>
              <td>{row._count?.jobOrders ?? 0}</td>
              <td>{row.active ? "Active" : "Inactive"}</td>
              <td><Actions busy={busy} active={row.active} onEdit={() => setEditor({ type: "uom", item: row })} onToggle={() => run(() => api(deactivatePath("uom", row.id), { method: "POST" }))} onActivate={() => run(() => api(activatePath("uom", row.id), { method: "POST" }))} /></td>
            </tr>
          ))}
          {tab === "network" && visibleNetworks.map((row) => (
            <tr key={row.id}>
              <td><strong>{row.code}</strong>{row.name && <div className="muted">{row.name}</div>}</td>
              <td>{row.project.code} · {row.project.name}</td>
              <td><span className={`badge badge--${row.source === "SAP" ? "sync" : "manual"}`}>{row.source === "SAP" ? "SAP feed" : "Manual"}</span></td>
              <td>{row._count?.jobOrders ?? 0}</td>
              <td>{row.active ? "Active" : "Inactive"}</td>
              <td><Actions busy={busy} active={row.active} onEdit={() => setEditor({ type: "network", item: row })} onToggle={() => run(() => api(deactivatePath("network", row.id), { method: "POST" }))} onActivate={() => run(() => api(activatePath("network", row.id), { method: "POST" }))} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    )}

    {editor && (
      <MasterModal
        editor={editor}
        projects={projects}
        uom={uom}
        projectFilter={projectFilter}
        busy={busy}
        error={error}
        onClose={() => { setEditor(null); setError(""); }}
        onSave={(path, method, body) => run(() => api(path, { method, body: JSON.stringify(body) }))}
      />
    )}
  </>;
}

function Actions({ active, busy, onEdit, onToggle, onActivate }: { active: boolean; busy: boolean; onEdit: () => void; onToggle: () => void; onActivate: () => void }) {
  return (
    <div className="sup-table__actions">
      <button type="button" className="btn btn-ghost btn-sm" onClick={onEdit}>Edit</button>
      {active ? (
        <button
          type="button"
          disabled={busy}
          className="btn btn-danger btn-sm"
          title="Deactivated rows stay in history but disappear from the pickers. A referenced row is never deleted."
          onClick={() => window.confirm("Deactivate this master row? It stays in history and disappears from the pickers.") && onToggle()}
        >
          Deactivate
        </button>
      ) : (
        <button type="button" disabled={busy} className="btn btn-secondary btn-sm" onClick={onActivate}>Activate</button>
      )}
    </div>
  );
}

function Field({ label, help, children }: { label: string; help: string; children: React.ReactNode }) {
  return (
    <div className="sup-field">
      <label>{label}</label>
      {children}
      <p className="md-help">{help}</p>
    </div>
  );
}

function Modal({ title, busy, error, onClose, onSubmit, children }: { title: string; busy: boolean; error: string; onClose: () => void; onSubmit: () => void; children: React.ReactNode }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <h2>{title}</h2>
          <button type="button" className="modal__close" onClick={onClose}>×</button>
        </div>
        <form className="modal__body sup-form" onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
          {error && <div className="error-banner" role="alert">{error}</div>}
          {children}
          <div className="modal__footer" style={{ padding: 0, borderTop: "none" }}>
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function MasterModal({ editor, projects, uom, projectFilter, busy, error, onClose, onSave }: {
  editor: EditorState;
  projects: ProjectRow[];
  uom: UomRow[];
  projectFilter: string;
  busy: boolean;
  error: string;
  onClose: () => void;
  onSave: (path: string, method: "POST" | "PUT", body: Record<string, unknown>) => void;
}) {
  if (editor.type === "project") return <ProjectForm item={editor.item} busy={busy} error={error} onClose={onClose} onSave={onSave} />;
  if (editor.type === "uom") return <UomForm item={editor.item} uom={uom} busy={busy} error={error} onClose={onClose} onSave={onSave} />;

  const parent = editor.item ? projects.find((project) => project.id === editor.item!.projectId) : projects.find((project) => String(project.id) === projectFilter);
  if (!parent) {
    return (
      <Modal title={`Add ${editor.type === "wbs" ? "WBS row" : "Network"}`} busy={busy} error={error} onClose={onClose} onSubmit={onClose}>
        <p className="sup-form__note">Select a project first. A {editor.type === "wbs" ? "WBS row" : "Network"} always belongs to one project.</p>
      </Modal>
    );
  }
  return editor.type === "wbs"
    ? <WbsForm item={editor.item} project={parent} busy={busy} error={error} onClose={onClose} onSave={onSave} />
    : <NetworkForm item={editor.item} project={parent} busy={busy} error={error} onClose={onClose} onSave={onSave} />;
}

type SaveFn = (path: string, method: "POST" | "PUT", body: Record<string, unknown>) => void;

function ProjectForm({ item, busy, error, onClose, onSave }: { item?: ProjectRow; busy: boolean; error: string; onClose: () => void; onSave: SaveFn }) {
  const [code, setCode] = useState(item?.code ?? "");
  const [name, setName] = useState(item?.name ?? "");
  const [colorKey, setColorKey] = useState(item?.colorKey ?? "");
  const [isNonProject, setIsNonProject] = useState(item?.isNonProject ?? false);
  const [sortOrder, setSortOrder] = useState(String(item?.sortOrder ?? ""));
  return (
    <Modal title={item ? "Edit Project" : "Add Project"} busy={busy} error={error} onClose={onClose} onSubmit={() => onSave(item ? `/master-data/projects/${item.id}` : "/master-data/projects", item ? "PUT" : "POST", { code, name, colorKey, isNonProject, sortOrder })}>
      <Field label="Project code (ERP project number)" help={`Unique across all projects. Example: ${PROJECT_CODE_EXAMPLE}`}>
        <input required autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder={PROJECT_CODE_EXAMPLE} />
      </Field>
      <Field label="Project name" help={`Required. Example: ${PROJECT_NAME_EXAMPLE}`}>
        <input required value={name} onChange={(e) => setName(e.target.value)} placeholder={PROJECT_NAME_EXAMPLE} />
      </Field>
      <Field label="Colour key (display token)" help={`1-4 uppercase characters or digits, unique across all projects. Example: ${COLOR_KEY_EXAMPLE} shows as "A" on Timesheet Entry.`}>
        <input required maxLength={4} value={colorKey} onChange={(e) => setColorKey(e.target.value)} placeholder={COLOR_KEY_EXAMPLE} />
      </Field>
      <Field label="Sort order" help="Optional. Lower numbers come first in the pickers. Example: 1">
        <input inputMode="numeric" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} placeholder="1" />
      </Field>
      <div className="sup-field">
        <label className="md-check">
          <input type="checkbox" checked={isNonProject} onChange={(e) => setIsNonProject(e.target.checked)} />
          <span>Standing / non-project row</span>
        </label>
        <p className="md-help">Tick this only for the single row that holds standing and idle-hours Job Orders. Reports include or exclude that row by this flag.</p>
      </div>
    </Modal>
  );
}

function WbsForm({ item, project, busy, error, onClose, onSave }: { item?: WbsRow; project: ProjectRow; busy: boolean; error: string; onClose: () => void; onSave: SaveFn }) {
  const [wbsCode, setWbsCode] = useState(item?.wbsCode ?? "");
  const [name, setName] = useState(item?.name ?? "");
  const [sortOrder, setSortOrder] = useState(String(item?.sortOrder ?? ""));
  return (
    <Modal title={item ? "Edit WBS row" : "Add WBS row"} busy={busy} error={error} onClose={onClose} onSubmit={() => onSave(item ? `/master-data/wbs/${item.id}` : `/master-data/projects/${project.id}/wbs`, item ? "PUT" : "POST", { wbsCode, name, sortOrder })}>
      <div className="sup-field">
        <label>Project</label>
        <p className="md-readonly">{project.colorKey} · {project.code} · {project.name}</p>
        <p className="md-help">A WBS row belongs to one project and cannot be moved to another.</p>
      </div>
      <Field label="WBS number" help={`Unique inside ${project.code} only, the same number may exist in another project. Example: ${WBS_CODE_EXAMPLE}`}>
        <input required autoFocus value={wbsCode} onChange={(e) => setWbsCode(e.target.value)} placeholder={WBS_CODE_EXAMPLE} />
      </Field>
      <Field label="WBS name" help={`Optional short description. Example: ${WBS_NAME_EXAMPLE}`}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={WBS_NAME_EXAMPLE} />
      </Field>
      <Field label="Sort order" help="Optional. Lower numbers come first inside the project. Example: 1">
        <input inputMode="numeric" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} placeholder="1" />
      </Field>
    </Modal>
  );
}

function UomForm({ item, uom, busy, error, onClose, onSave }: { item?: UomRow; uom: UomRow[]; busy: boolean; error: string; onClose: () => void; onSave: SaveFn }) {
  const [code, setCode] = useState(item?.code ?? "");
  const [name, setName] = useState(item?.name ?? "");
  const [example, setExample] = useState(item?.example ?? "");
  const masterExample = uomExampleFor(uom, code || item?.code || UOM_CODE_EXAMPLE);
  return (
    <Modal title={item ? "Edit UoM" : "Add UoM"} busy={busy} error={error} onClose={onClose} onSubmit={() => onSave(item ? `/master-data/uom/${item.id}` : "/master-data/uom", item ? "PUT" : "POST", { code, name, example })}>
      <Field label="UoM code" help={`Stored uppercase and unique across all units. Example: ${(code || UOM_CODE_EXAMPLE).toUpperCase()} — ${masterExample}`}>
        <input required autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder={UOM_CODE_EXAMPLE} />
      </Field>
      <Field label="UoM name" help={`Required. Example: ${code.toUpperCase() === "NOS" || !code ? "Numbers" : name || "Numbers"} — ${masterExample}`}>
        <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Numbers" />
      </Field>
      <Field label="Example (shown as help text)" help={`This exact string is shown to the user beside the quantity field. Example: ${masterExample}`}>
        <input value={example} onChange={(e) => setExample(e.target.value)} placeholder={masterExample} />
      </Field>
    </Modal>
  );
}

function NetworkForm({ item, project, busy, error, onClose, onSave }: { item?: NetworkRow; project: ProjectRow; busy: boolean; error: string; onClose: () => void; onSave: SaveFn }) {
  const [code, setCode] = useState(item?.code ?? "");
  const [name, setName] = useState(item?.name ?? "");
  return (
    <Modal title={item ? "Edit Network" : "Add Network"} busy={busy} error={error} onClose={onClose} onSubmit={() => onSave(item ? `/master-data/networks/${item.id}` : `/master-data/projects/${project.id}/networks`, item ? "PUT" : "POST", { code, name })}>
      <div className="sup-field">
        <label>Project</label>
        <p className="md-readonly">{project.colorKey} · {project.code} · {project.name}</p>
        <p className="md-help">A Network is scoped to one project. The same code may exist in another project.</p>
      </div>
      <Field label="Network code" help={`Unique inside ${project.code}. Example: ${NETWORK_CODE_EXAMPLE}`}>
        <input required autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder={NETWORK_CODE_EXAMPLE} />
      </Field>
      <Field label="Network name" help={`Optional description. Example: ${NETWORK_NAME_EXAMPLE}`}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={NETWORK_NAME_EXAMPLE} />
      </Field>
      <div className="sup-field">
        <label>Source</label>
        <p className="md-readonly">{item?.source === "SAP" ? "SAP feed (read-only)" : "Manual (MANUAL)"}</p>
        <p className="md-help">Rows added here are always MANUAL. SAP-fed networks arrive from the ERP feed and are never rewritten by this screen.</p>
      </div>
    </Modal>
  );
}
