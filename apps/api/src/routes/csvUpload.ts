import { Router } from "express";
import { prisma } from "../db";
import { requireAuth, requireRoles } from "../middleware/auth";
import { writeAudit } from "../audit";
import { canonicalEcNo, canonicalEcNoKey } from "../services/employeeIdentity";

/**
 * CSV upload for employee master data (CR#2) — future HRMS integration path.
 *
 * Role-gated (ADMIN/HR), audited, server-side validation with CSV-injection
 * neutralization (cells starting with = + - @ are rejected), and per-row
 * validation errors surfaced (never silent partial acceptance). Template
 * download is provided for correct column ordering.
 *
 * Expected columns (order):
 *   ecNo, name, departmentName, sectionName, designation, category
 */

export const csvUploadRouter = Router();

csvUploadRouter.use(requireAuth, requireRoles("ADMIN", "HR"));

const EXPECTED_HEADERS = ["ecNo", "name", "departmentName", "sectionName", "designation", "category"];

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
  const example = ["EMP001", "John Doe", "Hull Production", "Fabrication", "Engineer", "PAYROLL"].join(",");
  const csv = `${header}\n${example}\n`;
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", 'attachment; filename="employee_upload_template.csv"');
  res.send(csv);
});

/** Upload employee master data via CSV (ADMIN/HR gated, audited, validated). */
csvUploadRouter.post("/", async (req, res) => {
  const text = typeof req.body?.csv === "string" ? req.body.csv : null;
  if (!text?.trim()) return res.status(400).json({ error: "csv data is required (send raw CSV text).", code: "EMPTY_CSV" });
  if (text.length > 2 * 1024 * 1024) return res.status(400).json({ error: "CSV file exceeds 2MB limit.", code: "FILE_TOO_LARGE" });
  const rows = parseCsv(text);
  if (rows.length < 2) return res.status(400).json({ error: "CSV must have a header row + at least one data row.", code: "INVALID_CSV" });
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const expectedLower = EXPECTED_HEADERS.map((h) => h.toLowerCase());
  const missing = expectedLower.filter((h) => !header.includes(h));
  if (missing.length) return res.status(400).json({ error: `CSV missing required columns: ${missing.join(", ")}`, code: "MISSING_COLUMNS" });
  // idCardNo was retired. Reject old contracts rather than silently ignoring an identity field.
  if (header.includes("idcardno")) return res.status(400).json({ error: "idCardNo is no longer supported; ecNo is the canonical employee identifier.", code: "LEGACY_IDCARD_COLUMN" });
  const colIndex = (name: string) => header.indexOf(name.toLowerCase());
  const created: number[] = [];
  const errors: { row: number; error: string }[] = [];
  const existingEcNos = new Set((await prisma.employee.findMany({ select: { ecNo: true } })).map((employee) => canonicalEcNoKey(employee.ecNo)));

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const get = (name: string) => (r[colIndex(name)] || "").trim();
    const ecNo = canonicalEcNo(get("ecNo"));
    const name = get("name");
    const departmentName = get("departmentName");
    const sectionName = get("sectionName");
    if (!ecNo || !name || !departmentName || !sectionName) {
      errors.push({ row: i + 1, error: "ecNo, name, departmentName and sectionName are required." });
      continue;
    }
    if (r.some(isCsvInjection)) {
      errors.push({ row: i + 1, error: "Cell starts with =, +, -, or @ (possible CSV injection); rejected." });
      continue;
    }
    if (existingEcNos.has(canonicalEcNoKey(ecNo))) {
      errors.push({ row: i + 1, error: `ecNo ${ecNo} already exists.` });
      continue;
    }
    // Master rows must be provisioned first. CSV import never invents an
    // organization or falls back to department id 1.
    const department = await prisma.department.findUnique({ where: { name: departmentName } });
    if (!department || !department.active) {
      errors.push({ row: i + 1, error: `Active department '${departmentName}' was not found.` });
      continue;
    }
    const section = await prisma.section.findFirst({ where: { departmentId: department.id, name: sectionName, active: true } });
    if (!section) {
      errors.push({ row: i + 1, error: `Active section '${sectionName}' was not found under '${departmentName}'.` });
      continue;
    }
    try {
      const emp = await prisma.$transaction(async (tx) => {
        const employee = await tx.employee.create({ data: {
          ecNo, name, departmentId: department.id, designation: get("designation"),
          category: get("category") || "PAYROLL", employmentType: "PAYROLL",
          source: "PAYROLL", active: true,
        } });
        await tx.employeeSectionAssignment.create({ data: { employeeId: employee.id, sectionId: section.id, source: "CSV" } });
        return employee;
      });
      created.push(emp.id);
      existingEcNos.add(canonicalEcNoKey(ecNo));
    } catch (e) {
      errors.push({ row: i + 1, error: e instanceof Error ? e.message : String(e) });
    }
  }
  await writeAudit(req.user!.id, "EMPLOYEE_CSV_UPLOAD", "employee", created.length, { created: created.length, errors: errors.length });
  res.status(created.length ? 201 : 400).json({ ok: created.length > 0, created: created.length, errors });
});
