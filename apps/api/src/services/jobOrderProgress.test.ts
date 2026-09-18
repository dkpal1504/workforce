import test from "node:test";
import assert from "node:assert/strict";
import {
  REMARK_KINDS,
  achievedBefore,
  achievedQuantity,
  budgetInForce,
  canPunchJobOrder,
  isAmendableStatus,
  isDecisionRole,
  isPunchRole,
  isRemarkKind,
  jobOrderDisplay,
  latestRemarkForWrite,
  mapRemarkHistory,
  planAmendment,
  planDecision,
  planPunch,
  planRemarkWrite,
  quantityBalance,
  remarkKindForAction,
  remarkKindForStage,
  remarkReportScope,
  resolvePunchScope,
  validateCumulativeQuantity,
  type ProgressActor,
  type ProgressRow,
  type RemarkHistoryRow,
} from "./jobOrderProgress";

const sectionHod: ProgressActor = { id: 11, role: "HOD", departmentId: 3, sectionId: 42 };
const departmentHod: ProgressActor = { id: 12, role: "HOD", departmentId: 3, sectionId: null };
const admin: ProgressActor = { id: 1, role: "ADMIN", departmentId: 3, sectionId: null };
const supervisor: ProgressActor = { id: 9, role: "SUPERVISOR", departmentId: 3, sectionId: 42 };

function row(progressDate: string, revisionNo: number, cumulativeQuantity: number, status: string): ProgressRow {
  return { progressDate, revisionNo, cumulativeQuantity, status };
}

test("a cumulative figure never decreases below the last approved figure", () => {
  // The first punch of a Job Order has nothing approved yet: anything >= 0 is legal.
  assert.deepEqual(validateCumulativeQuantity(0, 0), { ok: true, value: 0 });
  assert.deepEqual(planPunch({ latestForDay: null, lastApprovedCumulative: 0, cumulativeQuantity: 25.5 }), {
    ok: true,
    value: { revisionNo: 1 },
  });

  // Equal to the last approved figure is allowed (a no-progress day).
  assert.deepEqual(planPunch({ latestForDay: null, lastApprovedCumulative: 40, cumulativeQuantity: 40 }), {
    ok: true,
    value: { revisionNo: 1 },
  });

  // Below it is refused, with a message that names the floor and the uom.
  const decreased = planPunch({
    latestForDay: null,
    lastApprovedCumulative: 40,
    cumulativeQuantity: 39.9,
    uomCode: "MTR",
  });
  assert.equal(decreased.ok, false);
  assert.equal(decreased.ok === false && decreased.error.code, "CUMULATIVE_DECREASED");
  assert.equal(decreased.ok === false && decreased.error.status, 409);
  assert.match(decreased.ok === false ? decreased.error.error : "", /cannot decrease/);
  assert.match(decreased.ok === false ? decreased.error.error : "", /40 MTR/);

  // A daily increment is a classic mistake: punching "5 more" must not pass a floor of 40.
  const increment = validateCumulativeQuantity(5, 40);
  assert.equal(increment.ok, false);
  assert.equal(increment.ok === false && increment.error.code, "CUMULATIVE_DECREASED");

  // Bad numbers never reach the database.
  assert.equal(validateCumulativeQuantity(Number.NaN, 0).ok, false);
  assert.equal(validateCumulativeQuantity("40" as unknown as number, 0).ok, false);
  assert.equal(validateCumulativeQuantity(-1, 0).ok, false);
});

test("an entry may be amended only after the PM rejects or sends it back", () => {
  assert.equal(isAmendableStatus("REJECTED"), true);
  assert.equal(isAmendableStatus("SENT_BACK"), true);
  assert.equal(isAmendableStatus("SUBMITTED"), false);
  assert.equal(isAmendableStatus("APPROVED"), false);

  for (const status of ["SUBMITTED", "APPROVED"]) {
    const refused = planAmendment({
      entry: { id: 7, revisionNo: 1, status, cumulativeQuantity: 30 },
      latestForDay: { id: 7, revisionNo: 1, status, cumulativeQuantity: 30 },
      lastApprovedCumulative: 20,
      cumulativeQuantity: 35,
    });
    assert.equal(refused.ok, false, `${status} must not be amendable`);
    assert.equal(refused.ok === false && refused.error.code, "AMENDMENT_NOT_ALLOWED");
    assert.equal(refused.ok === false && refused.error.status, 409);
    assert.match(refused.ok === false ? refused.error.error : "", /rejects it or sends it back/);
  }

  for (const status of ["REJECTED", "SENT_BACK"]) {
    const allowed = planAmendment({
      entry: { id: 7, revisionNo: 1, status, cumulativeQuantity: 30 },
      latestForDay: { id: 7, revisionNo: 1, status, cumulativeQuantity: 30 },
      lastApprovedCumulative: 20,
      cumulativeQuantity: 35,
    });
    assert.deepEqual(allowed, { ok: true, value: { revisionNo: 2 } }, `${status} must be amendable`);
  }

  // An amendment still obeys the cumulative rule.
  const decreased = planAmendment({
    entry: { id: 7, revisionNo: 1, status: "REJECTED", cumulativeQuantity: 30 },
    latestForDay: { id: 7, revisionNo: 1, status: "REJECTED", cumulativeQuantity: 30 },
    lastApprovedCumulative: 34,
    cumulativeQuantity: 33,
  });
  assert.equal(decreased.ok === false && decreased.error.code, "CUMULATIVE_DECREASED");

  // Only the newest revision of the day may be amended.
  const stale = planAmendment({
    entry: { id: 7, revisionNo: 1, status: "REJECTED", cumulativeQuantity: 30 },
    latestForDay: { id: 9, revisionNo: 2, status: "SUBMITTED", cumulativeQuantity: 35 },
    lastApprovedCumulative: 20,
    cumulativeQuantity: 36,
  });
  assert.equal(stale.ok === false && stale.error.code, "STALE_REVISION");
});

test("one entry per Job Order per day per revision, and a rejected row stays as history", () => {
  // A day that already carries a row cannot be punched again.
  const duplicate = planPunch({
    latestForDay: { id: 7, revisionNo: 1, status: "SUBMITTED", cumulativeQuantity: 30 },
    lastApprovedCumulative: 20,
    cumulativeQuantity: 35,
  });
  assert.equal(duplicate.ok === false && duplicate.error.code, "DUPLICATE_DAY_ENTRY");
  assert.equal(duplicate.ok === false && duplicate.error.status, 409);

  // Even a rejected day is amended, not punched again, so the refused figure survives.
  const rejectedDay = planPunch({
    latestForDay: { id: 7, revisionNo: 1, status: "REJECTED", cumulativeQuantity: 900 },
    lastApprovedCumulative: 20,
    cumulativeQuantity: 35,
  });
  assert.equal(rejectedDay.ok === false && rejectedDay.error.code, "DUPLICATE_DAY_ENTRY");
  assert.match(rejectedDay.ok === false ? rejectedDay.error.error : "", /Amend that entry \(revision 2\)/);

  // History: the rejected revision 1 row is still present after the amendment, and
  // the day now holds exactly two rows with distinct revision numbers.
  const history: ProgressRow[] = [row("2026-09-10", 1, 900, "REJECTED")];
  const plan = planAmendment({
    entry: { id: 7, revisionNo: 1, status: "REJECTED", cumulativeQuantity: 900 },
    latestForDay: { id: 7, revisionNo: 1, status: "REJECTED", cumulativeQuantity: 900 },
    lastApprovedCumulative: 20,
    cumulativeQuantity: 35,
  });
  assert.equal(plan.ok, true);
  const amended = [...history, row("2026-09-10", plan.ok ? plan.value.revisionNo : 0, 35, "SUBMITTED")];
  assert.equal(amended.length, 2);
  assert.equal(amended[0].status, "REJECTED", "the old row is kept as history");
  assert.equal(amended[0].cumulativeQuantity, 900, "the old figure is never rewritten");
  assert.deepEqual(
    amended.map((r) => r.revisionNo),
    [1, 2],
    "the unique key (job_order_id, progress_date, revision_no) stays distinct"
  );
  assert.equal(achievedQuantity(history), 0, "a rejected figure never counts as achieved");
});

test("achieved quantity is the latest approved cumulative", () => {
  const rows: ProgressRow[] = [
    row("2026-09-08", 1, 10, "APPROVED"),
    row("2026-09-09", 1, 25, "APPROVED"),
    row("2026-09-10", 1, 60, "REJECTED"),
    row("2026-09-11", 1, 55, "SUBMITTED"),
    row("2026-09-09", 2, 30, "APPROVED"),
  ];
  assert.equal(achievedQuantity(rows), 30, "the same date prefers the higher revision");
  assert.equal(achievedQuantity([]), 0);
  assert.equal(achievedQuantity([row("2026-09-12", 1, 80, "SUBMITTED")]), 0);

  // The figure a PM sees as "last approved" for a specific proposed entry.
  assert.equal(achievedBefore(rows, { progressDate: "2026-09-11", revisionNo: 1 }), 30);
  // Same date, lower revision numbers count; the entry itself and later ones never do.
  assert.equal(achievedBefore(rows, { progressDate: "2026-09-09", revisionNo: 2 }), 25);
  assert.equal(achievedBefore(rows, { progressDate: "2026-09-08", revisionNo: 1 }), 0, "nothing approved yet");
});

test("section scope: a section HOD punches its own section, a department-level HOD must select one", () => {
  // Section HOD: section is pre-selected and another section is refused.
  assert.deepEqual(resolvePunchScope(sectionHod, null), { ok: true, value: 42 });
  assert.deepEqual(resolvePunchScope(sectionHod, 42), { ok: true, value: 42 });
  const otherSection = resolvePunchScope(sectionHod, 77);
  assert.equal(otherSection.ok === false && otherSection.error.code, "SECTION_OUT_OF_SCOPE");
  assert.equal(otherSection.ok === false && otherSection.error.status, 403);

  // Department-level HOD: owns every section under the department, so one is required.
  const mustSelect = resolvePunchScope(departmentHod, null);
  assert.equal(mustSelect.ok === false && mustSelect.error.code, "SECTION_REQUIRED");
  assert.equal(mustSelect.ok === false && mustSelect.error.status, 400);
  assert.deepEqual(resolvePunchScope(departmentHod, 77), { ok: true, value: 77 });
  assert.deepEqual(resolvePunchScope(admin, 77), { ok: true, value: 77 });
  assert.equal(resolvePunchScope(admin, null).ok === false, true);

  // Punching is an HOD duty.
  const wrongRole = resolvePunchScope(supervisor, 42);
  assert.equal(wrongRole.ok === false && wrongRole.error.code, "ROLE_NOT_ALLOWED");
  assert.equal(wrongRole.ok === false && wrongRole.error.status, 403);

  // An account with no department fails closed.
  const noDepartment = resolvePunchScope({ ...departmentHod, departmentId: null }, 42);
  assert.equal(noDepartment.ok === false && noDepartment.error.code, "DEPARTMENT_REQUIRED");
});

test("a Department Head punches by selecting a section, while approval stays with the PM", () => {
  const deptHead: ProgressActor = { id: 13, role: "DEPT_HEAD", departmentId: 3, sectionId: null };

  assert.equal(isPunchRole("DEPT_HEAD"), true, "the Department Head punches");
  assert.equal(isDecisionRole("DEPT_HEAD"), false, "a Department Head never approves the figure he punched");
  assert.equal(isPunchRole("SUPERVISOR"), false);

  // He owns every section, so he must say which one he is punching for.
  const mustSelect = resolvePunchScope(deptHead, null);
  assert.equal(mustSelect.ok === false && mustSelect.error.code, "SECTION_REQUIRED");
  assert.equal(mustSelect.ok === false && mustSelect.error.status, 400);
  assert.deepEqual(resolvePunchScope(deptHead, 9), { ok: true, value: 9 });
  assert.deepEqual(resolvePunchScope(deptHead, 77), { ok: true, value: 77 }, "every section of his department is his");
  const noDepartment = resolvePunchScope({ ...deptHead, departmentId: null }, 9);
  assert.equal(noDepartment.ok === false && noDepartment.error.code, "DEPARTMENT_REQUIRED");

  // A Department Head who still carries a section scope keeps that section only.
  const scopedDeptHead: ProgressActor = { id: 14, role: "DEPT_HEAD", departmentId: 3, sectionId: 42 };
  assert.deepEqual(resolvePunchScope(scopedDeptHead, null), { ok: true, value: 42 });
  const scopedOtherSection = resolvePunchScope(scopedDeptHead, 77);
  assert.equal(scopedOtherSection.ok === false && scopedOtherSection.error.code, "SECTION_OUT_OF_SCOPE");

  // The Job Order rules are unchanged for him: same department, its own section
  // unless it is a standing / Non-Project Job Order.
  const jobOrder = {
    code: "1900000107",
    status: "active",
    departmentId: 3,
    sectionId: 42 as number | null,
    project: { active: true },
    department: { active: true },
  };
  assert.deepEqual(canPunchJobOrder(3, 9, { ...jobOrder, sectionId: null }), { ok: true, value: true });
  assert.deepEqual(canPunchJobOrder(3, 42, jobOrder), { ok: true, value: true });
  const wrongSection = canPunchJobOrder(3, 9, jobOrder);
  assert.equal(wrongSection.ok === false && wrongSection.error.code, "SECTION_OUT_OF_SCOPE");
  const otherDepartment = canPunchJobOrder(3, 9, { ...jobOrder, departmentId: 4, sectionId: null });
  assert.equal(otherDepartment.ok === false && otherDepartment.error.code, "JOB_ORDER_OUT_OF_SCOPE");
});

test("a Job Order is punchable only inside its own department and section", () => {
  const projectJobOrder = {
    code: "1900000107",
    status: "active",
    departmentId: 3,
    sectionId: 42 as number | null,
    project: { active: true },
    department: { active: true },
  };
  assert.deepEqual(canPunchJobOrder(3, 42, projectJobOrder), { ok: true, value: true });

  const wrongSection = canPunchJobOrder(3, 77, projectJobOrder);
  assert.equal(wrongSection.ok === false && wrongSection.error.code, "SECTION_OUT_OF_SCOPE");
  assert.equal(wrongSection.ok === false && wrongSection.error.status, 403);

  const otherDepartment = canPunchJobOrder(4, 42, projectJobOrder);
  assert.equal(otherDepartment.ok === false && otherDepartment.error.code, "JOB_ORDER_OUT_OF_SCOPE");

  // A standing / Non-Project Job Order has no section: any section of the department may punch it.
  assert.deepEqual(canPunchJobOrder(3, 77, { ...projectJobOrder, sectionId: null }), { ok: true, value: true });

  // Inactive Job Orders, projects and departments are refused.
  const inactiveJobOrder = canPunchJobOrder(3, 42, { ...projectJobOrder, status: "inactive" });
  assert.equal(inactiveJobOrder.ok === false && inactiveJobOrder.error.code, "JOB_ORDER_INACTIVE");
  const inactiveProject = canPunchJobOrder(3, 42, { ...projectJobOrder, project: { active: false } });
  assert.equal(inactiveProject.ok === false && inactiveProject.error.code, "PROJECT_INACTIVE");
  const inactiveDepartment = canPunchJobOrder(3, 42, { ...projectJobOrder, department: { active: false } });
  assert.equal(inactiveDepartment.ok === false && inactiveDepartment.error.code, "DEPARTMENT_INACTIVE");
  assert.equal(canPunchJobOrder(null, 42, projectJobOrder).ok, false);
});

test("a PM decision needs a remark to reject or send back and stamps approvals", () => {
  assert.deepEqual(planDecision({ action: "APPROVE", currentStatus: "SUBMITTED" }), {
    ok: true,
    value: { status: "APPROVED", stampApproval: true },
  });

  for (const action of ["REJECT", "SEND_BACK"] as const) {
    const missing = planDecision({ action, currentStatus: "SUBMITTED" });
    assert.equal(missing.ok === false && missing.error.code, "REMARKS_REQUIRED");
    const blank = planDecision({ action, currentStatus: "SUBMITTED", remarks: "   " });
    assert.equal(blank.ok === false && blank.error.code, "REMARKS_REQUIRED");
  }
  assert.deepEqual(planDecision({ action: "REJECT", currentStatus: "SUBMITTED", remarks: "Figure too high" }), {
    ok: true,
    value: { status: "REJECTED", stampApproval: false },
  });
  assert.deepEqual(planDecision({ action: "SEND_BACK", currentStatus: "SUBMITTED", remarks: "Check the survey" }), {
    ok: true,
    value: { status: "SENT_BACK", stampApproval: false },
  });

  // Only a SUBMITTED entry may be decided, once.
  const twice = planDecision({ action: "APPROVE", currentStatus: "APPROVED" });
  assert.equal(twice.ok === false && twice.error.code, "DECISION_NOT_ALLOWED");
  assert.equal(twice.ok === false && twice.error.status, 409);
  assert.equal(planDecision({ action: "APPROVE", currentStatus: "REJECTED" }).ok, false);
  assert.equal(
    planDecision({ action: "NOPE" as unknown as "APPROVE", currentStatus: "SUBMITTED" }).ok === false,
    true
  );
});

test("budget in force is effective-dated and the balance clamps at a zero budget", () => {
  const revisions = [
    { revisionNo: 1, effectiveFrom: "2026-01-01", budgetedQuantity: 100 },
    { revisionNo: 2, effectiveFrom: "2026-06-01", budgetedQuantity: 160 },
  ];
  assert.equal(budgetInForce(revisions, "2026-05-31"), 100);
  assert.equal(budgetInForce(revisions, "2026-06-01"), 160);
  assert.equal(budgetInForce(revisions, "2026-12-31"), 160);
  // Before any revision exists, the Job Order's own budget is the fallback.
  assert.equal(budgetInForce(revisions, "2025-12-31", 42), 42);
  assert.equal(budgetInForce([], "2026-09-01", 42), 42);

  assert.deepEqual(quantityBalance(160, 40), { balance: 120, percentComplete: 25 });
  assert.deepEqual(quantityBalance(0, 40), { balance: -40, percentComplete: 0 });
  assert.deepEqual(quantityBalance(100, 0), { balance: 100, percentComplete: 0 });
  assert.equal(quantityBalance(100, 150).percentComplete, 150, "an over-run is shown, never hidden");
});

test("the Job Order display form is Job_Order-Job_Description", () => {
  assert.equal(jobOrderDisplay("1900000107", "Pipe Spool Installation"), "1900000107-Pipe Spool Installation");
});

test("the remark kind mapping covers all five stages", () => {
  assert.deepEqual([...REMARK_KINDS], ["PUNCH", "AMEND", "APPROVE", "REJECT", "SEND_BACK"]);
  assert.deepEqual(
    (["PUNCH", "AMEND", "APPROVE", "REJECT", "SEND_BACK"] as const).map((stage) => [stage, remarkKindForStage(stage)]),
    [
      ["PUNCH", "PUNCH"],
      ["AMEND", "AMEND"],
      ["APPROVE", "APPROVE"],
      ["REJECT", "REJECT"],
      ["SEND_BACK", "SEND_BACK"],
    ]
  );
  // A PM decision's action is its stage.
  assert.equal(remarkKindForAction("APPROVE"), "APPROVE");
  assert.equal(remarkKindForAction("REJECT"), "REJECT");
  assert.equal(remarkKindForAction("SEND_BACK"), "SEND_BACK");

  assert.equal(isRemarkKind("PUNCH"), true);
  assert.equal(isRemarkKind("APPROVED"), false);
  assert.equal(isRemarkKind("punch"), false, "kinds are stored upper case");
  assert.equal(isRemarkKind(null), false);
});

test("a remark row is built from the stage, the remark and the acting author", () => {
  // The remark is trimmed, and the author is the acting user, never the entry owner.
  assert.deepEqual(
    planRemarkWrite({ progressId: 7, kind: remarkKindForStage("PUNCH"), remark: "  Week 1 spools done  ", authorId: 11, authorRole: "HOD" }),
    { ok: true, value: { progressId: 7, kind: "PUNCH", remark: "Week 1 spools done", authorId: 11, authorRole: "HOD" } }
  );
  assert.deepEqual(
    planRemarkWrite({ progressId: 9, kind: "AMEND", remark: "Recounted", authorId: 13, authorRole: "DEPT_HEAD" }),
    { ok: true, value: { progressId: 9, kind: "AMEND", remark: "Recounted", authorId: 13, authorRole: "DEPT_HEAD" } },
    "the author role is carried through exactly as written"
  );
  assert.deepEqual(
    planRemarkWrite({ progressId: 9, kind: "APPROVE", remark: "Fine", authorId: 5, authorRole: "PM" }),
    { ok: true, value: { progressId: 9, kind: "APPROVE", remark: "Fine", authorId: 5, authorRole: "PM" } }
  );
  const rejected = planRemarkWrite({ progressId: 9, kind: "REJECT", remark: " Figure too high ", authorId: 5, authorRole: "PM" });
  assert.equal(rejected.ok === true && rejected.value?.kind, "REJECT");
  assert.equal(rejected.ok === true && rejected.value?.remark, "Figure too high");
  const sentBack = planRemarkWrite({ progressId: 9, kind: "SEND_BACK", remark: "Check the survey", authorId: 5, authorRole: "PM" });
  assert.equal(sentBack.ok === true && sentBack.value?.kind, "SEND_BACK");

  // A nullable author is allowed for a system / backfilled row.
  const backfilled = planRemarkWrite({ progressId: 3, kind: "PUNCH", remark: "Migrated", authorId: null, authorRole: "HOD" });
  assert.equal(backfilled.ok === true && backfilled.value?.authorId, null);

  // Refusals.
  const badKind = planRemarkWrite({ progressId: 7, kind: "PUNCHED", remark: "x", authorId: 11, authorRole: "HOD" });
  assert.equal(badKind.ok === false && badKind.error.code, "INVALID_REMARK_KIND");
  const noEntry = planRemarkWrite({ progressId: 0, kind: "PUNCH", remark: "x", authorId: 11, authorRole: "HOD" });
  assert.equal(noEntry.ok === false && noEntry.error.code, "REMARK_PROGRESS_REQUIRED");
  const noRole = planRemarkWrite({ progressId: 7, kind: "PUNCH", remark: "x", authorId: 11, authorRole: "   " });
  assert.equal(noRole.ok === false && noRole.error.code, "AUTHOR_ROLE_REQUIRED");
  assert.equal(noRole.ok === false && noRole.error.status, 400);
});

test("a missing remark writes no row, except where a remark is mandatory", () => {
  for (const kind of ["PUNCH", "AMEND", "APPROVE"] as const) {
    assert.deepEqual(planRemarkWrite({ progressId: 7, kind, remark: null, authorId: 11, authorRole: "HOD" }), { ok: true, value: null });
    assert.deepEqual(planRemarkWrite({ progressId: 7, kind, remark: "   ", authorId: 11, authorRole: "HOD" }), { ok: true, value: null });
    assert.deepEqual(planRemarkWrite({ progressId: 7, kind, remark: undefined, authorId: 11, authorRole: "HOD" }), { ok: true, value: null });
  }
  for (const kind of ["REJECT", "SEND_BACK"] as const) {
    const missing = planRemarkWrite({ progressId: 7, kind, remark: null, authorId: 5, authorRole: "PM" });
    assert.equal(missing.ok === false && missing.error.code, "REMARKS_REQUIRED", `${kind} needs a remark`);
    assert.equal(missing.ok === false && missing.error.status, 400);
    const blank = planRemarkWrite({ progressId: 7, kind, remark: "  ", authorId: 5, authorRole: "PM" });
    assert.equal(blank.ok === false && blank.error.code, "REMARKS_REQUIRED");
  }
});

test("the entry column keeps the latest message while the history keeps every remark", () => {
  // The column: an approval without a remark leaves the punched note in place, a
  // rejection or send-back carries the PM's reason forward, and a blank punch writes none.
  assert.equal(latestRemarkForWrite("PUNCH", "Week 1", null), "Week 1");
  assert.equal(latestRemarkForWrite("PUNCH", "", null), null);
  assert.equal(latestRemarkForWrite("AMEND", "  Recounted ", null), "Recounted");
  assert.equal(latestRemarkForWrite("APPROVE", null, "Week 1"), "Week 1");
  assert.equal(latestRemarkForWrite("APPROVE", "Looks right", "Week 1"), "Looks right");
  assert.equal(latestRemarkForWrite("REJECT", "Too high", "Week 1"), "Too high");
  assert.equal(latestRemarkForWrite("SEND_BACK", " Recheck ", "Week 1"), "Recheck");

  // The history: revision 1's punch and rejection survive the amendment to revision 2.
  const history: RemarkHistoryRow[] = [
    { id: 1, kind: "PUNCH", remark: "Week 1 spools", authorRole: "HOD", createdAt: new Date("2026-09-10T06:00:00Z"), author: { name: "Ravi" } },
    { id: 2, kind: "REJECT", remark: "Figure too high", authorRole: "PM", createdAt: new Date("2026-09-10T09:30:00Z"), author: { name: "Meera" } },
    { id: 3, kind: "AMEND", remark: "Recounted with QA", authorRole: "HOD", createdAt: new Date("2026-09-11T05:15:00Z"), author: { name: "Ravi" } },
  ];
  const mapped = mapRemarkHistory(history);
  assert.deepEqual(
    mapped.map((item) => [item.kind, item.remark, item.authorName, item.authorRole]),
    [
      ["PUNCH", "Week 1 spools", "Ravi", "HOD"],
      ["REJECT", "Figure too high", "Meera", "PM"],
      ["AMEND", "Recounted with QA", "Ravi", "HOD"],
    ],
    "every remark is kept, in the order it happened, with its author and role"
  );
  assert.equal(mapped[2].createdAt, "2026-09-11T05:15:00.000Z");
});

test("the remark history is oldest first and survives a missing or unknown author", () => {
  const shuffled: RemarkHistoryRow[] = [
    { id: 12, kind: "APPROVE", remark: "Fine", authorRole: "PM", createdAt: "2026-09-12T10:00:00Z", author: { name: "Meera" } },
    { id: 3, kind: "PUNCH", remark: "First", authorRole: "HOD", createdAt: "2026-09-10T10:00:00Z", author: null },
    { id: 2, kind: "PUNCH", remark: "Same instant, lower id first", authorRole: "HOD", createdAt: "2026-09-10T10:00:00Z", author: { name: "Ravi" } },
    { id: 41, kind: "AMEND", remark: "System note", authorRole: "ADMIN", createdAt: "2026-09-11T10:00:00Z" },
  ];
  const mapped = mapRemarkHistory(shuffled);
  assert.deepEqual(mapped.map((item) => item.id), [2, 3, 41, 12], "sorted by time, then by id");
  assert.equal(mapped[1].authorName, null, "a deleted or system author has no name");
  assert.equal(mapped[2].authorName, null);
  assert.deepEqual(mapRemarkHistory([]), []);
});

test("the remarks report is scoped to the caller's own department and section", () => {
  assert.deepEqual(remarkReportScope({ id: 5, role: "PM", departmentId: 3, sectionId: null }), {
    ok: true,
    value: { departmentId: null, sectionId: null },
  });
  assert.deepEqual(remarkReportScope(admin), { ok: true, value: { departmentId: null, sectionId: null } });

  assert.deepEqual(remarkReportScope(sectionHod), { ok: true, value: { departmentId: 3, sectionId: 42 } });
  assert.deepEqual(remarkReportScope(departmentHod), { ok: true, value: { departmentId: 3, sectionId: null } });
  const deptHead: ProgressActor = { id: 13, role: "DEPT_HEAD", departmentId: 3, sectionId: null };
  assert.deepEqual(remarkReportScope(deptHead), { ok: true, value: { departmentId: 3, sectionId: null } });

  const noDepartment = remarkReportScope({ ...deptHead, departmentId: null });
  assert.equal(noDepartment.ok === false && noDepartment.error.code, "DEPARTMENT_REQUIRED");
  assert.equal(noDepartment.ok === false && noDepartment.error.status, 403);
  const wrongRole = remarkReportScope(supervisor);
  assert.equal(wrongRole.ok === false && wrongRole.error.code, "ROLE_NOT_ALLOWED");
  assert.equal(wrongRole.ok === false && wrongRole.error.status, 403);
});
