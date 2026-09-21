/**
 * The longest Job Order text a picker may show, Job Order number included.
 *
 * The API sends the full `Job_Order-Job_Description` label (for example
 * `1900000107-Pipe Spool Installation`), and a native `<select>` sizes BOTH its box
 * and its popup to the LONGEST option. Real descriptions reach 77 characters
 * (`M4116-Welding of anchor loose stud welding in conjunction with anchor ranging`),
 * which made the Timesheet Entry Job Order column 563px wide, pushed the ASSIGN
 * column off the row and let the open list run past the window.
 *
 * Every Job Order dropdown therefore displays at most 34 characters. The option
 * VALUE is still the Job Order id, so the cap is display-only; the full description
 * stays in the Job Order master data and in the Timesheet bulk bar's read-only
 * Job Order Name field.
 */
export const JOB_ORDER_OPTION_MAX_CHARS = 34;

/** Cut display text to `JOB_ORDER_OPTION_MAX_CHARS`; a trailing space is dropped. */
export function limitJobOrderOptionText(text: string): string {
  if (text.length <= JOB_ORDER_OPTION_MAX_CHARS) return text;
  return text.slice(0, JOB_ORDER_OPTION_MAX_CHARS).replace(/\s+$/, "");
}
