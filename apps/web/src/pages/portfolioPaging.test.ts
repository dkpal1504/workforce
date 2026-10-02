import test from "node:test";
import assert from "node:assert/strict";
import { PAGE_SIZE, clampPage, pageNumbers, paginate } from "./portfolioPaging";

/**
 * WHY THESE TESTS EXIST: the dashboard lists up to 63 job orders in one table, and the pager
 * has to stay correct when the list is filtered underneath the page the operator is standing
 * on. These tests pin the decisions that are easy to get wrong and expensive in the browser:
 *   1. the empty list is ONE page (never "page 0 of 0") with 0/0 display numbers;
 *   2. a page past either end is CLAMPED, so a shrunk list shows the nearest valid page and
 *      never an empty table with a live Next button;
 *   3. junk page/pageSize inputs (NaN, Infinity, 0, negatives, fractions) normalise to sane
 *      integers and never propagate NaN or a fractional page;
 *   4. every slice is a contiguous, in-order slice of the ORIGINAL array;
 *   5. `pageNumbers` never exceeds `max`, always keeps the first and last page, and degrades
 *      sanely for a tiny `max` or a one-page list.
 */

/** An ordered list where each row is its own 1-based number, so order and identity are checkable. */
function rows(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i + 1);
}

test("63 rows at pageSize 25 give 3 pages and page 3 holds rows 51-63", () => {
  const slice = paginate(rows(63), 3, 25);
  assert.equal(slice.pageCount, 3);
  assert.equal(slice.total, 63);
  assert.equal(slice.page, 3);
  assert.equal(slice.rows.length, 13);
  assert.equal(slice.from, 51);
  assert.equal(slice.to, 63);
  assert.deepEqual(slice.rows, [51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63]);
});

test("the empty list is ONE page with rows [] and from/to 0", () => {
  const slice = paginate([], 1);
  assert.equal(slice.pageCount, 1);
  assert.equal(slice.page, 1);
  assert.equal(slice.total, 0);
  assert.deepEqual(slice.rows, []);
  // Never "Showing 1-0 of 0": an empty list reports 0/0 display numbers.
  assert.equal(slice.from, 0);
  assert.equal(slice.to, 0);
  assert.equal(slice.hasPrev, false);
  assert.equal(slice.hasNext, false);
});

test("a page beyond the end clamps to the last page", () => {
  const slice = paginate(rows(63), 99, 25);
  assert.equal(slice.page, 3);
  assert.equal(slice.from, 51);
  assert.equal(slice.to, 63);
  assert.equal(slice.hasNext, false);
});

test("a page below 1 clamps to the first page", () => {
  const slice = paginate(rows(63), -5, 25);
  assert.equal(slice.page, 1);
  assert.equal(slice.from, 1);
  assert.equal(slice.to, 25);
  assert.equal(slice.hasPrev, false);
});

test("the clamped page is the behaviour a shrunk list needs", () => {
  // The operator was on page 3 (63 rows); the filter now yields 12 rows. They must land on
  // the nearest valid page (here the only page), not an empty table with a live Next button.
  const slice = paginate(rows(12), 3, 25);
  assert.equal(slice.pageCount, 1);
  assert.equal(slice.page, 1);
  assert.equal(slice.rows.length, 12);
  assert.equal(slice.hasNext, false);
});

test("a pageSize that is not a positive finite integer falls back to PAGE_SIZE", () => {
  for (const bad of [0, -10, Number.NaN, Number.POSITIVE_INFINITY, 7.5]) {
    const slice = paginate(rows(63), 1, bad);
    // PAGE_SIZE rows on page 1, three pages total for 63 rows.
    assert.equal(slice.rows.length, PAGE_SIZE, `pageSize ${bad} should fall back to ${PAGE_SIZE}`);
    assert.equal(slice.pageCount, 3, `pageSize ${bad} should give 3 pages`);
  }
});

test("a valid explicit pageSize is honoured, including a short final page", () => {
  // Unlike the fallbacks above, an integer pageSize is used verbatim: 10 rows at 3 per page is
  // 4 pages, the last of which holds a single row.
  const slice = paginate(rows(10), 4, 3);
  assert.equal(slice.pageCount, 4);
  assert.equal(slice.rows.length, 1);
  assert.equal(slice.from, 10);
  assert.equal(slice.to, 10);
});

test("a page that is not a positive finite integer clamps to a sane integer page", () => {
  for (const bad of [0, Number.NaN, Number.POSITIVE_INFINITY, -3]) {
    const slice = paginate(rows(63), bad, 25);
    assert.equal(slice.page, 1, `page ${bad} should clamp to 1`);
    assert.ok(Number.isInteger(slice.page));
  }
});

test("a fractional page is floored to the page the reader can actually see", () => {
  const slice = paginate(rows(63), 2.5, 25);
  assert.equal(slice.page, 2);
  assert.equal(slice.from, 26);
  assert.equal(slice.to, 50);
  assert.ok(Number.isInteger(slice.page));
});

test("every slice is a contiguous, in-order slice of the ORIGINAL array", () => {
  const original = rows(63);
  const seen: number[] = [];
  for (let p = 1; p <= 3; p += 1) {
    const slice = paginate(original, p, 25);
    // No reordering, no duplication: the page equals the original slice verbatim.
    assert.deepEqual(slice.rows, original.slice((p - 1) * 25, p * 25));
    seen.push(...slice.rows);
  }
  // Stitched together, the pages reproduce the whole list exactly once.
  assert.deepEqual(seen, original);
});

test("from/to are correct on the first, middle and last page", () => {
  const original = rows(63);
  const first = paginate(original, 1, 25);
  assert.equal(first.from, 1);
  assert.equal(first.to, 25);

  const middle = paginate(original, 2, 25);
  assert.equal(middle.from, 26);
  assert.equal(middle.to, 50);

  const last = paginate(original, 3, 25);
  assert.equal(last.from, 51);
  assert.equal(last.to, 63);
});

test("hasPrev/hasNext are false only at the ends", () => {
  assert.deepEqual(
    [1, 2, 3].map((p) => {
      const s = paginate(rows(63), p, 25);
      return { hasPrev: s.hasPrev, hasNext: s.hasNext };
    }),
    [
      { hasPrev: false, hasNext: true },
      { hasPrev: true, hasNext: true },
      { hasPrev: true, hasNext: false },
    ]
  );
});

test("pageNumbers for a one-page list is exactly [1]", () => {
  assert.deepEqual(pageNumbers(1, 1), [1]);
  // The empty-list case is also a one-page list, so the pager renders "1".
  assert.deepEqual(pageNumbers(paginate([], 1).page, paginate([], 1).pageCount), [1]);
});

test("pageNumbers for pageCount 100 with max 7 is 7 ascending in-range numbers keeping 1 and 100", () => {
  const numbers = pageNumbers(50, 100, 7);
  assert.equal(numbers.length, 7);
  assert.equal(numbers[0], 1);
  assert.equal(numbers[numbers.length - 1], 100);
  assert.ok(numbers.includes(50), "the current page must be in its own window");
  for (const n of numbers) {
    assert.ok(Number.isInteger(n) && n >= 1 && n <= 100, `out-of-range number ${n}`);
  }
  for (let i = 1; i < numbers.length; i += 1) {
    assert.ok(numbers[i] > numbers[i - 1], `not strictly ascending at ${i}: ${numbers.join(",")}`);
  }
  assert.equal(new Set(numbers).size, numbers.length, "no duplicates");
});

test("pageNumbers never exceeds max and keeps the endpoints at either extreme of the range", () => {
  for (const current of [1, 2, 3, 98, 99, 100]) {
    const numbers = pageNumbers(current, 100, 7);
    assert.equal(numbers.length, 7, `current ${current} should still yield 7`);
    assert.equal(numbers[0], 1, `current ${current} must keep the first page`);
    assert.equal(numbers[numbers.length - 1], 100, `current ${current} must keep the last page`);
    assert.ok(numbers.includes(current), `current ${current} must appear`);
    for (let i = 1; i < numbers.length; i += 1) {
      assert.ok(numbers[i] > numbers[i - 1], `not ascending for current ${current}`);
    }
  }
});

test("pageNumbers shows every page when they fit within max", () => {
  assert.deepEqual(pageNumbers(2, 5, 7), [1, 2, 3, 4, 5]);
});

test("pageNumbers with max 2 or max 1 returns something sane and in range instead of throwing", () => {
  // max 2 has room only for the two endpoints.
  assert.deepEqual(pageNumbers(50, 100, 2), [1, 100]);
  // max 1 cannot keep both endpoints; it must still not throw or emit an out-of-range value.
  const single = pageNumbers(50, 100, 1);
  assert.equal(single.length, 1);
  assert.ok(single[0] >= 1 && single[0] <= 100);
});

test("pageNumbers tolerates a pageCount of 0 without throwing", () => {
  assert.deepEqual(pageNumbers(1, 0), []);
});

test("clampPage folds any requested page into [1, pageCount]", () => {
  assert.equal(clampPage(0, 5), 1);
  assert.equal(clampPage(-9, 5), 1);
  assert.equal(clampPage(3, 5), 3);
  assert.equal(clampPage(9, 5), 5);
  assert.equal(clampPage(2.7, 5), 2);
  assert.equal(clampPage(Number.NaN, 5), 1);
  // A pageCount of 0 is still one page.
  assert.equal(clampPage(1, 0), 1);
});
