import { Request, Response, Router } from "express";
import { requireAuth, requireRoles } from "../middleware/auth";
import { parsePortfolioFilters, type ParseError } from "../services/portfolioFilters";
import {
  buildPortfolioReport,
  type PortfolioReport,
  type ReportActor,
} from "../services/portfolioReport";
import {
  buildPortfolioPdf,
  buildPortfolioXlsx,
  portfolioExportFilename,
  type PortfolioExportFormat,
} from "../services/portfolioExport";
import {
  CoverageRequestError,
  buildTimesheetCoverageReport,
  type CoverageActor,
  type CoverageFilters,
} from "../services/timesheetCoverageReport";
import { buildTimesheetCoverageXlsx, timesheetCoverageFilename } from "../services/timesheetCoverageExport";
import { parseCoverageStatuses } from "../services/timesheetCoverage";
import { writeAudit } from "../audit";
import { prisma } from "../db";
import { getMaxDailyHours } from "../config";
import { notBookedCsv, summariseNotBooked , eachDay } from "../services/notBooked";
import { reportCalendarFor } from "../services/reportCalendar";

export const reportsRouter = Router();

/**
 * Portfolio & Job-Work Operations Dashboard — the JSON screen.
 *
 * Gated on PM, ADMIN, COO, HOD and DEPT_HEAD, which are exactly the roles whose
 * `capabilitiesFor(role).viewPortfolioDashboard` is true (services/roleAccess.ts). Requiring the
 * ROLES rather than re-deriving the capability here follows the house pattern set by
 * `routes/summary.ts`: the capability flag drives the web navigation, and the router list is the
 * server-side enforcement of the same set.
 *
 * THE GATE IS NOT THE SCOPE. Admitting HOD/DEPT_HEAD here does NOT grant them the whole portfolio:
 * PM/ADMIN/COO read every Department, while an HOD (either shape) and a DEPT_HEAD read their ONE
 * Department, narrowed server-side in `buildPortfolioReport` via `reportScopeFor`. The request's
 * `departmentIds` can only narrow that further, never widen it. A head with no Department mapping
 * reads zero rows (fail closed). SUPERVISOR and EMPLOYEE stay 403.
 *
 * This single `requireRoles(...)` covers the JSON handler AND both downloads below: the router-level
 * `use` runs for every route, so a scoped screen and an unscoped export cannot diverge.
 *
 * The JSON handler is READ-ONLY. The two DOWNLOAD handlers below are read-only as well, apart
 * from the audit row they are REQUIRED to write — "who pulled these numbers" has to be
 * answerable later, and an export writes nothing else at all.
 */
/**
 * WHO may open the portfolio report.
 *
 * PROJECT_MANAGER is admitted here and NARROWED to its assigned projects by `reportScopeFor`; the
 * gate is only the door. HOD/DEPT_HEAD are narrowed to their Department in the same place, and the
 * request's filters can only narrow further.
 */
const PORTFOLIO_ROLES = ["PM", "ADMIN", "COO", "HOD", "DEPT_HEAD", "PROJECT_MANAGER"] as const;

/**
 * WHO may read the Timesheet coverage report — deliberately WITHOUT PROJECT_MANAGER.
 *
 * That report's row set is the EMPLOYEE ROSTER (employees x dates), and a project scope cannot
 * define who is in it. Because the router-level gate above admits the new role, its two routes carry
 * this second, narrower gate explicitly; inheriting the wider one would hand a Project Manager a
 * report whose scope is undefined.
 */
const COVERAGE_ROLES = ["PM", "ADMIN", "COO", "HOD", "DEPT_HEAD"] as const;

reportsRouter.use(requireAuth, requireRoles(...PORTFOLIO_ROLES));

reportsRouter.get("/portfolio", async (req, res) => {
  // One parser for every format: the JSON screen, the XLSX and the PDF all go through
  // parsePortfolioFilters, so a screen can never disagree with a download.
  const parsed = parsePortfolioFilters(req.query);
  if (!parsed.ok) {
    // The parser owns the code and the human sentence; the route owns only the status. A
    // typo in `status` or `band` must FAIL rather than silently widen the report.
    return res.status(400).json({ error: parsed.error, code: parsed.code });
  }

  // The actor is stamped into the provenance block, because "who pulled the numbers" is a
  // question an operations report has to be able to answer. `departmentId` is carried too, so the
  // loader can derive the actor's OWN scope server-side (intersected with the request, never
  // trusted from it).
  const actor: ReportActor = {
    id: req.user!.id,
    name: req.user!.name,
    role: req.user!.role,
    departmentId: req.user!.departmentId,
  };

  try {
    const report = await buildPortfolioReport(parsed.filters, actor);
    return res.json(report);
  } catch (error) {
    // express-async-errors is installed in src/index.ts and would forward this, but the
    // handler is defensive so it behaves identically under any Express app (the HTTP test
    // mounts this router on a bare server).
    const message = error instanceof Error ? error.message : "Failed to build the portfolio report.";
    console.error("[reports] portfolio report failed:", error);
    return res.status(500).json({ error: message, code: "PORTFOLIO_REPORT_FAILED" });
  }
});

/* --------------------------------------------------------------------------- *
 * Downloads — XLSX and PDF
 * ------------------------------------------------------------------------- */

/** The wire format of each download, in one place so a header can never drift from its builder. */
const EXPORT_CONTENT_TYPES: Record<PortfolioExportFormat, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
};

/** A one-line, human-readable statement of scope, for the audit row. */
function filtersDescription(report: PortfolioReport): string {
  // Read off the assembled report rather than re-deriving it: the report is what was rendered,
  // so the audit row records the scope that actually produced the file.
  return report.provenance.filters.map((entry) => `${entry.label}: ${entry.value}`).join("; ");
}

/**
 * The shared body of both downloads.
 *
 * WHY IT IS SHARED AND NOT COPIED: the whole contract is that a download CANNOT disagree with
 * the screen. That is only true if every format parses the SAME query through the SAME parser,
 * builds the SAME `PortfolioReport` through `buildPortfolioReport`, and stamps the SAME
 * provenance. Duplicating the handler would make that a convention; sharing it makes it a fact.
 *
 * The only difference between the two formats is which pure builder renders the buffer and which
 * Content-Type is set — nothing about the numbers changes.
 */
import { isInsightPeriod } from "../services/delayReasons";
import { loadReportInsights } from "../services/reportInsights";

function downloadHandler(format: PortfolioExportFormat) {
  return async (req: Request, res: Response) => {
    const parsed = parsePortfolioFilters(req.query);
    if (!parsed.ok) {
      // House error shape and code, exactly as the JSON endpoint answers — a bad filter is a
      // 400 for every format.
      const failure: ParseError = parsed;
      return res.status(400).json({ error: failure.error, code: failure.code });
    }

    const actor: ReportActor = {
      id: req.user!.id,
      name: req.user!.name,
      role: req.user!.role,
      departmentId: req.user!.departmentId,
    };

    try {
      // SAME assembly as GET /api/reports/portfolio. Nothing is recomputed for the file.
      const report = await buildPortfolioReport(parsed.filters, actor);

      // The conversation half travels with the file. Same scope vocabulary as the screens (a PM reads his
      // portfolio, an HOD his department), so a download can never show delays or hindrances the reader
      // could not open on screen.
      const period = isInsightPeriod(req.query.insightsPeriod) ? req.query.insightsPeriod : "quarter";
      const hindranceState = req.query.hindranceState === "CLOSED" ? "CLOSED" : "OPEN";
      const insights = await loadReportInsights(
        {
          id: req.user!.id,
          role: req.user!.role,
          departmentId: req.user!.departmentId ?? null,
          sectionScope: req.user!.sectionScope ?? [],
          sectionId: req.user!.sectionId ?? null,
        },
        period,
        hindranceState
      );

      const buffer =
        format === "xlsx"
          ? await buildPortfolioXlsx(report, parsed.filters, undefined, insights)
          : await buildPortfolioPdf(report, parsed.filters, undefined, insights);

      // The filename carries the as-of date AND the filters hash, so two differently-filtered
      // reports can never collide and a file on disk still states its period and scope.
      const filename = portfolioExportFilename(report, format);
      res.setHeader("Content-Type", EXPORT_CONTENT_TYPES[format]);
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Content-Length", String(buffer.length));
      res.send(buffer);

      // AUDIT LAST, and deliberately not awaited before the response: the row must never be able
      // to turn a successfully generated file into a failed request. `writeAudit` swallows its
      // own errors for the same reason. It records WHO pulled WHICH scope, in WHICH format.
      await writeAudit(actor.id, "PORTFOLIO_EXPORT", "portfolio_report", report.provenance.filtersHash, {
        format,
        filterDescription: filtersDescription(report),
        filtersHash: report.provenance.filtersHash,
        asOf: report.asOf,
        generatedAt: report.generatedAt,
        generatedBy: actor,
        jobOrders: report.pulse.jobOrders,
        insights: {
          period,
          hindranceState,
          delayReports: insights.delays.total,
          hindrances: insights.hindrances.total,
        },
        bytes: buffer.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to build the portfolio export.";
      console.error(`[reports] portfolio ${format} export failed:`, error);
      return res.status(500).json({ error: message, code: "PORTFOLIO_EXPORT_FAILED" });
    }
  };
}

// GET /api/reports/portfolio.xlsx — the same IDENTICAL query parameters as the JSON screen.
reportsRouter.get("/portfolio.xlsx", downloadHandler("xlsx"));
// GET /api/reports/portfolio.pdf — same gate, same parameters, same assembled numbers.
reportsRouter.get("/portfolio.pdf", downloadHandler("pdf"));

/* --------------------------------------------------------------------------- *
 * Timesheet coverage by date — a DIFFERENT report on the same screen
 *
 * Gated by the same `requireRoles` above (PM, ADMIN, COO, HOD, DEPT_HEAD), because it is the same
 * audience and the same scope rule; the loader narrows a head to his own Department exactly as the
 * portfolio report does.
 * ------------------------------------------------------------------------- */

/** The coverage filters, parsed from the query string. Junk is refused, never silently widened. */
function parseCoverageFilters(query: Record<string, unknown>): CoverageFilters | { error: ParseError } {
  const list = (key: string): number[] => {
    const raw = query[key];
    if (raw == null || raw === "") return [];
    const text = Array.isArray(raw) ? raw.join(",") : String(raw);
    const ids = new Set<number>();
    for (const token of text.split(",")) {
      const trimmed = token.trim();
      if (!/^\d+$/.test(trimmed)) continue;
      const id = Number(trimmed);
      if (Number.isSafeInteger(id) && id > 0) ids.add(id);
    }
    return [...ids].sort((a, b) => a - b);
  };
  return {
    from: String(query.from ?? "").trim(),
    to: String(query.to ?? "").trim(),
    departmentIds: list("departmentIds"),
    sectionIds: list("sectionIds"),
    projectIds: list("projectIds"),
    // The Approval Status filter: unknown words are dropped by the parser, never a zero-row report.
    statuses: parseCoverageStatuses(query.statuses),
    page: query.page == null || query.page === "" ? 1 : Number(query.page),
    pageSize: query.pageSize == null || query.pageSize === "" ? undefined : Number(query.pageSize),
  };
}

function coverageActor(req: Request): CoverageActor {
  return {
    id: req.user!.id,
    name: req.user!.name,
    role: req.user!.role,
    departmentId: req.user!.departmentId ?? null,
  };
}

/**
 * GET /api/reports/timesheet-coverage — the report as JSON.
 *
 * PAGED server-side, unlike the portfolio tables. Those page on the client because a section holds
 * ~60 rows; THIS report's row count is `employees x days` (500 x 31 = 15,500), so sending every row
 * to the browser to page there would push megabytes for one screenful. The coverage figures are
 * computed over ALL rows before the page is cut, so the summary never changes with the page.
 */

/**
 * GET /api/reports/not-booked — the CLMS men nobody booked, folded per person.
 *
 * The coverage report already lists every unfilled employee-day; this is the same fact asked as a payroll
 * question, so it uses the SAME roster rule (`employmentType: "CLMS"`, active) and the SAME idea of "booked"
 * (a day with any sheet, whatever its status). Payroll staff are outside it by construction: they are paid
 * by allocation, not by timesheet.
 */
/** `?departmentIds=4,7` -> [4, 7]. Non-numeric tokens are dropped, never turned into a zero-row report. */
function idList(raw: unknown): number[] {
  const text = String(raw ?? "").trim();
  if (!text) return [];
  const ids = new Set<number>();
  for (const token of text.split(",")) {
    const trimmed = token.trim();
    if (!/^\d+$/.test(trimmed)) continue;
    const id = Number(trimmed);
    if (Number.isSafeInteger(id) && id > 0) ids.add(id);
  }
  return [...ids].sort((a, b) => a - b);
}

function readNotBookedRange(req: Request): { from: string; to: string } | { error: string } {
  const today = new Date();
  const firstOfMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const from = String(req.query.from ?? firstOfMonth);
  const to = String(req.query.to ?? today.toISOString().slice(0, 10));
  const shape = /^\d{4}-\d{2}-\d{2}$/;
  if (!shape.test(from) || !shape.test(to)) return { error: "from and to must be YYYY-MM-DD" };
  if (from > to) return { error: "from must be on or before to" };
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  if (days > 62) return { error: "the range is longer than 62 days; pick a shorter one" };
  return { from, to };
}

async function buildNotBooked(req: Request) {
  const range = readNotBookedRange(req);
  if ("error" in range) return range;

  const role = req.user!.role;
  const departmentScoped = role === "HOD" || role === "DEPT_HEAD";
  // Department and Section narrow the roster the way every other Reports filter does: a scoped user can
  // only narrow inside his own Department, and a request outside it is an honest empty report rather than
  // a silent widening to his own.
  const roleDepartment = departmentScoped ? req.user!.departmentId : null;
  const askedDepartments = idList(req.query.departmentIds);
  const departmentIds = roleDepartment
    ? askedDepartments.length
      ? askedDepartments.filter((id) => id === roleDepartment)
      : [roleDepartment]
    : askedDepartments;
  const sectionIds = idList(req.query.sectionIds);
  const people = await prisma.employee.findMany({
    where: {
      active: true,
      employmentType: "CLMS",
      ...(departmentIds.length ? { departmentId: { in: departmentIds } } : {}),
      ...(sectionIds.length ? { sectionAssignment: { sectionId: { in: sectionIds } } } : {}),
    },
    select: {
      id: true,
      ecNo: true,
      name: true,
      category: true,
      department: { select: { name: true } },
      sectionAssignment: { select: { section: { select: { name: true } } } },
    },
  });

  const fromDate = new Date(`${range.from}T00:00:00.000Z`);
  const toDate = new Date(`${range.to}T00:00:00.000Z`);
  const [sheets, rates] = await Promise.all([
    prisma.timesheetDay.findMany({
      where: { workDate: { gte: fromDate, lte: toDate }, employeeId: { in: people.map((p) => p.id) } },
      select: { employeeId: true, workDate: true },
    }),
    prisma.costRate.findMany({ orderBy: { effectiveFrom: "desc" } }),
  ]);

  const booked = new Map<number, Set<string>>();
  for (const sheet of sheets) {
    const key = sheet.workDate.toISOString().slice(0, 10);
    const set = booked.get(sheet.employeeId) ?? new Set<string>();
    set.add(key);
    booked.set(sheet.employeeId, set);
  }

  // The dates this report divides by: calendar days, or the settled working days when the work calendar
  // answered for the whole range (SETTLE_REPORTS). Same seam as Timesheet coverage, same fail-safe.
  const calendar = await reportCalendarFor(eachDay(range.from, range.to));

  const report = summariseNotBooked({
    from: range.from,
    to: range.to,
    days: calendar.days,
    maxDailyHours: getMaxDailyHours(),
    people: people.map((p) => ({
      id: p.id,
      ecNo: p.ecNo,
      name: p.name,
      department: p.department.name,
      section: p.sectionAssignment?.section.name ?? "",
      category: p.category,
    })),
    booked,
    rateFor: (category) => {
      const row = rates.find((r) => r.category === category);
      return row ? Number(row.ratePerHour) : 0;
    },
  });
  // An empty cost-rate table is a data gap, not a zero: saying "Idle cost 0" would read as "these men cost
  // nothing", which is the opposite of the point.
  if (rates.length === 0) {
    report.notes.unshift(
      "No cost rate is configured, so Idle cost reads 0. Set a rate per category under Cost rates and this column prices the gap."
    );
  }
  // The denominator travels with the report, so the screen can state which days it divided by.
  return { ...report, calendar };
}

/**
 * Paged on the server: the screen asks for one page and gets one page.
 *
 * The roster is 601 people, so the unpaged response was ~600 rows of JSON for a table that shows 50 — pulled
 * from the database's process, serialised, compressed and thrown away six times over. Totals still describe
 * the WHOLE roster on every page (they are computed before the slice), because a total that changed as you
 * paged would be worse than no total.
 */
reportsRouter.get("/not-booked", requireRoles(...COVERAGE_ROLES), async (req, res) => {
  const report = await buildNotBooked(req);
  if ("error" in report) return res.status(400).json({ error: report.error });

  const pageSize = Math.min(200, Math.max(10, Number(req.query.pageSize ?? 50) || 50));
  const pageCount = Math.max(1, Math.ceil(report.people.length / pageSize));
  const page = Math.min(pageCount, Math.max(1, Number(req.query.page ?? 1) || 1));
  const start = (page - 1) * pageSize;

  res.json({
    ...report,
    people: report.people.slice(start, start + pageSize),
    page,
    pageSize,
    pageCount,
    rowTotal: report.people.length,
  });
});

reportsRouter.get("/not-booked.csv", requireRoles(...COVERAGE_ROLES), async (req, res) => {
  const report = await buildNotBooked(req);
  if ("error" in report) return res.status(400).json({ error: report.error });
  const quote = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  // The FILE is never paged - a download that carried one page would be a trap.
  const csv = notBookedCsv(report).map((line) => line.map(quote).join(",")).join("\r\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="not-booked-${report.from}_to_${report.to}.csv"`);
  res.send("\uFEFF" + csv);
});

reportsRouter.get("/timesheet-coverage", requireRoles(...COVERAGE_ROLES), async (req, res) => {
  const filters = parseCoverageFilters(req.query as Record<string, unknown>);
  if ("error" in filters) return res.status(400).json(filters.error);
  try {
    const report = await buildTimesheetCoverageReport(filters, coverageActor(req));
    return res.json(report);
  } catch (error) {
    if (error instanceof CoverageRequestError) {
      return res.status(400).json({ error: error.message, code: error.code });
    }
    const message = error instanceof Error ? error.message : "Failed to build the coverage report.";
    console.error("[reports] timesheet coverage failed:", error);
    return res.status(500).json({ error: message, code: "COVERAGE_REPORT_FAILED" });
  }
});

/**
 * GET /api/reports/timesheet-coverage.xlsx — the same report as a workbook.
 *
 * `includeAllRows: true` and NO page parameter is read from the request: a download is always the
 * whole period, so a hostile `?page=3` cannot turn the file into one page of the screen.
 */
reportsRouter.get("/timesheet-coverage.xlsx", requireRoles(...COVERAGE_ROLES), async (req, res) => {
  const filters = parseCoverageFilters(req.query as Record<string, unknown>);
  if ("error" in filters) return res.status(400).json(filters.error);
  const actor = coverageActor(req);
  try {
    const report = await buildTimesheetCoverageReport(
      { ...filters, page: 1, pageSize: undefined },
      actor,
      { includeAllRows: true }
    );
    const buffer = await buildTimesheetCoverageXlsx(report);
    const filename = timesheetCoverageFilename(report);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", String(buffer.length));
    res.send(buffer);

    await writeAudit(actor.id, "TIMESHEET_COVERAGE_EXPORT", "timesheet_coverage", `${report.from}..${report.to}`, {
      format: "xlsx",
      filterDescription: report.provenance.filters.map((entry) => `${entry.label}: ${entry.value}`).join("; "),
      scope: report.provenance.scope,
      employees: report.totals.employees,
      employeeDays: report.totals.employeeDays,
      filledDays: report.totals.filledDays,
      notFilledDays: report.totals.notFilledDays,
      generatedAt: report.generatedAt,
      generatedBy: actor,
      bytes: buffer.length,
    });
  } catch (error) {
    if (error instanceof CoverageRequestError) {
      return res.status(400).json({ error: error.message, code: error.code });
    }
    const message = error instanceof Error ? error.message : "Failed to build the coverage export.";
    console.error("[reports] timesheet coverage export failed:", error);
    return res.status(500).json({ error: message, code: "COVERAGE_EXPORT_FAILED" });
  }
});
