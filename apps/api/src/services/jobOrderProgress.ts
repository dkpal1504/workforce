/**
 * Job Order quantity progress — the rules, with no database access.
 *
 * Quantity and hours are INDEPENDENT measures: nothing here converts between them
 * and nothing blends them. `cumulativeQuantity` is the total quantity achieved to
 * date as punched, never a daily increment.
 *
 * The lifecycle is:
 *
 *   SUBMITTED  an HOD punched a cumulative figure for a Job Order on a date
 *   APPROVED   the PM accepted it; it becomes part of the achieved quantity
 *   REJECTED   the PM rejected it (a remark is mandatory)
 *   SENT_BACK  the PM returned it to the HOD for correction (a remark is mandatory)
 *
 * An HOD may revise a figure ONLY after REJECTED or SENT_BACK. An amendment never
 * mutates the old row: it inserts revision_no + 1, so every rejection stays in the
 * history. The unique key is (job_order_id, progress_date, revision_no).
 *
 * Every rule in this file is pure so it can be unit-tested without a database.
 */

export const PROGRESS_STATUSES = ["SUBMITTED", "APPROVED", "REJECTED", "SENT_BACK"] as const;
export type ProgressStatus = (typeof PROGRESS_STATUSES)[number];

/** Only these statuses let the HOD revise the figure. */
export const AMENDABLE_STATUSES: readonly ProgressStatus[] = ["REJECTED", "SENT_BACK"];

/**
 * Punching is the Section HOD's duty and the Department Head's.
 *
 * A **Department Head** owns every section under his department, so he punches with
 * an explicitly selected section — exactly like a department-level HOD (a user whose
 * section is null). An **Admin** is accepted as a fallback, as everywhere else.
 */
export const PUNCH_ROLES: readonly string[] = ["HOD", "DEPT_HEAD", "ADMIN"];

/**
 * Approval is a PM duty and ONLY a PM duty. An Admin account may look at the queue
 * (`GET /pending` allows it) but must not decide: the chain is HOD punches, PM approves.
 */
export const DECISION_ROLES: readonly string[] = ["PM"];

export type DecisionAction = "APPROVE" | "REJECT" | "SEND_BACK";

export type RuleError = { code: string; error: string; status: number };
export type RuleResult<T> = { ok: true; value: T } | { ok: false; error: RuleError };

export function ruleError(code: string, error: string, status = 400): RuleError {
  return { code, error, status };
}

function fail<T>(code: string, error: string, status = 400): RuleResult<T> {
  return { ok: false, error: ruleError(code, error, status) };
}

export function isProgressStatus(value: unknown): value is ProgressStatus {
  return typeof value === "string" && (PROGRESS_STATUSES as readonly string[]).includes(value);
}

/** An HOD may amend only after the PM rejects or sends it back. */
export function isAmendableStatus(status: string): status is "REJECTED" | "SENT_BACK" {
  return (AMENDABLE_STATUSES as readonly string[]).includes(status);
}

export function isPunchRole(role: string): boolean {
  return PUNCH_ROLES.includes(role);
}

export function isDecisionRole(role: string): boolean {
  return DECISION_ROLES.includes(role);
}

/** Shape of one progress row as the pure rules see it. `progressDate` is YYYY-MM-DD. */
export type ProgressRow = {
  progressDate: string;
  revisionNo: number;
  cumulativeQuantity: number;
  status: string;
};

export type BudgetRevisionRow = {
  revisionNo: number;
  effectiveFrom: string;
  budgetedQuantity: number;
};

function compareRows(a: ProgressRow, b: ProgressRow): number {
  if (a.progressDate !== b.progressDate) return a.progressDate < b.progressDate ? -1 : 1;
  return a.revisionNo - b.revisionNo;
}

/**
 * Achieved quantity = the cumulative quantity of the latest APPROVED entry.
 *
 * The latest entry is the one with the greatest progress date, and on the same
 * date the greatest revision number. Rejected and sent-back rows never count.
 */
export function achievedQuantity(rows: readonly ProgressRow[]): number {
  const approved = rows.filter((row) => row.status === "APPROVED").slice().sort(compareRows);
  return approved.length ? approved[approved.length - 1].cumulativeQuantity : 0;
}

/**
 * The cumulative quantity already approved BEFORE the given entry is decided.
 *
 * This is the figure shown next to a proposed new cumulative so the PM can see the
 * step the HOD is asking for. Rows on the same date with a lower revision number
 * count too; the entry itself and later rows never do.
 */
export function achievedBefore(
  rows: readonly ProgressRow[],
  target: { progressDate: string; revisionNo: number }
): number {
  const earlier = rows.filter(
    (row) =>
      row.status === "APPROVED" &&
      (row.progressDate < target.progressDate ||
        (row.progressDate === target.progressDate && row.revisionNo < target.revisionNo))
  );
  return achievedQuantity(earlier);
}

/**
 * A cumulative figure must never decrease and must never fall below the last
 * approved cumulative figure for the same Job Order.
 */
export function validateCumulativeQuantity(
  cumulativeQuantity: unknown,
  lastApprovedCumulative: number,
  uomCode?: string | null
): RuleResult<number> {
  if (typeof cumulativeQuantity !== "number" || !Number.isFinite(cumulativeQuantity)) {
    return fail("CUMULATIVE_INVALID", "Cumulative quantity must be a number.");
  }
  if (cumulativeQuantity < 0) {
    return fail("CUMULATIVE_NEGATIVE", "Cumulative quantity cannot be negative.");
  }
  const floor = Number.isFinite(lastApprovedCumulative) ? lastApprovedCumulative : 0;
  if (cumulativeQuantity < floor) {
    const unit = uomCode ? ` ${uomCode}` : "";
    return fail(
      "CUMULATIVE_DECREASED",
      `Cumulative quantity cannot decrease: the last approved figure is ${floor}${unit}. ` +
        `Punch the total achieved to date, not a daily increment.`,
      409
    );
  }
  return { ok: true, value: cumulativeQuantity };
}

export type ProgressActor = {
  id: number;
  role: string;
  departmentId: number | null;
  sectionId: number | null;
};

/**
 * Which section a punch will be recorded against.
 *
 *   Section HOD (department + section)       -> always his own section; naming
 *                                               another section is refused.
 *   Department-level HOD (section is null)   -> owns every section of the
 *   Department Head (section is null)          department, so he MUST select one.
 *
 * The selected section is only a scope hint here: the caller still checks that it
 * belongs to the actor's department before anything is written.
 */
export function resolvePunchScope(
  actor: ProgressActor,
  requestedSectionId: number | null
): RuleResult<number> {
  if (!isPunchRole(actor.role)) {
    return fail(
      "ROLE_NOT_ALLOWED",
      "Only an HOD may punch Job Order quantity progress.",
      403
    );
  }
  if (actor.departmentId == null) {
    return fail(
      "DEPARTMENT_REQUIRED",
      "Your account has no department, so quantity progress cannot be scoped to one.",
      403
    );
  }
  const requested = Number.isInteger(requestedSectionId) ? (requestedSectionId as number) : null;

  if (actor.sectionId != null) {
    if (requested != null && requested !== actor.sectionId) {
      return fail(
        "SECTION_OUT_OF_SCOPE",
        "You may punch quantity progress only for your own section.",
        403
      );
    }
    return { ok: true, value: actor.sectionId };
  }
  if (requested == null) {
    return fail(
      "SECTION_REQUIRED",
      "Select a section before punching: a Department Head (or a department-level HOD) owns every section of the department.",
      400
    );
  }
  return { ok: true, value: requested };
}

export type PunchableJobOrder = {
  code: string;
  status: string;
  departmentId: number;
  sectionId: number | null;
  project: { active: boolean };
  department: { active: boolean };
};

/**
 * May this HOD punch this Job Order?
 *
 * A project Job Order belongs to exactly one section, so the punch must be recorded
 * for that section. A standing / Non-Project Job Order has no section and may be
 * punched by any section of its department.
 */
export function canPunchJobOrder(
  actorDepartmentId: number | null,
  resolvedSectionId: number,
  jobOrder: PunchableJobOrder
): RuleResult<true> {
  if (actorDepartmentId == null || jobOrder.departmentId !== actorDepartmentId) {
    return fail(
      "JOB_ORDER_OUT_OF_SCOPE",
      `Job Order ${jobOrder.code} belongs to another department.`,
      403
    );
  }
  if (!jobOrder.department.active) {
    return fail("DEPARTMENT_INACTIVE", "The Job Order's department is inactive.", 409);
  }
  if (!jobOrder.project.active) {
    return fail("PROJECT_INACTIVE", "The Job Order's project is inactive.", 409);
  }
  if (jobOrder.status !== "active") {
    return fail("JOB_ORDER_INACTIVE", `Job Order ${jobOrder.code} is inactive.`, 409);
  }
  if (jobOrder.sectionId != null && jobOrder.sectionId !== resolvedSectionId) {
    return fail(
      "SECTION_OUT_OF_SCOPE",
      `Job Order ${jobOrder.code} is owned by another section.`,
      403
    );
  }
  return { ok: true, value: true };
}

export type DayEntryRef = { id: number; revisionNo: number; status: string; cumulativeQuantity: number };

/**
 * A new punch for a Job Order and date.
 *
 * One entry per Job Order per date per revision: a day that already carries a row
 * cannot be punched again, whatever its status. A rejected or sent-back day must be
 * AMENDED instead, so the refused figure stays in the history.
 */
export function planPunch(params: {
  latestForDay: DayEntryRef | null;
  lastApprovedCumulative: number;
  cumulativeQuantity: unknown;
  uomCode?: string | null;
}): RuleResult<{ revisionNo: number }> {
  const quantity = validateCumulativeQuantity(
    params.cumulativeQuantity,
    params.lastApprovedCumulative,
    params.uomCode
  );
  if (!quantity.ok) return quantity;

  if (params.latestForDay) {
    const status = params.latestForDay.status;
    const guidance = isAmendableStatus(status)
      ? "Amend that entry (revision " + (params.latestForDay.revisionNo + 1) + ") instead of punching a new one."
      : "An entry for this date is already " + status + ".";
    return fail(
      "DUPLICATE_DAY_ENTRY",
      `This Job Order already has a quantity entry for that date. ${guidance}`,
      409
    );
  }
  return { ok: true, value: { revisionNo: 1 } };
}

/**
 * An amendment to an existing entry.
 *
 * The row being amended must be the latest revision of its day, and it must be
 * REJECTED or SENT_BACK. The amendment inserts revision_no + 1 and leaves the old
 * row untouched as history.
 */
export function planAmendment(params: {
  entry: DayEntryRef;
  latestForDay: DayEntryRef | null;
  lastApprovedCumulative: number;
  cumulativeQuantity: unknown;
  uomCode?: string | null;
}): RuleResult<{ revisionNo: number }> {
  if (!isAmendableStatus(params.entry.status)) {
    return fail(
      "AMENDMENT_NOT_ALLOWED",
      `This entry is ${params.entry.status}. An HOD may amend an entry only after the PM rejects it or sends it back.`,
      409
    );
  }
  if (!params.latestForDay || params.latestForDay.revisionNo !== params.entry.revisionNo) {
    return fail(
      "STALE_REVISION",
      "A newer revision of this entry exists. Amend the latest revision.",
      409
    );
  }
  const quantity = validateCumulativeQuantity(
    params.cumulativeQuantity,
    params.lastApprovedCumulative,
    params.uomCode
  );
  if (!quantity.ok) return quantity;

  return { ok: true, value: { revisionNo: params.entry.revisionNo + 1 } };
}

/**
 * A PM decision on a SUBMITTED entry.
 *
 * Reject and send-back require a remark, because the HOD has to know what to
 * correct on the amendment. Only an approval stamps approved_by / approved_at.
 */
export function planDecision(params: {
  action: DecisionAction;
  currentStatus: string;
  remarks?: string | null;
}): RuleResult<{ status: ProgressStatus; stampApproval: boolean }> {
  if (params.action !== "APPROVE" && params.action !== "REJECT" && params.action !== "SEND_BACK") {
    return fail("INVALID_ACTION", "action must be APPROVE, REJECT or SEND_BACK.");
  }
  if (params.currentStatus !== "SUBMITTED") {
    return fail(
      "DECISION_NOT_ALLOWED",
      `Only a SUBMITTED entry may be decided; this entry is ${params.currentStatus}.`,
      409
    );
  }
  const remarks = typeof params.remarks === "string" ? params.remarks.trim() : "";
  if (params.action !== "APPROVE" && !remarks) {
    return fail(
      "REMARKS_REQUIRED",
      params.action === "REJECT"
        ? "A remark is required to reject a quantity entry."
        : "A remark is required to send a quantity entry back."
    );
  }
  if (params.action === "APPROVE") return { ok: true, value: { status: "APPROVED", stampApproval: true } };
  if (params.action === "REJECT") return { ok: true, value: { status: "REJECTED", stampApproval: false } };
  return { ok: true, value: { status: "SENT_BACK", stampApproval: false } };
}

/** The budget revision in force on a date: the latest effective_from <= date. */
export function budgetInForce(
  revisions: readonly BudgetRevisionRow[],
  onDate: string,
  fallbackQuantity = 0
): number {
  let best: BudgetRevisionRow | null = null;
  for (const revision of revisions) {
    if (revision.effectiveFrom > onDate) continue;
    if (
      best == null ||
      revision.effectiveFrom > best.effectiveFrom ||
      (revision.effectiveFrom === best.effectiveFrom && revision.revisionNo > best.revisionNo)
    ) {
      best = revision;
    }
  }
  return best ? best.budgetedQuantity : fallbackQuantity;
}

/**
 * Quantity balance against the budget in force. Percentages clamp at 0 when the
 * budget is 0, so an unbudgeted Job Order never divides by zero.
 */
export function quantityBalance(
  budgetedQuantity: number,
  achievedCumulative: number
): { balance: number; percentComplete: number } {
  const budget = Number.isFinite(budgetedQuantity) ? budgetedQuantity : 0;
  const achieved = Number.isFinite(achievedCumulative) ? achievedCumulative : 0;
  return {
    balance: budget - achieved,
    percentComplete: budget > 0 ? Math.max(0, (achieved / budget) * 100) : 0,
  };
}

/** `Job_Order-Job_Description`, the display form used on every picker. */
export function jobOrderDisplay(code: string, name: string): string {
  return `${code}-${name}`;
}

/* ---------------------------------------------------------------------------
 * Remark history (job_order_progress_remarks)
 *
 * A remark is a fact about a stage of the entry, not a field of it: the row's own
 * `remarks` column only ever carries the LATEST message (what the screen shows),
 * while every remark anyone ever wrote is kept as its own append-only row. An
 * amendment therefore never erases what was said about the revision it replaced,
 * and a report can list who said what, at which stage, and when.
 * ------------------------------------------------------------------------- */

export const REMARK_KINDS = ["PUNCH", "AMEND", "APPROVE", "REJECT", "SEND_BACK"] as const;
export type RemarkKind = (typeof REMARK_KINDS)[number];

/** A remark is mandatory at these stages; elsewhere an absent remark writes no row. */
export const REMARK_REQUIRED_KINDS: readonly RemarkKind[] = ["REJECT", "SEND_BACK"];

export function isRemarkKind(value: unknown): value is RemarkKind {
  return typeof value === "string" && (REMARK_KINDS as readonly string[]).includes(value);
}

export function isRemarkRequired(kind: RemarkKind): boolean {
  return REMARK_REQUIRED_KINDS.includes(kind);
}

function trimmedOrEmpty(remark: string | null | undefined): string {
  return typeof remark === "string" ? remark.trim() : "";
}

/** The append-only row a write will insert, or null when there is nothing to record. */
/** The stage a write belongs to. The stage name IS the remark kind. */
export type RemarkStage = "PUNCH" | "AMEND" | "APPROVE" | "REJECT" | "SEND_BACK";

export function remarkKindForStage(stage: RemarkStage): RemarkKind {
  switch (stage) {
    case "PUNCH":
      return "PUNCH";
    case "AMEND":
      return "AMEND";
    case "APPROVE":
      return "APPROVE";
    case "REJECT":
      return "REJECT";
    case "SEND_BACK":
      return "SEND_BACK";
  }
}

/** A PM decision's stage is its action: APPROVE, REJECT or SEND_BACK. */
export function remarkKindForAction(action: DecisionAction): RemarkKind {
  return remarkKindForStage(action);
}

export type RemarkRowInput = {
  progressId: number;
  kind: RemarkKind;
  remark: string;
  authorId: number | null;
  authorRole: string;
};

/**
 * Build the remark row for one stage of one progress entry.
 *
 *   - a mandatory stage (REJECT / SEND_BACK) without a remark is refused;
 *   - every other stage without a remark writes NO row (null), so the history holds
 *     only what someone actually said;
 *   - authorId and authorRole are the acting user's, never the entry owner's.
 */
export function planRemarkWrite(params: {
  progressId: number;
  kind: RemarkKind | string;
  remark?: string | null;
  authorId: number | null;
  authorRole: string;
}): RuleResult<RemarkRowInput | null> {
  if (!isRemarkKind(params.kind)) {
    return fail("INVALID_REMARK_KIND", `kind must be one of ${REMARK_KINDS.join(", ")}.`);
  }
  if (!Number.isInteger(params.progressId) || params.progressId <= 0) {
    return fail("REMARK_PROGRESS_REQUIRED", "A remark must belong to a quantity progress entry.");
  }
  if (typeof params.authorRole !== "string" || !params.authorRole.trim()) {
    return fail("AUTHOR_ROLE_REQUIRED", "A remark must record the role of its author.");
  }

  const remark = trimmedOrEmpty(params.remark);
  if (!remark) {
    if (isRemarkRequired(params.kind)) {
      return fail(
        "REMARKS_REQUIRED",
        params.kind === "REJECT"
          ? "A remark is required to reject a quantity entry."
          : "A remark is required to send a quantity entry back."
      );
    }
    return { ok: true, value: null };
  }

  return {
    ok: true,
    value: {
      progressId: params.progressId,
      kind: params.kind,
      remark,
      authorId: params.authorId,
      authorRole: params.authorRole.trim(),
    },
  };
}

/**
 * What the entry's own `remarks` column keeps: the LATEST message, exactly as the
 * screen has always shown it. An approval without a remark leaves the punched note
 * in place; a rejection or a send-back carries the PM's reason forward.
 */
export function latestRemarkForWrite(
  kind: RemarkKind,
  remark: string | null | undefined,
  currentRemarks: string | null
): string | null {
  const trimmed = trimmedOrEmpty(remark);
  if (kind === "APPROVE") return trimmed || currentRemarks;
  if (kind === "REJECT" || kind === "SEND_BACK") return trimmed || null;
  return trimmed || null;
}

export type RemarkHistoryRow = {
  id: number;
  kind: string;
  remark: string;
  authorRole: string;
  createdAt: Date | string;
  author?: { name: string } | null;
};

export type RemarkHistoryItem = {
  id: number;
  kind: string;
  remark: string;
  authorName: string | null;
  authorRole: string;
  createdAt: string;
};

/** Oldest first, so the client renders the conversation in the order it happened. */
export function mapRemarkHistory(rows: readonly RemarkHistoryRow[]): RemarkHistoryItem[] {
  return rows
    .slice()
    .sort((a, b) => {
      const left = new Date(a.createdAt).getTime();
      const right = new Date(b.createdAt).getTime();
      if (left !== right) return left - right;
      return a.id - b.id;
    })
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      remark: row.remark,
      authorName: row.author?.name ?? null,
      authorRole: row.authorRole,
      createdAt: new Date(row.createdAt).toISOString(),
    }));
}

/**
 * The data scope of the remarks report.
 *
 *   PM / ADMIN              -> everything (no department and no section filter).
 *   HOD / Department Head   -> his own department; a section-scoped HOD is narrowed
 *                              to his own section, a department-level actor to all
 *                              sections of the department.
 *   any other role          -> refused.
 */
export function remarkReportScope(
  actor: ProgressActor
): RuleResult<{ departmentId: number | null; sectionId: number | null }> {
  if (actor.role === "PM" || actor.role === "ADMIN") {
    return { ok: true, value: { departmentId: null, sectionId: null } };
  }
  if (actor.role === "HOD" || actor.role === "DEPT_HEAD") {
    if (actor.departmentId == null) {
      return fail(
        "DEPARTMENT_REQUIRED",
        "Your account has no department, so the remarks report cannot be scoped.",
        403
      );
    }
    return { ok: true, value: { departmentId: actor.departmentId, sectionId: actor.sectionId } };
  }
  return fail("ROLE_NOT_ALLOWED", "The remarks report is available to HOD, Department Head, PM and Admin.", 403);
}
