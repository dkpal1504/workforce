#!/usr/bin/env node
/**
 * Import a holiday-hours reconciliation's `01-dates.csv` into `work_calendar_date`.
 *
 * WHY: the settled calendar is normally written by the nightly settlement, which reads LabourWorks. A
 * development machine cannot reach LabourWorks — so on dev the calendar would stay empty forever and the
 * report's new denominator could never be seen. The reconciliation CSV is the SAME evidence, measured on
 * the production view and already reviewed by the customer, so importing it gives dev a calendar that is
 * evidence-backed rather than invented.
 *
 * What this does NOT do: write `attendance_day`. Hours are not settled by this script, so the only thing a
 * report can use afterwards is the DENOMINATOR (which days were working days). That is exactly what the
 * coverage report needs to show the difference, and it is honest about what is missing.
 *
 *   npm run calendar:import -- --file C:\Project\workforce\recon\01-dates.csv --dry-run
 *   npm run calendar:import -- --file …/01-dates.csv
 *
 * Idempotent: upserted on work_date. An OVERRIDE row (a human decision) is never overwritten.
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`--${name} needs a value`);
  return value;
}

const isFlag = (name) => process.argv.includes(`--${name}`);

/** Minimal CSV reader: the recon writes plain comma-separated values with no quoting. */
function parseCsv(text) {
  const lines = text.replace(/\r/g, "").split("\n").filter((line) => line.trim().length);
  const header = lines.shift().split(",").map((cell) => cell.trim());
  return lines.map((line) => {
    const cells = line.split(",");
    const row = {};
    header.forEach((key, index) => {
      row[key] = (cells[index] ?? "").trim();
    });
    return row;
  });
}

const number = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
};

async function main() {
  const file = arg("file", null);
  if (!file) throw new Error("--file is required (the recon's 01-dates.csv)");
  const rows = parseCsv(readFileSync(file, "utf8"));
  const wanted = new Set(["WORKING", "WEEKLY_OFF", "HOLIDAY"]);

  const accepted = [];
  const skipped = [];
  for (const row of rows) {
    const dayType = (row.day_type || "").toUpperCase();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date || "")) {
      skipped.push(`${row.date || "(no date)"}: not a date`);
      continue;
    }
    if (!wanted.has(dayType)) {
      skipped.push(`${row.date}: day_type "${row.day_type}" is not one of WORKING/WEEKLY_OFF/HOLIDAY`);
      continue;
    }
    accepted.push({ ...row, dayType });
  }

  const byType = accepted.reduce((acc, row) => {
    acc[row.dayType] = (acc[row.dayType] ?? 0) + 1;
    return acc;
  }, {});

  console.log(`file        : ${file}`);
  console.log(`rows read   : ${rows.length}`);
  console.log(`acceptable  : ${accepted.length}  (${Object.entries(byType).map(([k, v]) => `${k}=${v}`).join("  ")})`);
  for (const reason of skipped.slice(0, 5)) console.log(`  skipped   : ${reason}`);

  if (!accepted.length) throw new Error("nothing to import — check the file is the recon's 01-dates.csv");
  if (isFlag("dry-run")) {
    console.log("dry run     : nothing written");
    return;
  }

  let written = 0;
  let keptOverrides = 0;
  for (const row of accepted) {
    const workDate = new Date(`${row.date}T00:00:00.000Z`);
    const existing = await prisma.workCalendarDate.findUnique({ where: { workDate }, select: { source: true } });
    if (existing?.source === "OVERRIDE") {
      // A human decision outranks evidence, including evidence from production.
      keptOverrides += 1;
      continue;
    }
    await prisma.workCalendarDate.upsert({
      where: { workDate },
      create: {
        workDate,
        dayType: row.dayType,
        source: "REGISTER",
        employeeRows: number(row.employees_with_row),
        presentRows: number(row.present),
        absentRows: number(row.absent),
        weeklyOffRows: 0,
        holidayFlagRows: number(row.holiday_flag_rows),
        holidayStatusRows: number(row.holiday_status_rows),
        settledAt: new Date(),
        note: "imported from the holiday-hours reconciliation 01-dates.csv",
      },
      update: {
        dayType: row.dayType,
        source: "REGISTER",
        employeeRows: number(row.employees_with_row),
        presentRows: number(row.present),
        absentRows: number(row.absent),
        holidayFlagRows: number(row.holiday_flag_rows),
        holidayStatusRows: number(row.holiday_status_rows),
        note: "imported from the holiday-hours reconciliation 01-dates.csv",
      },
    });
    written += 1;
  }

  const total = await prisma.workCalendarDate.count();
  console.log(`written     : ${written} date(s)   overrides kept untouched: ${keptOverrides}`);
  console.log(`calendar now: ${total} date(s) in work_calendar_date`);
  console.log("");
  console.log("Next: set SETTLE_REPORTS=true, restart the API, and open Reports > Timesheet coverage.");
}

main()
  .catch((error) => {
    console.error(`[calendar:import] FAILED: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
