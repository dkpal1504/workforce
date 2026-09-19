import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, getToken } from "../api/client";
import "../styles/supervisors.css";

type RowError = { row: number; column?: string; error?: string; message?: string };

/** A WBS or Network master the upload created, with the file row that introduced it. */
type CreatedMaster = {
  row: number;
  projectCode: string;
  wbsCode?: string;
  networkCode?: string;
};

type UploadResult = {
  ok?: boolean;
  total?: number;
  created?: number;
  skipped?: number;
  rejected?: number;
  createMissingMasters?: boolean;
  wbsCreated?: number;
  networksCreated?: number;
  createdWbs?: CreatedMaster[];
  createdNetworks?: CreatedMaster[];
  errors?: RowError[];
};

/**
 * Job Order CSV upload — ADMIN/PM gated at the API.
 *
 * One row is one Job Order. The template columns are fixed by the API:
 * Project_ID, Project_Name, WBS_NO, Network_ID, Job_Order, Job_Description, UoM,
 * Qty, Budgeted_hours, Department, Section, Job_Order_Status.
 *
 * A row is rejected when Project_ID + WBS_NO + Job_Order already exists: the Job
 * Order number repeats across projects, so it is unique inside one project only.
 * Department and Section must come from the badge-sync master, and the uploader
 * NEVER creates a Project, UoM, Department or Section. A missing WBS_NO or
 * Network_ID is different: with the "create missing masters" option on (the API
 * default) the master is created and the row imported, and the result reports each
 * created master with the row that introduced it. Every rejected row is reported
 * back; the file is never partially accepted in silence.
 */
const TEMPLATE_COLUMNS =
  "Project_ID, Project_Name, WBS_NO, Network_ID, Job_Order, Job_Description, UoM, Qty, Budgeted_hours, Department, Section, Job_Order_Status";

const MAX_BYTES = 2 * 1024 * 1024;

type JobOrderRow = {
  id: number;
  code: string;
  name: string;
  status: string;
  project: { id: number; code: string; name: string; colorKey: string } | null;
  projectWbs: { id: number; wbsCode: string; name?: string | null } | null;
  department: { id: number; name: string } | null;
  section: { id: number; name: string } | null;
  uom: { id: number; code: string } | null;
};

type ProjectOption = { id: number; code: string; name: string; colorKey: string };

export function JobOrderUploadPage() {
  const [fileName, setFileName] = useState("");
  const [csvText, setCsvText] = useState("");
  const [rowsPreview, setRowsPreview] = useState(0);
  const [busy, setBusy] = useState(false);
  // Default ON: the API defaults to it too, and the operator asked for a Job Work
  // upload to be able to create a missing WBS / Network master.
  const [createMissingMasters, setCreateMissingMasters] = useState(true);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  // Job Order status maintenance. A Job Order is created by this upload and the
  // upload skips an existing row, so retiring one has to happen here.
  const [jobOrders, setJobOrders] = useState<JobOrderRow[]>([]);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("all");
  const [projectFilter, setProjectFilter] = useState<number | "">("");
  const [statusBusy, setStatusBusy] = useState<number | null>(null);

  const loadJobOrders = useCallback(async () => {
    const qs = new URLSearchParams();
    if (statusFilter !== "all") qs.set("status", statusFilter);
    if (projectFilter !== "") qs.set("project_id", String(projectFilter));
    try {
      const res = await api<{ jobOrders: JobOrderRow[] }>(`/master-data/job-orders?${qs.toString()}`);
      setJobOrders(res.jobOrders);
    } catch {
      // The upload itself still works when the list cannot be read.
    }
  }, [statusFilter, projectFilter]);

  useEffect(() => {
    void loadJobOrders();
  }, [loadJobOrders]);

  useEffect(() => {
    api<{ projects: ProjectOption[] }>("/master-data/projects")
      .then((d) => setProjects(d.projects.map((p) => ({ id: p.id, code: p.code, name: p.name, colorKey: p.colorKey }))))
      .catch(() => setProjects([]));
  }, []);

  async function changeStatus(id: number, status: string) {
    setStatusBusy(id);
    setError("");
    try {
      await api(`/master-data/job-orders/${id}/status`, { method: "POST", body: JSON.stringify({ status }) });
      await loadJobOrders();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The Job Order status could not be changed.");
    } finally {
      setStatusBusy(null);
    }
  }

  const parseCount = useCallback((text: string) => {
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
    return Math.max(0, lines.length - 1);
  }, []);

  function handleFile(file: File | undefined | null) {
    setResult(null);
    setError("");
    if (!file) return;
    if (!/\.csv$/i.test(file.name)) {
      setError("Only .csv files are accepted.");
      return;
    }
    if (file.size > MAX_BYTES) {
      setError("File exceeds the 2MB limit.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      setFileName(file.name);
      setCsvText(text);
      setRowsPreview(parseCount(text));
    };
    reader.onerror = () => setError("Could not read the file.");
    reader.readAsText(file);
  }

  async function upload() {
    if (!csvText.trim()) {
      setError("Choose a CSV file first.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await api<UploadResult>("/job-order-upload", {
        method: "POST",
        body: JSON.stringify({ csv: csvText, createMissingMasters }),
      });
      setResult(res);
      // Anything the file created must appear in the status list below.
      if ((res.created ?? 0) > 0) await loadJobOrders();
    } catch (e) {
      const payload = e instanceof ApiError && e.payload && typeof e.payload === "object" ? (e.payload as UploadResult & { error?: string }) : null;
      setError(payload?.error ? String(payload.error) : e instanceof Error ? e.message : "Upload failed");
      if (payload?.errors) setResult({ ok: false, errors: payload.errors });
    } finally {
      setBusy(false);
    }
  }

  function downloadTemplate() {
    fetch("/api/job-order-upload/template", { headers: { Authorization: `Bearer ${getToken()}` } })
      .then((r) => {
        if (!r.ok) throw new Error("download failed");
        return r.blob();
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "job_order_upload_template.csv";
        a.click();
        URL.revokeObjectURL(url);
      })
      .catch(() => setError("Could not download the template."));
  }

  const rowMessage = (e: RowError) => e.message || e.error || "Rejected";
  const rejectedCount = result?.rejected ?? result?.errors?.length ?? 0;
  const wbsCreatedCount = result?.wbsCreated ?? 0;
  const networksCreatedCount = result?.networksCreated ?? 0;
  /** "A.HULL.0042.900 (PRJ-A, row 2)" — the code plus the row that introduced it. */
  const createdMasterLabel = (m: CreatedMaster) =>
    `${m.wbsCode ?? m.networkCode ?? "?"} (${m.projectCode}, row ${m.row})`;

  return (
    <>
      <div className="supervisors-toolbar">
        <span className="supervisors-toolbar__count">
          Upload Job Orders in bulk. One row is one Job Order. Department and Section come from the organisation master
          (Department is the full &quot;BuName - Division&quot; name). Section may be blank only for a Non-Project Job Order.
          A WBS_NO or Network_ID missing under the row&apos;s Project can be created from the file — see the option below.
          A Project, UoM, Department or Section is never created. Status is Active or In-Active. A row is rejected when
          the same Project, WBS and Job Order number already exist; the other rows in the file are still imported.
        </span>
        <div className="supervisors-actions">
          <button type="button" className="btn btn-ghost" onClick={downloadTemplate}>
            ⬇ Download Template
          </button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="panel">
        <div className="panel__header">
          <span>Upload Job Orders</span>
          <span className="panel__count">Columns: {TEMPLATE_COLUMNS}</span>
        </div>
        <div className="panel__body">
          <input
            ref={fileRef}
            type="file"
            accept=".csv"
            onChange={(e) => handleFile(e.target.files?.[0])}
            style={{ display: "none" }}
          />
          <div
            className="csv-dropzone"
            onClick={() => fileRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && fileRef.current?.click()}
          >
            {fileName ? (
              <>
                <strong>{fileName}</strong>
                <span className="muted"> {rowsPreview} data row{rowsPreview === 1 ? "" : "s"} detected — click to choose another</span>
              </>
            ) : (
              <>
                <strong>Choose a CSV file</strong>
                <span className="muted"> or click here to browse (max 2MB)</span>
              </>
            )}
          </div>
          <label style={{ display: "flex", gap: 10, alignItems: "flex-start", marginTop: 14 }}>
            <input
              type="checkbox"
              checked={createMissingMasters}
              disabled={busy}
              onChange={(e) => setCreateMissingMasters(e.target.checked)}
              style={{ marginTop: 3, width: "auto" }}
            />
            <span>
              <strong>Create a missing WBS or Network automatically</strong>
              <span className="muted">
                {" "}— ON (default): a WBS_NO or a Network_ID that does not exist under the row&apos;s Project is created as
                a new master row and that Job Order is imported. Two rows naming the same new code create it ONCE, and the
                result below names the row that introduced each master, so a typo that became a master is visible. This
                cannot create a Project (it needs a unique colour key the template does not carry), and an unknown UoM,
                Department or Section still rejects its row. OFF: those rows are rejected instead and the reason names the
                missing master. The duplicate rule (Project + WBS + Job Order already exists) is unaffected — it always
                rejects that line.
              </span>
            </span>
          </label>
          {!createMissingMasters && (
            <div className="muted" style={{ marginTop: 8 }}>
              Auto-creation is OFF for this run: a row naming an unknown WBS_NO or Network_ID will be rejected, exactly as
              before.
            </div>
          )}
          <div className="footer-actions" style={{ marginTop: 14 }}>
            <button type="button" className="btn btn-primary" disabled={!csvText || busy} onClick={upload}>
              {busy ? "Uploading…" : "Upload & Validate"}
            </button>
          </div>
        </div>
      </div>

      {result && (
        <div className="panel" style={{ marginTop: 16 }}>
          <div className="panel__header">
            <span>Upload Result</span>
            <span className="panel__count">
              {result.created ?? 0} created · {result.skipped ?? 0} skipped · {rejectedCount} rejected ·{" "}
              {wbsCreatedCount} WBS created · {networksCreatedCount} Network{networksCreatedCount === 1 ? "" : "s"} created
            </span>
          </div>
          <div className="panel__body">
            {(result.created ?? 0) > 0 && (
              <div className="alloc-note" style={{ marginBottom: 10 }}>
                ✓ {result.created} Job Order{result.created === 1 ? "" : "s"} created.
              </div>
            )}
            {(result.skipped ?? 0) > 0 && (
              <div className="alloc-note" style={{ marginBottom: 10 }}>
                {result.skipped} row{result.skipped === 1 ? "" : "s"} skipped because the Job Order already exists — an
                existing budget is never overwritten by an upload.
              </div>
            )}
            {wbsCreatedCount > 0 && (
              <div className="alloc-note" style={{ marginBottom: 10 }}>
                ＋ {wbsCreatedCount} WBS master{wbsCreatedCount === 1 ? "" : "s"} created from this file:{" "}
                {(result.createdWbs ?? []).map(createdMasterLabel).join(", ")}. Each one carries the code the file typed
                and the row that introduced it — check them against the Project's WBS list.
              </div>
            )}
            {networksCreatedCount > 0 && (
              <div className="alloc-note" style={{ marginBottom: 10 }}>
                ＋ {networksCreatedCount} Network master{networksCreatedCount === 1 ? "" : "s"} created from this file:{" "}
                {(result.createdNetworks ?? []).map(createdMasterLabel).join(", ")}.
              </div>
            )}
            {(result.errors?.length ?? 0) > 0 ? (
              <ul className="csv-error-list">
                {result.errors!.map((e, idx) => (
                  <li key={`${e.row}-${idx}`}>
                    <strong>Row {e.row}:</strong> {e.column ? `${e.column} — ` : ""}
                    {rowMessage(e)}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">
                {(result.created ?? 0) > 0
                  ? `${result.created} row${result.created === 1 ? "" : "s"} created.`
                  : "No row was created."}
                {(result.skipped ?? 0) > 0 ? ` ${result.skipped} already existed and was skipped.` : ""}
                {wbsCreatedCount + networksCreatedCount > 0
                  ? ` ${wbsCreatedCount} WBS and ${networksCreatedCount} Network master${wbsCreatedCount + networksCreatedCount === 1 ? "" : "s"} created with them.`
                  : ""}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Job Order status maintenance. The upload creates Job Orders; this is the
          only place that can retire one, because the upload skips an existing row. */}
      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel__header">
          <span>Job Order Status</span>
          <span className="panel__count">{jobOrders.length} shown</span>
        </div>
        <div className="panel__body">
          <div className="supervisors-actions" style={{ gap: 10, marginBottom: 10 }}>
            <select
              aria-label="Filter by project"
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value === "" ? "" : Number(e.target.value))}
            >
              <option value="">All projects</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.colorKey} — {p.name}
                </option>
              ))}
            </select>
            <select
              aria-label="Filter by status"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as "all" | "active" | "inactive")}
            >
              <option value="all">All statuses</option>
              <option value="active">Active</option>
              <option value="inactive">In-Active</option>
            </select>
          </div>
          <p className="muted" style={{ marginTop: 0 }}>
            An In-Active Job Order cannot be booked on a timesheet and cannot have quantity progress punched against it.
            The upload sets the status when a Job Order is created and skips one that already exists, so change it here.
          </p>
          <table className="sup-table">
            <thead>
              <tr>
                <th>Job Order</th>
                <th>Project</th>
                <th>WBS</th>
                <th>Department / Section</th>
                <th>UoM</th>
                <th>Status</th>
                <th style={{ textAlign: "right" }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {jobOrders.map((jo) => (
                <tr key={jo.id}>
                  <td>
                    <strong>{jo.code}</strong>
                    <div className="muted">{jo.name}</div>
                  </td>
                  <td>
                    <strong>{jo.project?.colorKey ?? "—"}</strong>
                    <div className="muted">{jo.project?.name ?? "—"}</div>
                  </td>
                  <td>{jo.projectWbs?.wbsCode ?? "—"}</td>
                  <td>
                    {jo.department?.name ?? "—"}
                    <div className="muted">{jo.section?.name ?? "All sections (standing)"}</div>
                  </td>
                  <td>{jo.uom?.code ?? "—"}</td>
                  <td>
                    <span className={`badge badge--${jo.status === "active" ? "manual" : "sync"}`}>
                      {jo.status === "active" ? "ACTIVE" : "IN-ACTIVE"}
                    </span>
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={statusBusy === jo.id}
                      onClick={() => changeStatus(jo.id, jo.status === "active" ? "inactive" : "active")}
                    >
                      {jo.status === "active" ? "Set In-Active" : "Set Active"}
                    </button>
                  </td>
                </tr>
              ))}
              {jobOrders.length === 0 && (
                <tr>
                  <td colSpan={7} className="muted">
                    No Job Order matches this filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
