import { Router } from "express";
import { prisma } from "../db";
import { requireAuth, requireRoles } from "../middleware/auth";
import { writeAudit } from "../audit";
import { buildCsvText, readCsvFile } from "../services/csvParser";
import {
  JOB_ORDER_CSV_HEADERS,
  checkJobOrderHeader,
  codeKey,
  planJobOrderImport,
  projectCodeOfRow,
  type JobOrderImportMasters,
  type JobOrderRowIssue,
} from "../services/jobOrderCsv";

/**
 * Job Order master-data CSV import (CR: master data for production).
 *
 * Role-gated to ADMIN/PM (the Employee uploader stays ADMIN/HR), audited, and
 * validated server-side against the Project / WBS / Network / UoM / Department /
 * Section masters. Every rejected row is reported with its row number and column,
 * so a file is never partially accepted in silence; nothing is ever auto-created.
 *
 * Routes:
 *   GET  /template   the template CSV (fixed header row + one real example row)
 *   POST /           upload raw CSV text as { "csv": "<text>" }
 */
export const jobOrderCsvRouter = Router();

jobOrderCsvRouter.use(requireAuth, requireRoles("ADMIN", "PM"));

/**
 * Download the Job Order CSV template.
 *
 * The header row is the contract order. The example row is copied from an existing
 * Job Order, so every master value in it (Project, WBS, Network, UoM, Department,
 * Section) really exists: an invented example would be rejected on upload. Leaving
 * it in place is harmless as well - it is an exact duplicate of an existing row, so
 * the upload reports it instead of creating a Job Order by accident.
 */
jobOrderCsvRouter.get("/template", async (_req, res) => {
  const sample = await prisma.jobOrder.findFirst({
    where: { project: { active: true } },
    orderBy: { id: "asc" },
    select: {
      code: true,
      name: true,
      budgetedQuantity: true,
      budgetedHours: true,
      status: true,
      project: { select: { code: true, name: true } },
      projectWbs: { select: { wbsCode: true } },
      network: { select: { code: true } },
      uom: { select: { code: true } },
      department: { select: { name: true } },
      section: { select: { name: true } },
    },
  });
  const rows: string[][] = [[...JOB_ORDER_CSV_HEADERS]];
  if (sample) {
    rows.push([
      sample.project.code,
      sample.project.name,
      sample.projectWbs.wbsCode,
      sample.network.code,
      sample.code,
      sample.name,
      sample.uom.code,
      String(sample.budgetedQuantity),
      String(sample.budgetedHours),
      sample.department.name,
      sample.section?.name ?? "",
      sample.status === "inactive" ? "In-Active" : "Active",
    ]);
  }
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", 'attachment; filename="job_order_upload_template.csv"');
  res.send(buildCsvText(rows));
});

/**
 * Load the master snapshot the planner validates against, in a fixed number of
 * queries rather than one per row. Codes are matched case-insensitively by
 * `codeKey`, so the Job Order query is scoped by project id, not by a
 * case-sensitive code filter.
 */
async function loadJobOrderMasters(rows: string[][]): Promise<JobOrderImportMasters> {
  const projects = await prisma.project.findMany({
    select: { id: true, code: true, name: true, isNonProject: true, active: true },
  });
  const wantedCodes = new Set<string>();
  for (let i = 1; i < rows.length; i++) {
    const code = codeKey(projectCodeOfRow(rows[i]));
    if (code) wantedCodes.add(code);
  }
  const wantedProjectIds = projects.filter((project) => wantedCodes.has(codeKey(project.code))).map((project) => project.id);
  const [departments, sections, wbsRows, networks, uoms, existingJobOrders] = await Promise.all([
    prisma.department.findMany({ select: { id: true, name: true, active: true } }),
    prisma.section.findMany({ select: { id: true, departmentId: true, name: true, active: true } }),
    prisma.projectWbs.findMany({ select: { id: true, projectId: true, wbsCode: true, active: true } }),
    prisma.network.findMany({ select: { id: true, projectId: true, code: true, active: true } }),
    prisma.uom.findMany({ select: { id: true, code: true, active: true } }),
    prisma.jobOrder.findMany({
      where: { projectId: { in: wantedProjectIds.length ? wantedProjectIds : [-1] } },
      select: { id: true, projectId: true, code: true, projectWbs: { select: { wbsCode: true } } },
    }),
  ]);
  return {
    departments,
    sections,
    projects,
    wbsRows,
    networks,
    uoms,
    existingJobOrders: existingJobOrders.map((jobOrder) => ({
      id: jobOrder.id,
      projectId: jobOrder.projectId,
      code: jobOrder.code,
      wbsCode: jobOrder.projectWbs.wbsCode,
    })),
  };
}

export type CreatedJobOrderRow = {
  row: number;
  id: number;
  jobOrder: string;
  projectId: number;
  projectWbsId: number;
  status: string;
};

/**
 * Upload Job Orders as CSV text (ADMIN/PM, audited, validated, never silent).
 *
 * Response: the counts of created / skipped / rejected rows plus the per-row
 * report. `ok` means no row was refused (`rejected === 0`); a file whose rows all
 * already exist is a success that created nothing.
 *   201 - at least one Job Order was created
 *   200 - nothing to do (every row already exists)
 *   400 - at least one row was refused (or the file/header is unusable)
 */
jobOrderCsvRouter.post("/", async (req, res) => {
  const file = readCsvFile(req.body?.csv);
  if (!file.ok) return res.status(file.status).json({ error: file.error, code: file.code });

  const header = checkJobOrderHeader(file.rows[0]);
  if (!header.ok) {
    const total = file.rows.length - 1;
    // A refused file is still an upload attempt, so it is audited with the counts.
    await writeAudit(req.user!.id, "JOB_ORDER_CSV_UPLOAD", "job_order", 0, {
      total, created: 0, skipped: 0, rejected: total, stage: "HEADER_MISMATCH",
    });
    return res.status(400).json({ error: header.error, code: "HEADER_MISMATCH" });
  }

  const masters = await loadJobOrderMasters(file.rows);
  const plan = planJobOrderImport(file.rows, masters);

  const createdRows: CreatedJobOrderRow[] = [];
  const errors: JobOrderRowIssue[] = [...plan.errors];
  for (const item of plan.create) {
    try {
      const jobOrder = await prisma.$transaction(async (tx) => {
        const created = await tx.jobOrder.create({
          data: {
            projectId: item.projectId,
            projectWbsId: item.projectWbsId,
            networkId: item.networkId,
            code: item.code,
            name: item.name,
            uomId: item.uomId,
            budgetedQuantity: item.budgetedQuantity,
            budgetedHours: item.budgetedHours,
            departmentId: item.departmentId,
            sectionId: item.sectionId,
            status: item.status,
          },
        });
        // Revision 1 is the budget set when the Job Order is created, so consumption
        // is measured against an effective-dated budget from day one.
        await tx.jobOrderBudgetRevision.create({
          data: {
            jobOrderId: created.id,
            revisionNo: 1,
            budgetedHours: item.budgetedHours,
            budgetedQuantity: item.budgetedQuantity,
            uomId: item.uomId,
            effectiveFrom: new Date(),
            reason: "Initial budget from the Job Order CSV import",
            createdById: req.user!.id,
          },
        });
        return created;
      });
      createdRows.push({
        row: item.row,
        id: jobOrder.id,
        jobOrder: jobOrder.code,
        projectId: jobOrder.projectId,
        projectWbsId: jobOrder.projectWbsId,
        status: jobOrder.status,
      });
    } catch (error) {
      // A unique-constraint clash here means another upload created the same Job
      // Order between validation and insert. The row is reported, never retried
      // blindly against a budget that already exists.
      errors.push({
        row: item.row,
        column: "Job_Order",
        message: `Job Order '${item.code}' could not be created: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  const created = createdRows.length;
  const rejected = plan.rejected + (plan.create.length - created);
  const skipped = plan.skipped;
  const total = plan.total;
  errors.sort((a, b) => a.row - b.row);

  await writeAudit(req.user!.id, "JOB_ORDER_CSV_UPLOAD", "job_order", created, {
    total, created, skipped, rejected, template: JOB_ORDER_CSV_HEADERS.join(","),
  });

  return res.status(created > 0 ? 201 : rejected > 0 ? 400 : 200).json({
    ok: rejected === 0,
    total,
    created,
    skipped,
    rejected,
    createdRows,
    skippedRows: plan.skippedRows,
    errors,
  });
});
