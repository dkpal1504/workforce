import { Router } from "express";
import { prisma } from "../db";
import { requireAuth } from "../middleware/auth";
import { endOfFrequency, parseDateOnly, startOfFrequency } from "../utils/date";
import { getMaxDailyHours } from "../config";

export const summaryRouter = Router();

summaryRouter.use(requireAuth);

type JoStatus = "all" | "active" | "closed";

summaryRouter.get("/job-order", async (req, res) => {
  const role = req.user!.role;
  const userId = req.user!.id;

  // Optional filters
  const status = (String(req.query.status || "all") as JoStatus);
  if (!["all", "active", "closed"].includes(status)) {
    return res.status(400).json({ error: "status must be one of all|active|closed" });
  }
  const requestedDeptId =
    typeof req.query.departmentId === "string" && req.query.departmentId.length
      ? Number(req.query.departmentId)
      : undefined;
  // "All Departments" must remain organization-wide. Apply department
  // filtering only when the user explicitly selects a department in the report.
  const filterDeptId = requestedDeptId;

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
      scope: role === "SUPERVISOR" ? "own" : "organization",
    });
  }

  const jobOrderIds = jobOrders.map((j) => j.id);

  // Pull final-approved consumption entries for those JOs. Supervisors see
  // their own tagging; reporting roles see organization-wide data unless filtered.
  const entries = await prisma.timesheetEntry.findMany({
    where: {
      jobOrderId: { in: jobOrderIds },
      // Consumption is recognized only after the final Project Manager approval.
      status: "PM_APPROVED",
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
    select: { jobOrderId: true, shiftSlot: true, hourSlot: true, otHours: true },
  });

  // Payroll/My Hours allocations use a separate parent-day model. Include
  // their slots only after the same final PM approval stage.
  const linkedUser =
    role === "SUPERVISOR"
      ? await prisma.user.findUnique({ where: { id: userId }, select: { employeeId: true } })
      : null;
  const allocations = await prisma.employeeAllocation.findMany({
    where: {
      jobOrderId: { in: jobOrderIds },
      allocationDay: { status: "PM_APPROVED" },
      ...(filterDeptId != null ? { employee: { departmentId: filterDeptId } } : {}),
      ...(role === "SUPERVISOR"
        ? { employeeId: linkedUser?.employeeId ?? -1 }
        : {}),
    },
    select: { jobOrderId: true },
  });

  // Group true approved hours by JobOrder: shift slots are 2h, legacy slots
  // are 1h, an OT row contributes its explicit hours, and each payroll slot is 2h.
  const consumptionByJo = new Map<number, number>();
  for (const e of entries) {
    if (e.jobOrderId == null) continue;
    const hours = e.otHours ?? (e.shiftSlot != null ? 2 : e.hourSlot != null ? 1 : 0);
    consumptionByJo.set(e.jobOrderId, (consumptionByJo.get(e.jobOrderId) ?? 0) + hours);
  }
  for (const allocation of allocations) {
    if (allocation.jobOrderId == null) continue;
    consumptionByJo.set(
      allocation.jobOrderId,
      (consumptionByJo.get(allocation.jobOrderId) ?? 0) + 2
    );
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
    scope: role === "SUPERVISOR" ? "own" : "organization",
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
  type Bucket = {
    label: string;
    secondary: string;
    projectHours: Record<string, number>;
    projectCost: Record<string, number>;
    projectOtHours: Record<string, number>;
    projectOtCost: Record<string, number>;
    overheadHours: number;
    overheadCost: number;
  };
  const buckets = new Map<AggKey, Bucket>();

  const groupIdentity = (e: (typeof entries)[number]) => {
    if (groupBy === "employee") {
      return { key: `emp-${e.employeeId}`, label: e.employee.name, secondary: e.employee.department.name };
    }
    if (groupBy === "department") {
      return { key: `dept-${e.employee.departmentId}`, label: e.employee.department.name, secondary: "" };
    }
    if (groupBy === "totals") {
      return { key: "totals", label: "All", secondary: "" };
    }
    return {
      key: `sup-${e.taggedById}`,
      label: e.taggedBy.name,
      secondary: e.taggedBy.department?.name ?? "",
    };
  };

  const getBucket = (e: (typeof entries)[number]) => {
    const identity = groupIdentity(e);
    let bucket = buckets.get(identity.key);
    if (!bucket) {
      bucket = {
        label: identity.label,
        secondary: identity.secondary,
        projectHours: {},
        projectCost: {},
        projectOtHours: {},
        projectOtCost: {},
        overheadHours: 0,
        overheadCost: 0,
      };
      buckets.set(identity.key, bucket);
    }
    return bucket;
  };

  // Regular and OT hours both remain associated with their booked project.
  // Summary OT is approved-only, matching the approval/reporting contract.
  for (const e of entries) {
    let colorKey: string | null = null;
    if (e.projectWbsId != null && e.projectWbs) {
      colorKey = String(e.projectWbs.colorKey || "").toUpperCase();
    } else if (e.jobOrderId != null && e.jobOrder?.project) {
      colorKey = String(e.jobOrder.project.colorKey || "").toUpperCase();
    }
    if (!colorKey || !projectMeta.has(colorKey)) continue;

    const bucket = getBucket(e);
    if (e.otHours != null) {
      if (e.status !== "HOD_APPROVED" && e.status !== "PM_APPROVED") continue;
      bucket.projectOtHours[colorKey] = (bucket.projectOtHours[colorKey] || 0) + e.otHours;
      bucket.projectOtCost[colorKey] =
        (bucket.projectOtCost[colorKey] || 0) + e.otHours * rateFor(e.employee.category);
      continue;
    }

    const regularHours = e.shiftSlot != null ? 2 : e.hourSlot != null ? 1 : 0;
    bucket.projectHours[colorKey] = (bucket.projectHours[colorKey] || 0) + regularHours;
    bucket.projectCost[colorKey] =
      (bucket.projectCost[colorKey] || 0) + regularHours * rateFor(e.employee.category);
  }

  // Overhead is unused regular capacity for a timesheet day. It is deliberately
  // kept outside every project and shown only in the final Overhead Total column.
  const dayRegular = new Map<number, { sample: (typeof entries)[number]; hours: number }>();
  for (const e of entries) {
    let day = dayRegular.get(e.timesheetDayId);
    if (!day) {
      day = { sample: e, hours: 0 };
      dayRegular.set(e.timesheetDayId, day);
    }
    if (e.otHours == null) {
      day.hours += e.shiftSlot != null ? 2 : e.hourSlot != null ? 1 : 0;
    }
  }
  const maxDailyHours = getMaxDailyHours();
  for (const day of dayRegular.values()) {
    const identity = groupIdentity(day.sample);
    const bucket = buckets.get(identity.key);
    if (!bucket) continue;
    const overhead = Math.max(0, maxDailyHours - day.hours);
    bucket.overheadHours += overhead;
    bucket.overheadCost += overhead * rateFor(day.sample.employee.category);
  }

  const rows = Array.from(buckets.values()).map((b, i) => {
    const values: Record<string, number> = {};
    const projectOtValues: Record<string, number> = {};
    let total = 0;
    for (const p of projects) {
      const regular = view === "cost" ? b.projectCost[p.code] || 0 : b.projectHours[p.code] || 0;
      const ot = view === "cost" ? b.projectOtCost[p.code] || 0 : b.projectOtHours[p.code] || 0;
      values[p.code] = regular;
      projectOtValues[p.code] = ot;
      total += regular + ot;
    }
    return {
      srNo: i + 1,
      name: b.label,
      department: b.secondary,
      values,
      projectOtValues,
      total,
      overheadHours: b.overheadHours,
      overheadCost: b.overheadCost,
    };
  });

  const totals: Record<string, number> = {};
  const projectOtTotals: Record<string, number> = {};
  let grand = 0;
  for (const p of projects) {
    totals[p.code] = rows.reduce((acc, r) => acc + (r.values[p.code] || 0), 0);
    projectOtTotals[p.code] = rows.reduce((acc, r) => acc + (r.projectOtValues[p.code] || 0), 0);
    grand += totals[p.code] + projectOtTotals[p.code];
  }
  const overheadTotalHours = rows.reduce((acc, r) => acc + r.overheadHours, 0);
  const overheadTotalCost = rows.reduce((acc, r) => acc + r.overheadCost, 0);

  res.json({
    projects: projects.map((p) => ({ id: p.id, code: p.code, name: p.name, colorKey: p.colorKey })),
    rows,
    totals,
    projectOtTotals,
    grandTotal: grand,
    overheadTotalHours,
    overheadTotalCost,
    groupBy,
    view,
    frequency,
    scope: role === "SUPERVISOR" ? "own" : role === "HOD" ? "department" : "organization",
    dateFrom: start.toISOString().slice(0, 10),
    dateTo: end.toISOString().slice(0, 10),
  });
});
