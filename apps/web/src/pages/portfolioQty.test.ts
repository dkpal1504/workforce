import test from "node:test";
import assert from "node:assert/strict";
import { fmtQtyCompletePct, qtyCompleteNote } from "./portfolioQty";

/**
 * WHY THESE TESTS EXIST: `% Qty` is a numeric column the operator trusts, and the API's
 * `qtyCompletePct` is a FRACTION that must never surface as "NaN%" or a blank. These pin
 * the four cases the divide-by-zero rule turns on:
 *   1. a genuine zero renders "0.0%" (never blank, never an em dash);
 *   2. a normal fraction renders with one decimal;
 *   3. over-achievement is not clamped (150 of 100 shows "150.0%");
 *   4. a non-finite value (stale bundle / cached payload) ALSO renders "0.0%", not "NaN%".
 */

test("a genuine zero renders 0.0%, never blank and never an em dash", () => {
  assert.equal(fmtQtyCompletePct(0), "0.0%");
  // 0 / positive-target is the production case for every row with no approved progress.
  assert.notEqual(fmtQtyCompletePct(0), "—");
  assert.notEqual(fmtQtyCompletePct(0), "");
});

test("a normal fraction renders as a one-decimal percentage", () => {
  assert.equal(fmtQtyCompletePct(0.55), "55.0%");
  assert.equal(fmtQtyCompletePct(0.05), "5.0%");
  assert.equal(fmtQtyCompletePct(1), "100.0%");
  assert.equal(fmtQtyCompletePct(0.075), "7.5%");
});

test("over-achievement is shown, not clamped to 100%", () => {
  assert.equal(fmtQtyCompletePct(1.5), "150.0%");
  assert.equal(fmtQtyCompletePct(2), "200.0%");
});

test("a non-finite or absent value renders 0.0% rather than NaN%", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, null, undefined]) {
    assert.equal(fmtQtyCompletePct(bad), "0.0%", `value ${String(bad)} must render 0.0%`);
    assert.ok(!fmtQtyCompletePct(bad).includes("NaN"), `value ${String(bad)} must never contain NaN`);
  }
});

test("every output is a one-decimal percent string", () => {
  for (const value of [0, 0.1, 0.333, 0.999, 1.21, 3.456]) {
    assert.match(fmtQtyCompletePct(value), /^\d+(\.\d)?%$/);
  }
});

test("the note flags only the no-quantity-budget zero", () => {
  // The zero from "no quantity budget" (target <= 0) needs explaining; a zero from a real
  // target with nothing completed yet does NOT, because its positive QTY BDG already says so.
  assert.equal(qtyCompleteNote(0), "no qty budget");
  assert.equal(qtyCompleteNote(-5), "no qty budget");
  assert.equal(qtyCompleteNote(Number.NaN), "no qty budget");
  assert.equal(qtyCompleteNote(Number.POSITIVE_INFINITY), "no qty budget");
  assert.equal(qtyCompleteNote(500), null);
  assert.equal(qtyCompleteNote(1), null);
});
