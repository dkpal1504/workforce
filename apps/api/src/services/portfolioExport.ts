/**
 * Portfolio report exports — the XLSX and the PDF.
 *
 * WHY THIS MODULE EXISTS, and why it is shaped the way it is:
 *
 *   The Operations Dashboard has THREE renderings of one report: the JSON screen
 *   (`GET /api/reports/portfolio`), an Excel workbook and a PDF. If each one built its own
 *   numbers, a screen and a download could disagree — the worst class of reporting bug,
 *   because both look plausible and a reader has no way to tell which is right.
 *
 *   So both exports are built from the SAME assembled `PortfolioReport` the JSON endpoint
 *   returns. `routes/reports.ts` calls `parsePortfolioFilters` once, `buildPortfolioReport`
 *   once, and then hands that one report object to `buildPortfolioXlsx` / `buildPortfolioPdf`.
 *   Nothing here re-queries the database, re-derives a band or re-scores attention: the
 *   layout is the only thing this module owns.
 *
 * BOTH BUILDERS ARE PURE (report in, Buffer out) so the layout can be asserted in a unit test
 * with an injected fixture, with no HTTP and no database. `portfolioExport.test.ts` proves —
 * among other things — that the row count on the "Job work" sheet equals `report.jobWork.length`,
 * which is the whole point of sharing the assembly.
 *
 * A NOTE ON THE PDF ENGINE: the api container has no Chromium, so a headless-browser PDF is
 * impossible. pdfkit is the deliberate choice; the tables below are drawn by hand (column
 * widths scaled to the page, a header row repeated on every page break, wrapping cells), which
 * is more work than `pdfkit-table` but keeps the dependency surface to the two packages the
 * task pinned.
 */

import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import {
  BANDS,
  describePortfolioFilters,
  type Band,
  type FilterLabels,
  type PortfolioFilters,
} from "./portfolioFilters";
import type { DepartmentRollUp, ProjectRollUp } from "./portfolioReporting";
import type { PortfolioReport, ReportJobRow } from "./portfolioReport";

/* --------------------------------------------------------------------------- *
 * Shared shaping
 * --------------------------------------------------------------------------- */

/** The two formats this module renders. Used for the audit row and the filename. */
export type PortfolioExportFormat = "xlsx" | "pdf";

/**
 * The download filename, e.g. `workforce-portfolio_2026-10-02_ab12cd34.xlsx`.
 *
 * The AS-OF date and the FILTERS HASH are both in the name on purpose: two differently
 * filtered reports can never collide on a name, and a file found in a downloads folder months
 * later still says which period and which scope it covers.
 */
export function portfolioExportFilename(
  report: PortfolioReport,
  format: PortfolioExportFormat
): string {
  return `workforce-portfolio_${report.asOf}_${report.provenance.filtersHash}.${format}`;
}

/** Percentages and hours are printed the same way in both formats so they can be compared. */
function pct(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}
function hours(value: number): string {
  return value.toFixed(2);
}
/** A null date is rendered as a dash, never as an empty cell that reads as "zero". */
function textOrDash(value: string | null): string {
  return value === null || value === "" ? "-" : value;
}
/** The attention reasons are the audit trail of a score; joined they are one readable cell. */
function reasonsText(row: ReportJobRow): string {
  return row.reasons.length ? row.reasons.join("; ") : "";
}
function sectionName(row: ReportJobRow): string {
  return row.section === null ? "-" : row.section.name;
}
/**
 * The row projection carries dates as `YYYY-MM-DD` strings. Turn one back into a real `Date` so
 * Excel holds a DATE, not text: the `yyyy-mm-dd` number format then applies, the column sorts
 * chronologically and a date can never be read as a raw serial number.
 */
function dateCell(key: string | null): Date | null {
  return key === null ? null : new Date(`${key}T00:00:00.000Z`);
}
/** The roll-ups already carry a `Date | null`; pass it through as a real date cell. */
function dateCellFromDate(value: Date | null): Date | null {
  return value;
}

/* --------------------------------------------------------------------------- *
 * XLSX
 * ------------------------------------------------------------------------- */

/** A value a worksheet cell may carry. `Date` (not a serial number) is what makes a date a date. */
type CellValue = string | number | Date | null;

type SheetColumn<T> = {
  header: string;
  /** Character width; ExcelJS scales by ~7px per unit. */
  width: number;
  /** Excel number format, applied per cell. `"0.0%"` renders a fraction as a percentage. */
  numFmt?: string;
  value: (row: T) => CellValue;
};

/** A key/value pair for the Summary and Filters sheets, where a number needs its own format. */
type LabelValue = { label: string; value: CellValue; numFmt?: string };

/**
 * Build a data sheet: a frozen header row, an autofilter over the used range, per-column
 * widths and per-cell number formats.
 *
 * The header is written through `sheet.columns` so it is row 1, which is what the frozen pane
 * pins — a reader scrolled to row 400 always knows which column they are looking at.
 * The autofilter is only set when there are data rows; a one-row filter range is noise.
 */
function addDataSheet<T>(
  workbook: ExcelJS.Workbook,
  name: string,
  columns: SheetColumn<T>[],
  rows: readonly T[]
): ExcelJS.Worksheet {
  const sheet = workbook.addWorksheet(name);
  sheet.columns = columns.map((column) => ({ header: column.header, width: column.width }));

  for (const row of rows) {
    const added = sheet.addRow(columns.map((column) => column.value(row)));
    columns.forEach((column, index) => {
      // Number format is set PER CELL rather than per column: the band/text columns must stay
      // general, and a column-level format would also dress the header.
      if (column.numFmt) added.getCell(index + 1).numFmt = column.numFmt;
    });
  }

  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).alignment = { vertical: "middle" };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  if (rows.length > 0) {
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: rows.length + 1, column: columns.length },
    };
  }
  return sheet;
}

/** A key/value sheet (Summary, Filters). Not autofiltered: it is a statement, not a table. */
function addLabelValueSheet(
  workbook: ExcelJS.Workbook,
  name: string,
  pairs: readonly LabelValue[]
): ExcelJS.Worksheet {
  const sheet = workbook.addWorksheet(name);
  sheet.columns = [{ width: 30 }, { width: 70 }];
  for (const pair of pairs) {
    const added = sheet.addRow([pair.label, pair.value]);
    if (pair.numFmt) added.getCell(2).numFmt = pair.numFmt;
    added.getCell(1).font = { bold: true };
  }
  return sheet;
}

/** Per-job-order columns for the detail sheets. The Band columns carry TEXT so the file is
 *  readable without colour — the colour is a bonus, never the message. */
const JOB_DETAIL_COLUMNS: SheetColumn<ReportJobRow>[] = [
  { header: "Project", width: 18, value: (row) => row.project.name },
  { header: "WBS", width: 14, value: (row) => row.wbs.wbsCode },
  { header: "Code", width: 12, value: (row) => row.code },
  { header: "Job", width: 30, value: (row) => row.name },
  { header: "Department", width: 18, value: (row) => row.department.name },
  { header: "Section", width: 16, value: (row) => sectionName(row) },
  { header: "Status", width: 10, value: (row) => row.status },
  { header: "UoM", width: 8, value: (row) => row.uom },
  { header: "Band", width: 15, value: (row) => row.hoursBand },
  { header: "Budget h", width: 12, numFmt: "0.00", value: (row) => row.budgetHours },
  { header: "Actual h", width: 12, numFmt: "0.00", value: (row) => row.actualHours },
  { header: "Burn %", width: 10, numFmt: "0.0%", value: (row) => row.burnPct },
  { header: "Hrs/day", width: 10, numFmt: "0.00", value: (row) => row.hoursPerDay },
  { header: "Forecast exhausted", width: 16, numFmt: "yyyy-mm-dd", value: (row) => dateCell(row.forecastExhaustedOn) },
  { header: "Target qty", width: 12, numFmt: "0.00", value: (row) => row.targetQty },
  { header: "Achieved qty", width: 13, numFmt: "0.00", value: (row) => row.achievedQty },
  { header: "Qty %", width: 10, numFmt: "0.0%", value: (row) => row.qtyPct },
  { header: "Qty band", width: 15, value: (row) => row.qtyBand },
  { header: "Balance qty", width: 12, numFmt: "0.00", value: (row) => row.balanceQty },
  { header: "Last booking", width: 13, numFmt: "yyyy-mm-dd", value: (row) => dateCell(row.lastBooking) },
  { header: "Days since activity", width: 14, numFmt: "0", value: (row) => row.daysSinceActivity },
  { header: "Unapproved h", width: 13, numFmt: "0.00", value: (row) => row.unapprovedHours },
  { header: "Oldest unapproved", width: 16, numFmt: "yyyy-mm-dd", value: (row) => dateCell(row.oldestUnapprovedAt) },
  { header: "Attention", width: 10, numFmt: "0", value: (row) => row.attentionScore },
  { header: "Reasons", width: 52, value: (row) => reasonsText(row) },
];

/** The exception buckets, in the order the report defines them, with their printed names. */
function exceptionSheets(report: PortfolioReport): Array<{ label: string; count: number; rows: ReportJobRow[] }> {
  const { exceptions } = report;
  return [
    { label: "No budget hours", count: exceptions.noBudgetHours.count, rows: exceptions.noBudgetHours.rows },
    { label: "Budget with no bookings", count: exceptions.budgetWithNoBookings.count, rows: exceptions.budgetWithNoBookings.rows },
    { label: "No approved progress", count: exceptions.noProgress.count, rows: exceptions.noProgress.rows },
    { label: "Hours awaiting approval", count: exceptions.unapproved.count, rows: exceptions.unapproved.rows },
  ];
}

/**
 * The workbook, as a pure function: the assembled report in, an xlsx Buffer out.
 *
 * `filters` is passed alongside the report because the READABLE filter list
 * (`describePortfolioFilters`) needs the label map, which is a presentation concern the report
 * itself does not carry.
 */
export async function buildPortfolioXlsx(
  report: PortfolioReport,
  filters: PortfolioFilters,
  labels?: FilterLabels
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = report.provenance.generatedBy.name;
  workbook.created = new Date(report.generatedAt);

  /* ---- Summary ---------------------------------------------------------- */
  const pulse: LabelValue[] = [
    { label: "Report", value: "Portfolio & Job-Work Operations Dashboard" },
    { label: "Generated at", value: report.generatedAt },
    { label: "Data as of", value: report.asOf },
    { label: "Generated by", value: `${report.provenance.generatedBy.name} (${report.provenance.generatedBy.role})` },
    { label: "Filters hash", value: report.provenance.filtersHash },
    { label: "", value: "" },
    { label: "Projects in scope", value: report.pulse.projects, numFmt: "0" },
    { label: "Job orders in scope", value: report.pulse.jobOrders, numFmt: "0" },
    { label: "Budgeted hours", value: report.pulse.budgetHours, numFmt: "0.00" },
    { label: "Actual hours", value: report.pulse.actualHours, numFmt: "0.00" },
    { label: "Portfolio burn", value: report.pulse.portfolioBurnPct, numFmt: "0.0%" },
    { label: "RED job orders", value: report.pulse.bands.RED, numFmt: "0" },
    { label: "AMBER job orders", value: report.pulse.bands.AMBER, numFmt: "0" },
    { label: "GREEN job orders", value: report.pulse.bands.GREEN, numFmt: "0" },
    { label: "NOT_MEASURABLE job orders", value: report.pulse.bands.NOT_MEASURABLE, numFmt: "0" },
    { label: "No activity", value: report.pulse.noActivity, numFmt: "0" },
    { label: "Hours awaiting approval", value: report.pulse.hoursAwaitingApproval, numFmt: "0.00" },
    { label: "Oldest unapproved", value: report.pulse.oldestUnapprovedAt },
    // needsPush is capped at 50 while the total is whole; the screen says "showing 50 of 63"
    // and the workbook must say the same thing rather than silently showing a short list.
    { label: "Needs push (shown of total)", value: `${report.needsPush.length} of ${report.needsPushTotal}` },
  ];
  addLabelValueSheet(workbook, "Summary", pulse);

  /* ---- Data sheets ------------------------------------------------------ */
  // "Needs push", "Job work" and "On track" share the detail columns; each is the report's own
  // already-ordered list, so the sheet order IS the ranking.
  addDataSheet(workbook, "Needs push", JOB_DETAIL_COLUMNS, report.needsPush);
  // The parity sheet: exactly one row per jobWork entry, no subtotals, no filtering.
  addDataSheet(workbook, "Job work", JOB_DETAIL_COLUMNS, report.jobWork);
  // On track carries BOTH halves of the split; the Band column tells GREEN (measurable and
  // healthy) apart from NOT_MEASURABLE (no hours budget to judge), which must never be blended.
  addDataSheet(workbook, "On track", JOB_DETAIL_COLUMNS, [
    ...report.onTrack,
    ...report.onTrackNotMeasurable,
  ]);

  /* ---- Dept load -------------------------------------------------------- */
  const deptColumns: SheetColumn<DepartmentRollUp>[] = [
    { header: "Department", width: 26, value: (row) => row.department.name },
    { header: "Sections", width: 10, numFmt: "0", value: (row) => row.sectionCount },
    { header: "Job orders", width: 11, numFmt: "0", value: (row) => row.jobOrderCount },
    { header: "Budget h", width: 12, numFmt: "0.00", value: (row) => row.budgetHours },
    { header: "Actual h", width: 12, numFmt: "0.00", value: (row) => row.actualHours },
    { header: "Burn %", width: 10, numFmt: "0.0%", value: (row) => row.burnPct },
    // Worst band headline vs the band of the summed hours: both are true and they answer
    // different questions, so both travel as text.
    { header: "Worst band", width: 15, value: (row) => row.hoursBand },
    { header: "Burn band", width: 15, value: (row) => row.burnBand },
    { header: "RED", width: 8, numFmt: "0", value: (row) => row.redCount },
    { header: "AMBER", width: 8, numFmt: "0", value: (row) => row.amberCount },
    { header: "GREEN", width: 8, numFmt: "0", value: (row) => row.greenCount },
    { header: "NOT_MEASURABLE", width: 16, numFmt: "0", value: (row) => row.notMeasurableCount },
    { header: "Attention", width: 10, numFmt: "0", value: (row) => row.attentionScore },
    { header: "Last booking", width: 13, numFmt: "yyyy-mm-dd", value: (row) => dateCellFromDate(row.lastBooking) },
  ];
  addDataSheet(workbook, "Dept load", deptColumns, report.departmentLoad);

  /* ---- Exceptions ------------------------------------------------------- */
  // One row per exception row, tagged with its bucket and the bucket's WHOLE count (the row
  // list is capped at 100, the count is not) so a reader can tell "1 of 3" from "1 of 100".
  type ExceptionRow = { bucket: string; count: number; row: ReportJobRow };
  const exceptionRows: ExceptionRow[] = [];
  for (const bucket of exceptionSheets(report)) {
    for (const row of bucket.rows) exceptionRows.push({ bucket: bucket.label, count: bucket.count, row });
  }
  const exceptionColumns: SheetColumn<ExceptionRow>[] = [
    { header: "Exception", width: 26, value: (item) => item.bucket },
    { header: "In bucket", width: 10, numFmt: "0", value: (item) => item.count },
    { header: "Project", width: 18, value: (item) => item.row.project.name },
    { header: "Code", width: 12, value: (item) => item.row.code },
    { header: "Job", width: 28, value: (item) => item.row.name },
    { header: "Department", width: 18, value: (item) => item.row.department.name },
    { header: "Band", width: 15, value: (item) => item.row.hoursBand },
    { header: "Budget h", width: 12, numFmt: "0.00", value: (item) => item.row.budgetHours },
    { header: "Actual h", width: 12, numFmt: "0.00", value: (item) => item.row.actualHours },
    { header: "Unapproved h", width: 13, numFmt: "0.00", value: (item) => item.row.unapprovedHours },
    { header: "Attention", width: 10, numFmt: "0", value: (item) => item.row.attentionScore },
    { header: "Reasons", width: 48, value: (item) => reasonsText(item.row) },
  ];
  addDataSheet(workbook, "Exceptions", exceptionColumns, exceptionRows);

  /* ---- Filters ---------------------------------------------------------- */
  // Every applied filter IN WORDS, so the workbook states its own scope. An unset filter reads
  // "All" (describePortfolioFilters), which is a complete statement — an ABSENT line is what
  // lets a reader assume a filter was not applied.
  const filterPairs: LabelValue[] = describePortfolioFilters(filters, labels).map((entry) => ({
    label: entry.label,
    value: entry.value,
  }));
  filterPairs.push(
    { label: "", value: "" },
    { label: "Filters hash", value: report.provenance.filtersHash },
    { label: "Data as of", value: report.asOf },
    { label: "Generated at", value: report.generatedAt },
    { label: "Generated by", value: report.provenance.generatedBy.name },
    { label: "Generated by role", value: report.provenance.generatedBy.role },
    { label: "", value: "" },
    { label: "Band thresholds", value: "(booked hours vs budget in force)" }
  );
  for (const band of BANDS) {
    filterPairs.push({ label: `  ${band}`, value: report.definitions.bands[band].label });
  }
  filterPairs.push({ label: "", value: "" }, { label: "Attention weights", value: "(added to each job order's attention score)" });
  const weights = report.definitions.attentionWeights;
  filterPairs.push(
    { label: "  hours RED", value: weights.hoursRed, numFmt: "0" },
    { label: "  hours AMBER", value: weights.hoursAmber, numFmt: "0" },
    { label: "  no activity 7d", value: weights.noActivity7d, numFmt: "0" },
    { label: "  approval ageing 3d", value: weights.unapprovedAging3d, numFmt: "0" },
    { label: "  quantity behind", value: weights.quantityBehind, numFmt: "0" },
    { label: "  no budget", value: weights.noBudget, numFmt: "0" },
    { label: "", value: "" },
    { label: "Activity window", value: report.definitions.activityWindowDaysNote }
  );
  for (const note of report.definitions.notes) filterPairs.push({ label: "Note", value: note });
  addLabelValueSheet(workbook, "Filters", filterPairs);

  // exceljs types `writeBuffer()` with its own ArrayBuffer-like `Buffer`, not Node's. At
  // runtime it is a Node Buffer; re-wrap it as a Uint8Array view so the declared return type is
  // the standard Node Buffer the route and the tests expect.
  const written = (await workbook.xlsx.writeBuffer()) as unknown as Uint8Array;
  return Buffer.from(written);
}

/* --------------------------------------------------------------------------- *
 * PDF
 * --------------------------------------------------------------------------- */

/** A4 landscape geometry (points). Kept as named constants so the table maths is checkable. */
const PDF_FONT_SIZE = 7.5;
const PDF_ROW_PADDING = 2;

type PdfColumn<T> = { header: string; width: number; value: (row: T) => string };

/**
 * Render a table section. A heading is followed by a header row, then the data. When a row
 * would fall off the bottom the page is broken and the HEADER ROW IS REPEATED — a table that
 * continues onto page 7 with no column names is unreadable.
 *
 * Column widths are authored as relative units and scaled to the printable width, so the
 * tables always fill an A4 landscape page without either overflowing or bunching up on the left.
 */
function drawTable<T>(
  doc: PDFKit.PDFDocument,
  title: string,
  columns: PdfColumn<T>[],
  rows: readonly T[]
): void {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const bottom = doc.page.height - doc.page.margins.bottom;
  const totalWidth = right - left;
  const units = columns.reduce((sum, column) => sum + column.width, 0) || 1;
  const widths = columns.map((column) => (column.width / units) * totalWidth);
  const headerHeight = PDF_FONT_SIZE + 8;

  // Keep the heading with at least its header row.
  if (doc.y + headerHeight + 22 > bottom) doc.addPage();
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#111111").text(title, left, doc.y);
  doc.moveDown(0.35);

  const drawHeader = (): void => {
    const y = doc.y;
    doc.font("Helvetica-Bold").fontSize(PDF_FONT_SIZE).fillColor("#000000");
    let x = left;
    columns.forEach((column, index) => {
      doc.text(column.header, x + 2, y + 2, { width: widths[index] - 4, lineGap: 0 });
      x += widths[index];
    });
    doc.y = y + headerHeight;
    doc.moveTo(left, doc.y).lineTo(right, doc.y).lineWidth(0.6).strokeColor("#888888").stroke();
  };

  if (doc.y + headerHeight > bottom) doc.addPage();
  drawHeader();

  if (rows.length === 0) {
    doc.font("Helvetica-Oblique").fontSize(PDF_FONT_SIZE).fillColor("#666666")
      .text("(nothing in this section for the current scope)", left, doc.y + 2, { width: totalWidth });
    doc.moveDown(0.8);
    return;
  }

  for (const row of rows) {
    const cells = columns.map((column, index) => ({
      text: column.value(row),
      width: widths[index],
    }));
    doc.font("Helvetica").fontSize(PDF_FONT_SIZE);
    // Wrap every cell, so a long attention reason is fully readable rather than truncated.
    let height = PDF_FONT_SIZE + PDF_ROW_PADDING;
    for (const cell of cells) {
      height = Math.max(height, doc.heightOfString(cell.text, { width: cell.width - 4, lineGap: 0 }));
    }
    if (doc.y + height > bottom) {
      doc.addPage();
      drawHeader();
    }
    const y = doc.y;
    let x = left;
    for (const cell of cells) {
      doc.fillColor("#111111").text(cell.text, x + 2, y + 1, { width: cell.width - 4, lineGap: 0 });
      x += cell.width;
    }
    // A hairline under each row: without it a wrapped row reads as two rows.
    doc.moveTo(left, y + height).lineTo(right, y + height).lineWidth(0.15).strokeColor("#dddddd").stroke();
    doc.y = y + height;
  }
  doc.moveDown(0.7);
}

/** Burn percentage and hours, formatted for a text-only medium. */
function pdfPct(value: number | null): string {
  return pct(value);
}
function pdfHours(value: number): string {
  return hours(value);
}

/** The columns the three job-order sections share in the PDF (narrower than the workbook). */
const PDF_JOB_COLUMNS: PdfColumn<ReportJobRow>[] = [
  { header: "Project", width: 20, value: (row) => row.project.name },
  { header: "Code", width: 12, value: (row) => row.code },
  { header: "Job", width: 30, value: (row) => row.name },
  { header: "Department", width: 20, value: (row) => row.department.name },
  { header: "Band", width: 14, value: (row) => row.hoursBand },
  { header: "Budget h", width: 11, value: (row) => pdfHours(row.budgetHours) },
  { header: "Actual h", width: 11, value: (row) => pdfHours(row.actualHours) },
  { header: "Burn %", width: 10, value: (row) => pdfPct(row.burnPct) },
  { header: "Attention", width: 11, value: (row) => String(row.attentionScore) },
  { header: "Last booking", width: 13, value: (row) => textOrDash(row.lastBooking) },
  // The reason strings are the audit trail: a reader can see WHY a row is in "Needs push".
  { header: "Reasons", width: 40, value: (row) => reasonsText(row) },
];

/**
 * The PDF, as a pure function: the assembled report in, a PDF Buffer out.
 *
 * MANDATORY PROVENANCE ON PAGE ONE. A report that cannot state its own scope, period and author
 * is a liability — someone will quote it in a meeting with no idea what it covers. So the first
 * page always carries the filters in words, the as-of date, the generation instant and the
 * generating user, and it also PRINTS THE RULES (band thresholds and attention weights) so any
 * red flag can be traced back to the threshold that produced it.
 */
export async function buildPortfolioPdf(
  report: PortfolioReport,
  filters: PortfolioFilters,
  labels?: FilterLabels
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      layout: "landscape",
      margin: 28,
      compress: true,
      info: { Title: `Portfolio report ${report.asOf}`, Author: report.provenance.generatedBy.name },
    });
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    try {
      const left = doc.page.margins.left;
      const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;

      /* ---- Provenance (page 1) ------------------------------------------ */
      doc.font("Helvetica-Bold").fontSize(16).fillColor("#111111")
        .text("Portfolio & Job-Work Operations Dashboard", left, doc.y, { width });
      doc.moveDown(0.2);
      doc.font("Helvetica").fontSize(9).fillColor("#333333");
      const filterLine = describePortfolioFilters(filters, labels)
        .map((entry) => `${entry.label}: ${entry.value}`)
        .join("   |   ");
      doc.text(`Filters applied: ${filterLine}`, left, doc.y, { width });
      doc.text(
        `Data as of: ${report.asOf}    |    Generated at: ${report.generatedAt}    |    Filters hash: ${report.provenance.filtersHash}`,
        left,
        doc.y,
        { width }
      );
      doc.text(
        `Generated by: ${report.provenance.generatedBy.name} (${report.provenance.generatedBy.role}, user id ${report.provenance.generatedBy.id})`,
        left,
        doc.y,
        { width }
      );
      doc.moveDown(0.3);
      doc.font("Helvetica-Bold").fontSize(9).text("Band thresholds (booked hours vs budget in force):", left, doc.y, { width });
      doc.font("Helvetica").fontSize(9);
      for (const band of BANDS) {
        const definition = report.definitions.bands[band];
        // One band per line so the label is never wrapped mid-phrase.
        doc.text(`    ${band.padEnd(16, " ")} ${definition.label}`, left, doc.y, { width });
      }
      doc.moveDown(0.2);
      doc.font("Helvetica-Bold").fontSize(9).text("Attention weights (added to each job order's attention score):", left, doc.y, { width });
      doc.font("Helvetica").fontSize(9);
      const w = report.definitions.attentionWeights;
      doc.text(
        `    hours RED +${w.hoursRed};  hours AMBER +${w.hoursAmber};  no activity 7d +${w.noActivity7d}`,
        left, doc.y, { width }
      );
      doc.text(
        `    approval ageing 3d +${w.unapprovedAging3d};  quantity behind +${w.quantityBehind};  no budget +${w.noBudget}`,
        left, doc.y, { width }
      );
      doc.text(`    ${report.definitions.activityWindowDaysNote}`, left, doc.y, { width });
      // The definitions NOTES are printed here as well as on the workbook's Filters sheet, so the
      // PDF inherits them from the SAME data block the screen and the XLSX render. In particular
      // the burn-vs-activity note explains why a GREEN row may also appear under Needs push.
      for (const note of report.definitions.notes) {
        doc.text(`    ${note}`, left, doc.y, { width });
      }
      doc.moveDown(0.5);

      /* ---- Summary ------------------------------------------------------ */
      const pulse: Array<{ label: string; value: string }> = [
        { label: "Projects in scope", value: String(report.pulse.projects) },
        { label: "Job orders in scope", value: String(report.pulse.jobOrders) },
        { label: "Budgeted hours", value: pdfHours(report.pulse.budgetHours) },
        { label: "Actual hours", value: pdfHours(report.pulse.actualHours) },
        { label: "Portfolio burn", value: pdfPct(report.pulse.portfolioBurnPct) },
        { label: "Bands", value: `RED ${report.pulse.bands.RED}; AMBER ${report.pulse.bands.AMBER}; GREEN ${report.pulse.bands.GREEN}; NOT_MEASURABLE ${report.pulse.bands.NOT_MEASURABLE}` },
        { label: "No activity", value: String(report.pulse.noActivity) },
        { label: "Hours awaiting approval", value: pdfHours(report.pulse.hoursAwaitingApproval) },
        { label: "Oldest unapproved", value: textOrDash(report.pulse.oldestUnapprovedAt) },
        { label: "Needs push (shown of total)", value: `${report.needsPush.length} of ${report.needsPushTotal}` },
      ];
      drawTable(doc, "Summary", [
        { header: "Metric", width: 34, value: (row: { label: string }) => row.label },
        { header: "Value", width: 40, value: (row: { value: string }) => row.value },
      ], pulse);

      /* ---- Project roll-ups (carried in the report but not a sheet of its own) ---- */
      const projectColumns: PdfColumn<ProjectRollUp>[] = [
        { header: "Project", width: 26, value: (row) => row.project.name },
        { header: "Job orders", width: 12, value: (row) => String(row.jobOrderCount) },
        { header: "Budget h", width: 12, value: (row) => pdfHours(row.budgetHours) },
        { header: "Actual h", width: 12, value: (row) => pdfHours(row.actualHours) },
        { header: "Burn %", width: 10, value: (row) => pdfPct(row.burnPct) },
        { header: "Worst band", width: 14, value: (row) => row.hoursBand },
        { header: "Burn band", width: 14, value: (row) => row.burnBand },
        { header: "Attention", width: 11, value: (row) => String(row.attentionScore) },
      ];
      drawTable(doc, "Project roll-ups", projectColumns, report.projectRollUps);

      /* ---- Needs push / Job work / On track ----------------------------- */
      drawTable(doc, `Needs push (top ${report.needsPush.length} of ${report.needsPushTotal} by attention)`, PDF_JOB_COLUMNS, report.needsPush);
      drawTable(doc, "Job work (every job order in scope)", PDF_JOB_COLUMNS, report.jobWork);
      drawTable(doc, "On track", PDF_JOB_COLUMNS, [...report.onTrack, ...report.onTrackNotMeasurable]);

      /* ---- Department load ---------------------------------------------- */
      const deptColumns: PdfColumn<DepartmentRollUp>[] = [
        { header: "Department", width: 26, value: (row) => row.department.name },
        { header: "Sections", width: 10, value: (row) => String(row.sectionCount) },
        { header: "Job orders", width: 12, value: (row) => String(row.jobOrderCount) },
        { header: "Budget h", width: 12, value: (row) => pdfHours(row.budgetHours) },
        { header: "Actual h", width: 12, value: (row) => pdfHours(row.actualHours) },
        { header: "Burn %", width: 10, value: (row) => pdfPct(row.burnPct) },
        { header: "Worst band", width: 14, value: (row) => row.hoursBand },
        { header: "Burn band", width: 14, value: (row) => row.burnBand },
        { header: "RED/AMBER/GREEN", width: 20, value: (row) => `${row.redCount}/${row.amberCount}/${row.greenCount}` },
        { header: "Attention", width: 11, value: (row) => String(row.attentionScore) },
      ];
      drawTable(doc, "Department load", deptColumns, report.departmentLoad);

      /* ---- Exceptions ---------------------------------------------------- */
      type ExceptionPdfRow = { bucket: string; count: number; row: ReportJobRow; shown: number };
      const exceptionRows: ExceptionPdfRow[] = [];
      for (const bucket of exceptionSheets(report)) {
        for (const row of bucket.rows) {
          exceptionRows.push({ bucket: bucket.label, count: bucket.count, row, shown: bucket.rows.length });
        }
      }
      const exceptionColumns: PdfColumn<ExceptionPdfRow>[] = [
        { header: "Exception", width: 24, value: (item) => item.bucket },
        { header: "Count (shown)", width: 13, value: (item) => `${item.count} (${item.shown})` },
        { header: "Project", width: 20, value: (item) => item.row.project.name },
        { header: "Code", width: 12, value: (item) => item.row.code },
        { header: "Band", width: 13, value: (item) => item.row.hoursBand },
        { header: "Budget h", width: 11, value: (item) => pdfHours(item.row.budgetHours) },
        { header: "Actual h", width: 11, value: (item) => pdfHours(item.row.actualHours) },
        { header: "Unapproved h", width: 12, value: (item) => pdfHours(item.row.unapprovedHours) },
        { header: "Reasons", width: 40, value: (item) => reasonsText(item.row) },
      ];
      drawTable(doc, "Exceptions", exceptionColumns, exceptionRows);

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}
