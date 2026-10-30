import test from "node:test";
import assert from "node:assert/strict";
import { slotTooltip } from "./slotTooltip";

test("names the project, the job order and its description on two lines — and no slot time", () => {
  assert.equal(
    slotTooltip({
      projectKey: "B",
      projectName: "MV AINA",
      jobOrderCode: "1900000204",
      jobOrderName: "Block Transfer (Block 223)",
    }),
    "MV AINA\n1900000204 — Block Transfer (Block 223)"
  );
});

test("falls back to the project token when the Project has no name", () => {
  assert.equal(slotTooltip({ projectKey: "c", jobOrderCode: "1900000110" }), "PROJECT C\n1900000110");
});

test("a slot with no job order says so instead of ending in a bare dash", () => {
  assert.equal(slotTooltip({ projectKey: "n", projectName: "Non-Project" }), "Non-Project\nNo Job Order");
});

test("no project at all does not print 'undefined'", () => {
  assert.equal(slotTooltip({ jobOrderCode: "1900000205" }), "Project\n1900000205");
});
