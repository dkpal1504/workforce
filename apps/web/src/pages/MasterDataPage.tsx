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

   A Network belongs to ONE WBS element of its project (one Network number never
   spans two WBS rows), so the Network form asks for the WBS and the Job Order
   mapping form offers only the Networks of the selected WBS.

   A master row that other tables reference is DEACTIVATED, never deleted: the
   foreign keys and the frozen attribution snapshots on booked hours must survive.
   ============================================================================ */

type Tab = "project" | "wbs" | "uom" | "network" | "joborder";

/** The Network fields a picker needs. The Job Order list sends them nested inside each
 *  WBS row; the project list sends them flat, each row carrying its `wbsId` and `wbsCode`. */
type NetworkOption = {
  id: number;
  code: string;
  name: string | null;
  active: boolean;
};

type WbsRow = {
  id: number;
  projectId: number;
  wbsCode: string;
  name: string | null;
  sortOrder: number;
  active: boolean;
  /** The Networks of THIS WBS element. The Job Order list sends them inside each WBS
   *  row, so the mapping form can offer only the Networks of the selected WBS. */
  networks?: NetworkOption[];
  _count?: { jobOrders: number };
};

type NetworkRow = NetworkOption & {
  projectId: number;
  /** The WBS element this Network belongs to. One Network number never spans two WBS
   *  rows of the same project, so a Network always points at exactly one WBS. */
  wbsId: number;
  /** The WBS code the server reports beside `wbsId`, so the table can show it. */
  wbsCode?: string | null;
  wbsName?: string | null;
  source: string;
  _count?: { jobOrders: number };
};

/** A Job Order row for the mapping tab: its WBS and Network can be corrected here. */
type JobOrderRow = {
  id: number;
  code: string;
  name: string;
  status: string;
  budgetedHours: number | null;
  budgetedQuantity: number | null;
  /** The last few effective-dated budget revisions, newest first. */
  budgetRevisions?: {
    revisionNo: number;
    budgetedHours: number | null;
    budgetedQuantity: number | null;
    effectiveFrom: string;
    reason: string | null;
    createdBy: { name: string; role: string } | null;
  }[];
  /** The project of a Job Order carries its WBS rows, and each WBS row carries its own
   *  Networks — never a flat project-wide Network list, because a Network belongs to a WBS. */
  project: (Pick<ProjectRow, "id" | "code" | "name" | "colorKey"> & { wbsRows: WbsRow[] }) | null;
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
  /** Active Job Orders of this project: while any exists the project cannot be deactivated. */
  activeJobOrderCount?: number;
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

/** The help paragraph of each tab. One source, so the phone/tablet paragraph and the
 *  desktop help card can never drift apart. */
const HELP_TEXT: Record<Tab, string> = {
  project: `A project is the commercial container. Its colour key is the short token shown on Timesheet Entry, unique across all projects (example: ${COLOR_KEY_EXAMPLE}). A WBS row and its Networks live inside it.`,
  wbs: `A WBS row groups Job Orders inside one project. The WBS number (example: ${WBS_CODE_EXAMPLE}) is unique inside the project, not globally.`,
  uom: "Unit of measure, with the example string that is shown as help text wherever a quantity is entered.",
  network: `A Network belongs to ONE WBS element of its project: one Network number never spans two WBS rows. Codes are maintained by hand (example: ${NETWORK_CODE_EXAMPLE}); SAP-fed networks arrive from the ERP feed and are read-only here.`,
  joborder: "Job Orders come from the CSV upload, which never updates an existing row. Use Edit on a row to correct its WBS or Network. A WBS may not change once hours are booked, because every booked row keeps the attribution it was given. The Project itself is changed by an Admin from the Job Order Mapping screen.",
};

/** The label of the desktop help card. Presentation only: the text above is unchanged. */
const HELP_TITLE: Record<Tab, string> = {
  project: "How projects are managed",
  wbs: "How WBS rows are managed",
  uom: "How units of measure are managed",
  network: "How networks are managed",
  joborder: "How job orders are managed",
};

/** The noun of the desktop stat pair, one per tab. */
const STAT_LABEL: Record<Tab, string> = {
  project: "projects",
  wbs: "WBS rows",
  uom: "units of measure",
  network: "networks",
  joborder: "job orders",
};

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
  // Desktop-only: the help card is collapsed until the user opens it. It does not
  // touch the data, the tab or the filter state.
  const [helpOpen, setHelpOpen] = useState(false);

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
    () => allNetworks.filter((row) => String(row.projectId) === projectFilter && matches(row.code, row.name, row.source, row.wbsCode, row.wbsName, row.project.name, row.project.code)),
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

  // The desktop stat pair reads two counts the API already returns for the rows that
  // are on screen. "Booked rows" is a COUNT of booked rows (timesheet entries plus
  // allocations) and never hours: budgetedHours is hours, so the two must not be mixed
  // into a consumption figure. There is therefore no honest ratio to draw a progress
  // bar from, and no bar is drawn.
  const visibleActiveFlags: boolean[] =
    tab === "project" ? visibleProjects.map((row) => row.active)
      : tab === "wbs" ? visibleWbs.map((row) => row.active)
        : tab === "uom" ? visibleUom.map((row) => row.active)
          : tab === "network" ? visibleNetworks.map((row) => row.active)
            : visibleJobOrders.map((row) => row.status === "active");
  const activeCount = visibleActiveFlags.filter(Boolean).length;
  const bookedRows = visibleJobOrders.reduce(
    (total, row) => total + (row._count?.timesheetEntries ?? 0) + (row._count?.employeeAllocations ?? 0),
    0
  );

  function deactivatePath(type: Tab, id: number) {
    if (type === "project") return `/master-data/projects/${id}/deactivate`;
    if (type === "wbs") return `/master-data/wbs/${id}/deactivate`;
    if (type === "uom") return `/master-data/uom/${id}/deactivate`;
    return `/master-data/networks/${id}/deactivate`;
  }

  function activatePath(type: Tab, id: number) {
    return deactivatePath(type, id).replace("/deactivate", "/activate");
  }

  return <div className="md-page">
    <div className="supervisors-toolbar md-toolbar">
      <div className="supervisors-actions md-tabs" role="tablist" aria-label="Master data">
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
      <div className="supervisors-actions md-toolbar__right">
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
        <div className="md-search">
          <MdIcon name="search" className="md-search__icon" />
          <input className="search-input" style={{ marginBottom: 0, minWidth: 180, maxWidth: 260 }} value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Search ${TAB_LABELS[tab].toLowerCase()}…`} />
        </div>
        {/* Desktop-only stat pair: the number of rows shown, and either how many of them
            are active or how many booked rows the shown Job Orders carry. Both are
            counts of what is already on screen; neither is hours. */}
        {!loading && (
          <div className="md-stats">
            <span className="md-stat"><strong>{counts[tab]}</strong> {STAT_LABEL[tab]}</span>
            <span className="md-stat">
              <strong>{tab === "joborder" ? bookedRows : activeCount}</strong> {tab === "joborder" ? "booked rows" : "active"}
            </span>
          </div>
        )}
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

    {/* The plain paragraph is what the phone and the tablet render, exactly as before.
        The desktop help card below replaces it at >=1200px, where the paragraph is
        display:none, so the same sentence is never on screen twice. */}
    <p className="muted md-help-paragraph" style={{ marginTop: 0 }}>{HELP_TEXT[tab]}</p>

    <div className="md-info">
      <button
        type="button"
        className="md-info__toggle"
        aria-expanded={helpOpen}
        onClick={() => setHelpOpen((open) => !open)}
      >
        <span className="md-info__label">{HELP_TITLE[tab]}</span>
        <MdIcon name="chevron" className={`md-info__chevron${helpOpen ? " is-open" : ""}`} />
      </button>
      {helpOpen && <p className="md-info__body">{HELP_TEXT[tab]}</p>}
    </div>

    {error && !editor && <div className="error-banner" role="alert">{error}</div>}
    {loading ? <div className="loading-state">Loading master data…</div> : counts[tab] === 0 ? (
      <div className="empty-state">
        {needsProject && !selectedProject ? "Select a project to see its rows." : tab === "joborder" ? "No Job Order matches this filter." : `No ${addLabel.toLowerCase()} rows found.`}
      </div>
    ) : (
      /* The card is layout-neutral below 1200px (`display: contents`), so the phone and
         tablet keep the bare table box they render today. */
      <div className="md-table-card">
      <table className="sup-table">
        <thead>
          {tab === "project" && <tr><th>Colour key</th><th>Project</th><th>WBS / Networks</th><th>Job Orders</th><th>Status</th><th style={{ textAlign: "right" }}>Actions</th></tr>}
          {tab === "wbs" && <tr><th>WBS number</th><th>Project</th><th>Job Orders</th><th>Status</th><th style={{ textAlign: "right" }}>Actions</th></tr>}
          {tab === "uom" && <tr><th>Code</th><th>Name</th><th>Example (on-screen help)</th><th>Job Orders</th><th>Status</th><th style={{ textAlign: "right" }}>Actions</th></tr>}
          {tab === "network" && <tr><th>Network code</th><th>Project</th><th>WBS</th><th>Source</th><th>Job Orders</th><th>Status</th><th style={{ textAlign: "right" }}>Actions</th></tr>}
          {tab === "joborder" && <tr><th>Job Order</th><th>Project</th><th>WBS</th><th>Network</th><th>Booked hours</th><th>Status</th><th style={{ textAlign: "right" }}>Actions</th></tr>}
        </thead>
        <tbody>
          {tab === "project" && visibleProjects.map((row) => (
            <tr key={row.id}>
              <td><span className="badge badge--manual md-color-key">{row.colorKey}</span></td>
              <td><strong>{row.code}</strong><div className="muted">{row.name}{row.isNonProject ? " · standing / non-project row" : ""}</div></td>
              <td>{row.wbsRows.length} WBS · {row.networks.length} network{row.networks.length === 1 ? "" : "s"}</td>
              <td>{row._count?.jobOrders ?? 0}</td>
              <td><span className={`md-status${row.active ? "" : " md-status--off"}`}>{row.active ? "Active" : "Inactive"}</span></td>
              <td><Actions busy={busy} active={row.active} blockReason={projectDeactivationReason(row)} onEdit={() => setEditor({ type: "project", item: row })} onToggle={() => run(() => api(deactivatePath("project", row.id), { method: "POST" }))} onActivate={() => run(() => api(activatePath("project", row.id), { method: "POST" }))} /></td>
            </tr>
          ))}
          {tab === "wbs" && visibleWbs.map((row) => (
            <tr key={row.id}>
              <td><strong>{row.wbsCode}</strong>{row.name && <div className="muted">{row.name}</div>}</td>
              <td>{row.project.code} · {row.project.name}</td>
              <td>{row._count?.jobOrders ?? 0}</td>
              <td><span className={`md-status${row.active ? "" : " md-status--off"}`}>{row.active ? "Active" : "Inactive"}</span></td>
              <td><Actions busy={busy} active={row.active} onEdit={() => setEditor({ type: "wbs", item: row })} onToggle={() => run(() => api(deactivatePath("wbs", row.id), { method: "POST" }))} onActivate={() => run(() => api(activatePath("wbs", row.id), { method: "POST" }))} /></td>
            </tr>
          ))}
          {tab === "uom" && visibleUom.map((row) => (
            <tr key={row.id}>
              <td><strong>{row.code}</strong></td>
              <td>{row.name}</td>
              <td>{row.example ?? <span className="muted">No example yet</span>}</td>
              <td>{row._count?.jobOrders ?? 0}</td>
              <td><span className={`md-status${row.active ? "" : " md-status--off"}`}>{row.active ? "Active" : "Inactive"}</span></td>
              <td><Actions busy={busy} active={row.active} onEdit={() => setEditor({ type: "uom", item: row })} onToggle={() => run(() => api(deactivatePath("uom", row.id), { method: "POST" }))} onActivate={() => run(() => api(activatePath("uom", row.id), { method: "POST" }))} /></td>
            </tr>
          ))}
          {tab === "joborder" && visibleJobOrders.map((row) => {
            const booked = (row._count?.timesheetEntries ?? 0) + (row._count?.employeeAllocations ?? 0);
            return (
              <tr key={row.id}>
                <td><strong>{row.code}</strong><div className="muted">{row.name}</div></td>
                <td>{row.project ? <><span className="badge badge--manual md-color-key">{row.project.colorKey}</span> {row.project.code}</> : "—"}</td>
                <td>
                  {row.projectWbs?.wbsCode ?? "—"}
                  {/* The row already tells us it has booked rows; that is the rule that
                      freezes the WBS. No extra data is read for the glyph. */}
                  {booked > 0 && row.projectWbs && (
                    <span className="md-lock" aria-hidden="true" title="Hours are booked against this Job Order, so its WBS is frozen.">
                      <MdIcon name="lock" />
                    </span>
                  )}
                </td>
                <td>{row.network?.code ?? "—"}</td>
                <td>{booked === 0 ? <span className="muted">None</span> : booked}</td>
                <td><span className={`badge badge--${row.status === "active" ? "manual" : "sync"}`}>{row.status === "active" ? "Active" : "In-Active"}</span></td>
                <td>
                  <div className="sup-table__actions">
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditor({ type: "joborder", item: row })}>
                      <MdIcon name="pencil" />Edit Job Order
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
          {tab === "network" && visibleNetworks.map((row) => (
            <tr key={row.id}>
              <td><strong>{row.code}</strong>{row.name && <div className="muted">{row.name}</div>}</td>
              <td>{row.project.code} · {row.project.name}</td>
              <td>
                {row.wbsCode ?? <span className="muted">—</span>}
                {row.wbsName && <div className="muted">{row.wbsName}</div>}
              </td>
              <td><span className={`badge badge--${row.source === "SAP" ? "sync" : "manual"}`}>{row.source === "SAP" ? "SAP feed" : "Manual"}</span></td>
              <td>{row._count?.jobOrders ?? 0}</td>
              <td><span className={`md-status${row.active ? "" : " md-status--off"}`}>{row.active ? "Active" : "Inactive"}</span></td>
              <td><Actions busy={busy} active={row.active} onEdit={() => setEditor({ type: "network", item: row })} onToggle={() => run(() => api(deactivatePath("network", row.id), { method: "POST" }))} onActivate={() => run(() => api(activatePath("network", row.id), { method: "POST" }))} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
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
  </div>;
}

/**
 * Why this row cannot be deactivated yet, or null when it can. A Project may only be retired
 * once EVERY Job Order of it is In-Active (the API enforces the same rule with a 409 naming the
 * Job Orders), so the button is disabled with the reason instead of offering a click that fails.
 */
function projectDeactivationReason(row: ProjectRow): string | null {
  if (!row.active || !row.activeJobOrderCount) return null;
  return `${row.activeJobOrderCount} active Job Order${row.activeJobOrderCount === 1 ? "" : "s"} — set them In-Active first`;
}

function Actions({ active, busy, blockReason, onEdit, onToggle, onActivate }: { active: boolean; busy: boolean; blockReason?: string | null; onEdit: () => void; onToggle: () => void; onActivate: () => void }) {
  return (
    <div className="sup-table__actions">
      <button type="button" className="btn btn-ghost btn-sm" onClick={onEdit}>
        <MdIcon name="pencil" />Edit
      </button>
      {active ? (
        <>
          <button
            type="button"
            disabled={busy || Boolean(blockReason)}
            className="btn btn-danger btn-sm"
            title={
              blockReason ??
              "Deactivated rows stay in history but disappear from the pickers. A referenced row is never deleted."
            }
            onClick={() =>
              window.confirm(
                blockReason
                  ? `This project still has active Job Orders: ${blockReason}`
                  : "Deactivate this master row? It stays in history and disappears from the pickers."
              ) &&
              !blockReason &&
              onToggle()
            }
          >
            Deactivate
          </button>
          {blockReason && <span className="muted">{blockReason}</span>}
        </>
      ) : (
        <button type="button" disabled={busy} className="btn btn-secondary btn-sm" onClick={onActivate}>Activate</button>
      )}
    </div>
  );
}

/**
 * A decorative glyph for the desktop refresh.
 *
 * The stylesheet removes every `.md-icon` below 1200px, so the phone and the tablet
 * draw the same text-only controls they draw today. Every glyph is aria-hidden, so it
 * never adds to the accessible name of the control it sits in (the row action must stay
 * exactly "Edit Job Order").
 */
function MdIcon({ name, className = "" }: { name: "search" | "pencil" | "lock" | "chevron"; className?: string }) {
  const shape: React.SVGProps<SVGSVGElement> = { className: `md-icon${className ? ` ${className}` : ""}`, viewBox: "0 0 16 16", width: 14, height: 14, "aria-hidden": true, focusable: "false" };
  if (name === "search") {
    return (
      <svg {...shape}>
        <circle cx="7" cy="7" r="4.4" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M10.4 10.4 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  if (name === "pencil") {
    return (
      <svg {...shape}>
        <path d="M11.3 2 14 4.7 5.7 13H3v-2.7z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
    );
  }
  if (name === "lock") {
    return (
      <svg {...shape}>
        <rect x="3.4" y="7" width="9.2" height="6.4" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path d="M5.6 7V5.2a2.4 2.4 0 0 1 4.8 0V7" fill="none" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    );
  }
  return (
    <svg {...shape}>
      <path d="M3.6 6.2 8 10.6l4.4-4.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
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
  if (editor.type === "joborder") return <JobOrderForm item={editor.item} busy={busy} error={error} onClose={onClose} onSave={onSave} />;

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
/**
 * Edit a Job Order.
 *
 * Only the BUDGET may be changed here: Budget hours and Budget quantity, and an optional
 * reason. The Project, WBS, Network, UoM, Department, Section and Status of an uploaded Job
 * Order are shown read-only, because they identify it and because booked hours keep the
 * attribution they were given. Saving writes a NEW effective-dated budget revision stamped
 * with the date and time, which is what the Job Order Summary compares consumption against.
 */
function JobOrderForm({ item, busy, error, onClose, onSave }: { item: JobOrderRow; busy: boolean; error: string; onClose: () => void; onSave: SaveFn }) {
  const [budgetedHours, setBudgetedHours] = useState(String(item.budgetedHours ?? 0));
  const [budgetedQuantity, setBudgetedQuantity] = useState(String(item.budgetedQuantity ?? 0));
  const [reason, setReason] = useState("");

  const round = (value: number) => Math.round(value * 100) / 100;
  const hours = Number(budgetedHours);
  const quantity = Number(budgetedQuantity);
  const valid = budgetedHours.trim() !== "" && budgetedQuantity.trim() !== "" &&
    Number.isFinite(hours) && Number.isFinite(quantity) && hours >= 0 && quantity >= 0;
  const changed = valid && (
    round(hours) !== round(Number(item.budgetedHours ?? 0)) ||
    round(quantity) !== round(Number(item.budgetedQuantity ?? 0))
  );
  const booked = (item._count?.timesheetEntries ?? 0) + (item._count?.employeeAllocations ?? 0);
  const revisions = item.budgetRevisions ?? [];
  const latest = revisions[0] ?? null;

  const submitDisabled = !valid || !changed;
  const submitTitle = !valid
    ? "Enter Budget hours and Budget quantity as zero or greater."
    : !changed
      ? "Change Budget hours or Budget quantity first: an unchanged budget writes no revision."
      : undefined;

  return (
    <Modal
      title={`Edit Job Order ${item.code}`}
      busy={busy}
      error={error}
      onClose={onClose}
      submitDisabled={submitDisabled}
      submitTitle={submitTitle}
      onSubmit={() => onSave(`/master-data/job-orders/${item.id}/budget`, "PUT", {
        budgetedHours: round(hours),
        budgetedQuantity: round(quantity),
        reason,
      })}
    >
      <div className="sup-field">
        <p className="md-readonly">{item.code} · {item.name}</p>
        <p className="md-help">
          Only the budget can be revised here. Saving records a new revision with the date and time, so the
          consumption of an earlier month is still measured against the budget that was in force then.
        </p>
      </div>

      <div className="sup-form__grid">
        <div className="sup-field">
          <label>Project</label>
          <p className="md-readonly">
            {item.project ? `${item.project.colorKey} · ${item.project.code} · ${item.project.name}` : "—"}
          </p>
        </div>
        <div className="sup-field">
          <label>WBS number</label>
          <p className="md-readonly">{item.projectWbs ? item.projectWbs.wbsCode : "—"}</p>
        </div>
        <div className="sup-field">
          <label>Network</label>
          <p className="md-readonly">{item.network ? item.network.code : "—"}</p>
        </div>
        <div className="sup-field">
          <label>Unit of measure</label>
          <p className="md-readonly">{item.uom ? item.uom.code : "—"}</p>
        </div>
        <div className="sup-field">
          <label>Department</label>
          <p className="md-readonly">{item.department ? item.department.name : "—"}</p>
        </div>
        <div className="sup-field">
          <label>Section</label>
          <p className="md-readonly">{item.section ? item.section.name : "All sections (standing)"}</p>
        </div>
        <div className="sup-field">
          <label>Status</label>
          <p className="md-readonly">{item.status === "active" ? "Active" : "In-Active"}</p>
        </div>
        <div className="sup-field">
          <label>Booked rows</label>
          <p className="md-readonly">{booked === 0 ? "None" : String(booked)}</p>
        </div>
      </div>

      <Field
        label="Budget hours"
        help={`Required, zero or greater. This is the hours budget the consumption on the Job Order Summary is measured against. Current: ${item.budgetedHours ?? 0}`}
      >
        <input inputMode="decimal" required value={budgetedHours} onChange={(e) => setBudgetedHours(e.target.value)} />
      </Field>
      <Field
        label="Budget quantity"
        help={`Required, zero or greater, in the Job Order's own unit (${item.uom?.code ?? "—"}). Hours and quantity are independent figures. Current: ${item.budgetedQuantity ?? 0}`}
      >
        <input inputMode="decimal" required value={budgetedQuantity} onChange={(e) => setBudgetedQuantity(e.target.value)} />
      </Field>
      <Field label="Reason (optional)" help="Recorded against the revision, for example the transfer that caused it.">
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Budget transfer from another Job Order" />
      </Field>

      <div className="sup-field">
        <label>{latest ? `Last revision (${revisions.length} shown)` : "Revisions"}</label>
        {revisions.length === 0 ? (
          <p className="md-help">No revision recorded yet for this Job Order.</p>
        ) : (
          <ul className="md-help" style={{ margin: 0, paddingLeft: 18 }}>
            {revisions.map((revision) => (
              <li key={revision.revisionNo}>
                Revision {revision.revisionNo} · {new Date(revision.effectiveFrom).toLocaleString()} ·{" "}
                {revision.budgetedHours ?? 0} hrs · {revision.budgetedQuantity ?? 0} qty
                {revision.createdBy ? ` · ${revision.createdBy.name}` : ""}
                {revision.reason ? ` · ${revision.reason}` : ""}
              </li>
            ))}
          </ul>
        )}
      </div>
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

/**
 * Add or edit a Network. The WBS is a REQUIRED field, because a Network belongs to one
 * WBS element and one Network number never spans two WBS rows of a project. The select
 * is limited to the WBS rows of the Network's own project.
 */
function NetworkForm({ item, project, busy, error, onClose, onSave }: { item?: NetworkRow; project: ProjectRow; busy: boolean; error: string; onClose: () => void; onSave: SaveFn }) {
  const [wbsId, setWbsId] = useState(item?.wbsId != null ? String(item.wbsId) : "");
  const [code, setCode] = useState(item?.code ?? "");
  const [name, setName] = useState(item?.name ?? "");
  // Only the project's own WBS rows are offered, and an inactive row is offered only
  // while it is the row this Network already has (so the stored value stays visible).
  // The server refuses an inactive parent, so it is never presented as a free choice.
  const wbsOptions = useMemo(() => {
    const rows = project.wbsRows.filter((row) => row.active || row.id === item?.wbsId);
    return rows;
  }, [project.wbsRows, item?.wbsId]);
  const noWbs = wbsOptions.length === 0;
  return (
    <Modal
      title={item ? "Edit Network" : "Add Network"}
      busy={busy}
      error={error}
      onClose={onClose}
      submitDisabled={noWbs || !wbsId}
      submitTitle={noWbs ? "This project has no WBS row yet. Add one on the WBS tab first." : !wbsId ? "Select the WBS row this Network belongs to." : undefined}
      onSubmit={() => onSave(
        item ? `/master-data/networks/${item.id}` : `/master-data/projects/${project.id}/networks`,
        item ? "PUT" : "POST",
        { wbsId: Number(wbsId), code, name }
      )}
    >
      <div className="sup-field">
        <label>Project</label>
        <p className="md-readonly">{project.colorKey} · {project.code} · {project.name}</p>
        <p className="md-help">A Network belongs to one project, and the same code may exist in another project. The project cannot be changed here.</p>
      </div>
      <Field label="WBS number" help={`Required. One Network number never spans two WBS rows, so this Network belongs to exactly one WBS of ${project.code}. Example: ${WBS_CODE_EXAMPLE}`}>
        <select value={wbsId} onChange={(e) => setWbsId(e.target.value)} required disabled={noWbs}>
          {noWbs && <option value="">No WBS row in this project yet</option>}
          {!noWbs && !wbsId && <option value="">Select a WBS row…</option>}
          {wbsOptions.map((row) => (
            <option key={row.id} value={row.id}>
              {row.wbsCode}{row.name ? ` · ${row.name}` : ""}{row.active ? "" : " (inactive)"}
            </option>
          ))}
        </select>
      </Field>
      {noWbs && (
        <p className="md-help">This project has no WBS row yet, and a Network must sit under one. Add a WBS row on the WBS tab first, then add this Network.</p>
      )}
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
