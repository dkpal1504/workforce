import { Router } from "express";
import { prisma } from "../db";
import { requireAuth, requireRoles } from "../middleware/auth";
import { writeAudit } from "../audit";
import { canonicalEcNo, canonicalEcNoKey } from "../services/employeeIdentity";
import { initialCredentialState } from "../services/defaultLoginCredentials";
import { credentialRecipientFor, sendInitialCredentialEmail } from "../services/credentialEmail";
import { processCredentialDeliveries } from "../services/credentialDelivery";
import { columnIndexByName, isCsvInjection, readCsvFile, rowReader } from "../services/csvParser";

/**
 * CSV upload for employee master data (CR#2) — future HRMS integration path.
 *
 * Role-gated (ADMIN/HR), audited, server-side validation with CSV-injection
 * neutralization (cells starting with = + - @ are rejected), and per-row
 * validation errors surfaced (never silent partial acceptance). Template
 * download is provided for correct column ordering.
 *
 * Expected columns (order):
 *   ecNo, name, departmentName, sectionName, designation, category, email, mobile
 *
 * File reading (RFC-ish quoting, the 2MB ceiling) and the formula-injection check
 * are shared with the Job Order import in `services/csvParser.ts`.
 *
 * Each row provisions the Employee master data AND the login account, exactly like
 * the Employee Registration screen: role EMPLOYEE, ecNo login, the local dev
 * bootstrap password pre-production (changeable afterwards) and the credential
 * e-mail sent to the employee's own address, or to the shared credential inbox when
 * the row carries no email.
 */

export const csvUploadRouter = Router();

csvUploadRouter.use(requireAuth, requireRoles("ADMIN", "HR"));

const EXPECTED_HEADERS = ["ecNo", "name", "departmentName", "sectionName", "designation", "category", "email", "mobile"];

/**
 * Download the CSV template (GET /api/csv-upload/template).
 *
 * The example row uses a Department/Section pair that actually exists in the
 * master data — Department and Section are matched by exact name, so a template
 * built from invented names fails every row the user uploads. `email` is optional;
 * leave it blank and the credential notice goes to the shared inbox.
 */
csvUploadRouter.get("/template", async (_req, res) => {
  const header = EXPECTED_HEADERS.join(",");
  const sample = await prisma.section.findFirst({
    where: { active: true, department: { active: true } },
    select: { name: true, department: { select: { name: true } } },
    orderBy: { departmentId: "asc" },
  });
  const example = [
    "EMP001", "John Doe",
    sample?.department?.name ?? "Production - EOU",
    sample?.name ?? "Hull Production",
    "Engineer", "PAYROLL", "john.doe@example.com", "9999999999",
  ].join(",");
  const csv = `${header}\n${example}\n`;
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", 'attachment; filename="employee_upload_template.csv"');
  res.send(csv);
});

/** Upload employee master data via CSV (ADMIN/HR gated, audited, validated). */
csvUploadRouter.post("/", async (req, res) => {
  const file = readCsvFile(req.body?.csv);
  if (!file.ok) return res.status(file.status).json({ error: file.error, code: file.code });
  const rows = file.rows;
  const columns = columnIndexByName(rows[0]);
  // Lower-cased on purpose: this message is the contract the Employee page shows.
  const missing = EXPECTED_HEADERS.map((h) => h.toLowerCase()).filter((h) => !columns.has(h));
  if (missing.length) return res.status(400).json({ error: `CSV missing required columns: ${missing.join(", ")}`, code: "MISSING_COLUMNS" });
  // idCardNo was retired. Reject old contracts rather than silently ignoring an identity field.
  if (columns.has("idcardno")) return res.status(400).json({ error: "idCardNo is no longer supported; ecNo is the canonical employee identifier.", code: "LEGACY_IDCARD_COLUMN" });
  const created: number[] = [];
  const errors: { row: number; error: string }[] = [];
  const emailsSent: { row: number; to: string }[] = [];
  const emailFailures: { row: number; to: string; error: string }[] = [];
  const existingEcNos = new Set((await prisma.employee.findMany({ select: { ecNo: true } })).map((employee) => canonicalEcNoKey(employee.ecNo)));

  /**
   * A LabourWorks-style login handle for accounts in the ecNo pool, mirroring the
   * Employee Registration screen. The row's own e-mail address is used when given,
   * so the person keeps a recognisable login id and can receive their credentials.
   */
  async function loginIdentity(ecNo: string, rowEmail: string | null): Promise<{ loginEmail: string; deliverTo: string | null }> {
    if (rowEmail) {
      const taken = await prisma.user.findUnique({ where: { email: rowEmail }, select: { id: true } });
      if (taken) throw new Error(`email ${rowEmail} already has an account.`);
      return { loginEmail: rowEmail, deliverTo: rowEmail };
    }
    const local = ecNo.toLowerCase().replace(/[^a-z0-9._-]/g, "_") || "employee";
    let candidate = `${local}@employee.local`;
    for (let suffix = 1; await prisma.user.findUnique({ where: { email: candidate }, select: { id: true } }); suffix += 1) {
      candidate = `${local}.${suffix}@employee.local`;
    }
    return { loginEmail: candidate, deliverTo: null };
  }

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const get = rowReader(r, columns);
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
    const rowEmail = get("email").toLowerCase();
    if (rowEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(rowEmail)) {
      errors.push({ row: i + 1, error: `'${rowEmail}' is not a valid e-mail address.` });
      continue;
    }

    let login: { loginEmail: string; deliverTo: string | null };
    try {
      login = await loginIdentity(ecNo, rowEmail || null);
    } catch (e) {
      errors.push({ row: i + 1, error: e instanceof Error ? e.message : String(e) });
      continue;
    }

    try {
      // Same shape as the Employee Registration screen: master data + assignment +
      // a login account, so the person can sign in (ecNo) and can later be elevated
      // to HOD/PM from Role Assignment.
      const credential = await initialCredentialState();
      const emp = await prisma.$transaction(async (tx) => {
        const employee = await tx.employee.create({ data: {
          ecNo, name, departmentId: department.id, designation: get("designation"),
          category: get("category") || "PAYROLL", employmentType: "PAYROLL",
          mobile: get("mobile") || null,
          source: "PAYROLL", active: true,
        } });
        await tx.employeeSectionAssignment.create({ data: { employeeId: employee.id, sectionId: section.id, source: "CSV" } });
        const user = await tx.user.create({ data: {
          employeeId: employee.id, email: login.loginEmail, ...credential, name: employee.name,
          role: "EMPLOYEE", source: "MANUAL", departmentId: employee.departmentId,
        } });
        // Durable fallback: if the direct send below cannot go out, the credential
        // worker owns delivery, exactly as for a screen registration.
        await tx.credentialDelivery.create({
          data: { userId: user.id, recipient: credentialRecipientFor(login.deliverTo), purpose: "INITIAL" },
        });
        return { employee, user };
      });
      created.push(emp.employee.id);
      existingEcNos.add(canonicalEcNoKey(ecNo));

      const outcome = await sendInitialCredentialEmail(emp.user.id, {
        employeeEmail: login.deliverTo, ecNo, purpose: "CSV_IMPORT",
      });
      if (outcome.sent) emailsSent.push({ row: i + 1, to: outcome.recipient });
      else emailFailures.push({ row: i + 1, to: outcome.recipient, error: outcome.reason ?? "not sent" });
    } catch (e) {
      errors.push({ row: i + 1, error: e instanceof Error ? e.message : String(e) });
    }
  }
  await writeAudit(req.user!.id, "EMPLOYEE_CSV_UPLOAD", "employee", created.length, {
    created: created.length, errors: errors.length, emailsSent: emailsSent.length, emailFailures: emailFailures.length,
  });
  // Any account whose direct e-mail failed is left to the credential queue. Deliver
  // it inline when the worker is configured; otherwise it stays PENDING by design
  // and the failure is reported per row so nobody assumes mail went out.
  let queuedDeliveries: { processed: number; sent: number; pending: number; disabled: boolean } | null = null;
  if (emailFailures.length) {
    try {
      const result = await processCredentialDeliveries();
      queuedDeliveries = { processed: result.processed, sent: result.sent, pending: result.pending, disabled: result.disabled };
    } catch {
      queuedDeliveries = null;
    }
  }
  res.status(created.length ? 201 : 400).json({
    ok: created.length > 0,
    created: created.length,
    accountsCreated: created.length,
    emailsSent,
    emailFailures,
    queuedDeliveries,
    errors,
  });
});
