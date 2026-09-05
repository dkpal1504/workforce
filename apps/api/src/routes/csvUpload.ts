import { Router } from "express";
import { prisma } from "../db";
import { requireAuth, requireRoles } from "../middleware/auth";
import { writeAudit } from "../audit";

/**
 * CSV upload for employee master data (CR#2) — future HRMS integration path.
 *
 * Role-gated (ADMIN/HR), audited, server-side validation with CSV-injection
 * neutralization (cells starting with = + - @ are rejected), and per-row
 * validation errors surfaced (never silent partial acceptance). Template
 * download is provided for correct column ordering.
 *
 * Expected columns (order):
 *   ecNo, idCardNo, name, departmentName, designation, category, grade, section, plant
 */

export const csvUploadRouter = Router();

csvUploadRouter.use(requireAuth, requireRoles("ADMIN", "HR"));

const EXPECTED_HEADERS = ["ecNo", "idCardNo", "name", "departmentName", "designation", "category", "grade", "section", "plant"];

/** Neutralize CSV injection: a cell starting with =,+,-,@ is a formula-injection risk. */
function isCsvInjection(value: string): boolean {
  const first = value.trim().charAt(0);
  return first === "=" || first === "+" || first === "-" || first === "@";
}

/** Parse a CSV string (handles quoted fields and embedded commas). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      if (cell !== "" || row.length > 0) row.push(cell);
      if (row.length > 0 || cell !== "") rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** Download the CSV template (GET /api/csv-upload/template). */
csvUploadRouter.get("/template", (_req, res) => {
  const header = EXPECTED_HEADERS.join(",");
  const example = ["EMP001", "PAY001", "John Doe", "Hull Production", "Engineer", "PAYROLL", "Plumber", "Mechanical", "Plant A"].join(",");
  const csv = `${header}\n${example}\n`;
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", 'attachment; filename="employee_upload_template.csv"');
  res.send(csv);
});

/** Upload employee master data via CSV (ADMIN/HR gated, audited, validated). */
csvUploadRouter.post("/", async (req, res) => {
  const text = typeof req.body?.csv === "string" ? req.body.csv : null;
  if (!text || text.trim() === "") {
    return res.status(400).json({ error: "csv data is required (send raw CSV text).", code: "EMPTY_CSV" });
  }
  if (text.length > 2 * 1024 * 1024) {
    return res.status(400).json({ error: "CSV file exceeds 2MB limit.", code: "FILE_TOO_LARGE" });
  }

  const rows = parseCsv(text);
  if (rows.length < 2) {
    return res.status(400).json({ error: "CSV must have a header row + at least one data row.", code: "INVALID_CSV" });
  }

  // Normalize header (trim, lowercase) and verify.
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const expectedLower = EXPECTED_HEADERS.map((h) => h.toLowerCase());
  const missing = expectedLower.filter((h) => !header.includes(h));
  if (missing.length) {
    return res.status(400).json({ error: `CSV missing required columns: ${missing.join(", ")}`, code: "MISSING_COLUMNS" });
  }
  const colIndex = (name: string) => header.indexOf(name.toLowerCase());

  const created: number[] = [];
  const errors: { row: number; error: string }[] = [];

  // Auto-create referenced departments (idempotent on code) and map names.
  const deptNames = new Set<string>();
  for (let i = 1; i < rows.length; i++) {
    const name = (rows[i][colIndex("departmentName")] || "").trim();
    if (name) deptNames.add(name);
  }
  const deptByName = new Map<string, number>();
  for (const name of deptNames) {
    const code = name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "UNASSIGNED";
    let dept = await prisma.department.findUnique({ where: { code } });
    if (!dept) {
      dept = await prisma.department.create({ data: { name, code, source: "MANUAL" } });
    }
    deptByName.set(name, dept.id);
  }

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const get = (name: string) => (r[colIndex(name)] || "").trim();

    const ecNo = get("ecNo");
    const idCardNo = get("idCardNo");
    const name = get("name");
    const departmentName = get("departmentName");

    // Validate required fields.
    if (!ecNo || !name) {
      errors.push({ row: i + 1, error: "ecNo and name are required." });
      continue;
    }
    // CSV-injection check on every field.
    let injection = false;
    for (const cell of r) {
      if (isCsvInjection(cell)) { injection = true; break; }
    }
    if (injection) {
      errors.push({ row: i + 1, error: "Cell starts with =, +, -, or @ (possible CSV injection); rejected." });
      continue;
    }
    // ecNo unique.
    const existingEcNo = await prisma.employee.findUnique({ where: { ecNo } });
    if (existingEcNo) {
      errors.push({ row: i + 1, error: `ecNo ${ecNo} already exists.` });
      continue;
    }

    const deptId = departmentName ? deptByName.get(departmentName) ?? 1 : 1;

    try {
      const emp = await prisma.employee.create({
        data: {
          ecNo,
          idCardNo: idCardNo || null,
          name,
          departmentId: deptId,
          designation: get("designation") || "",
          category: get("category") || "PAYROLL",
          source: get("category")?.toUpperCase() === "PAYROLL" ? "PAYROLL" : "MANUAL",
          grade: get("grade") || null,
          section: get("section") || null,
          plant: get("plant") || null,
          active: true,
        },
      });
      created.push(emp.id);
    } catch (e) {
      errors.push({ row: i + 1, error: e instanceof Error ? e.message : String(e) });
    }
  }

  await writeAudit(req.user!.id, "EMPLOYEE_CSV_UPLOAD", "employee", created.length, {
    created: created.length,
    errors: errors.length,
  });

  res.status(created.length ? 201 : 400).json({
    ok: created.length > 0,
    created: created.length,
    errors,
    // If any errors, return 200 with created count + errors so the UI can
    // show which rows failed (not silent partial acceptance).
  });
});
