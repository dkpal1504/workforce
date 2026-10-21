import test from "node:test";
import assert from "node:assert/strict";
import { deliveryTarget } from "./conversations";

/**
 * WHO gets a copy of a message, and at WHICH address.
 *
 * The participant key inside a thread is the LOGIN handle (`40032021@employee.local`). It is what the
 * unread badge looks a reader up by, and it is not a mailbox. These cases pin the rule that a delivery
 * is only QUEUED to an address something can actually receive, and that when there is none the row says
 * so instead of failing at the relay.
 */

const handle = "40032021@employee.local";

test("the owner with a notification address is queued to it, not to his login handle", () => {
  assert.deepEqual(
    deliveryTarget({ key: handle, isOwner: true, ownerEmail: "owner@swan.co.in", accountAddress: null, mutedAt: null, emailOwner: true }),
    { address: "owner@swan.co.in", state: "QUEUED" }
  );
});

test("the owner with no routable address says NO_ADDRESS and keeps the handle for display", () => {
  assert.deepEqual(
    deliveryTarget({ key: handle, isOwner: true, ownerEmail: null, accountAddress: null, mutedAt: null, emailOwner: true }),
    { address: handle, state: "NO_ADDRESS" }
  );
});

test("A NON-OWNER participant is queued to HIS notification address too", () => {
  // This is the case that used to be mailed at a login handle and fail at the relay: a PM posts on a
  // thread, the owner replies, and the PM's copy goes to 40032021@employee.local.
  assert.deepEqual(
    deliveryTarget({
      key: "40032021@employee.local",
      isOwner: false,
      ownerEmail: "owner@swan.co.in",
      accountAddress: "pm@swan.co.in",
      mutedAt: null,
      emailOwner: true,
    }),
    { address: "pm@swan.co.in", state: "QUEUED" }
  );
});

test("a non-owner with only a login handle is NO_ADDRESS, never queued to a dead address", () => {
  assert.deepEqual(
    deliveryTarget({ key: handle, isOwner: false, ownerEmail: null, accountAddress: null, mutedAt: null, emailOwner: true }),
    { address: handle, state: "NO_ADDRESS" }
  );
});

test("a real login address counts as routable when there is no notification address", () => {
  assert.deepEqual(
    deliveryTarget({ key: handle, isOwner: false, ownerEmail: null, accountAddress: "someone@swan.co.in", mutedAt: null, emailOwner: true }),
    { address: "someone@swan.co.in", state: "QUEUED" }
  );
});

test("an owner whose copy is switched off is MUTED at the resolvable address, not silently dropped", () => {
  assert.deepEqual(
    deliveryTarget({ key: handle, isOwner: true, ownerEmail: "owner@swan.co.in", accountAddress: null, mutedAt: null, emailOwner: false }),
    { address: "owner@swan.co.in", state: "MUTED" }
  );
});

test("a per-thread mute wins over everything else", () => {
  assert.deepEqual(
    deliveryTarget({
      key: handle,
      isOwner: false,
      ownerEmail: null,
      accountAddress: "pm@swan.co.in",
      mutedAt: new Date("2026-10-21T00:00:00Z"),
      emailOwner: true,
    }),
    { address: "pm@swan.co.in", state: "MUTED" }
  );
});

test("an @employee.local notification address is not a mailbox, even if somebody typed one there", () => {
  assert.deepEqual(
    deliveryTarget({
      key: handle,
      isOwner: false,
      ownerEmail: null,
      accountAddress: "40032021@employee.local",
      mutedAt: null,
      emailOwner: true,
    }),
    { address: handle, state: "NO_ADDRESS" }
  );
});
