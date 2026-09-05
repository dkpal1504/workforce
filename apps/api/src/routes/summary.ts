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

  let projectIds: string[] | undefined;
  if (typeof req.query.projectIds === "string" && req.query.projectIds.length) {
    projectIds = req.query.projectIds.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  } else if (Array.isArray(req.query.projectIds)) {
    projectIds = (req.query.projectIds as string[]).map((s) => String(s).trim().toUpperCase()).filter(Boolean);
  }

  const role = req.user!.role;
  const userId = req.user!.id;
  const departmentId = req.user!.departmentId;

  // Role scope: supervisors only see hours they tagged — not other supervisors' sheets.
  // Match BOTH legacy ProjectWbs-tagged and new JobOrder-tagged entries (the daily
  // timesheet entry writes jobOrder-only rows), so the summary isn't empty for
  // jobOrder-tagged hours.
  const entries = await prisma.timesheetEntry.findMany({
    where: {
      workDate: { gte: start, lte: end },
      OR: [{ projectWbsId: { not: null } }, { jobOrderId: { not: null } }],
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
      jobOrder: { include: { project: true } },
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

  // Build the dynamic project-column set from the entries actually present,
  // resolving each entry's project via legacy ProjectWbs colorKey OR the
  // JobOrder→Project colorKey. Keyed by colorKey (code) so A/B/C/D/… all show.
  const projectMeta = new Map<string, { id: number; code: string; name: string; colorKey: string }>();
  for (const e of entries) {
    if (e.projectWbsId != null && e.projectWbs) {
      projectMeta.set(e.projectWbs.colorKey, {
        id: e.projectWbs.id,
        code: e.projectWbs.colorKey,
        name: e.projectWbs.name,
        colorKey: e.projectWbs.colorKey,
      });
    } else if (e.jobOrderId != null && e.jobOrder?.project) {
      const ck = String(e.jobOrder.project.colorKey || "").toUpperCase();
      if (ck) {
        projectMeta.set(ck, {
          id: e.jobOrder.project.id,
          code: ck,
          name: e.jobOrder.project.name,
          colorKey: ck,
        });
      }
    }
  }
  // Only projects explicitly selected when a filter is provided. Filter by
  // colorKey (code) — the unified identity across BOTH tagging paths (legacy
  // ProjectWbs and new JobOrder→Project). Numeric ids differ between the two
  // models (WBS ids vs Project ids), so matching on colorKey avoids the
  // mismatch that made per-project filters return 0.
  if (projectIds?.length) {
    const codes = new Set(projectIds);
    for (const k of [...projectMeta.keys()]) {
      if (!codes.has(k)) projectMeta.delete(k);
    }
  }
  const projects = [...projectMeta.values()].sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));

  type AggKey = string;
  const buckets = new Map<
    AggKey,
    {
      label: string;
      secondary: string;
      projectHours: Record<string, number>;
      projectCost: Record<string, number>;
      otHours: number;
      otCost: number;
    }
  >();

  for (const e of entries) {
    // OT rows are additive and separate — never count toward regular project
    // hours/cost (an OT row has shiftSlot/hourSlot null, so +1 would miscount it
    // as a regular hour). Accumulate OT into a dedicated otHours/otCost instead.
    if (e.otHours != null) {
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
        bucket = { label, secondary, projectHours: {}, projectCost: {}, otHours: 0, otCost: 0 };
        buckets.set(key, bucket);
      }
      bucket.otHours += e.otHours;
      bucket.otCost += e.otHours * rateFor(e.employee.category);
      continue;
    }

    // Resolve this entry's project colorKey ONCE (never double-count an entry
    // that carries both projectWbsId and jobOrderId).
    let colorKey: string | null = null;
    if (e.projectWbsId != null && e.projectWbs) {
      colorKey = e.projectWbs.colorKey;
    } else if (e.jobOrderId != null && e.jobOrder?.project) {
      colorKey = String(e.jobOrder.project.colorKey || "").toUpperCase();
    }
    if (!colorKey || !projectMeta.has(colorKey)) continue;

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
      bucket = { label, secondary, projectHours: {}, projectCost: {}, otHours: 0, otCost: 0 };
      buckets.set(key, bucket);
    }
    bucket.projectHours[colorKey] = (bucket.projectHours[colorKey] || 0) + 1;
    const cost = rateFor(e.employee.category);
    bucket.projectCost[colorKey] = (bucket.projectCost[colorKey] || 0) + cost;
  }

  const rows = Array.from(buckets.values()).map((b, i) => {
    const values: Record<string, number> = {};
    let total = 0;
    for (const p of projects) {
      const v = view === "cost" ? b.projectCost[p.code] || 0 : b.projectHours[p.code] || 0;
      values[p.code] = v;
      total += v;
    }
    return {
      srNo: i + 1,
      name: b.label,
      department: b.secondary,
      values,
      total,
      // OT is additive and separate — shown as its own value, never folded into
      // the regular project totals.
      otHours: b.otHours,
      otCost: b.otCost,
    };
  });

  const totals: Record<string, number> = {};
  let grand = 0;
  for (const p of projects) {
    const sum = rows.reduce((acc, r) => acc + (r.values[p.code] || 0), 0);
    totals[p.code] = sum;
    grand += sum;
  }
  const otTotalHours = rows.reduce((acc, r) => acc + (r.otHours || 0), 0);
  const otTotalCost = rows.reduce((acc, r) => acc + (r.otCost || 0), 0);

  res.json({
    projects: projects.map((p) => ({ id: p.id, code: p.code, name: p.name, colorKey: p.colorKey })),
    rows,
    totals,
    grandTotal: grand,
    otTotalHours,
    otTotalCost,
    groupBy,
    view,
    frequency,
    scope: role === "SUPERVISOR" ? "own" : role === "HOD" ? "department" : "organization",
    dateFrom: start.toISOString().slice(0, 10),
    dateTo: end.toISOString().slice(0, 10),
  });
});
