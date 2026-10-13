/**
 * TIMESHEET COVERAGE BY DATE — "which employees have a timesheet on each date, and who is missing".
 *
 * WHAT IT ANSWERS: for every date in a range, EVERY active contract (CLMS) employee in the caller's
 * scope appears — 500 employees means 500 rows per date — with that person's hours per Project
 * (Regular / OT), that day's overheads and combined hours, and where the sheet has got to in the
 * approval chain. Plus the question the report exists for: per Department and Section, how many
 * employees were covered and how many were not.
 *
 * THE THREE DESIGN DECISIONS A READER WILL ASK ABOUT
 *
 *   1. THE ROW SET IS THE ROSTER, NOT THE BOOKINGS. Rows are built from the EMPLOYEE population and
 *      then matched to whatever sheets exist, so a person with no sheet still gets a row reading
 *      "Not Filled". Building it from bookings (the obvious way) would make the missing employees
 *      invisible — which is precisely the population this report is for.
 *
 *   2. ONE ROW PER (date x employee), even though a sheet is unique per (employee, workDate, tagger)
 *      and the same person can appear on two supervisors' sheets on the same day. The hours are
 *      summed across those sheets, the row names BOTH supervisors, and the status is the LEAST
 *      advanced of them. Two rows per person would break the roster count; and overheads must be
 *      computed on the person's whole day, because daily capacity belongs to the PERSON: two sheets
 *      of 4h are 8h against an 8h day (no overhead), where per-sheet arithmetic would invent 4h of
 *      unused capacity twice over.
 *
 *   3. THE PROJECT FILTER CHOOSES COLUMNS, NOT HOURS. Totals, overheads and combined hours always
 *      cover the whole day, so narrowing the project columns cannot change them. Narrowing the HOURS
 *      instead would inflate overheads (unused capacity measured against a smaller denominator), and
 *      the report would show two different answers for the same day depending on a display choice.
 *
 * SCOPE: the same rule as the rest of the Reports screen — `reportScopeFor` + `intersectDepartmentFilter`,
 * so PM/ADMIN/COO read every department and an HOD/DEPT_HEAD reads their own, a missing Department
 * mapping reads NOTHING (fail closed), and the request can only narrow.
 */

import { prisma } from "../db";
import { getMaxDailyHours } from "../config";
import { intersectDepartmentFilter, reportScopeFor } from "./roleAccess";
import { projectHoursFromEntries, type BookingEntryLike } from "./contractWorkHours";
import {
  NOT_FILLED,
  buildCoverage,
  combineCoverageStatuses,
  coverageRange,
  filterCoverageRows,
  parseCoverageStatuses,
  type CoverageBucket,
  type CoverageStatus,
} from "./timesheetCoverage";

/** The caller's identity, stamped into the provenance and used to derive the scope. */
export type CoverageActor = { id: number; name: string; role: string; departmentId: number | null };

export type CoverageFilters = {
  from: string;
  to: string;
  departmentIds: number[];
  sectionIds: number[];
  projectIds: number[];
  /** The Approval Status filter. Narrows the DETAIL rows only — see `filterCoverageRows`. */
  statuses?: string[];
  /** 1-based, JSON screen only. The export NEVER passes one (a download is always complete). */
  page?: number;
  pageSize?: number;
};

export type CoverageRow = {
  date: string;
  department: { id: number; name: string };
  section: { id: number; name: string } | null;
  /** The supervisors whose sheet(s) cover this employee-day; more than one when two sheets exist. */
  supervisors: string[];
  employee: { id: number; ecNo: string; name: string };
  /** Regular hours per Project colour key (the keys of `projects`). */
  projectHours: Record<string, number>;
  /** Overtime hours per Project colour key. */
  projectOtHours: Record<string, number>;
  regularTotal: number;
  otTotal: number;
  totalHours: number;
  overheads: number;
  combinedHours: number;
  status: CoverageStatus;
};

export type TimesheetCoverageReport = {
  from: string;
  to: string;
  days: string[];
  generatedAt: string;
  provenance: {
    filters: Array<{ label: string; value: string }>;
    scope: string;
    generatedBy: { id: number; name: string; role: string };
  };
  definitions: {
    statuses: Array<{ status: CoverageStatus; meaning: string }>;
    hours: {
      regular: string;
      overtime: string;
      overheads: string;
      combined: string;
      maxDailyHours: number;
    };
    population: string;
    duplicateSheets: string;
    notes: string[];
  };
  /** The Project columns of this report, in display order. */
  projects: Array<{ colorKey: string; name: string }>;
  /** The page of rows (JSON) or every row (export). */
  rows: CoverageRow[];
  rowTotal: number;
  page: number;
  pageSize: number;
  pageCount: number;
  coverage: CoverageBucket[];
  totals: {
    employees: number;
    employeeDays: number;
    filledDays: number;
    notFilledDays: number;
    employeesWithNoFilledDay: number;
    /** A FRACTION (0.87 = 87%), always finite. */
    filledPct: number;
  };
  maxDailyHours: number;
};

/** A refusal the route turns into a 400 (a bad range is the caller's mistake, not an empty report). */
export class CoverageRequestError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/** `YYYY-MM-DD` -> the UTC midnight the rows are keyed on (the timesheet's own convention). */
function dayToDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function dateToDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function normalizePage(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.floor(n);
}

function normalizePageSize(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.floor(n));
}

/**
 * Build the report. `includeAllRows` is what the export sets: it assembles every row and ignores any
 * page numbers, so a download can never be a page of the screen.
 */
export async function buildTimesheetCoverageReport(
  filters: CoverageFilters,
  actor: CoverageActor,
  options: { includeAllRows: boolean } = { includeAllRows: false }
): Promise<TimesheetCoverageReport> {
  const range = coverageRange(filters.from, filters.to);
  if (!range.ok) throw new CoverageRequestError(range.code, range.error);

  const maxDailyHours = getMaxDailyHours();

  // ---- Scope: derived server-side, intersected with the request, never trusted from it --------
  const scope = reportScopeFor(actor.role, actor.departmentId);
  const effectiveDepartmentIds = intersectDepartmentFilter(scope, filters.departmentIds.length ? filters.departmentIds : null);
  if (effectiveDepartmentIds !== null && effectiveDepartmentIds.length === 0) {
    // A DISJOINT request is an honest empty report, never a fallback to the actor's own department.
    return emptyReport(filters, actor, range, maxDailyHours, scopeLabel(scope, effectiveDepartmentIds));
  }
  const departmentWhere = effectiveDepartmentIds === null ? {} : { departmentId: { in: effectiveDepartmentIds } };

  // ---- The roster ---------------------------------------------------------------------------
  const employees = await prisma.employee.findMany({
    where: {
      active: true,
      employmentType: "CLMS",
      ...departmentWhere,
      ...(filters.sectionIds.length ? { sectionAssignment: { sectionId: { in: filters.sectionIds } } } : {}),
    },
    select: {
      id: true,
      ecNo: true,
      name: true,
      department: { select: { id: true, name: true } },
      sectionAssignment: { select: { section: { select: { id: true, name: true } } } },
    },
    orderBy: [{ department: { name: "asc" } }, { name: "asc" }],
  });

  const fromDate = dayToDate(range.from);
  const toDate = dayToDate(range.to);
  const employeeIds = employees.map((employee) => employee.id);

  // ---- The sheets, and the bookings on them --------------------------------------------------
  const sheets = employeeIds.length
    ? await prisma.timesheetDay.findMany({
        where: { employeeId: { in: employeeIds }, workDate: { gte: fromDate, lte: toDate } },
        select: {
          employeeId: true,
          workDate: true,
          status: true,
          taggedBy: { select: { name: true } },
          entries: {
            select: {
              projectWbsId: true,
              jobOrderId: true,
              status: true,
              shiftSlot: true,
              hourSlot: true,
              otHours: true,
              project: { select: { colorKey: true } },
              projectWbs: { select: { wbsCode: true, name: true } },
              jobOrder: { select: { project: { select: { colorKey: true } } } },
            },
          },
        },
      })
    : [];

  const sheetsByEmployeeDay = new Map<string, typeof sheets>();
  for (const sheet of sheets) {
    const key = `${sheet.employeeId}:${dateToDay(sheet.workDate)}`;
    const list = sheetsByEmployeeDay.get(key);
    if (list) list.push(sheet);
    else sheetsByEmployeeDay.set(key, [sheet]);
  }

  // ---- The Project columns: the master, in display order, narrowed by the Projects filter -----
  const projects = await prisma.project.findMany({
    where: filters.projectIds.length ? { id: { in: filters.projectIds } } : {},
    select: { colorKey: true, name: true },
    orderBy: { name: "asc" },
  });
  const projectColumns = projects
    .filter((project) => project.colorKey)
    .map((project) => ({ colorKey: String(project.colorKey).toUpperCase(), name: project.name }));

  // ---- One row per (date x employee) ---------------------------------------------------------
  const rows: CoverageRow[] = [];
  for (const day of range.days) {
    for (const employee of employees) {
      const daySheets = sheetsByEmployeeDay.get(`${employee.id}:${day}`) ?? [];
      const entries: BookingEntryLike[] = daySheets.flatMap((sheet) => sheet.entries);
      // NO SHEET MEANS NO HOURS — including no overheads. Overheads are UNUSED CAPACITY on a day the
      // person was present, and a missing sheet is not evidence that they were: inventing 8h there
      // would turn the very gap this report exists to expose into a booking, and would make
      // "combined hours" claim a day nobody can account for. A day WITH a sheet does report the
      // capacity gap, because the sheet is what proves the day happened.
      const booking = daySheets.length
        ? projectHoursFromEntries(entries, maxDailyHours)
        : { projectHours: {}, projectOtHours: {}, overhead: 0, totalAlloc: 0, regularTotalAlloc: 0, totalOtHours: 0 };
      rows.push({
        date: day,
        department: employee.department,
        section: employee.sectionAssignment?.section ?? null,
        supervisors: [...new Set(daySheets.map((sheet) => sheet.taggedBy.name))].sort(),
        employee: { id: employee.id, ecNo: employee.ecNo, name: employee.name },
        projectHours: booking.projectHours,
        projectOtHours: booking.projectOtHours,
        regularTotal: booking.regularTotalAlloc,
        otTotal: booking.totalOtHours,
        totalHours: booking.totalAlloc,
        overheads: booking.overhead,
        combinedHours: booking.totalAlloc + booking.overhead,
        status: combineCoverageStatuses(daySheets.map((sheet) => sheet.status)),
      });
    }
  }

  // ---- Coverage is computed over EVERY row, never over the page NOR over the status filter -----
  const coverage = buildCoverage(
    rows.map((row) => ({
      date: row.date,
      employeeId: row.employee.id,
      departmentId: row.department.id,
      departmentName: row.department.name,
      sectionId: row.section?.id ?? null,
      sectionName: row.section?.name ?? null,
      status: row.status,
    }))
  );
  const employeeDays = rows.length;
  const filledDays = rows.filter((row) => row.status !== NOT_FILLED).length;
  const employeesWithFilledDay = new Set(rows.filter((row) => row.status !== NOT_FILLED).map((row) => row.employee.id)).size;

  // The Approval Status filter narrows the DETAIL rows only: the coverage figures and the totals
  // above describe the whole roster, so filtering to "Not Filled" shows the gap rows while the
  // summary still states how big the gap is. `detailRows` is what the pager and the export use.
  const statusFilter = parseCoverageStatuses(filters.statuses);
  const detailRows = filterCoverageRows(rows, statusFilter);

  const pageSize = normalizePageSize(filters.pageSize);
  const pageCount = Math.max(1, Math.ceil(detailRows.length / pageSize));
  const page = options.includeAllRows ? 1 : Math.min(normalizePage(filters.page), pageCount);
  const pageRows = options.includeAllRows
    ? detailRows
    : detailRows.slice((page - 1) * pageSize, page * pageSize);

  return {
    from: range.from,
    to: range.to,
    days: range.days,
    generatedAt: new Date().toISOString(),
    provenance: {
      filters: [
        { label: "Period", value: `${range.from} to ${range.to} (${range.days.length} day(s))` },
        {
          label: "Department",
          value: effectiveDepartmentIds === null ? "All (no filter)" : effectiveDepartmentIds.join(", ") || "None",
        },
        { label: "Section", value: filters.sectionIds.length ? filters.sectionIds.join(", ") : "All (no filter)" },
        {
          label: "Projects (columns)",
          value: filters.projectIds.length ? projectColumns.map((project) => project.name).join(" · ") : "All projects",
        },
        {
          label: "Approval status (detail rows only)",
          value: statusFilter.length ? statusFilter.join(", ") : "All statuses",
        },
      ],
      scope: scopeLabel(scope, effectiveDepartmentIds),
      generatedBy: { id: actor.id, name: actor.name, role: actor.role },
    },
    definitions: {
      statuses: [
        { status: "Draft", meaning: "Timesheet is in draft, or was rejected / sent back to the supervisor" },
        { status: "Submitted", meaning: "Submitted by the supervisor, awaiting HOD approval" },
        { status: "HOD Approved", meaning: "Approved by the HOD, awaiting PM approval" },
        { status: "Approved", meaning: "Approved by the PM" },
        { status: NOT_FILLED, meaning: "No timesheet exists for this employee on this date" },
      ],
      hours: {
        regular: "Sum of booked regular slots: a shift slot (am1/am2/pm1/pm2) is 2h, a legacy hour slot is 1h.",
        overtime: "Sum of the day's OT hours, kept under the Project they are charged to.",
        overheads: `Unused regular capacity, computed once per employee-day: max(0, ${maxDailyHours}h - regular hours), and 0 on an OT-only day (OT then represents the whole attendance).`,
        combined: "Regular + OT + Overheads.",
        maxDailyHours,
      },
      population:
        "Every ACTIVE contract (CLMS) employee in scope, listed for EVERY date in the range — an employee with no timesheet is a row reading Not Filled, which is the point of the report.",
      duplicateSheets:
        "A sheet is unique per employee, date and supervisor, so one employee can appear on two supervisors' sheets on one day. The row sums their hours, names both supervisors, and reports the LEAST advanced status: a day is not approved until every sheet covering it is.",
      notes: [
        "Coverage counts the roster (employees) and the exposure (employee-days x dates) separately; an employee with one filled day out of twenty counts as covered AND leaves nineteen unfilled days.",
        "A date with NO sheet reports ZERO hours, including zero overheads: overheads are unused capacity on a day the person was present, and a missing sheet is not evidence that they were. A date WITH a sheet reports the capacity gap, because the sheet proves the day.",
        "The Project filter chooses which project COLUMNS appear; totals, overheads and combined hours always cover the whole day, so narrowing the columns cannot change them.",
        "The Approval Status filter narrows the DETAIL rows only. The coverage figures and the headline totals always describe the WHOLE roster — recomputing them from the filtered rows would make the filter circular: selecting 'Not Filled' would report 0% filled everywhere and hide the very gap being looked for.",
        "Days with no bookings at all are listed, not skipped: a date nobody filled in is the finding, not noise.",
      ],
    },
    projects: projectColumns,
    rows: pageRows,
    rowTotal: detailRows.length,
    page,
    pageSize,
    pageCount,
    coverage,
    totals: {
      employees: employees.length,
      employeeDays,
      filledDays,
      notFilledDays: employeeDays - filledDays,
      employeesWithNoFilledDay: employees.length - employeesWithFilledDay,
      filledPct: employeeDays === 0 ? 0 : filledDays / employeeDays,
    },
    maxDailyHours,
  };
}

function scopeLabel(scope: ReturnType<typeof reportScopeFor>, effectiveDepartmentIds: number[] | null): string {
  if (scope.kind === "NONE") return "None — this account has no usable scope, so the report is empty.";
  if (scope.kind === "ORGANISATION") {
    return effectiveDepartmentIds === null
      ? "Whole organisation (no Department filter)"
      : `Organisation scope, narrowed by the request to Department(s) ${effectiveDepartmentIds.join(", ")}`;
  }
  return `Department ${scope.departmentId} (the account's own scope; the request can only narrow it)`;
}

/** An honest empty report — used for a disjoint scope. It still carries the definitions. */
function emptyReport(
  filters: CoverageFilters,
  actor: CoverageActor,
  range: Extract<ReturnType<typeof coverageRange>, { ok: true }>,
  maxDailyHours: number,
  scope: string
): TimesheetCoverageReport {
  return {
    from: range.from,
    to: range.to,
    days: range.days,
    generatedAt: new Date().toISOString(),
    provenance: {
      filters: [
        { label: "Period", value: `${range.from} to ${range.to} (${range.days.length} day(s))` },
        { label: "Department", value: "None — the request is outside your scope" },
      ],
      scope,
      generatedBy: { id: actor.id, name: actor.name, role: actor.role },
    },
    definitions: {
      statuses: [],
      hours: { regular: "", overtime: "", overheads: "", combined: "", maxDailyHours },
      population: "Nothing is in scope, so there is no population to report.",
      duplicateSheets: "",
      notes: ["An empty report from a disjoint filter is the honest answer; the filter is never widened to your own Department."],
    },
    projects: [],
    rows: [],
    rowTotal: 0,
    page: 1,
    pageSize: normalizePageSize(filters.pageSize),
    pageCount: 1,
    coverage: [],
    totals: { employees: 0, employeeDays: 0, filledDays: 0, notFilledDays: 0, employeesWithNoFilledDay: 0, filledPct: 0 },
    maxDailyHours,
  };
}
