import test from "node:test";
import assert from "node:assert/strict";
import { contractOverheadHours } from "./contractWorkHours";

test("OT-only holiday attendance has zero overhead", () => {
  assert.equal(contractOverheadHours(8, 0, 8), 0);
  assert.equal(contractOverheadHours(8, 0, 4), 0);
});

test("regular contract attendance keeps unused shift capacity as overhead", () => {
  assert.equal(contractOverheadHours(8, 6, 0), 2);
  assert.equal(contractOverheadHours(8, 6, 2), 2);
  assert.equal(contractOverheadHours(8, 8, 4), 0);
});
