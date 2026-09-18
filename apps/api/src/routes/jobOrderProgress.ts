import { Request, Response, Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db";
import { requireAuth, requireRoles } from "../middleware/auth";
import { writeAudit } from "../audit";
import { formatDateOnly, parseDateOnly } from "../utils/date";
import {
  REMARK_KINDS,
  achievedBefore,
  achievedQuantity,
  budgetInForce,
  canPunchJobOrder,
  isRemarkKind,
  jobOrderDisplay,
  latestRemarkForWrite,
  mapRemarkHistory,
  planAmendment,
  planDecision,
  planPunch,
  planRemarkWrite,
  quantityBalance,
  remarkKindForAction,
  remarkReportScope,
  resolvePunchScope,
  type BudgetRevisionRow,
  type ProgressActor,
  type ProgressRow,
  type RemarkKind,
  type RuleError,
  type RuleResult,
} from "../services/jobOrderProgress";

/**
 * Job Order quantity progress — HOD punching and PM approval (CR#2).
 *
 * The HOD punches the CUMULATIVE quantity achieved to date for a Job Order; the PM
 * approves, rejects or sends it back. An HOD may revise a figure only after a
 * rejection or a send-back, and the revision is a NEW row (revision_no + 1) so the
 * refused figure stays in the history. Hours are a separate measure and never move
 * through this router.
 *
 * Scope: a section HOD punches only its own section. A Department Head, and a
 * department-level HOD (a user whose section is null), own every section under the
 * department and must select the section they are punching for.
 *
 * Mounted by the integration lead in apps/api/src/index.ts:
 *   import { jobOrderProgressRouter } from "./routes/jobOrderProgress";
 *   api.use("/job-order-progress", jobOrderProgressRouter);
 */

export const jobOrderProgressRouter = Router();

jobOrderProgressRouter.use(requireAuth);

const entryInclude = {
  jobOrder: { include: { project: true, projectWbs: true, uom: true } },
  section: { select: { id: true, code: true, name: true } },
  punchedBy: { select: { id: true, name: true } },
  approvedBy: { select: { id: true, name: true } },
  // Every remark ever written about this entry, oldest first. The entry's own
  // `remarks` column only carries the latest message.
  remarkHistory: { include: { author: { select: { name: true } } }, orderBy: { createdAt: "asc" } },
} as const;

type EntryWithRelations = Prisma.JobOrderProgressGetPayload<{ include: typeof entryInclude }>;

type ProgressDateRow = {
  jobOrderId: number;
  progressDate: Date;
  revisionNo: number;
  cumulativeQuantity: number;
  status: string;
};

const optionalId = z.union([z.coerce.number().int().positive(), z.null()]).optional();
const optionalRemarks = z.union([z.string().trim().max(500), z.null()]).optional();

const punchSchema = z.object({
  jobOrderId: z.coerce.number().int().positive(),
  progressDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "progressDate must be YYYY-MM-DD"),
  cumulativeQuantity: z.coerce.number().finite(),
  sectionId: optionalId,
  remarks: optionalRemarks,
});

const amendSchema = z.object({
  cumulativeQuantity: z.coerce.number().finite(),
  remarks: optionalRemarks,
});

const decisionSchema = z.object({
  action: z.enum(["APPROVE", "REJECT", "SEND_BACK"], { errorMap: () => ({ message: "action must be APPROVE, REJECT or SEND_BACK" }) }),
  remarks: optionalRemarks,
});

function actorOf(req: Request): ProgressActor {
  const user = req.user!;
  return { id: user.id, role: user.role, departmentId: user.departmentId, sectionId: user.sectionId };
}

/** A refused rule answers with the rule's own status and a stable code. */
function sendRuleError(res: Response, error: RuleError) {
  return res.status(error.status).json({ error: error.error, code: error.code });
}

function invalidPayload(res: Response, error: z.ZodError) {
  return res.status(400).json({ error: error.issues[0]?.message ?? "Invalid request payload.", code: "INVALID_PAYLOAD" });
}

function optionalInt(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function pathId(value: string): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** A rule refusal raised inside a transaction, answered with the rule's own status. */
class RuleFailure extends Error {
  readonly ruleCode: string;
  readonly status: number;
  constructor(error: RuleError) {
    super(error.error);
    this.ruleCode = error.code;
    this.status = error.status;
  }
}

function throwRuleError(error: RuleError): never {
  throw new RuleFailure(error);
}

function isRuleFailure(error: unknown): error is RuleFailure {
  return error instanceof RuleFailure;
}

function sendRuleFailure(res: Response, failure: RuleFailure) {
  return res.status(failure.status).json({ error: failure.message, code: failure.ruleCode });
}

/**
 * Insert one remark row. Called inside the same transaction as the entry change, so
 * a failure can never leave a remark without its entry or the entry without its remark.
 */
async function writeRemarkRow(
  tx: Prisma.TransactionClient,
  progressId: number,
  kind: RemarkKind,
  remark: string | null | undefined,
  actor: ProgressActor
): Promise<void> {
  const plan = planRemarkWrite({ progressId, kind, remark, authorId: actor.id, authorRole: actor.role });
  if (!plan.ok) throwRuleError(plan.error);
  if (plan.value) await tx.jobOrderProgressRemark.create({ data: plan.value });
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}

function isDateOnly(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** Pure rule rows carry the date as YYYY-MM-DD so the rules stay database-free. */
function toRuleRows(rows: ProgressDateRow[]): ProgressRow[] {
  return rows.map((row) => ({
    progressDate: formatDateOnly(row.progressDate),
    revisionNo: row.revisionNo,
    cumulativeQuantity: row.cumulativeQuantity,
    status: row.status,
  }));
}

function groupBy<T, K>(rows: T[], key: (row: T) => K): Map<K, T[]> {
  const grouped = new Map<K, T[]>();
  for (const row of rows) {
    const bucket = grouped.get(key(row));
    if (bucket) bucket.push(row);
    else grouped.set(key(row), [row]);
  }
  return grouped;
}

function mapEntry(entry: EntryWithRelations) {
  return {
    id: entry.id,
    jobOrderId: entry.jobOrderId,
    progressDate: formatDateOnly(entry.progressDate),
    cumulativeQuantity: entry.cumulativeQuantity,
    revisionNo: entry.revisionNo,
    status: entry.status,
    remarks: entry.remarks,
    section: entry.section ? { id: entry.section.id, code: entry.section.code, name: entry.section.name } : null,
    punchedBy: entry.punchedBy ? { id: entry.punchedBy.id, name: entry.punchedBy.name } : null,
    approvedBy: entry.approvedBy ? { id: entry.approvedBy.id, name: entry.approvedBy.name } : null,
    approvedAt: entry.approvedAt ? entry.approvedAt.toISOString() : null,
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
    remarksHistory: mapRemarkHistory(entry.remarkHistory ?? []),
    jobOrder: {
      id: entry.jobOrder.id,
      code: entry.jobOrder.code,
      name: entry.jobOrder.name,
      display: jobOrderDisplay(entry.jobOrder.code, entry.jobOrder.name),
      status: entry.jobOrder.status,
      sectionId: entry.jobOrder.sectionId,
      budgetedQuantity: entry.jobOrder.budgetedQuantity,
      uom: entry.jobOrder.uom ? { code: entry.jobOrder.uom.code, name: entry.jobOrder.uom.name } : null,
      project: {
        id: entry.jobOrder.project.id,
        code: entry.jobOrder.project.code,
        name: entry.jobOrder.project.name,
        colorKey: entry.jobOrder.project.colorKey,
      },
      projectWbs: entry.jobOrder.projectWbs ? { wbsCode: entry.jobOrder.projectWbs.wbsCode } : null,
    },
  };
}

function budgetRowsFor(rows: { jobOrderId: number; revisionNo: number; effectiveFrom: Date; budgetedQuantity: number }[]) {
  return groupBy(rows, (row) => row.jobOrderId);
}

function toBudgetRevisionRows(rows: { revisionNo: number; effectiveFrom: Date; budgetedQuantity: number }[]): BudgetRevisionRow[] {
  return rows.map((row) => ({
    revisionNo: row.revisionNo,
    effectiveFrom: formatDateOnly(row.effectiveFrom),
    budgetedQuantity: row.budgetedQuantity,
  }));
}

const progressDateSelect = {
  jobOrderId: true,
  progressDate: true,
  revisionNo: true,
  cumulativeQuantity: true,
  status: true,
} as const;

/** GET /api/job-order-progress/mine — the HOD's own entries and the Job Orders he may punch. */
jobOrderProgressRouter.get("/mine", requireRoles("HOD", "DEPT_HEAD", "ADMIN"), async (req, res) => {
  const actor = actorOf(req);
  const requestedSectionId = optionalInt(req.query.sectionId);
  const scope = resolvePunchScope(actor, requestedSectionId);
  const resolvedSectionId = scope.ok ? scope.value : null;
  const departmentId = actor.departmentId;

  const sections = departmentId == null ? [] : await prisma.section.findMany({
    where: { departmentId, active: true, ...(actor.sectionId != null ? { id: actor.sectionId } : {}) },
    select: { id: true, code: true, name: true, departmentId: true },
    orderBy: { name: "asc" },
  });

  const projects = departmentId == null ? [] : await prisma.project.findMany({
    where: { active: true },
    select: { id: true, code: true, name: true, colorKey: true },
    orderBy: { sortOrder: "asc" },
  });

  // A project Job Order is punchable only by its own section; a standing /
  // Non-Project Job Order (section_id IS NULL) by any section of the department.
  const projectId = optionalInt(req.query.projectId);
  const search = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const filters: Record<string, unknown>[] = [];
  if (resolvedSectionId != null) filters.push({ OR: [{ sectionId: resolvedSectionId }, { sectionId: null }] });
  if (search) filters.push({ OR: [{ code: { contains: search } }, { name: { contains: search } }] });

  const jobOrders = departmentId == null || resolvedSectionId == null ? [] : await prisma.jobOrder.findMany({
    where: {
      departmentId,
      status: "active",
      project: { active: true },
      department: { active: true },
      ...(projectId != null ? { projectId } : {}),
      ...(filters.length ? { AND: filters } : {}),
    },
    include: {
      project: { select: { id: true, code: true, name: true, colorKey: true } },
      projectWbs: { select: { wbsCode: true } },
      uom: { select: { code: true, name: true } },
    },
    orderBy: [{ code: "asc" }],
    take: 200,
  });

  const jobOrderIds = jobOrders.map((jobOrder) => jobOrder.id);
  const [approvedRows, latestRows, revisionRows] = jobOrderIds.length
    ? await Promise.all([
        prisma.jobOrderProgress.findMany({ where: { jobOrderId: { in: jobOrderIds }, status: "APPROVED" }, select: progressDateSelect }),
        prisma.jobOrderProgress.findMany({
          where: { jobOrderId: { in: jobOrderIds } },
          select: { id: true, jobOrderId: true, progressDate: true, revisionNo: true, cumulativeQuantity: true, status: true },
          orderBy: [{ progressDate: "desc" }, { revisionNo: "desc" }],
        }),
        prisma.jobOrderBudgetRevision.findMany({
          where: { jobOrderId: { in: jobOrderIds } },
          select: { jobOrderId: true, revisionNo: true, effectiveFrom: true, budgetedQuantity: true },
        }),
      ])
    : [[], [], []];

  const approvedByJobOrder = groupBy(approvedRows, (row) => row.jobOrderId);
  const latestByJobOrder = groupBy(latestRows, (row) => row.jobOrderId);
  const revisionsByJobOrder = budgetRowsFor(revisionRows);
  const today = formatDateOnly(new Date());

  // The HOD's own entries. An Admin may punch for a department and needs oversight,
  // so an Admin sees every entry the department's HODs punched.
  const entryStatus = typeof req.query.status === "string" && req.query.status ? req.query.status : null;
  const entryJobOrderId = optionalInt(req.query.jobOrderId);
  const entries = await prisma.jobOrderProgress.findMany({
    where: {
      ...(actor.role === "ADMIN" ? {} : { punchedById: actor.id }),
      ...(entryStatus ? { status: entryStatus } : {}),
      ...(entryJobOrderId != null ? { jobOrderId: entryJobOrderId } : {}),
    },
    include: entryInclude,
    orderBy: [{ progressDate: "desc" }, { revisionNo: "desc" }],
    take: 100,
  });

  // History: every revision of the (Job Order, date) pairs the caller can see.
  const historyRows = entries.length
    ? await prisma.jobOrderProgress.findMany({
        where: {
          jobOrderId: { in: [...new Set(entries.map((entry) => entry.jobOrderId))] },
          progressDate: { in: entries.map((entry) => entry.progressDate) },
        },
        select: { ...progressDateSelect, id: true, remarks: true, createdAt: true, punchedBy: { select: { name: true } }, approvedBy: { select: { name: true } } },
        orderBy: [{ revisionNo: "asc" }],
      })
    : [];
  const historyByKey = groupBy(historyRows, (row) => `${row.jobOrderId}|${formatDateOnly(row.progressDate)}`);

  res.json({
    requiresSectionSelection: actor.sectionId == null,
    sectionId: resolvedSectionId,
    ...(scope.ok ? {} : { scopeError: { code: scope.error.code, error: scope.error.error } }),
    sections,
    projects,
    jobOrders: jobOrders.map((jobOrder) => {
      const approved = approvedByJobOrder.get(jobOrder.id) ?? [];
      const latest = (latestByJobOrder.get(jobOrder.id) ?? [])[0] ?? null;
      const revisions = revisionsByJobOrder.get(jobOrder.id) ?? [];
      return {
        id: jobOrder.id,
        code: jobOrder.code,
        name: jobOrder.name,
        display: jobOrderDisplay(jobOrder.code, jobOrder.name),
        status: jobOrder.status,
        sectionId: jobOrder.sectionId,
        departmentId: jobOrder.departmentId,
        budgetedQuantity: budgetInForce(toBudgetRevisionRows(revisions), today, jobOrder.budgetedQuantity),
        uom: jobOrder.uom ? { code: jobOrder.uom.code, name: jobOrder.uom.name } : null,
        project: { id: jobOrder.project.id, code: jobOrder.project.code, name: jobOrder.project.name, colorKey: jobOrder.project.colorKey },
        projectWbs: jobOrder.projectWbs ? { wbsCode: jobOrder.projectWbs.wbsCode } : null,
        lastApprovedCumulative: achievedQuantity(toRuleRows(approved)),
        lastEntry: latest
          ? {
              id: latest.id,
              progressDate: formatDateOnly(latest.progressDate),
              cumulativeQuantity: latest.cumulativeQuantity,
              revisionNo: latest.revisionNo,
              status: latest.status,
            }
          : null,
      };
    }),
    entries: entries.map((entry) => ({
      ...mapEntry(entry),
      history: (historyByKey.get(`${entry.jobOrderId}|${formatDateOnly(entry.progressDate)}`) ?? []).map((row) => ({
        id: row.id,
        revisionNo: row.revisionNo,
        status: row.status,
        cumulativeQuantity: row.cumulativeQuantity,
        remarks: row.remarks,
        createdAt: row.createdAt.toISOString(),
        punchedBy: row.punchedBy ? { name: row.punchedBy.name } : null,
        approvedBy: row.approvedBy ? { name: row.approvedBy.name } : null,
      })),
    })),
  });
});

/** GET /api/job-order-progress/pending — the PM queue, grouped by Job Order. */
jobOrderProgressRouter.get("/pending", requireRoles("PM", "ADMIN"), async (req, res) => {
  const jobOrderId = optionalInt(req.query.jobOrderId);
  const projectId = optionalInt(req.query.projectId);
  const from = isDateOnly(req.query.from) ? req.query.from : null;
  const to = isDateOnly(req.query.to) ? req.query.to : null;

  const pendingEntries = await prisma.jobOrderProgress.findMany({
    where: {
      status: "SUBMITTED",
      ...(jobOrderId != null ? { jobOrderId } : {}),
      ...(projectId != null ? { jobOrder: { projectId } } : {}),
      ...(from || to
        ? { progressDate: { ...(from ? { gte: parseDateOnly(from) } : {}), ...(to ? { lte: parseDateOnly(to) } : {}) } }
        : {}),
    },
    include: entryInclude,
    orderBy: [{ progressDate: "asc" }, { id: "asc" }],
    take: 300,
  });

  const jobOrderIds = [...new Set(pendingEntries.map((entry) => entry.jobOrderId))];
  const [allRows, revisionRows] = jobOrderIds.length
    ? await Promise.all([
        prisma.jobOrderProgress.findMany({ where: { jobOrderId: { in: jobOrderIds } }, select: progressDateSelect }),
        prisma.jobOrderBudgetRevision.findMany({
          where: { jobOrderId: { in: jobOrderIds } },
          select: { jobOrderId: true, revisionNo: true, effectiveFrom: true, budgetedQuantity: true },
        }),
      ])
    : [[], []];
  const rowsByJobOrder = groupBy(allRows, (row) => row.jobOrderId);
  const revisionsByJobOrder = budgetRowsFor(revisionRows);
  const today = formatDateOnly(new Date());

  const groupedEntries = groupBy(pendingEntries, (entry) => entry.jobOrderId);
  const groups = [...groupedEntries.entries()].map(([groupJobOrderId, entries]) => {
    const jobOrder = entries[0].jobOrder;
    const rows = toRuleRows(rowsByJobOrder.get(groupJobOrderId) ?? []);
    const revisions = revisionsByJobOrder.get(groupJobOrderId) ?? [];
    return {
      jobOrderId: groupJobOrderId,
      jobOrderCode: jobOrder.code,
      jobOrderName: jobOrder.name,
      display: jobOrderDisplay(jobOrder.code, jobOrder.name),
      colorKey: jobOrder.project.colorKey,
      projectName: jobOrder.project.name,
      wbsCode: jobOrder.projectWbs?.wbsCode ?? null,
      sectionId: jobOrder.sectionId,
      uom: jobOrder.uom ? { code: jobOrder.uom.code, name: jobOrder.uom.name } : null,
      budgetedQuantity: budgetInForce(toBudgetRevisionRows(revisions), today, jobOrder.budgetedQuantity),
      lastApprovedCumulative: achievedQuantity(rows),
      balance: quantityBalance(
        budgetInForce(toBudgetRevisionRows(revisions), today, jobOrder.budgetedQuantity),
        achievedQuantity(rows)
      ).balance,
      entries: entries.map((entry) => {
        const progressDate = formatDateOnly(entry.progressDate);
        const previous = (rowsByJobOrder.get(groupJobOrderId) ?? [])
          .filter((row) => formatDateOnly(row.progressDate) === progressDate && row.revisionNo < entry.revisionNo)
          .sort((a, b) => a.revisionNo - b.revisionNo);
        return {
          id: entry.id,
          progressDate,
          cumulativeQuantity: entry.cumulativeQuantity,
          proposedCumulative: entry.cumulativeQuantity,
          revisionNo: entry.revisionNo,
          status: entry.status,
          remarks: entry.remarks,
          createdAt: entry.createdAt.toISOString(),
          punchedBy: entry.punchedBy ? { name: entry.punchedBy.name } : null,
          section: entry.section ? { id: entry.section.id, name: entry.section.name } : null,
          budgetedQuantity: budgetInForce(toBudgetRevisionRows(revisions), progressDate, jobOrder.budgetedQuantity),
          lastApprovedCumulative: achievedBefore(rows, { progressDate, revisionNo: entry.revisionNo }),
          previousCumulative: previous.length ? previous[previous.length - 1].cumulativeQuantity : null,
          remarksHistory: mapRemarkHistory(entry.remarkHistory ?? []),
        };
      }),
    };
  });

  res.json({ pendingCount: pendingEntries.length, groups });
});

/**
 * GET /api/job-order-progress/remarks — the reportable remark history.
 *
 * A flat, chronological list (by the time each remark was written) across every
 * quantity progress entry the caller may see. Scope is the same as /mine: an HOD or
 * Department Head sees only his own department (a section HOD only his own section),
 * while a PM or Admin sees everything.
 *
 * Filters: job_order_id, project_id, from, to, kind (PUNCH | AMEND | APPROVE | REJECT | SEND_BACK).
 */
jobOrderProgressRouter.get("/remarks", requireRoles("HOD", "DEPT_HEAD", "PM", "ADMIN"), async (req, res) => {
  const actor = actorOf(req);
  const scope = remarkReportScope(actor);
  if (!scope.ok) return sendRuleError(res, scope.error);

  const jobOrderId = optionalInt(req.query.job_order_id);
  const projectId = optionalInt(req.query.project_id);
  const from = isDateOnly(req.query.from) ? req.query.from : null;
  const to = isDateOnly(req.query.to) ? req.query.to : null;
  const requestedKind = typeof req.query.kind === "string" ? req.query.kind.trim().toUpperCase() : "";
  if (requestedKind && !isRemarkKind(requestedKind)) {
    return res.status(400).json({
      error: `kind must be one of ${REMARK_KINDS.join(", ")}.`,
      code: "INVALID_REMARK_KIND",
    });
  }

  const jobOrderFilter: Record<string, unknown> = {};
  if (projectId != null) jobOrderFilter.projectId = projectId;
  if (scope.value.departmentId != null) jobOrderFilter.departmentId = scope.value.departmentId;

  const progressWhere: Record<string, unknown> = {
    ...(jobOrderId != null ? { jobOrderId } : {}),
    ...(Object.keys(jobOrderFilter).length ? { jobOrder: jobOrderFilter } : {}),
    ...(scope.value.sectionId != null ? { sectionId: scope.value.sectionId } : {}),
    ...(from || to
      ? { progressDate: { ...(from ? { gte: parseDateOnly(from) } : {}), ...(to ? { lte: parseDateOnly(to) } : {}) } }
      : {}),
  };

  const rows = await prisma.jobOrderProgressRemark.findMany({
    where: { progress: progressWhere, ...(requestedKind ? { kind: requestedKind } : {}) },
    include: {
      author: { select: { name: true } },
      progress: {
        include: {
          jobOrder: { include: { project: true, projectWbs: true, uom: true } },
          section: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 500,
  });

  const remarks = rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    remark: row.remark,
    authorName: row.author?.name ?? null,
    authorRole: row.authorRole,
    createdAt: row.createdAt.toISOString(),
    progressId: row.progressId,
    progressDate: formatDateOnly(row.progress.progressDate),
    progressStatus: row.progress.status,
    revisionNo: row.progress.revisionNo,
    cumulativeQuantity: row.progress.cumulativeQuantity,
    uomCode: row.progress.jobOrder.uom?.code ?? null,
    sectionId: row.progress.sectionId,
    sectionName: row.progress.section?.name ?? null,
    jobOrderId: row.progress.jobOrder.id,
    jobOrderCode: row.progress.jobOrder.code,
    jobOrderName: row.progress.jobOrder.name,
    display: jobOrderDisplay(row.progress.jobOrder.code, row.progress.jobOrder.name),
    projectId: row.progress.jobOrder.project.id,
    projectCode: row.progress.jobOrder.project.code,
    projectName: row.progress.jobOrder.project.name,
    colorKey: row.progress.jobOrder.project.colorKey,
    wbsCode: row.progress.jobOrder.projectWbs?.wbsCode ?? null,
  }));

  res.json({ count: remarks.length, remarks });
});

/** POST /api/job-order-progress — punch a cumulative quantity for one day. */
jobOrderProgressRouter.post("/", requireRoles("HOD", "DEPT_HEAD", "ADMIN"), async (req, res) => {
  const actor = actorOf(req);
  const parsed = punchSchema.safeParse(req.body ?? {});
  if (!parsed.success) return invalidPayload(res, parsed.error);
  const { jobOrderId, progressDate: progressDateText, cumulativeQuantity } = parsed.data;

  const scope = resolvePunchScope(actor, parsed.data.sectionId ?? null);
  if (!scope.ok) return sendRuleError(res, scope.error);

  const section = await prisma.section.findUnique({
    where: { id: scope.value },
    select: { id: true, departmentId: true, active: true },
  });
  if (!section || section.departmentId !== actor.departmentId) {
    return res.status(403).json({ error: "That section is not part of your department.", code: "SECTION_OUT_OF_SCOPE" });
  }
  if (!section.active) {
    return res.status(409).json({ error: "That section is inactive.", code: "SECTION_INACTIVE" });
  }

  const jobOrder = await prisma.jobOrder.findUnique({
    where: { id: jobOrderId },
    include: {
      project: { select: { active: true } },
      department: { select: { active: true } },
      uom: { select: { code: true } },
    },
  });
  if (!jobOrder) return res.status(404).json({ error: "Job Order not found.", code: "JOB_ORDER_NOT_FOUND" });

  const punchable = canPunchJobOrder(actor.departmentId, scope.value, {
    code: jobOrder.code,
    status: jobOrder.status,
    departmentId: jobOrder.departmentId,
    sectionId: jobOrder.sectionId,
    project: jobOrder.project,
    department: jobOrder.department,
  });
  if (!punchable.ok) return sendRuleError(res, punchable.error);

  const progressDate = parseDateOnly(progressDateText);
  const [dayRows, approvedRows] = await Promise.all([
    prisma.jobOrderProgress.findMany({
      where: { jobOrderId: jobOrder.id, progressDate },
      select: { id: true, revisionNo: true, cumulativeQuantity: true, status: true },
      orderBy: { revisionNo: "desc" },
    }),
    prisma.jobOrderProgress.findMany({
      where: { jobOrderId: jobOrder.id, status: "APPROVED" },
      select: progressDateSelect,
    }),
  ]);

  const plan = planPunch({
    latestForDay: dayRows[0] ?? null,
    lastApprovedCumulative: achievedQuantity(toRuleRows(approvedRows)),
    cumulativeQuantity,
    uomCode: jobOrder.uom?.code ?? null,
  });
  if (!plan.ok) return sendRuleError(res, plan.error);

  let entry: EntryWithRelations;
  try {
    entry = await prisma.$transaction(async (tx) => {
      const created = await tx.jobOrderProgress.create({
        data: {
          jobOrderId: jobOrder.id,
          progressDate,
          cumulativeQuantity,
          revisionNo: plan.value.revisionNo,
          sectionId: scope.value,
          status: "SUBMITTED",
          punchedById: actor.id,
          // The column keeps the latest message the screen shows; the history
          // table keeps every remark ever written.
          remarks: latestRemarkForWrite("PUNCH", parsed.data.remarks ?? null, null),
        },
      });
      await writeRemarkRow(tx, created.id, "PUNCH", parsed.data.remarks ?? null, actor);
      return tx.jobOrderProgress.findUniqueOrThrow({ where: { id: created.id }, include: entryInclude });
    });
  } catch (error) {
    if (isRuleFailure(error)) return sendRuleFailure(res, error);
    // (job_order_id, progress_date, revision_no) is unique; a concurrent punch
    // loses the race and gets the same clear answer as a sequential one.
    if (isUniqueViolation(error)) {
      return res.status(409).json({
        error: "This Job Order already has a quantity entry for that date.",
        code: "DUPLICATE_DAY_ENTRY",
      });
    }
    throw error;
  }

  // Every write is audited.
  await writeAudit(actor.id, "JOB_ORDER_PROGRESS_PUNCH", "job_order_progress", entry.id, {
    jobOrderId: jobOrder.id,
    jobOrderCode: jobOrder.code,
    progressDate: progressDateText,
    cumulativeQuantity,
    revisionNo: entry.revisionNo,
    sectionId: scope.value,
  });

  res.status(201).json({ entry: mapEntry(entry) });
});

/** POST /api/job-order-progress/:id/amend — revise a rejected / sent-back entry. */
jobOrderProgressRouter.post("/:id/amend", requireRoles("HOD", "DEPT_HEAD", "ADMIN"), async (req, res) => {
  const actor = actorOf(req);
  const id = pathId(req.params.id);
  if (id == null) return res.status(400).json({ error: "Invalid progress entry id.", code: "INVALID_ID" });

  const parsed = amendSchema.safeParse(req.body ?? {});
  if (!parsed.success) return invalidPayload(res, parsed.error);

  const entry = await prisma.jobOrderProgress.findUnique({
    where: { id },
    include: entryInclude,
  });
  if (!entry) return res.status(404).json({ error: "Progress entry not found.", code: "ENTRY_NOT_FOUND" });

  if (actor.role !== "ADMIN" && entry.punchedById !== actor.id) {
    return res.status(403).json({ error: "Only the HOD who punched this entry may amend it.", code: "NOT_OWNER" });
  }

  // An amendment stays inside the punch scope: a section HOD cannot reach another
  // section's entry, and a department-level HOD re-states the section it owns.
  let scope: RuleResult<number | null> = resolvePunchScope(actor, entry.sectionId);
  if (!scope.ok && entry.sectionId == null && scope.error.code === "SECTION_REQUIRED" && actor.departmentId === entry.jobOrder.departmentId) {
    scope = { ok: true, value: null };
  }
  if (!scope.ok) return sendRuleError(res, scope.error);
  if (actor.departmentId != null && actor.departmentId !== entry.jobOrder.departmentId) {
    return res.status(403).json({ error: "That Job Order belongs to another department.", code: "JOB_ORDER_OUT_OF_SCOPE" });
  }

  const [dayRows, approvedRows] = await Promise.all([
    prisma.jobOrderProgress.findMany({
      where: { jobOrderId: entry.jobOrderId, progressDate: entry.progressDate },
      select: { id: true, revisionNo: true, cumulativeQuantity: true, status: true },
      orderBy: { revisionNo: "desc" },
    }),
    prisma.jobOrderProgress.findMany({
      where: { jobOrderId: entry.jobOrderId, status: "APPROVED" },
      select: progressDateSelect,
    }),
  ]);

  const plan = planAmendment({
    entry,
    latestForDay: dayRows[0] ?? null,
    lastApprovedCumulative: achievedQuantity(toRuleRows(approvedRows)),
    cumulativeQuantity: parsed.data.cumulativeQuantity,
    uomCode: entry.jobOrder.uom?.code ?? null,
  });
  if (!plan.ok) return sendRuleError(res, plan.error);

  let amended: EntryWithRelations;
  try {
    amended = await prisma.$transaction(async (tx) => {
      const created = await tx.jobOrderProgress.create({
        data: {
          jobOrderId: entry.jobOrderId,
          progressDate: entry.progressDate,
          cumulativeQuantity: parsed.data.cumulativeQuantity,
          revisionNo: plan.value.revisionNo,
          sectionId: entry.sectionId,
          status: "SUBMITTED",
          punchedById: actor.id,
          remarks: latestRemarkForWrite("AMEND", parsed.data.remarks ?? null, null),
        },
      });
      // The amendment writes its own remark row. The superseded revision keeps
      // every row written about it: this one never touches them.
      await writeRemarkRow(tx, created.id, "AMEND", parsed.data.remarks ?? null, actor);
      return tx.jobOrderProgress.findUniqueOrThrow({ where: { id: created.id }, include: entryInclude });
    });
  } catch (error) {
    if (isRuleFailure(error)) return sendRuleFailure(res, error);
    if (isUniqueViolation(error)) {
      return res.status(409).json({
        error: "A revision of this entry already exists. Reload and amend the latest revision.",
        code: "STALE_REVISION",
      });
    }
    throw error;
  }

  // The amended row is kept, untouched, as history. Nothing is updated in place.
  await writeAudit(actor.id, "JOB_ORDER_PROGRESS_AMEND", "job_order_progress", amended.id, {
    jobOrderId: entry.jobOrderId,
    jobOrderCode: entry.jobOrder.code,
    progressDate: formatDateOnly(entry.progressDate),
    previousEntryId: entry.id,
    previousRevisionNo: entry.revisionNo,
    previousStatus: entry.status,
    previousCumulativeQuantity: entry.cumulativeQuantity,
    revisionNo: amended.revisionNo,
    cumulativeQuantity: parsed.data.cumulativeQuantity,
  });

  res.status(201).json({ entry: mapEntry(amended) });
});

/** POST /api/job-order-progress/:id/decision — PM approve / reject / send back. */
jobOrderProgressRouter.post("/:id/decision", requireRoles("PM", "ADMIN"), async (req, res) => {
  const actor = actorOf(req);
  const id = pathId(req.params.id);
  if (id == null) return res.status(400).json({ error: "Invalid progress entry id.", code: "INVALID_ID" });

  const parsed = decisionSchema.safeParse(req.body ?? {});
  if (!parsed.success) return invalidPayload(res, parsed.error);

  const entry = await prisma.jobOrderProgress.findUnique({ where: { id }, include: entryInclude });
  if (!entry) return res.status(404).json({ error: "Progress entry not found.", code: "ENTRY_NOT_FOUND" });

  const plan = planDecision({
    action: parsed.data.action,
    currentStatus: entry.status,
    remarks: parsed.data.remarks ?? null,
  });
  if (!plan.ok) return sendRuleError(res, plan.error);

  // The row's own column keeps the LATEST message, exactly as the screen shows it: a
  // rejection or a send-back carries the PM's reason forward, and an approval without
  // a remark leaves the HOD's note in place. Every remark is preserved regardless, in
  // job_order_progress_remarks and in the audit entry.
  const remarkKind = remarkKindForAction(parsed.data.action);
  const decisionRemarks = latestRemarkForWrite(remarkKind, parsed.data.remarks ?? null, entry.remarks);
  let updated: EntryWithRelations;
  try {
    updated = await prisma.$transaction(async (tx) => {
      const decided = await tx.jobOrderProgress.update({
        where: { id: entry.id },
        data: {
          status: plan.value.status,
          approvedById: plan.value.stampApproval ? actor.id : null,
          approvedAt: plan.value.stampApproval ? new Date() : null,
          remarks: decisionRemarks,
        },
      });
      // An approval without a remark writes no row; reject and send-back always do.
      await writeRemarkRow(tx, decided.id, remarkKind, parsed.data.remarks ?? null, actor);
      return tx.jobOrderProgress.findUniqueOrThrow({ where: { id: decided.id }, include: entryInclude });
    });
  } catch (error) {
    if (isRuleFailure(error)) return sendRuleFailure(res, error);
    throw error;
  }

  const auditAction =
    parsed.data.action === "APPROVE"
      ? "JOB_ORDER_PROGRESS_APPROVE"
      : parsed.data.action === "REJECT"
        ? "JOB_ORDER_PROGRESS_REJECT"
        : "JOB_ORDER_PROGRESS_SEND_BACK";

  await writeAudit(actor.id, auditAction, "job_order_progress", updated.id, {
    jobOrderId: entry.jobOrderId,
    jobOrderCode: entry.jobOrder.code,
    progressDate: formatDateOnly(entry.progressDate),
    revisionNo: entry.revisionNo,
    cumulativeQuantity: entry.cumulativeQuantity,
    previousStatus: entry.status,
    status: updated.status,
    punchedRemarks: entry.remarks,
    decisionRemarks: parsed.data.remarks ?? null,
  });

  res.json({ entry: mapEntry(updated) });
});
