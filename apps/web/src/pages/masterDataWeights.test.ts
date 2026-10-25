import assert from "node:assert/strict";
import test from "node:test";
import { budgetSplit, equalSplit, previewWeights, weightPayload } from "./masterDataWeights";

const rows = [
  { wbsId: 1, plannedWeight: null, budgetHours: 500 },
  { wbsId: 2, plannedWeight: null, budgetHours: 300 },
  { wbsId: 3, plannedWeight: null, budgetHours: 200 },
];

test("percentages typed by a planner become the shares the curve will draw", () => {
  const preview = previewWeights(rows, { 1: "50", 2: "30", 3: "20" });
  assert.equal(preview.sharePct.get(1), 50);
  assert.equal(preview.sharePct.get(2), 30);
  assert.equal(preview.sharePct.get(3), 20);
  assert.equal(preview.enteredTotal, 100);
  assert.equal(preview.configuredCount, 3);
  assert.equal(preview.averagePct, null, "nothing is unweighted");
  assert.equal(preview.allBlank, false);
});

test("percentages do not have to add up to 100 — they are normalised, and the preview says so", () => {
  // A planner who types 25 / 25 into two of three boxes means 50/50 between them, with the third taking the
  // average. The dialog must show that rather than silently multiplying everything by four.
  const preview = previewWeights(rows, { 1: "25", 2: "25" });
  assert.equal(preview.enteredTotal, 50);
  assert.equal(preview.configuredCount, 2);
  assert.equal(preview.averagePct, 25, "the unweighted node takes the average of 25 and 25");
  assert.equal(preview.sharePct.get(1), 33.33);
  assert.equal(preview.sharePct.get(2), 33.33);
  assert.equal(preview.sharePct.get(3), 33.33);
});

test("a blank box and a typed zero both mean 'no opinion', never 'no share'", () => {
  // A zero share would drop the node out of the plan while the screen still listed it.
  const preview = previewWeights(rows, { 1: "60", 2: "", 3: "0" });
  assert.equal(preview.configuredCount, 1);
  assert.equal(preview.averagePct, 60);
  assert.equal(preview.sharePct.get(1), 33.33);
  assert.equal(preview.sharePct.get(2), 33.33);
  assert.equal(preview.sharePct.get(3), 33.33);

  const payload = weightPayload(rows, { 1: "60", 2: "", 3: "0" });
  assert.deepEqual(payload, [
    { wbsId: 1, plannedWeight: 60 },
    { wbsId: 2, plannedWeight: null },
    { wbsId: 3, plannedWeight: null },
  ]);
});

test("with nothing typed the project is on an equal share", () => {
  const preview = previewWeights(rows, {});
  assert.equal(preview.allBlank, true);
  assert.equal(preview.configuredCount, 0);
  assert.equal(preview.sharePct.get(1), 33.33);
  assert.equal(preview.sharePct.get(3), 33.33);
});

test("'follow the money' splits 100% by budgeted hours, and skips nodes with no budget", () => {
  const withEmpty = [...rows, { wbsId: 4, plannedWeight: null, budgetHours: 0 }];
  const inputs = budgetSplit(withEmpty);
  assert.equal(inputs[1], "50");
  assert.equal(inputs[2], "30");
  assert.equal(inputs[3], "20");
  assert.equal(inputs[4], undefined, "a node with no budget gets no percentage of its own");

  // …and that node then takes the average, 33.33%, rather than being silently dropped.
  const preview = previewWeights(withEmpty, inputs);
  assert.equal(preview.configuredCount, 3);
  assert.equal(preview.sharePct.get(4), 25);
});

test("an equal split adds up to exactly 100, even when 100 does not divide evenly", () => {
  const three = equalSplit(rows);
  assert.deepEqual(three, { 1: "33.3", 2: "33.3", 3: "33.4" });
  const total = Object.values(three).reduce((sum, value) => sum + Number(value), 0);
  assert.equal(Math.round(total * 10) / 10, 100);

  const seven = equalSplit(Array.from({ length: 7 }, (_, index) => ({ wbsId: index + 1, plannedWeight: null, budgetHours: 1 })));
  const sevenTotal = Object.values(seven).reduce((sum, value) => sum + Number(value), 0);
  assert.equal(Math.round(sevenTotal * 10) / 10, 100);
});
