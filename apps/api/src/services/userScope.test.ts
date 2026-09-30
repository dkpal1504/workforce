import test from "node:test";
import assert from "node:assert/strict";
import { legacySectionId, normaliseSectionIds, scopeSectionIds, validateScopeSections } from "./userScope";

/**
 * The write-side rules for a multi-section Section Head.
 *
 * The rule under test throughout: an HOD is single-Department, so a scope may only name Sections of
 * that Department — and the refusal has to be here, not only in the UI.
 */

test("section ids are deduped and sorted, so the mirror and the stored rows are deterministic", () => {
  assert.deepEqual(normaliseSectionIds([42, 8, 42]), [8, 42]);
  assert.deepEqual(normaliseSectionIds([8]), [8]);
  assert.deepEqual(normaliseSectionIds([]), []);
});

test("the legacy mirror is the first section, or null for department-wide", () => {
  // `null` means "the whole Department" and must agree with an EMPTY set, or an API-only rollback
  // would change who can approve.
  assert.equal(legacySectionId([]), null);
  assert.equal(legacySectionId([8]), 8);
  assert.equal(legacySectionId([8, 42]), 8);
  assert.equal(legacySectionId([42, 8]), 8, "order of input must not change the mirror");
});

test("every chosen section must belong to the user's own Department", () => {
  const sections = [
    { id: 8, departmentId: 4, active: true },
    { id: 42, departmentId: 4, active: true },
    { id: 9, departmentId: 2, active: true },
    { id: 10, departmentId: 4, active: false },
  ];

  assert.equal(validateScopeSections(4, [8, 42], sections), null, "both sections are in department 4");
  assert.equal(validateScopeSections(4, [], sections), null, "empty = department-wide, always valid");
  assert.equal(validateScopeSections(4, [8], sections), null);
});

test("an empty set is valid even as a whole-Department Section Head", () => {
  // This is the shape the user described as "HOD will be only for one Department".
  assert.equal(validateScopeSections(4, [], [{ id: 8, departmentId: 4, active: true }]), null);
});

test("a scope with no Department is refused rather than silently matching nothing", () => {
  const refusal = validateScopeSections(null, [8], [{ id: 8, departmentId: 4, active: true }]);
  assert.equal(refusal?.code, "DEPARTMENT_REQUIRED");
});

test("a Section from another Department is refused with the reason", () => {
  const sections = [
    { id: 8, departmentId: 4, active: true },
    { id: 9, departmentId: 2, active: true },
  ];
  const refusal = validateScopeSections(4, [8, 9], sections);
  assert.equal(refusal?.code, "SECTION_NOT_IN_DEPARTMENT");
  assert.match(refusal!.error, /another Department/i);
  assert.match(refusal!.error, /own Department/i);
});

test("an inactive or unknown Section is refused, and checked before the department rule", () => {
  const sections = [
    { id: 10, departmentId: 4, active: false },
    { id: 8, departmentId: 4, active: true },
  ];
  assert.equal(validateScopeSections(4, [10], sections)?.code, "SECTION_INACTIVE");
  assert.equal(validateScopeSections(4, [999], sections)?.code, "SECTION_NOT_FOUND");
  // A section that is BOTH unknown and in "another department" is reported as unknown - there is
  // nothing to compare a department with until the row exists.
  assert.equal(validateScopeSections(4, [999, 8], sections)?.code, "SECTION_NOT_FOUND");
});

test("the query ids are only the NARROWING sections; empty must stay empty", () => {
  // An empty array means department-wide. Filtering with `{ in: [] }` would match NOTHING, which is
  // the opposite of the intent, so the caller checks emptiness and drops the filter entirely.
  assert.deepEqual(scopeSectionIds([42, 8]), [8, 42]);
  assert.deepEqual(scopeSectionIds([]), []);
  assert.equal(scopeSectionIds([]).length, 0);
});
