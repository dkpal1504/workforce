import test from "node:test";
import assert from "node:assert/strict";
import { LABOURWORKS_CARD_TYPES, cardTypeFilter, cardTypesLabel } from "./labourWorksCardTypes";

/**
 * WHY THESE TESTS EXIST: this one list decides WHO the contract workforce is. A value that is
 * misspelled, missing, or bound to the wrong parameter does not fail loudly — it silently selects a
 * different population, so the app either loses a whole yard (no Employee row, no login, nothing in
 * any picker) or reports one as "not in the source" when the sync simply never asked for it. That is
 * the failure mode a test can catch and an operator cannot see.
 *
 * The three things pinned here:
 *   1. BOTH contract card types are selected — `ASSOCIATES` and `ASSOCIATE SEZ`;
 *   2. one bound parameter per value, in the same order, so a caller cannot bind them crossed;
 *   3. the predicate is a single `IN (...)` on `[Card Type]`, never a bare `= @cardType` (which is
 *      what the sync used to have, and which made the second population unreachable).
 */

test("both contract card types are selected, spelled as the source spells them", () => {
  assert.deepEqual([...LABOURWORKS_CARD_TYPES], ["ASSOCIATES", "ASSOCIATE SEZ"]);
  // The SEZ population arrived second and is the one that used to be invisible: if a future edit
  // "tidies" the list back to one value, this is the assertion that stops it.
  assert.ok(LABOURWORKS_CARD_TYPES.includes("ASSOCIATE SEZ"));
  assert.equal(LABOURWORKS_CARD_TYPES.length, 2);
});

test("the list is usable: no blank value, no duplicate, no padding", () => {
  for (const value of LABOURWORKS_CARD_TYPES) {
    assert.ok(value.trim().length > 0, "a blank card type would build `IN ('')` and select nothing");
    assert.equal(value, value.trim());
  }
  const folded = LABOURWORKS_CARD_TYPES.map((value) => value.toUpperCase());
  assert.equal(new Set(folded).size, folded.length, "a duplicate card type is a list that lies about its size");
});

test("the predicate is one IN clause on [Card Type], never a bare equality", () => {
  const { where } = cardTypeFilter();
  assert.equal(where, "[Card Type] IN (@cardType0, @cardType1)");
  // The shape that caused the bug: a single parameter bound to a single literal.
  assert.equal(where.includes("= @cardType"), false);
  assert.equal(/^\[Card Type\] IN \(@cardType\d+(, @cardType\d+)*\)$/.test(where), true);
});

test("one parameter per value, in the same order — so the caller cannot bind them crossed", () => {
  const { where, values } = cardTypeFilter();
  assert.deepEqual(values, ["ASSOCIATES", "ASSOCIATE SEZ"]);
  const parameters = where.match(/@cardType\d+/g) || [];
  assert.equal(parameters.length, values.length, "every value needs its own parameter");
  assert.deepEqual(parameters, values.map((_value, index) => `@cardType${index}`));
  // Fresh arrays each call: a caller mutating the result must not be able to edit the definition.
  const first = cardTypeFilter();
  first.values.push("MUTATED");
  assert.deepEqual([...LABOURWORKS_CARD_TYPES], ["ASSOCIATES", "ASSOCIATE SEZ"]);
  assert.notEqual(first.values, cardTypeFilter().values);
});

test("the printed words are DERIVED from the list, so they cannot outlive it", () => {
  // The triage script prints this sentence; when it was the literal "ASSOCIATES row(s)" it described
  // a population the sync had stopped asking for.
  assert.equal(cardTypesLabel(), "ASSOCIATES or ASSOCIATE SEZ");
  for (const value of LABOURWORKS_CARD_TYPES) {
    assert.ok(cardTypesLabel().includes(value), `${value} must appear in the prose`);
  }
});
