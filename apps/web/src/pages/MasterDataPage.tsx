import { cloneElement, isValidElement, useCallback, useEffect, useId, useMemo, useState } from "react";
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

type Tab = "project" | "wbs" | "uom" | "network" | "joborder";

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

/** A Job Order row for the mapping tab: its WBS and Network can be corrected here. */
type JobOrderRow = {
  id: number;
  code: string;
  name: string;
  status: string;
  project: (ProjectRow & { wbsRows: WbsRow[]; networks: NetworkRow[] }) | null;
  projectWbs: { id: number; wbsCode: string; name?: string | null } | null;
  network: { id: number; code: string } | null;
  uom: { id: number; code: string } | null;
  section: { id: number; name: string } | null;
  department: { id: number; name: string } | null;
  _count?: { timesheetEntries: number; employeeAllocations: number };
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
  | { type: "network"; item?: NetworkRow }
  | { type: "joborder"; item: JobOrderRow };

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

const TAB_LABELS: Record<Tab, string> = { project: "Project", wbs: "WBS", uom: "UoM", network: "Network", joborder: "Job Order" };

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
  const [jobOrders, setJobOrders] = useState<JobOrderRow[]>([]);
  const [projectFilter, setProjectFilter] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editor, setEditor] = useState<EditorState | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [projectData, uomData, jobOrderData] = await Promise.all([
        api<{ projects: ProjectRow[] }>("/master-data/projects"),
        api<{ uom: UomRow[] }>("/master-data/uom"),
        // The mapping tab lists every Job Order; the project selector filters it.
        api<{ jobOrders: JobOrderRow[] }>("/master-data/job-orders").catch(() => ({ jobOrders: [] as JobOrderRow[] })),
      ]);
      setProjects(projectData.projects);
      setUom(uomData.uom);
      setJobOrders(jobOrderData.jobOrders);
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

  const visibleJobOrders = useMemo(
    () => jobOrders.filter((row) => (!projectFilter || String(row.project?.id) === projectFilter) &&
      matches(row.code, row.name, row.project?.code, row.project?.name, row.projectWbs?.wbsCode, row.network?.code)),
    [jobOrders, projectFilter, q]
  );

  // A WBS row and a Network live inside a project, so those tabs need one selected.
  const needsProject = tab === "wbs" || tab === "network" || tab === "joborder";
  // A Job Order is created by the CSV upload, never here.
  const creatable = tab !== "joborder";
  const addLabel = tab === "wbs" ? "WBS row" : TAB_LABELS[tab];
  const counts = {
    project: visibleProjects.length,
    wbs: visibleWbs.length,
    uom: visibleUom.length,
    network: visibleNetworks.length,
    joborder: visibleJobOrders.length,
  };

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
        {creatable ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={needsProject && !selectedProject}
            title={needsProject && !selectedProject ? "Select a project first" : undefined}
            onClick={() => setEditor({ type: tab })}
          >
            + Add {addLabel}
          </button>
        ) : (
          <a className="btn btn-ghost" href="/job-order-upload">Job Orders are created by CSV upload →</a>
        )}
      </div>
    </div>

    <p className="muted" style={{ marginTop: 0 }}>
      {tab === "project" && `A project is the commercial container. Its colour key is the short token shown on Timesheet Entry, unique across all projects (example: ${COLOR_KEY_EXAMPLE}). A WBS row and its Networks live inside it.`}
      {tab === "wbs" && `A WBS row groups Job Orders inside one project. The WBS number (example: ${WBS_CODE_EXAMPLE}) is unique inside the project, not globally.`}
      {tab === "uom" && "Unit of measure, with the example string that is shown as help text wherever a quantity is entered."}
      {tab === "network" && `A Network is scoped to one project. Codes are maintained by hand (example: ${NETWORK_CODE_EXAMPLE}); SAP-fed networks arrive from the ERP feed and are read-only here.`}
      {tab === "joborder" && "Job Orders come from the CSV upload, which never updates an existing row. Use Edit on a row to correct its WBS or Network. A WBS may not change once hours are booked, because every booked row keeps the attribution it was given. The Project itself is changed by an Admin from the Job Order Mapping screen."}
    </p>

    {error && !editor && <div className="error-banner" role="alert">{error}</div>}
    {loading ? <div className="loading-state">Loading master data…</div> : counts[tab] === 0 ? (
      <div className="empty-state">
        {needsProject && !selectedProject ? "Select a project to see its rows." : tab === "joborder" ? "No Job Order matches this filter." : `No ${addLabel.toLowerCase()} rows found.`}
      </div>
    ) : (
      <table className="sup-table">
        <thead>
          {tab === "project" && <tr><th>Colour key</th><th>Project</th><th>WBS / Networks</th><th>Job Orders</th><th>Status</th><th style={{ textAlign: "right" }}>Actions</th></tr>}
          {tab === "wbs" && <tr><th>WBS number</th><th>Project</th><th>Job Orders</th><th>Status</th><th style={{ textAlign: "right" }}>Actions</th></tr>}
          {tab === "uom" && <tr><th>Code</th><th>Name</th><th>Example (on-screen help)</th><th>Job Orders</th><th>Status</th><th style={{ textAlign: "right" }}>Actions</th></tr>}
          {tab === "network" && <tr><th>Network code</th><th>Project</th><th>Source</th><th>Job Orders</th><th>Status</th><th style={{ textAlign: "right" }}>Actions</th></tr>}
          {tab === "joborder" && <tr><th>Job Order</th><th>Project</th><th>WBS</th><th>Network</th><th>Booked hours</th><th>Status</th><th style={{ textAlign: "right" }}>Actions</th></tr>}
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
          {tab === "joborder" && visibleJobOrders.map((row) => {
            const booked = (row._count?.timesheetEntries ?? 0) + (row._count?.employeeAllocations ?? 0);
            return (
              <tr key={row.id}>
                <td><strong>{row.code}</strong><div className="muted">{row.name}</div></td>
                <td>{row.project ? <><span className="badge badge--manual md-color-key">{row.project.colorKey}</span> {row.project.code}</> : "—"}</td>
                <td>{row.projectWbs?.wbsCode ?? "—"}</td>
                <td>{row.network?.code ?? "—"}</td>
                <td>{booked === 0 ? <span className="muted">None</span> : booked}</td>
                <td><span className={`badge badge--${row.status === "active" ? "manual" : "sync"}`}>{row.status === "active" ? "Active" : "In-Active"}</span></td>
                <td>
                  <div className="sup-table__actions">
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditor({ type: "joborder", item: row })}>Edit WBS / Network</button>
                  </div>
                </td>
              </tr>
            );
          })}
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

/**
 * A labelled field. The label is tied to the control by id, so clicking the label
 * focuses the input and a screen reader can announce it. Without that the fields were
 * only visually labelled, and the example help text was the only cue.
 */
function Field({ label, help, children }: { label: string; help: string; children: React.ReactNode }) {
  const id = useId();
  const control = isValidElement(children)
    ? cloneElement(children as React.ReactElement<{ id?: string }>, { id })
    : children;
  return (
    <div className="sup-field">
      <label htmlFor={id}>{label}</label>
      {control}
      <p className="md-help">{help}</p>
    </div>
  );
}

function Modal({ title, busy, error, onClose, onSubmit, submitDisabled, submitTitle, children }: { title: string; busy: boolean; error: string; onClose: () => void; onSubmit: () => void; submitDisabled?: boolean; submitTitle?: string; children: React.ReactNode }) {
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
            <button type="submit" className="btn btn-primary" disabled={busy || submitDisabled} title={submitDisabled ? submitTitle : undefined}>
              {busy ? "Saving…" : "Save"}
            </button>
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
  if (editor.type === "joborder") return <JobOrderForm item={editor.item} projects={projects} busy={busy} error={error} onClose={onClose} onSave={onSave} />;

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

/**
 * Correct an existing Job Order's WBS row and Network.
 *
 * The CSV upload creates a Job Order and then skips it, so a wrong WBS or Network had
 * no path to correction. The Project stays fixed: an uploaded Job Order is keyed on its
 * Project and its number. A WBS may not change once hours are booked, because each
 * booked row keeps the attribution it was given (the server refuses it too).
 */
function JobOrderForm({ item, projects, busy, error, onClose, onSave }: { item: JobOrderRow; projects: ProjectRow[]; busy: boolean; error: string; onClose: () => void; onSave: SaveFn }) {
  // Take the options from the LIVE project list, not from the row's own copy: a WBS row
  // or Network added on the other tabs a moment ago must be selectable straight away.
  const liveProject = projects.find((project) => project.id === item.project?.id) ?? item.project;
  const wbsOptions = liveProject?.wbsRows ?? [];
  const networkOptions = liveProject?.networks ?? [];
  const booked = (item._count?.timesheetEntries ?? 0) + (item._count?.employeeAllocations ?? 0);
  const [projectWbsId, setProjectWbsId] = useState(String(item.projectWbs?.id ?? ""));
  const [networkId, setNetworkId] = useState(String(item.network?.id ?? ""));
  const wbsChanged = projectWbsId !== String(item.projectWbs?.id ?? "");
  const wbsLocked = wbsChanged && booked > 0;

  return (
    <Modal
      title={`Edit ${item.code} — WBS and Network`}
      busy={busy}
      error={error}
      onClose={onClose}
      submitDisabled={wbsLocked}
      submitTitle="This Job Order already has booked hours, so its WBS cannot change."
      onSubmit={() => onSave(`/master-data/job-orders/${item.id}/mapping`, "PUT", {
        projectWbsId: Number(projectWbsId),
        networkId: Number(networkId),
      })}
    >
      <div className="sup-field">
        <p className="md-readonly">{item.code} · {item.name}</p>
        <p className="md-help">
          {item.project ? `${item.project.colorKey} · ${item.project.code} · ${item.project.name}. ` : ""}
          The Project is fixed, because an uploaded Job Order is identified by its Project and its number.
        </p>
      </div>
      <Field
        label="WBS number"
        help={wbsLocked
          ? `This Job Order already has ${booked} booked row(s), so its WBS cannot change. Deactivate it and raise a new Job Order if the work really moved.`
          : `Only the WBS rows of ${item.project?.code ?? "this project"} are listed. Example: ${WBS_CODE_EXAMPLE}`}
      >
        <select value={projectWbsId} onChange={(e) => setProjectWbsId(e.target.value)} required>
          {wbsOptions.map((row) => (
            <option key={row.id} value={row.id}>
              {row.wbsCode}{row.name ? ` · ${row.name}` : ""}{row.active ? "" : " (inactive)"}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Network" help={`Only the Networks of ${item.project?.code ?? "this project"} are listed. A Network is informational, so it can be corrected at any time.`}>
        <select value={networkId} onChange={(e) => setNetworkId(e.target.value)} required>
          {networkOptions.map((row) => (
            <option key={row.id} value={row.id}>
              {row.code}{row.name ? ` · ${row.name}` : ""}{row.active ? "" : " (inactive)"}
            </option>
          ))}
        </select>
      </Field>
      {wbsOptions.length === 0 && (
        <p className="md-help">This project has no WBS row yet. Add one on the WBS tab first.</p>
      )}
      {networkOptions.length === 0 && (
        <p className="md-help">This project has no Network yet. Add one on the Network tab first.</p>
      )}
      {booked > 0 && !wbsChanged && (
        <p className="md-help">Booked rows on record: {booked}. The Network can still be corrected; the WBS is locked.</p>
      )}
    </Modal>
  );
}


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
