import test from "node:test";
import assert from "node:assert/strict";
import { audienceAddress, sectionHeadAudience, uniqueAudience, type AudiencePerson } from "./slaLadder";

/**
 * Who an escalation is mailed to, as a pure decision.
 *
 * The rule the operator asked for: the Section Heads hear about their own sections, every PM and the COO hear
 * about everything, and an assigned Project Manager hears about his projects. Here the ladder's two rungs are
 * reduced to their audience, so the ordering and the de-duplication are decided before any address is used.
 */

function person(overrides: Partial<AudiencePerson> & { id: number }): AudiencePerson {
  return {
    email: `${overrides.id}@swan.co.in`,
    notificationEmail: null,
    sectionId: null,
    scopeSections: [],
    ...overrides,
  };
}

test("the section head whose scope holds the section comes first, and the rung stops at four", () => {
  const hods = [
    person({ id: 1, scopeSections: [{ sectionId: 2 }] }),
    person({ id: 2, scopeSections: [{ sectionId: 9 }] }),
    person({ id: 3, sectionId: 9 }),
    person({ id: 4, scopeSections: [{ sectionId: 9 }] }),
    person({ id: 5, scopeSections: [{ sectionId: 9 }] }),
  ];
  const audience = sectionHeadAudience(hods, 9).map((row) => row.id);
  // Everyone covering section 9 is kept ahead of the one who does not, and only the first four survive.
  assert.deepEqual(audience, [2, 3, 4, 5]);
});

test("the legacy single-section mirror counts as a scope when no scope rows exist", () => {
  const hods = [person({ id: 1, sectionId: 4 }), person({ id: 2, scopeSections: [{ sectionId: 40 }] })];
  assert.deepEqual(sectionHeadAudience(hods, 4).map((row) => row.id), [1, 2]);
});

test("a Job Order with no section keeps the department's heads in their stored order", () => {
  const hods = [person({ id: 7, scopeSections: [{ sectionId: 9 }] }), person({ id: 8 })];
  assert.deepEqual(sectionHeadAudience(hods, null).map((row) => row.id), [7, 8]);
});

test("one row per person: a PM who is also the project's manager is addressed once", () => {
  const coo = person({ id: 1 });
  const pm = person({ id: 2 });
  const audience = uniqueAudience([coo, pm, person({ id: 2 })]);
  assert.equal(audience.length, 2);
  assert.deepEqual(audience.map((row) => row.userId), [1, 2]);
});

test("the notification address wins, and is lowercased", () => {
  const withNotif = person({ id: 3, email: "login@employee.local", notificationEmail: "  Head.Of.Section@SWAN.co.in " });
  assert.equal(audienceAddress(withNotif), "head.of.section@swan.co.in");
  assert.deepEqual(uniqueAudience([withNotif]), [{ userId: 3, email: "head.of.section@swan.co.in" }]);
});

test("a blank address is null, never an empty string that would be queued and refused", () => {
  const blank = person({ id: 4, email: "   ", notificationEmail: "  " });
  assert.equal(audienceAddress(blank), null);
});
