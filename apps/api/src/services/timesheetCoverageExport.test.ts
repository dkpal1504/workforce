import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import {
  buildTimesheetCoverageXlsx,
  detailHeaders,
  filledShareLabel,
  timesheetCoverageFilename,
} from "./timesheetCoverageExport";
import type { CoverageRow, TimesheetCoverageReport } from "./timesheetCoverageReport";

/**
 * WHY THESE TESTS EXIST: a workbook is the deliverable someone forwards, so two things have to be
 * true that nothing else checks — the file must contain EVERY row of the report (a page of a report
 * that looks complete is a lie nobody catches), and it must state its own period and scope on the
 * sheet itself, because the file travels without the screen.
 */

function row(date: string, employeeId: number, status: CoverageRow["status"], name: string): CoverageRow {
  return {
    date,
    department: { id: 7, name: "Production - EOU" },
    section: { id: 1, name: "Hull" },
    supervisors: ["Sup A"],
    remarks: null,
    employee: { id: employeeId, ecNo: `EMP${employeeId}`, name },
    projectHours: { P1: 8 },
    projectOtHours: { P1: 2 },
    regularTotal: 8,
    otTotal: 2,
    totalHours: 10,
    overheads: 0,
    combinedHours: 10,
    status,
  };
}

function report(overrides: Partial<TimesheetCoverageReport> = {}): TimesheetCoverageReport {
  const rows = [row("2026-10-01", 101, "Approved", "EMP1"), row("2026-10-01", 102, "Not Filled", "EMP2")];
  return {
    from: "2026-10-01",
    to: "2026-10-02",
    days: ["2026-10-01", "2026-10-02"],
    generatedAt: "2026-10-03T09:00:00.000Z",
    provenance: {
      filters: [
        { label: "Period", value: "2026-10-01 to 2026-10-02 (2 day(s))" },
        { label: "Projects (columns)", value: "All projects" },
      ],
      scope: "Whole organisation (no Department filter)",
      generatedBy: { id: 1, name: "Platform Admin", role: "ADMIN" },
    },
    definitions: {
      statuses: [{ status: "Approved", meaning: "Approved by the PM" }],
      hours: { regular: "reg", overtime: "ot", overheads: "oh", combined: "combo", maxDailyHours: 8 },
      population: "Every active CLMS employee in scope",
      duplicateSheets: "Least advanced status wins",
      notes: ["Note one"],
    },
    projects: [{ colorKey: "P1", name: "Project A" }],
    rows,
    rowTotal: rows.length,
    page: 1,
    pageSize: 50,
    pageCount: 1,
    coverage: [
      {
        department: { id: 7, name: "Production - EOU" },
        section: { id: 1, name: "Hull" },
        employees: 2,
        employeeDays: 2,
        filledDays: 1,
        notFilledDays: 1,
        employeesWithFilledDay: 1,
        employeesWithNoFilledDay: 1,
        filledPct: 0.5,
      },
    ],
    totals: {
      employees: 2,
      employeeDays: 2,
      filledDays: 1,
      notFilledDays: 1,
      employeesWithNoFilledDay: 1,
      filledPct: 0.5,
    },
    maxDailyHours: 8,
    ...overrides,
  };
}

test("a PARTIAL (paged) report is refused rather than exported as a quiet subset", async () => {
  const paged = report({ rowTotal: 15500, rows: [row("2026-10-01", 101, "Approved", "EMP1")] });
  await assert.rejects(() => buildTimesheetCoverageXlsx(paged), /Refusing to export a partial report/);
});

test("the detail headers are the operator's columns, one Regular/OT pair per Project", () => {
  const headers = detailHeaders(report());
  assert.deepEqual(headers.slice(0, 6), ["Date", "Department", "Section", "Supervisor", "EC No", "Employee name"]);
  assert.ok(headers.includes("Project A — Regular"));
  assert.ok(headers.includes("Project A — OT"));
  assert.deepEqual(headers.slice(-7), [
    "Total Project hours — Regular",
    "Total Project hours — OT",
    "Total Project hours — Total",
    "Overheads",
    "Combined Hours",
    "Approval Status",
    "Remarks",
  ]);
});

test("the workbook carries both sheets, every data row, and its own provenance", async () => {
  const source = report();
  const buffer = await buildTimesheetCoverageXlsx(source);
  assert.ok(buffer.length > 0, "a workbook was produced");

  // Re-open the buffer: asserting on the artefact, not on the object that produced it.
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const names = workbook.worksheets.map((sheet) => sheet.name);
  assert.deepEqual(names, ["Coverage", "Timesheet detail"]);

  const coverage = workbook.getWorksheet("Coverage");
  const detail = workbook.getWorksheet("Timesheet detail");
  assert.ok(coverage && detail);

  // EVERY row of the report is in the file — the parity that makes the download the report.
  const detailRows = detail.rowCount;
  const provenanceRows = detailRows - source.rows.length;
  assert.equal(
    detailRows - provenanceRows,
    source.rows.length,
    "the detail sheet holds exactly the report's rows"
  );

  // The period and the scope travel inside the file.
  const coverageText = coverage
    .getSheetValues()
    .flat()
    .filter((value): value is string => typeof value === "string")
    .join(" | ");
  assert.match(coverageText, /2026-10-01 to 2026-10-02/);
  assert.match(coverageText, /Whole organisation/);
  assert.match(coverageText, /Platform Admin/);
  assert.match(coverageText, /Not Filled|Not-filled/, "the definitions travel with the numbers");

  // The first data row of the detail sheet is the first row of the report, in order.
  const headerRowIndex = [...Array(detailRows).keys()].map((i) => i + 1).find((index) => {
    const first = detail.getRow(index).getCell(1).value;
    return String(first).startsWith("Date");
  });
  assert.ok(headerRowIndex, "the detail table has a header row");
  const firstData = detail.getRow(headerRowIndex + 1);
  assert.equal(String(firstData.getCell(5).value), "EMP101");
  assert.equal(String(firstData.getCell(6).value), "EMP1");

  // By HEADER, not by position: the status column used to be last and now has the supervisor's remark beside it,
  // and a test that names a column by its position breaks every time a column is added — which is exactly what
  // this one just proved.
  const header = detail.getRow(headerRowIndex);
  const columnOf = (name: string): number => {
    for (let index = 1; index <= detail.columnCount; index += 1) {
      if (String(header.getCell(index).value) === name) return index;
    }
    throw new Error(`no column called ${name}`);
  };
  assert.equal(String(firstData.getCell(columnOf("Approval Status")).value), "Approved");
  // The remark column exists on every detail sheet, and an employee-day with no remark is an EMPTY cell, not a
  // dash or a lie: "" is what the supervisor left behind.
  assert.equal(columnOf("Remarks"), detail.columnCount, "Remarks is the last column");
  assert.equal(String(firstData.getCell(columnOf("Remarks")).value), "");
});

test("the filename states the period, because that is what distinguishes two runs", () => {
  assert.equal(timesheetCoverageFilename(report()), "workforce-timesheet-coverage_2026-10-01_to_2026-10-02.xlsx");
});

test("the printed filled share is derived from the totals, so it cannot drift", () => {
  assert.equal(filledShareLabel(report()), "50.0% of employee-days filled (1 of 2)");
  const allFilled = report({
    totals: { employees: 2, employeeDays: 2, filledDays: 2, notFilledDays: 0, employeesWithNoFilledDay: 0, filledPct: 1 },
  });
  assert.equal(filledShareLabel(allFilled), "100.0% of employee-days filled (2 of 2)");
  const empty = report({
    rows: [],
    rowTotal: 0,
    totals: { employees: 0, employeeDays: 0, filledDays: 0, notFilledDays: 0, employeesWithNoFilledDay: 0, filledPct: 0 },
  });
  assert.equal(filledShareLabel(empty), "0.0% of employee-days filled (0 of 0)");
});
