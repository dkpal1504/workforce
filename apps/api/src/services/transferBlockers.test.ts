import assert from "node:assert/strict";
import test from "node:test";
import {
  blockingDaysMessage,
  blockingDaysOf,
  staleStageLabel,
  TRANSFER_BLOCKING_ALLOCATION_STATUSES,
  TRANSFER_BLOCKING_TIMESHEET_STATUSES,
} from "./transferBlockers";

test("a DRAFT day never blocks a transfer, a submitted one does", () => {
  assert.deepEqual(TRANSFER_BLOCKING_TIMESHEET_STATUSES, ["SUBMITTED", "HOD_APPROVED", "PLANNING_RETURNED"]);
  assert.equal((TRANSFER_BLOCKING_TIMESHEET_STATUSES as readonly string[]).includes("DRAFT"), false);
  assert.deepEqual(TRANSFER_BLOCKING_ALLOCATION_STATUSES, ["SUBMITTED", "HOD_APPROVED"]);
  assert.equal((TRANSFER_BLOCKING_ALLOCATION_STATUSES as readonly string[]).includes("REJECTED"), false);
});

test("each stage says where the day sits and who can move it on", () => {
  assert.match(staleStageLabel("TIMESHEET", "SUBMITTED"), /Section HOD/);
  assert.match(staleStageLabel("TIMESHEET", "HOD_APPROVED"), /Project Head/);
  assert.match(staleStageLabel("TIMESHEET", "PLANNING_RETURNED"), /resubmit/);
  assert.match(staleStageLabel("MY_HOURS", "SUBMITTED"), /Section HOD/);
  assert.match(staleStageLabel("MY_HOURS", "HOD_APPROVED"), /Project Head/);
});

test("the refusal counts the days, names them oldest first, and says how many more", () => {
  const message = blockingDaysMessage([
    { kind: "TIMESHEET", workDate: "2026-10-22", status: "HOD_APPROVED" },
    { kind: "TIMESHEET", workDate: "2026-10-21", status: "SUBMITTED" },
    { kind: "MY_HOURS", workDate: "2026-10-23", status: "SUBMITTED" },
  ]);
  assert.ok(message.startsWith("3 days are still open"), message);
  const first = message.indexOf("21-10-2026");
  const second = message.indexOf("22-10-2026");
  const third = message.indexOf("23-10-2026");
  assert.ok(first > 0 && first < second && second < third, "oldest day first");
  assert.match(message, /22-10-2026 timesheet \(with the Project Head/);
  assert.match(message, /23-10-2026 My Hours/);
  assert.match(message, /then transfer\.$/);
});

test("one day reads in the singular, and a long list is capped", () => {
  const one = blockingDaysMessage([{ kind: "MY_HOURS", workDate: "2026-10-21", status: "SUBMITTED" }]);
  assert.ok(one.startsWith("1 day is still open"), one);
  assert.ok(one.includes("that day first"), one);

  const many = blockingDaysMessage(
    Array.from({ length: 6 }, (_, index) => ({
      kind: "TIMESHEET" as const,
      workDate: `2026-10-${String(10 + index).padStart(2, "0")}`,
      status: "SUBMITTED",
    })),
    2
  );
  assert.match(many, /and 4 more/);
  assert.equal(many.match(/timesheet \(/g)?.length, 2, "only the shown days are listed");
});

test("no blockers means no message — the caller must not print an empty sentence", () => {
  assert.equal(blockingDaysMessage([]), "");
});

test("rows are converted with the date as a plain day, never a timestamp", () => {
  const days = blockingDaysOf(
    [{ workDate: new Date("2026-10-21T00:00:00.000Z"), status: "SUBMITTED" }],
    [{ workDate: "2026-10-22", status: "SUBMITTED" }]
  );
  assert.deepEqual(days, [
    { kind: "TIMESHEET", workDate: "2026-10-21", status: "SUBMITTED" },
    { kind: "MY_HOURS", workDate: "2026-10-22", status: "SUBMITTED" },
  ]);
});
