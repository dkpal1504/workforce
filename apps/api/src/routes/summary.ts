import { Router } from "express";
import { prisma } from "../db";
import { requireAuth } from "../middleware/auth";
import { endOfFrequency, parseDateOnly, startOfFrequency } from "../utils/date";

export const summaryRouter = Router();

summaryRouter.use(requireAuth);

type JoStatus = "all" | "active" | "closed";

summaryRouter.get("/job-order", async (req, res) => {
  const role = req.user!.role;
  const userId = req.user!.id;
  const departmentId = req.user!.departmentId;

  // Optional filters
  const status = (String(req.query.status || "all") as JoStatus);
  if (!["all", "active", "closed"].includes(status)) {
    return res.status(400).json({ error: "status must be one of all|active|closed" });
  }
  const filterDeptId =
    typeof req.query.departmentId === "string" && req.query.departmentId.length
      ? Number(req.query.departmentId)
      : departmentId ?? undefined;

  let projectIds: number[] | undefined;
  if (typeof req.query.projectIds === "string" && req.query.projectIds.length) {
    projectIds = req.query.projectIds.split(",").map(Number).filter(Boolean);
  }

  // All Job Orders matching the filters (excludes on_hold per spec).
  const jobOrders = await prisma.jobOrder.findMany({
    where: {
      status: status === "all" ? { in: ["active", "closed"] } : status,
      projectId: projectIds?.length ? { in: projectIds } : undefined,
      // If the caller narrowed to a department, restrict JOs to that department.
      // A null departmentId on the JO means "any department" (e.g. Non-Project standing JOs).
      ...(filterDeptId != null ? { OR: [{ departmentId: filterDeptId }, { departmentId: null }] } : {}),
    },
    include: { project: true },
    orderBy: [{ projectId: "asc" }, { code: "asc" }],
  });

  if (jobOrders.length === 0) {
    return res.json({
      groups: [],
      role,
      scope: role === "SUPERVISOR" ? "own" : role === "HOD" ? "department" : "organization",
    });
  }

  const jobOrderIds = jobOrders.map((j) => j.id);

  // Pull consumption entries for those JOs, role-scoped to match Project Summary.
  // Each shift-slot row counts as 1 hour-equivalent; each legacy hourSlot row also 1.
  const entries = await prisma.timesheetEntry.findMany({
    where: {
      jobOrderId: { in: jobOrderIds },
      OR: [
        { projectWbsId: { not: null } },
        { jobOrderId: { not: null } },
      ],
      ...(role === "SUPERVISOR" ? { taggedById: userId } : {}),
      ...(role === "HOD" && filterDeptId != null
        ? {
            OR: [
              { taggedBy: { departmentId: filterDeptId } },
              { employee: { departmentId: filterDeptId } },
            ],
          }
        : {}),
    },
    select: { jobOrderId: true },
  });

  // Group consumption counts by JobOrder.
  const consumptionByJo = new Map<number, number>();
  for (const e of entries) {
    if (e.jobOrderId == null) continue;
    consumptionByJo.set(e.jobOrderId, (consumptionByJo.get(e.jobOrderId) ?? 0) + 1);
  }

  // Group Job Orders by Project (preserves the projects' sortOrder).
  const byProject = new Map<
    number,
    {
      projectId: number;
      projectName: string;
      projectCode: string;
      projectColorKey: string;
      sortOrder: number;
      jobOrders: (typeof jobOrders)[number][];
    }
  >();
  for (const jo of jobOrders) {
    let g = byProject.get(jo.project.id);
    if (!g) {
      g = {
        projectId: jo.project.id,
        projectName: jo.project.name,
        projectCode: jo.project.code,
        projectColorKey: jo.project.colorKey,
        sortOrder: jo.project.sortOrder,
        jobOrders: [],
      };
      byProject.set(jo.project.id, g);
    }
    g.jobOrders.push(jo);
  }

  const groups = Array.from(byProject.values())
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((g) => ({
      projectId: g.projectId,
      projectName: g.projectName,
      projectCode: g.projectCode,
      projectColorKey: g.projectColorKey,
      rows: g.jobOrders.map((jo, i) => {
        const consumption = consumptionByJo.get(jo.id) ?? 0;
        const budget = jo.budgetedHours ?? 0;
        const pct = budget > 0 ? Math.round((consumption / budget) * 100) : 0;
        const balance = budget - consumption;
        return {
          id: jo.id,
          srNo: i + 1,
          code: jo.code,
          name: jo.name,
          status: jo.status,
          budgetedHours: jo.budgetedHours,
          consumption,
          consumptionPct: pct,
          balance,
        };
      }),
    }));

  res.json({
    groups,
    role,
    scope: role === "SUPERVISOR" ? "own" : role === "HOD" ? "department" : "organization",
  });
});

summaryRouter.get("/", async (req, res) => {
  const frequency = (String(req.query.frequency || "daily") as "daily" | "weekly" | "monthly");
  const groupBy = String(req.query.groupBy || "supervisor") as
    | "employee"
    | "supervisor"
    | "department"
    | "totals";
  const view = String(req.query.view || "hours") as "hours" | "cost";
  const dateStr = String(req.query.date || "");
  if (!dateStr) return res.status(400).json({ error: "date required" });

  const anchor = parseDateOnly(dateStr);
  const start = startOfFrequency(anchor, frequency);
  const end = endOfFrequency(anchor, frequency);

  let projectIds: number[] | undefined;
  if (typeof req.query.projectIds === "string" && req.query.projectIds.length) {
    projectIds = req.query.projectIds.split(",").map(Number).filter(Boolean);
  } else if (Array.isArray(req.query.projectIds)) {
    projectIds = (req.query.projectIds as string[]).map(Number).filter(Boolean);
  }

  const projects = await prisma.projectWbs.findMany({
    where: {
      active: true,
      ...(projectIds?.length ? { id: { in: projectIds } } : {}),
    },
    orderBy: { colorKey: "asc" },
  });

  const role = req.user!.role;
  const userId = req.user!.id;
  const departmentId = req.user!.departmentId;

  // Role scope: supervisors only see hours they tagged — not other supervisors' sheets.
  const entries = await prisma.timesheetEntry.findMany({
    where: {
      workDate: { gte: start, lte: end },
      projectWbsId: { not: null },
      ...(projectIds?.length ? { projectWbsId: { in: projectIds } } : {}),
      ...(role === "SUPERVISOR" ? { taggedById: userId } : {}),
      ...(role === "HOD" && departmentId != null
        ? {
            OR: [
              { taggedBy: { departmentId } },
              { employee: { departmentId } },
            ],
          }
        : {}),
    },
    include: {
      employee: { include: { department: true } },
      taggedBy: { include: { department: true } },
      projectWbs: true,
    },
  });

  const rates = await prisma.costRate.findMany({
    where: {
      effectiveFrom: { lte: end },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: start } }],
    },
    orderBy: { effectiveFrom: "desc" },
  });

  function rateFor(category: string): number {
    const r = rates.find((x) => x.category === category);
    return r ? Number(r.ratePerHour) : 0;
  }

  type AggKey = string;
  const buckets = new Map<
    AggKey,
    {
      label: string;
      secondary: string;
      projectHours: Record<number, number>;
      projectCost: Record<number, number>;
    }
  >();

  for (const e of entries) {
    if (!e.projectWbsId || !e.projectWbs) continue;
    let key: string;
    let label: string;
    let secondary: string;

    if (groupBy === "employee") {
      key = `emp-${e.employeeId}`;
      label = e.employee.name;
      secondary = e.employee.department.name;
    } else if (groupBy === "department") {
      key = `dept-${e.employee.departmentId}`;
      label = e.employee.department.name;
      secondary = "";
    } else if (groupBy === "totals") {
      key = "totals";
      label = "All";
      secondary = "";
    } else {
      key = `sup-${e.taggedById}`;
      label = e.taggedBy.name;
      secondary = e.taggedBy.department?.name ?? "";
    }

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { label, secondary, projectHours: {}, projectCost: {} };
      buckets.set(key, bucket);
    }
    bucket.projectHours[e.projectWbsId] = (bucket.projectHours[e.projectWbsId] || 0) + 1;
    const cost = rateFor(e.employee.category);
    bucket.projectCost[e.projectWbsId] = (bucket.projectCost[e.projectWbsId] || 0) + cost;
  }

  const rows = Array.from(buckets.values()).map((b, i) => {
    const values: Record<string, number> = {};
    let total = 0;
    for (const p of projects) {
      const v = view === "cost" ? b.projectCost[p.id] || 0 : b.projectHours[p.id] || 0;
      values[p.code] = v;
      total += v;
    }
    return {
      srNo: i + 1,
      name: b.label,
      department: b.secondary,
      values,
      total,
    };
  });

  const totals: Record<string, number> = {};
  let grand = 0;
  for (const p of projects) {
    const sum = rows.reduce((acc, r) => acc + (r.values[p.code] || 0), 0);
    totals[p.code] = sum;
    grand += sum;
  }

  res.json({
    projects: projects.map((p) => ({ id: p.id, code: p.code, name: p.name, colorKey: p.colorKey })),
    rows,
    totals,
    grandTotal: grand,
    groupBy,
    view,
    frequency,
    scope: role === "SUPERVISOR" ? "own" : role === "HOD" ? "department" : "organization",
    dateFrom: start.toISOString().slice(0, 10),
    dateTo: end.toISOString().slice(0, 10),
  });
});
