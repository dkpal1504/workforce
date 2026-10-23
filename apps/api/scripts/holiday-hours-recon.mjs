#!/usr/bin/env node
/**
 * HOLIDAY-HOURS RECONCILIATION — Step 0 of the work-calendar rollout. READ-ONLY.
 *
 * This is a thin wrapper on purpose: the runtime api image installs `npm ci --omit=dev`, so `tsx` is not
 * available inside it. The logic lives in `dist/services/holidayReconRun.js` (compiled) so this file can
 * run in production exactly as it does locally, the same pattern as create-first-admin.mjs.
 *
 * WHAT IT WRITES: CSV files in --out. Nothing else — SELECT-only queries against the app database and
 * LabourWorks. No INSERT, no UPDATE, no migration, no flag. Safe to run against production, which is
 * where its numbers are actually useful.
 *
 * Run inside the api container:
 *   docker compose -f infra/docker/compose.production.yml exec api \
 *     node apps/api/scripts/holiday-hours-recon.mjs --from 2026-07-19 --to 2026-10-16 --out /app/data/recon
 *
 * Options:
 *   --from / --to   inclusive ISO dates (default: the 90 days ending yesterday)
 *   --out           output directory (default: ./recon-out)
 *   --print-sql     print the register SQL for the DBA and exit (runs no queries)
 *   --describe-source  print the view's real columns, a suggested mapping and a few sample rows, then exit
 *
 * Environment:
 *   ATTENDANCE_REGISTER_FIXTURE  offline fixture (JSON/CSV) instead of SQL Server; refused in production
 *   ATTENDANCE_HOURS_AGGREGATE   SUM (default) or MAX — which shape the source's rows actually have
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  closeReconDb,
  reconCsvFiles,
  renderReconSummary,
  runHolidayRecon,
} from "../dist/services/holidayReconRun.js";
import { describeRegisterSource, registerColumns, registerSql } from "../dist/services/attendanceRegisterSource.js";

function parseArgs(argv) {
  const read = (name) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const utcDate = (offsetDays) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
  const to = read("to") ?? utcDate(-1);
  const from = read("from") ?? new Date(Date.parse(`${to}T00:00:00Z`) - 89 * 86_400_000).toISOString().slice(0, 10);
  return {
    from,
    to,
    out: read("out") ?? "recon-out",
    printSql: argv.includes("--print-sql"),
    describeSource: argv.includes("--describe-source"),
  };
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function writeCsv(file, rows) {
  const body = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  // BOM so Excel opens a UTF-8 CSV with the yard's names intact.
  await fs.writeFile(file, "\uFEFF" + body + "\r\n", "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.describeSource) {
    // Prints what the view ACTUALLY holds (columns, a few real rows, the generated SQL) and a suggested
    // column mapping. Read-only. This is the answer to "Invalid column name" without opening a SQL prompt.
    const described = await describeRegisterSource();
    const lines = [];
    lines.push(`-- Source: ${described.view}`);
    lines.push(`-- Columns (${described.columns.length}):`);
    for (const column of described.columns) {
      lines.push(`--   ${column.name}  ${column.type}  nullable=${column.nullable}`);
    }
    lines.push(`-- Suggested mapping (confirm before using): ${JSON.stringify(described.mapping)}`);
    if (described.missingColumns.length) {
      lines.push("");
      lines.push(`-- MISSING required column(s) on THIS view: ${described.missingColumns.join(", ")}`);
      if (described.candidates.length) {
        lines.push("-- Objects in this database that DO have them (most matching first):");
        for (const candidate of described.candidates) {
          lines.push(
            `--   ${candidate.schema}.${candidate.table}  [${candidate.objectType || "unknown type"}]  matched: ${candidate.matched.join(", ")}`
          );
        }
        lines.push("-- Re-run with -e \"ATTENDANCE_DB_VIEW=<schema.table from above>\" (no rebuild needed).");
      } else {
        lines.push("-- No readable object in this database carries them — ask IT which database/schema holds the register.");
      }
    }
    lines.push("");
    lines.push("-- Generated register SQL:");
    lines.push(described.sql);
    lines.push("");
    lines.push("-- Sample rows (latest by the configured date column):");
    for (const row of described.sample) lines.push(JSON.stringify(row));
    lines.push("");
    process.stdout.write(lines.join("\n"));
    return;
  }

  if (args.printSql) {
    process.stdout.write(
      [
        `-- Register SQL for ${args.from} .. ${args.to}`,
        `-- View: ${process.env.ATTENDANCE_DB_VIEW || "dbo.Report_Attendance_Intermediate"}`,
        `-- Columns: ${JSON.stringify(registerColumns())}`,
        registerSql(),
        "",
      ].join("\n")
    );
    return;
  }

  const result = await runHolidayRecon({ from: args.from, to: args.to });
  const outDir = path.resolve(args.out);
  await fs.mkdir(outDir, { recursive: true });

  for (const file of reconCsvFiles(result)) {
    await writeCsv(path.join(outDir, file.name), file.rows);
  }

  const lines = renderReconSummary(result);
  lines.push(`CSV files written to ${outDir}`);
  lines.push(
    "  " +
      reconCsvFiles(result)
        .map((file) => file.name)
        .join("  ")
  );
  lines.push("");
  process.stdout.write(lines.join("\n"));
}

main()
  .catch((error) => {
    console.error(`[recon] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeReconDb();
  });
