import assert from "node:assert/strict";
import test from "node:test";
import { jobOrderSearchFilters, threadSearchFilters } from "./conversationSearch";

test("a project code is a search term, and it matches every Job Order under the project", () => {
  const filters = jobOrderSearchFilters("CSR.008");
  assert.deepEqual(filters, [
    { code: { contains: "CSR.008" } },
    { name: { contains: "CSR.008" } },
    { project: { code: { contains: "CSR.008" } } },
    { project: { name: { contains: "CSR.008" } } },
  ]);
  assert.equal(filters.some((filter) => "projectId" in filter), false);
});

test("a whole number is a project id, and NOT a substring of every Job Order code containing that digit", () => {
  // Live failure this pins: q=5 answered 60 Job Orders across six projects, because "5" is a substring of
  // M4152, B5014, H1001… A project number has to be exact.
  // …and not a project CODE containing the digit either: "5" matched CSR.005 while answering for project 5.
  assert.deepEqual(jobOrderSearchFilters("5"), [{ projectId: 5 }]);
});

test("a number too large to be an id searches nothing rather than everything", () => {
  assert.deepEqual(jobOrderSearchFilters("99999999999999999999"), []);
});

test("zero is not a project id, so it searches nothing", () => {
  assert.deepEqual(jobOrderSearchFilters("0"), []);
});

test("a blank term produces no filter at all — an OR: [] would match nothing", () => {
  assert.deepEqual(jobOrderSearchFilters(""), []);
  assert.deepEqual(jobOrderSearchFilters("   "), []);
  assert.deepEqual(threadSearchFilters(""), []);
});

test("the term is trimmed, so a trailing space does not search for one", () => {
  assert.deepEqual(jobOrderSearchFilters("  HULL  ")[0], { code: { contains: "HULL" } });
});

test("a thread is matched through its Job Order, never by a second rule of its own", () => {
  const threads = threadSearchFilters("CSR.008");
  assert.equal(threads.length, jobOrderSearchFilters("CSR.008").length);
  for (const filter of threads) {
    assert.deepEqual(Object.keys(filter), ["jobOrder"]);
  }
  assert.deepEqual(threads[2], { jobOrder: { project: { code: { contains: "CSR.008" } } } });
  assert.deepEqual(threadSearchFilters("5")[0], { jobOrder: { projectId: 5 } });
});
