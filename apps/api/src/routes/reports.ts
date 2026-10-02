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
import { writeAudit } from "../audit";

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
reportsRouter.use(requireAuth, requireRoles("PM", "ADMIN", "COO", "HOD", "DEPT_HEAD"));

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
      const buffer =
        format === "xlsx"
          ? await buildPortfolioXlsx(report, parsed.filters)
          : await buildPortfolioPdf(report, parsed.filters);

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
