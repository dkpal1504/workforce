/**
 * The hover text for a booked slot, in ONE place.
 *
 * A slot cell shows a colour token and a Job Order number; the colour alone does not name the
 * Project and the number alone does not name the work. The operator's question on hover is
 * "which project, which work order" — so the answer is exactly those two lines, in this order,
 * on BOTH screens that print a slot (the timesheet grid and the approval queue).
 *
 * Deliberately NO slot time in the text: the cell already sits under its own 9a–11a / 2p–4p
 * column head, so repeating the time in the tooltip only made the useful lines harder to read.
 * Project name first, then the Job Order number with its description.
 */

export type SlotTooltipInput = {
  /** Project colour token, e.g. "B" — only a fallback label when the Project has no name. */
  projectKey?: string | null;
  /** The Project's name, e.g. "MV AINA". */
  projectName?: string | null;
  /** The Job Order number, e.g. "1900000204". */
  jobOrderCode?: string | null;
  /** The Job Order description, e.g. "Block Transfer (Block 223)". */
  jobOrderName?: string | null;
};

export function slotTooltip({ projectKey, projectName, jobOrderCode, jobOrderName }: SlotTooltipInput): string {
  const token = String(projectKey ?? "").trim().toUpperCase();
  const projectLine = projectName?.trim() || (token ? `PROJECT ${token}` : "Project");
  const workOrder = jobOrderCode
    ? `${jobOrderCode}${jobOrderName ? ` — ${jobOrderName}` : ""}`
    : "No Job Order";
  return `${projectLine}\n${workOrder}`;
}
