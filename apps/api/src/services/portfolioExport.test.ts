/**
 * The XLSX and PDF exports of the Operations Dashboard.
 *
 * WHAT THIS PROVES (and why it is worth proving):
 *
 *   1. THE FILE CANNOT DISAGREE WITH THE SCREEN. Both exports are built from the SAME
 *      assembled `PortfolioReport` the JSON endpoint returns, so the parity assertion — the
 *      row count on the "Job work" sheet equals `report.jobWork.length` — is the whole point
 *      of this file. A download that silently drops or duplicates a row is the worst kind of
 *      reporting bug, because both the screen and the file look plausible.
 *
 *   2. THE FILE IS SELF-DESCRIBING. The Filters sheet must state every applied filter IN
 *      WORDS plus the hash, the as-of date, the generation instant and the generating user.
 *      A report that cannot say what it covers is a liability.
 *
 *   3. A RED FLAG IS AUDITABLE. The "Needs push" / "Job work" rows carry their human reason
 *      strings ("hours budget exhausted", "12 h awaiting approval since ..."), and the PDF
 *      prints the band thresholds and attention weights, so a reader can trace a number back
 *      to the rule that produced it.
 *
 * Lives under src/services/ on purpose: `apps/api`'s test script globs `src/services/*.test.ts`,
 * so a test under src/routes/ would never run.
 */
import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { buildJobOrderFacts, type JobOrderFacts } from "./portfolioReporting";
import type { PortfolioFilters } from "./portfolioFilters";
import {
  assemblePortfolioReport,
  type PortfolioReport,
  type ReportActor,
} from "./portfolioReport";
import {
  buildPortfolioPdf,
  buildPortfolioXlsx,
  PDF_CELL_INSET,
  PDF_FONT_SIZE,
  PDF_JOB_COLUMNS,
  resolvePdfTableWidths,
} from "./portfolioExport";

const NOW = new Date("2026-10-02T00:00:00.000Z");
const DAY = 86_400_000;

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY);
}

const ACTOR: ReportActor = { id: 7, name: "Test Admin", role: "ADMIN" };

/** The scope every fixture below is reported under. Deliberately NON-default so the Filters
 *  sheet has to actually render the values (a default-everything filter set would prove
 *  nothing about the "state every applied filter" requirement). */
function fixtureFilters(overrides: Partial<PortfolioFilters> = {}): PortfolioFilters {
  return {
    projectIds: [1, 2],
    wbsIds: null,
    departmentIds: null,
    sectionIds: null,
    status: "active",
    budget: "with",
    bands: ["RED"],
    asOf: new Date("2026-09-30T00:00:00.000Z"),
    activityDays: 14,
    ...overrides,
  };
}

/** A real JobOrderFacts row, built by the SAME builder the loader uses, so the exports are
 *  tested against authentic bands, burn figures and attention reasons rather than stubs. */
function makeFact(params: {
  id: number;
  projectId: number;
  budgetHours: number;
  budgetQuantity?: number;
  /** An APPROVED progress entry at this cumulative quantity. Omitted means no progress at all,
   *  which is what makes `targetQty`-only rows exercise the divide-by-zero fallback. */
  approvedQty?: number;
  actualHours: number;
  unapprovedHours?: number;
  oldestUnapprovedAt?: Date | null;
  lastBooking?: Date | null;
  departmentId?: number;
  sectionId?: number | null;
}): JobOrderFacts {
  return buildJobOrderFacts({
    jobOrder: {
      id: params.id,
      code: `JO-${String(params.id).padStart(4, "0")}`,
      name: `Job ${params.id}`,
      status: "active",
      budgetedHours: params.budgetHours,
      budgetedQuantity: params.budgetQuantity ?? 0,
      uom: "TON",
      project: { id: params.projectId, code: `P-${params.projectId}`, name: `Project ${params.projectId}` },
      wbs: { id: params.projectId * 100, wbsCode: `WBS-${params.projectId}`, name: "Primary WBS" },
      department: { id: params.departmentId ?? 1, name: `Dept ${params.departmentId ?? 1}` },
      section: params.sectionId == null ? null : { id: params.sectionId, name: `Section ${params.sectionId}` },
    },
    budgetRevisions:
      params.budgetHours > 0
        ? [
            {
              revisionNo: 1,
              budgetedHours: params.budgetHours,
              budgetedQuantity: params.budgetQuantity ?? 0,
              effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
            },
          ]
        : [],
    actualHours: params.actualHours,
    unapprovedHours: params.unapprovedHours ?? 0,
    oldestUnapprovedAt: params.oldestUnapprovedAt ?? null,
    firstBooking: daysAgo(20),
    lastBooking: params.lastBooking ?? null,
    progressRows:
      params.approvedQty === undefined
        ? []
        : [
            {
              status: "APPROVED",
              cumulativeQuantity: params.approvedQty,
              progressDate: daysAgo(3),
              revisionNo: 1,
            },
          ],
    asOf: NOW,
    now: NOW,
  });
}

/** Four job orders covering all four bands, one of them RED with two reason strings. */
function fixtureReport(): PortfolioReport {
  const facts: JobOrderFacts[] = [
    // RED with unapproved hours ageing — carries BOTH reason strings.
    makeFact({
      id: 1,
      projectId: 1,
      budgetHours: 100,
      actualHours: 120,
      lastBooking: daysAgo(1),
      unapprovedHours: 12,
      oldestUnapprovedAt: daysAgo(5),
    }),
    // AMBER.
    makeFact({ id: 2, projectId: 1, budgetHours: 100, actualHours: 80, lastBooking: daysAgo(1) }),
    // GREEN and measurable.
    makeFact({ id: 3, projectId: 1, budgetHours: 200, actualHours: 20, lastBooking: daysAgo(1) }),
    // NOT_MEASURABLE on hours (no budget), AND the divide-by-zero case for quantity: a target of
    // 0 with 50 approved still reports `qtyCompletePct` 0 rather than NaN/blank.
    makeFact({ id: 4, projectId: 2, budgetHours: 0, budgetQuantity: 0, approvedQty: 50, actualHours: 0 }),
  ];
  return assemblePortfolioReport({ facts, filters: fixtureFilters(), actor: ACTOR, asOf: NOW, now: NOW });
}

/* ------------------------------------------------------------------ *
 * XLSX helpers
 * ------------------------------------------------------------------ */

/** The exact sheet names the workbook must contain, in order, one per report section. */
const EXPECTED_SHEETS = ["Summary", "Needs push", "Job work", "On track", "Dept load", "Exceptions", "Filters"];

/** Every string/number/date a sheet contains, flattened for substring assertions. */
function sheetText(sheet: ExcelJS.Worksheet): string {
  const parts: string[] = [];
  sheet.eachRow((row) => {
    row.eachCell((cell) => {
      const value = cell.value;
      if (value === null || value === undefined) return;
      if (value instanceof Date) parts.push(value.toISOString().slice(0, 10));
      else if (typeof value === "object" && "result" in value) parts.push(String((value as { result: unknown }).result));
      else parts.push(String(value));
    });
  });
  return parts.join(" | ");
}

/** The header row + every data row as raw arrays, so column positions can be read. */
function sheetRows(sheet: ExcelJS.Worksheet): unknown[][] {
  const rows: unknown[][] = [];
  sheet.eachRow((row) => {
    // row.values is 1-indexed (index 0 is empty); drop it.
    rows.push((row.values as unknown[]).slice(1));
  });
  return rows;
}

/* ------------------------------------------------------------------ *
 * XLSX
 * ------------------------------------------------------------------ */

test("buildPortfolioXlsx: opens with exceljs and contains exactly the seven expected sheets", async () => {
  const report = fixtureReport();
  const buffer = await buildPortfolioXlsx(report, fixtureFilters(), undefined);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);

  assert.deepEqual(
    workbook.worksheets.map((sheet) => sheet.name),
    EXPECTED_SHEETS,
    "one sheet per report section, in a fixed order"
  );
});

test("buildPortfolioXlsx: the Job work sheet row count EQUALS the JSON assembly's jobWork length", async () => {
  const report = fixtureReport();
  const buffer = await buildPortfolioXlsx(report, fixtureFilters(), undefined);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const sheet = workbook.getWorksheet("Job work");
  assert.ok(sheet, "the Job work sheet exists");

  // rowCount is header + data: no subtotal rows are appended, so this is a true parity check.
  assert.equal(sheet!.rowCount - 1, report.jobWork.length, "the file cannot drop or duplicate a job order");
  assert.equal(report.jobWork.length, 4, "the fixture really has four job orders");
});

test("buildPortfolioXlsx: the Filters sheet states every applied filter plus hash, as-of, generated-at and actor", async () => {
  const report = fixtureReport();
  const buffer = await buildPortfolioXlsx(report, fixtureFilters(), undefined);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const text = sheetText(workbook.getWorksheet("Filters")!);

  // Every applied filter in words (describePortfolioFilters).
  assert.ok(text.includes("Active"), "status in words");
  assert.ok(text.includes("With budget"), "budget in words");
  assert.ok(text.includes("RED"), "band in words");
  assert.ok(text.includes("14 days"), "activity window in words");
  assert.ok(text.includes("2026-09-30"), "the explicit as-of date");
  // The auditability stamp.
  assert.ok(text.includes(report.provenance.filtersHash), "the filters hash");
  assert.ok(text.includes(report.generatedAt), "the generated-at instant");
  assert.ok(text.includes("Test Admin") && text.includes("ADMIN"), "who generated it, and their role");
});

test("buildPortfolioXlsx: a RED job order is present WITH its reason strings", async () => {
  const report = fixtureReport();
  const buffer = await buildPortfolioXlsx(report, fixtureFilters(), undefined);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const sheet = workbook.getWorksheet("Needs push")!;

  const rows = sheetRows(sheet);
  const header = rows[0].map(String);
  const bandColumn = header.indexOf("Band");
  assert.ok(bandColumn >= 0, "the sheet has a readable text Band column (not colour-only)");

  const redRow = rows.find((row) => String(row[bandColumn]) === "RED");
  assert.ok(redRow, "the RED job order appears in Needs push");
  const redText = redRow!.map((cell) => String(cell)).join(" | ");
  assert.ok(redText.includes("hours budget exhausted"), "the RED reason string travels with the row");
  assert.ok(redText.includes("awaiting approval"), "the approval-ageing reason string travels with the row");
});

test("buildPortfolioXlsx: dates are real Date cells with a date format, and percentages are numeric", async () => {
  const report = fixtureReport();
  const buffer = await buildPortfolioXlsx(report, fixtureFilters(), undefined);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const sheet = workbook.getWorksheet("Job work")!;
  const header = (sheet.getRow(1).values as unknown[]).slice(1).map(String);
  const column = (name: string) => header.indexOf(name) + 1;

  // The RED fixture row has a lastBooking of yesterday, so the cell must be a real Date.
  const rows = sheetRows(sheet);
  const redIndex = rows.findIndex((row) => String(row[header.indexOf("Band")]) === "RED");
  assert.ok(redIndex >= 0, "the RED row exists");
  const lastBookingCell = sheet.getRow(redIndex + 2).getCell(column("Last bk"));
  assert.ok(lastBookingCell.value instanceof Date, `a date cell holds a Date, not text (got ${typeof lastBookingCell.value})`);
  assert.equal(lastBookingCell.numFmt, "yyyy-mm-dd", "and carries a date number format");

  // A percentage is stored as a FRACTION with a percent format, so Excel does the maths.
  const burnCell = sheet.getRow(redIndex + 2).getCell(column("Burn %"));
  assert.equal(typeof burnCell.value, "number");
  assert.equal(burnCell.numFmt, "0.0%");
});

/* ------------------------------------------------------------------ *
 * The quantity columns (QTY_BDG / QTY_Prgsd / %Qty)
 * ------------------------------------------------------------------ */

test("buildPortfolioXlsx: the Job work sheet has the three QTY headers EXACTLY and none of the old trio", async () => {
  const report = fixtureReport();
  const buffer = await buildPortfolioXlsx(report, fixtureFilters(), undefined);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const header = (workbook.getWorksheet("Job work")!.getRow(1).values as unknown[]).slice(1).map(String);

  // The operator named these three, and the file is read in Excel alongside their own trackers,
  // so the header strings are exact.
  assert.ok(header.includes("QTY_BDG"), "QTY_BDG column present");
  assert.ok(header.includes("QTY_Prgsd"), "QTY_Prgsd column present");
  assert.ok(header.includes("%Qty"), "%Qty column present");
  // The old trio must be GONE: two columns saying the same thing read as a discrepancy.
  for (const stale of ["Target qty", "Achieved qty", "Qty %"]) {
    assert.ok(!header.includes(stale), `the redundant "${stale}" header was removed`);
  }
  // The band and balance carry information the three do not, so they must survive the trim.
  assert.ok(header.includes("Qty band"), "Qty band kept");
  assert.ok(header.includes("Balance qty"), "Balance qty kept");
  // Exactly one column each — not a duplicate pair.
  assert.equal(header.filter((h) => h === "QTY_BDG").length, 1, "QTY_BDG appears exactly once");
  assert.equal(header.filter((h) => h === "QTY_Prgsd").length, 1, "QTY_Prgsd appears exactly once");
  assert.equal(header.filter((h) => h === "%Qty").length, 1, "%Qty appears exactly once");
});

test("buildPortfolioXlsx: the %Qty cell is a numeric fraction with the 0.0% format, not text", async () => {
  // 55 of 100 approved — a clean fraction to prove the CELL, not just the number.
  const facts: JobOrderFacts[] = [
    makeFact({ id: 1, projectId: 1, budgetHours: 100, budgetQuantity: 100, approvedQty: 55, actualHours: 10 }),
  ];
  const report = assemblePortfolioReport({ facts, filters: fixtureFilters(), actor: ACTOR, asOf: NOW, now: NOW });
  const buffer = await buildPortfolioXlsx(report, fixtureFilters(), undefined);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const sheet = workbook.getWorksheet("Job work")!;
  const header = (sheet.getRow(1).values as unknown[]).slice(1).map(String);
  const column = (name: string) => header.indexOf(name) + 1;

  const cell = sheet.getRow(2).getCell(column("%Qty"));
  assert.equal(typeof cell.value, "number", "the %Qty cell holds a number, so Excel does the maths");
  assert.equal(cell.value, 0.55, "55 of 100 is stored as the fraction 0.55");
  assert.equal(cell.numFmt, "0.0%", "and carries the 0.0% number format");

  const bdgCell = sheet.getRow(2).getCell(column("QTY_BDG"));
  assert.equal(bdgCell.value, 100, "QTY_BDG carries targetQty");
  assert.equal(bdgCell.numFmt, "0.00", "QTY_BDG uses the 0.00 format");
  const prgsdCell = sheet.getRow(2).getCell(column("QTY_Prgsd"));
  assert.equal(prgsdCell.value, 55, "QTY_Prgsd carries achievedQty");
  assert.equal(prgsdCell.numFmt, "0.00", "QTY_Prgsd uses the 0.00 format");
});

test("buildPortfolioXlsx: targetQty 0 shows %Qty as the number 0 — not NaN, not null, not blank", async () => {
  // 0 budgeted with 50 approved: the divide-by-zero case. `qtyCompletePct` must resolve it to a
  // real 0 so the cell prints "0.0%" and never "n/a", an empty cell, or an error.
  const facts: JobOrderFacts[] = [
    makeFact({ id: 1, projectId: 1, budgetHours: 0, budgetQuantity: 0, approvedQty: 50, actualHours: 0 }),
  ];
  const report = assemblePortfolioReport({ facts, filters: fixtureFilters(), actor: ACTOR, asOf: NOW, now: NOW });
  const buffer = await buildPortfolioXlsx(report, fixtureFilters(), undefined);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const sheet = workbook.getWorksheet("Job work")!;
  const header = (sheet.getRow(1).values as unknown[]).slice(1).map(String);
  const cell = sheet.getRow(2).getCell(header.indexOf("%Qty") + 1);

  assert.equal(cell.value, 0, "a zero target resolves to a real 0, never NaN");
  assert.equal(typeof cell.value, "number", "and it is a number, never blank/null/text");
  assert.notEqual(cell.value, null, "never null");
  assert.equal(cell.numFmt, "0.0%", "still carries the percent format, so it prints 0.0%");
});

test("buildPortfolioXlsx: over-achievement (150 of 100) shows 1.5, NOT a clamped 1.0", async () => {
  // The file must tell the truth: delivering beyond the plan is real information, and clamping
  // would hide it. `qtyCompletePct` is deliberately not clamped — this test is the tripwire.
  const facts: JobOrderFacts[] = [
    makeFact({ id: 1, projectId: 1, budgetHours: 100, budgetQuantity: 100, approvedQty: 150, actualHours: 10 }),
  ];
  const report = assemblePortfolioReport({ facts, filters: fixtureFilters(), actor: ACTOR, asOf: NOW, now: NOW });
  const buffer = await buildPortfolioXlsx(report, fixtureFilters(), undefined);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const sheet = workbook.getWorksheet("Job work")!;
  const header = (sheet.getRow(1).values as unknown[]).slice(1).map(String);
  const cell = sheet.getRow(2).getCell(header.indexOf("%Qty") + 1);

  assert.equal(cell.value, 1.5, "150 of 100 is 1.5, never clamped to 1.0");
  assert.equal(sheet.getRow(2).getCell(header.indexOf("QTY_BDG") + 1).value, 100, "QTY_BDG is the target");
  assert.equal(sheet.getRow(2).getCell(header.indexOf("QTY_Prgsd") + 1).value, 150, "QTY_Prgsd is the delivered quantity");
});

/* ------------------------------------------------------------------ *
 * PDF helpers — extracting text is awkward, so this reconstructs it from
 * the content streams: inflate each FlateDecode stream, then decode the
 * PDF text operators (hex <....> strings and literal (...) strings).
 * What it asserts is the VISIBLE glyph text, not the raw bytes.
 * ------------------------------------------------------------------ */

function extractPdfText(buffer: Buffer): string {
  const latin = buffer.toString("latin1");
  const streams = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  const parts: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = streams.exec(latin)) !== null) {
    const raw = Buffer.from(match[1], "latin1");
    let inflated: Buffer | null = null;
    for (const candidate of [raw, raw.slice(0, -1), raw.slice(0, -2)]) {
      try {
        inflated = zlib.inflateSync(candidate);
        break;
      } catch {
        // Not this one; try the next trim.
      }
    }
    if (!inflated) continue;
    const content = inflated.toString("latin1");
    // pdfkit emits one visible string as SEVERAL fragments inside a `TJ` array (kerning
    // boundaries split e.g. "Test Admin" into "T" + "est Admin"), so the decoded fragments of a
    // stream are CONCATENATED, not space-joined, or the assertion would see "T est Admin".
    let streamText = "";
    for (const hex of content.matchAll(/<([0-9A-Fa-f]+)>/g)) {
      if (hex[1].length % 2 === 0) streamText += Buffer.from(hex[1], "hex").toString("latin1");
    }
    for (const literal of content.matchAll(/\(((?:\\.|[^\\()])*)\)/g)) streamText += literal[1];
    parts.push(streamText);
  }
  return parts.join("\n");
}

/* ------------------------------------------------------------------ *
 * PDF
 * ------------------------------------------------------------------ */

test("buildPortfolioPdf: a real PDF buffer (magic bytes, non-trivial length)", async () => {
  const report = fixtureReport();
  const buffer = await buildPortfolioPdf(report, fixtureFilters(), undefined);

  assert.equal(buffer.slice(0, 5).toString("latin1"), "%PDF-", "starts with the PDF magic bytes");
  assert.ok(buffer.length > 1000, `a real document, not a stub (got ${buffer.length} bytes)`);
});

test("buildPortfolioPdf: the text carries the provenance block and the printed band rules", async () => {
  const report = fixtureReport();
  const buffer = await buildPortfolioPdf(report, fixtureFilters(), undefined);
  const text = extractPdfText(buffer);

  // Provenance (mandatory): who generated it, under what scope, as of when.
  assert.ok(text.includes("Test Admin"), "generated-by name");
  assert.ok(text.includes("ADMIN"), "generated-by role");
  assert.ok(text.includes("2026-09-30"), "the as-of date");
  assert.ok(text.includes("With budget"), "an applied filter in words");
  assert.ok(text.includes("14 days"), "the activity window in words");
  assert.ok(text.includes(report.provenance.filtersHash), "the filters hash");

  // The rules, so any red flag can be audited back to its threshold.
  assert.ok(text.includes("budget exhausted"), "the RED band threshold label");
  assert.ok(text.includes("hours RED") && text.includes("40"), "the hours-RED attention weight");
  assert.ok(text.includes("activity"), "the activity-window note");
  // The note must state the OPERATOR'S window (the fixture uses 14), never a hardcoded 7.
  assert.ok(
    text.includes("more than 14 day(s) old"),
    "the printed rules must state the window the report was requested with"
  );
  // The burn-vs-activity explanation travels into the PDF from the definitions data block, so a
  // reader who sees a GREEN row on both On track and Needs push is told why.
  assert.ok(
    text.includes("Burn and activity are separate measures"),
    "the PDF must carry the burn-vs-activity note that explains the On track / Needs push overlap"
  );
});

test("buildPortfolioPdf: the Job-work table carries the QTY_BDG, QTY_Prgsd and %Qty headers and the shortened Last bk", async () => {
  const report = fixtureReport();
  const buffer = await buildPortfolioPdf(report, fixtureFilters(), undefined);
  const text = extractPdfText(buffer);

  // The PDF and the workbook name the quantity columns identically, so a reader moving between
  // the two never has to translate. Adding three columns took the table from 11 to 14, so the
  // headers must still be legible in the re-balanced widths.
  assert.ok(text.includes("QTY_BDG"), "the QTY_BDG header is rendered");
  assert.ok(text.includes("QTY_Prgsd"), "the QTY_Prgsd header is rendered");
  assert.ok(text.includes("%Qty"), "the %Qty header is rendered");
  // The four shared headers were shortened for the same reason as the workbook's.
  assert.ok(text.includes("Last bk"), "the shortened \"Last bk\" header is rendered");
  assert.ok(!text.includes("Last booking"), "the old \"Last booking\" header is gone from the PDF");
});

/* ------------------------------------------------------------------ *
 * The Band column must not wrap — MEASURED, not eyeballed
 * ------------------------------------------------------------------ */

/**
 * The widest Band label. Every other band value (RED / AMBER / GREEN) is shorter, so if this one
 * fits its column on one line at the table's font size, they all do. If a future band is added
 * with a longer name, it must be added here so it is measured too.
 */
const WIDEST_BAND_LABEL = "NOT_MEASURABLE";

/** A4 landscape with 28pt margins, as `buildPortfolioPdf` opens the document — the width the
 *  renderer actually scales the relative column units against. Kept in one place so the geometry
 *  cannot silently drift from the PDF constructor. */
const PDF_PRINTABLE_WIDTH = 785.89;

/** A throwaway measurer: pdfkit exposes `widthOfString`/`heightOfString` only on a document, and
 *  font metrics depend on neither the page size nor the layout, so this document is used purely
 *  as a font-metrics oracle at the SAME family and size the tables are drawn with. */
function measureWithPdfKit(text: string, width: number): { width: number; height: number } {
  const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 28 });
  doc.font("Helvetica").fontSize(PDF_FONT_SIZE);
  const measuredWidth = doc.widthOfString(text);
  const measuredHeight = doc.heightOfString(text, { width, lineGap: 0 });
  return { width: measuredWidth, height: measuredHeight };
}

test("buildPortfolioPdf: the Band column is MEASURED to fit \"NOT_MEASURABLE\" on one line", async () => {
  // Resolve the widths the way the renderer does: the RELATIVE units of PDF_JOB_COLUMNS scaled
  // across the printable width. This is the number that was ~47pt at 12 units — too small for a
  // ~71pt value — which is exactly what wrapped "NOT_MEASURABLE" into "NOT_MEAS" / "URABLE".
  const widths = resolvePdfTableWidths(PDF_JOB_COLUMNS, PDF_PRINTABLE_WIDTH);
  const bandIndex = PDF_JOB_COLUMNS.findIndex((column) => column.header === "Band");
  assert.ok(bandIndex >= 0, "the job tables still have a Band column");
  const bandPt = widths[bandIndex];

  // The glyph budget the cell actually gets: the renderer draws at `x + PDF_CELL_INSET` with a
  // running width of `columnWidth - 2 * PDF_CELL_INSET`, so the usable text width is the column
  // minus both insets. Measuring against the raw column would over-state the room by 4pt.
  const textPt = bandPt - 2 * PDF_CELL_INSET;

  const neededPt = measureWithPdfKit(WIDEST_BAND_LABEL, 10_000).width;
  const singleLineHeight = measureWithPdfKit("RED", 10_000).height;
  const wrappedHeightAtTextWidth = measureWithPdfKit(WIDEST_BAND_LABEL, textPt).height;

  // STATE THE ARITHMETIC: the point needed versus the point available, so a failure reads as a
  // measurement rather than a mystery. The width assertion is the real guarantee.
  const detail =
    `Band column ${bandPt.toFixed(2)}pt (${textPt.toFixed(2)}pt of text after insets); ` +
    `"${WIDEST_BAND_LABEL}" needs ${neededPt.toFixed(2)}pt at ${PDF_FONT_SIZE}pt Helvetica`;
  assert.ok(
    neededPt <= textPt,
    `the Band column must fit its widest value on ONE line: ${detail}`
  );

  // Belt and braces: pdfkit's own wrapper must agree. `heightOfString` returns ONE line height
  // when the text fits and MORE when it wraps (it returned 17.34 vs 8.67 at the old width), so a
  // wrap — the exact "NOT_MEAS / URABLE" defect — cannot slip through even if the width maths
  // above were ever refactored.
  assert.equal(
    wrappedHeightAtTextWidth,
    singleLineHeight,
    `pdfkit must not wrap the widest Band value: ${detail}`
  );
  // A regression tripwire: the old 12-unit Band column must NOT satisfy the fit. If this ever
  // passes, the measurement above has stopped checking the thing that broke.
  const oldWidths = resolvePdfTableWidths(
    PDF_JOB_COLUMNS.map((column) =>
      column.header === "Band" ? { ...column, width: 12 } : column
    ),
    PDF_PRINTABLE_WIDTH
  );
  assert.ok(
    neededPt > oldWidths[bandIndex] - 2 * PDF_CELL_INSET,
    "the 12-unit width that shipped would still wrap the value, so this test is not vacuous"
  );
});

test("buildPortfolioXlsx: the Band column can hold NOT_MEASURABLE without wrapping", async () => {
  // Read the width off a REAL workbook rather than a constant, so the assertion measures what a
  // reader actually opens. Excel's column width unit is a CHARACTER count, so the question is
  // simply whether the longest value fits the column's characters: 15 > 14, so it does.
  const report = fixtureReport();
  const buffer = await buildPortfolioXlsx(report, fixtureFilters(), undefined);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const sheet = workbook.getWorksheet("Job work")!;
  const header = (sheet.getRow(1).values as unknown[]).slice(1).map(String);
  const bandColumnNumber = header.indexOf("Band") + 1;
  assert.ok(bandColumnNumber >= 1, "the workbook still has a Band column");

  const bandWidth = sheet.getColumn(bandColumnNumber).width ?? 0;
  assert.ok(
    bandWidth > WIDEST_BAND_LABEL.length,
    `Excel Band width ${bandWidth} must exceed the ${WIDEST_BAND_LABEL.length}-character value "${WIDEST_BAND_LABEL}"`
  );
});
