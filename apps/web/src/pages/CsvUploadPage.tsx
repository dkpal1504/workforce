import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, getToken } from "../api/client";
import "../styles/supervisors.css";

type UploadResult = {
  accountsCreated?: number;
  emailsSent?: { row: number; to: string }[];
  emailFailures?: { row: number; to: string; error: string }[];
  queuedDeliveries?: { processed: number; sent: number; pending: number; disabled: boolean } | null;
  ok: boolean;
  created: number;
  errors: { row: number; error: string }[];
};

const MAX_BYTES = 2 * 1024 * 1024; // keep in sync with the API's 2MB limit
const TEMPLATE_COLUMNS = "ecNo, name, departmentName, sectionName, designation, category, email, mobile";

/**
 * Payroll employee CSV upload — ADMIN/HR gated at the API. ecNo is the one
 * canonical identifier. Organisation hierarchy is assigned separately. Upload the raw CSV
 * text; the server validates every row (required fields, duplicate ecNo,
 * CSV-injection cells) and reports per-row errors — never silent partial
 * acceptance. The template mirrors the API's expected column order.
 */
export function CsvUploadPage() {
  const [fileName, setFileName] = useState("");
  const [csvText, setCsvText] = useState("");
  const [rowsPreview, setRowsPreview] = useState(0);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const parseCount = useCallback((text: string) => {
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
    return Math.max(0, lines.length - 1); // minus header
  }, []);

  function handleFile(file: File | undefined | null) {
    setResult(null);
    setError("");
    if (!file) return;
    if (!/\.(csv|txt)$/i.test(file.name)) {
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
      const res = await api<UploadResult>("/csv-upload", {
        method: "POST",
        body: JSON.stringify({ csv: csvText }),
      });
      setResult(res);
    } catch (e) {
      const msg =
        e instanceof ApiError && typeof e.payload === "object" && e.payload && "error" in e.payload
          ? String((e.payload as { error: string }).error)
          : e instanceof Error
            ? e.message
            : "Upload failed";
      setError(msg);
      // Per-row errors may come back with a 400 — surface them if present.
      if (e instanceof ApiError && e.payload && typeof e.payload === "object" && "errors" in e.payload) {
        setResult({ ok: false, created: 0, errors: (e.payload as UploadResult).errors ?? [] });
      }
    } finally {
      setBusy(false);
    }
  }

  function downloadTemplate() {
    // The template route is auth-gated, so fetch with the token and download the blob.
    fetch("/api/csv-upload/template", { headers: { Authorization: `Bearer ${getToken()}` } })
      .then((r) => {
        if (!r.ok) throw new Error("download failed");
        return r.blob();
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "employee_upload_template.csv";
        a.click();
        URL.revokeObjectURL(url);
      })
      .catch(() => setError("Could not download the template."));
  }

  return (
    <>
      <div className="supervisors-toolbar">
        <span className="supervisors-toolbar__count">
          Bulk-register payroll employees with canonical ecNo. Department and Section are required (exact names from
          Organisation Masters); Cost Center is derived from Section. Each row also creates the login account (Employee
          role, ecNo login). Credentials are e-mailed to the row&apos;s email; leave it blank and they go to the support
          inbox. Leave email and mobile blank if you do not have them.
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
          <span>Upload Employees</span>
          <span className="panel__count">Columns: {TEMPLATE_COLUMNS}</span>
        </div>
        <div className="panel__body">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => handleFile(e.target.files?.[0])}
            style={{ display: "none" }}
          />
          <div className="csv-dropzone" onClick={() => fileRef.current?.click()} role="button" tabIndex={0}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && fileRef.current?.click()}>
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
              {result.created} created · {result.errors.length} rejected
            </span>
          </div>
          <div className="panel__body">
            {result.created > 0 && (
              <div className="alloc-note" style={{ marginBottom: 10 }}>
                ✓ {result.created} employee record{result.created === 1 ? "" : "s"} created
                {result.accountsCreated ? ` with ${result.accountsCreated} login account${result.accountsCreated === 1 ? "" : "s"}` : ""}.
              </div>
            )}
            {result.emailsSent && result.emailsSent.length > 0 && (
              <div className="alloc-note" style={{ marginBottom: 10 }}>
                Credentials e-mailed for {result.emailsSent.length} row{result.emailsSent.length === 1 ? "" : "s"} —{" "}
                {result.emailsSent.slice(0, 3).map((m) => m.to).join(", ")}
                {result.emailsSent.length > 3 ? ` +${result.emailsSent.length - 3} more` : ""}.
              </div>
            )}
            {result.emailFailures && result.emailFailures.length > 0 && (
              <div className="error-banner" style={{ marginBottom: 10 }}>
                Credential e-mail could not be sent for {result.emailFailures.length} row
                {result.emailFailures.length === 1 ? "" : "s"}
                {result.queuedDeliveries
                  ? result.queuedDeliveries.disabled
                    ? " — the credential queue is idle (SMTP is not configured), so they stay pending."
                    : ` — the credential queue then delivered ${result.queuedDeliveries.sent} and ${result.queuedDeliveries.pending} remain pending.`
                  : " — they remain on the credential queue."}
                {" "}First reason: {result.emailFailures[0].error}
              </div>
            )}
            {result.errors.length === 0 ? (
              <p className="muted">All rows imported successfully.</p>
            ) : (
              <ul className="csv-error-list">
                {result.errors.map((e) => (
                  <li key={`${e.row}-${e.error}`}>
                    <strong>Row {e.row}:</strong> {e.error}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </>
  );
}
