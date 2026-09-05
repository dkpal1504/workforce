import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, getToken } from "../api/client";
import "../styles/supervisors.css";

type UploadResult = {
  ok: boolean;
  created: number;
  errors: { row: number; error: string }[];
};

const MAX_BYTES = 2 * 1024 * 1024; // keep in sync with the API's 2MB limit
const TEMPLATE_COLUMNS = "ecNo, idCardNo, name, departmentName, designation, category, grade, section, plant";

/**
 * Employee CSV upload (CR#2) — ADMIN/HR gated at the API. Upload the raw CSV
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
          Bulk-register payroll employees via CSV. Future HRMS integration path.
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
                ✓ {result.created} employee record{result.created === 1 ? "" : "s"} created.
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
