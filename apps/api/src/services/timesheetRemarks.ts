import { prisma } from "../db";

/**
 * The supervisor's remark, carried into a data dump.
 *
 * A remark lives on `timesheet_days` — one free text per employee per day, written while the sheet was filled,
 * and stored whether or not the day carried overtime. It is the only place the reason for a number is written
 * in words: "crane breakdown", "waiting for plate", "man sent to B1008 for the day". A dump that carries the
 * hours and not the sentence is a dump somebody has to go back to the screen for.
 *
 * Two shapes, because the two dumps count different things:
 *   - Portfolio — one row per JOB ORDER, so its remarks are every remark written on a day booked to it,
 *     de-duplicated, newest first, dated, and capped. A Job Order with 400 remarks is not a spreadsheet cell.
 *   - Timesheet coverage — one row per EMPLOYEE-DAY, so its remark is that day's remark, one to one. No
 *     formatting, no cap: the cell is exactly what the supervisor wrote.
 */

/** How many distinct remarks one Job Order cell carries before it says "…and N more". */
export const REMARKS_PER_JOB_ORDER = 6;

/** Characters one Job Order cell may hold. Longer than this and the sheet stops being a sheet. */
export const REMARK_CELL_MAX_CHARS = 600;

export type DatedRemark = { date: string; text: string };

/**
 * One cell for a Job Order's remarks: `dd-mm — sentence | dd-mm — sentence`.
 *
 * The date is part of the text on purpose. "waiting for material" means something different on the day the
 * Job Order was three weeks behind than it did in week one, and a reader comparing two dumps needs to know
 * which is which.
 */
export function formatRemarks(remarks: readonly DatedRemark[]): string {
  const seen = new Set<string>();
  const distinct: DatedRemark[] = [];
  for (const remark of remarks) {
    const text = remark.text.trim().replace(/\s+/g, " ");
    if (!text) continue;
    // De-duplicated on the sentence, not the date: the same complaint written on nine consecutive days is
    // one fact about the Job Order, and nine copies of it hide the nine other things that were said.
    if (seen.has(text)) continue;
    seen.add(text);
    distinct.push({ date: remark.date, text });
  }

  if (!distinct.length) return "";

  const shown = distinct.slice(0, REMARKS_PER_JOB_ORDER);
  const hidden = distinct.length - shown.length;
  let text = shown.map((remark) => `${shortDate(remark.date)} — ${remark.text}`).join(" | ");
  if (hidden > 0) text += ` | …and ${hidden} more`;
  if (text.length > REMARK_CELL_MAX_CHARS) text = `${text.slice(0, REMARK_CELL_MAX_CHARS - 1)}…`;
  return text;
}

/** `2026-10-12` → `12-10`. The year is in the report's own period line, and a cell is short. */
function shortDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return match ? `${match[3]}-${match[2]}` : date;
}

/**
 * The remarks on the days booked to each Job Order, keyed by Job Order id.
 *
 * ONE query for the whole dump, filtered to days that actually carry a remark (`timesheetDay.remarks` is not
 * null), so a portfolio of 400 Job Orders with 200,000 entries does not drag 200,000 rows into memory to find
 * the few hundred sentences. The relational filter is the whole point of the shape.
 *
 * The date used for ordering is the ENTRY's work date, so "newest first" is the newest day somebody worked on
 * that Job Order — not the day the sheet was typed.
 */
export async function remarksByJobOrder(
  jobOrderIds: readonly number[],
  db: typeof prisma = prisma
): Promise<Map<number, string>> {
  if (!jobOrderIds.length) return new Map();

  const rows = await db.timesheetEntry.findMany({
    where: {
      jobOrderId: { in: [...jobOrderIds] },
      timesheetDay: { remarks: { not: null } },
    },
    select: {
      jobOrderId: true,
      workDate: true,
      timesheetDay: { select: { remarks: true } },
    },
    orderBy: { workDate: "desc" },
  });

  const byJobOrder = new Map<number, DatedRemark[]>();
  for (const row of rows) {
    // An entry with no Job Order is overhead work: it has no Job Order row to print in, so it has no cell.
    if (row.jobOrderId == null) continue;
    const text = row.timesheetDay?.remarks ?? "";
    if (!text.trim()) continue;
    const list = byJobOrder.get(row.jobOrderId);
    const dated = { date: row.workDate.toISOString().slice(0, 10), text };
    if (list) list.push(dated);
    else byJobOrder.set(row.jobOrderId, [dated]);
  }

  const formatted = new Map<number, string>();
  for (const [jobOrderId, remarks] of byJobOrder) {
    const cell = formatRemarks(remarks);
    if (cell) formatted.set(jobOrderId, cell);
  }
  return formatted;
}
