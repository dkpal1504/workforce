import { Router } from "express";
import { prisma } from "../db";
import { requireAuth, requireRoles } from "../middleware/auth";
import { writeAudit } from "../audit";
import { buildCsvText, readCsvFile } from "../services/csvParser";
import {
  JOB_ORDER_CSV_HEADERS,
  PENDING_MASTER_ID,
  checkJobOrderHeader,
  codeKey,
  planJobOrderImport,
  projectCodeOfRow,
  projectScopedKey,
  type JobOrderImportMasters,
  type JobOrderRowIssue,
} from "../services/jobOrderCsv";

/**
 * Job Order master-data CSV import (CR: master data for production).
 *
 * Role-gated to ADMIN/PM (the Employee uploader stays ADMIN/HR), audited, and
 * validated server-side against the Project / WBS / Network / UoM / Department /
 * Section masters. Every rejected row is reported with its row number and column,
 * so a file is never silently partial.
 *
 * Auto-creation is narrow: a missing WBS or Network (only) is created on request
 * (`createMissingMasters`, default true) together with the Job Orders in ONE
 * transaction, and the response reports each created master with the row that
 * introduced it. A missing Project, UoM, Department or Section still refuses its
 * row and names what is missing.
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

/** A WBS master an upload created, with the file row that introduced it. */
export type CreatedWbsRow = {
  row: number;
  id: number;
  projectId: number;
  projectCode: string;
  wbsCode: string;
};

/** A Network master an upload created, with the file row that introduced it. */
export type CreatedNetworkRow = {
  row: number;
  id: number;
  projectId: number;
  projectCode: string;
  networkCode: string;
};

/**
 * Upload Job Orders as CSV text (ADMIN/PM, audited, validated, never silent).
 *
 * Body: `{ csv: "<text>", createMissingMasters?: boolean }`. The flag defaults to
 * TRUE: a row that names a WBS_NO or a Network_ID which does not exist under its
 * project CREATES the missing master and imports the row. Set it to false to
 * refuse such a row with the old message instead. A Project, UoM, Department or
 * Section is never created, either way.
 *
 * Response: the counts of created / skipped / rejected rows, the masters created
 * (`wbsCreated` / `networksCreated` counts plus `createdWbs` / `createdNetworks`,
 * each naming the code and the row that introduced it), and the per-row report.
 * `ok` means no row was refused (`rejected === 0`); a file whose rows all already
 * exist is a success that created nothing.
 *   201 - at least one Job Order was created
 *   200 - nothing to do (every row already exists)
 *   400 - at least one row was refused (or the file/header/flag is unusable)
 */
jobOrderCsvRouter.post("/", async (req, res) => {
  const file = readCsvFile(req.body?.csv);
  if (!file.ok) return res.status(file.status).json({ error: file.error, code: file.code });

  // Auto-creation is the default the operator asked for. A non-boolean flag is
  // refused rather than guessed, so a client typo cannot silently flip the rule.
  const rawFlag = req.body?.createMissingMasters;
  if (rawFlag !== undefined && typeof rawFlag !== "boolean") {
    return res.status(400).json({ error: "createMissingMasters must be true or false.", code: "INVALID_FLAG" });
  }
  const createMissingMasters = rawFlag ?? true;

  const header = checkJobOrderHeader(file.rows[0]);
  if (!header.ok) {
    const total = file.rows.length - 1;
    // A refused file is still an upload attempt, so it is audited with the counts.
    await writeAudit(req.user!.id, "JOB_ORDER_CSV_UPLOAD", "job_order", 0, {
      total, created: 0, skipped: 0, rejected: total, stage: "HEADER_MISMATCH", createMissingMasters,
    });
    return res.status(400).json({ error: header.error, code: "HEADER_MISMATCH" });
  }

  const masters = await loadJobOrderMasters(file.rows);
  const plan = planJobOrderImport(file.rows, masters, { createMissingMasters });

  const createdRows: CreatedJobOrderRow[] = [];
  const createdWbs: CreatedWbsRow[] = [];
  const createdNetworks: CreatedNetworkRow[] = [];
  const errors: JobOrderRowIssue[] = [...plan.errors];
  let batchFailure: string | null = null;

  // ONE transaction for the whole file: the masters it introduces and the Job
  // Orders that asked for them are written together, so a failure can leave
  // neither a master without its Job Orders nor the reverse. A `pending` row
  // (PENDING_MASTER_ID) is resolved from the id the master insert just returned.
  try {
    await prisma.$transaction(async (tx) => {
      const wbsIds = new Map<string, number>();
      for (const master of plan.wbsToCreate) {
        const inserted = await tx.projectWbs.create({
          data: { projectId: master.projectId, wbsCode: master.wbsCode },
          select: { id: true },
        });
        wbsIds.set(projectScopedKey(master.projectId, master.wbsCode), inserted.id);
        createdWbs.push({
          row: master.row,
          id: inserted.id,
          projectId: master.projectId,
          projectCode: master.projectCode,
          wbsCode: master.wbsCode,
        });
      }
      const networkIds = new Map<string, number>();
      for (const master of plan.networksToCreate) {
        const inserted = await tx.network.create({
          data: { projectId: master.projectId, code: master.networkCode, source: "MANUAL" },
          select: { id: true },
        });
        networkIds.set(projectScopedKey(master.projectId, master.networkCode), inserted.id);
        createdNetworks.push({
          row: master.row,
          id: inserted.id,
          projectId: master.projectId,
          projectCode: master.projectCode,
          networkCode: master.networkCode,
        });
      }
      for (const item of plan.create) {
        const projectWbsId = item.projectWbsId === PENDING_MASTER_ID
          ? wbsIds.get(projectScopedKey(item.projectId, item.wbsCode))
          : item.projectWbsId;
        const networkId = item.networkId === PENDING_MASTER_ID
          ? networkIds.get(projectScopedKey(item.projectId, item.networkCode))
          : item.networkId;
        if (projectWbsId === undefined || networkId === undefined) {
          throw new Error(`row ${item.row} refers to a master the upload planned but did not create; the whole file was refused.`);
        }
        const created = await tx.jobOrder.create({
          data: {
            projectId: item.projectId,
            projectWbsId,
            networkId,
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
        createdRows.push({
          row: item.row,
          id: created.id,
          jobOrder: created.code,
          projectId: created.projectId,
          projectWbsId: created.projectWbsId,
          status: created.status,
        });
      }
    }, { timeout: 60_000, maxWait: 10_000 });
  } catch (error) {
    // A unique-constraint clash (another upload won the race) or any other write
    // failure rolls the WHOLE file back, masters included, so no master is left
    // without its Job Orders. Each planned row is then reported as refused.
    batchFailure = error instanceof Error ? error.message : String(error);
    createdRows.length = 0;
    createdWbs.length = 0;
    createdNetworks.length = 0;
    for (const item of plan.create) {
      errors.push({
        row: item.row,
        column: "Job_Order",
        message: `nothing was written: the upload transaction failed for the whole file (${batchFailure}).`,
      });
    }
  }

  const created = createdRows.length;
  const rejected = plan.rejected + (plan.create.length - created);
  const skipped = plan.skipped;
  const total = plan.total;
  errors.sort((a, b) => a.row - b.row);

  const wbsCreated = createdWbs.length;
  const networksCreated = createdNetworks.length;

  await writeAudit(req.user!.id, "JOB_ORDER_CSV_UPLOAD", "job_order", created, {
    total,
    created,
    skipped,
    rejected,
    template: JOB_ORDER_CSV_HEADERS.join(","),
    createMissingMasters,
    wbsCreated,
    networksCreated,
    createdWbs,
    createdNetworks,
  });

  return res.status(created > 0 ? 201 : rejected > 0 ? 400 : 200).json({
    ok: rejected === 0,
    total,
    created,
    skipped,
    rejected,
    createMissingMasters,
    wbsCreated,
    networksCreated,
    createdRows,
    createdWbs,
    createdNetworks,
    skippedRows: plan.skippedRows,
    errors,
  });
});
