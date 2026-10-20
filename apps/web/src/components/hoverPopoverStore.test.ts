import test from "node:test";
import assert from "node:assert/strict";
import {
  claimPopover,
  closeAllPopovers,
  currentPopover,
  isPopoverOpen,
  releasePopover,
  resetPopoverStore,
  subscribePopover,
} from "./hoverPopoverStore";

/** The invariant the dashboard depends on: exactly one popover, ever. */

test("claiming a second key closes the first in the same tick", () => {
  resetPopoverStore();
  claimPopover("row-a");
  assert.equal(currentPopover(), "row-a");

  claimPopover("row-b");
  assert.equal(currentPopover(), "row-b");
  assert.equal(isPopoverOpen("row-a"), false);
  assert.equal(isPopoverOpen("row-b"), true);
});

test("every listener is told about the change — that is how the old row hides itself", () => {
  resetPopoverStore();
  const seen: Array<string | null> = [];
  const stopA = subscribePopover((open) => seen.push(open));
  const stopB = subscribePopover((open) => seen.push(open));

  claimPopover("row-a");
  claimPopover("row-b");
  stopA();
  stopB();

  // Both listeners hear both changes, in registration order — which is what makes the displaced row
  // close itself in the same tick the new one opens.
  assert.deepEqual(seen, ["row-a", "row-a", "row-b", "row-b"]);
});

test("claiming the key that is already open notifies nobody", () => {
  resetPopoverStore();
  let calls = 0;
  const stop = subscribePopover(() => {
    calls += 1;
  });
  claimPopover("row-a");
  claimPopover("row-a");
  stop();
  assert.equal(calls, 1);
});

test("a displaced row cannot close the row that replaced it", () => {
  resetPopoverStore();
  claimPopover("row-a");
  claimPopover("row-b");
  releasePopover("row-a"); // the slow grace timer of the row the pointer left
  assert.equal(currentPopover(), "row-b", "row-a's timer must not steal row-b's popover");

  releasePopover("row-b");
  assert.equal(currentPopover(), null);
});

test("closing everything is silent when nothing is open", () => {
  resetPopoverStore();
  let calls = 0;
  const stop = subscribePopover(() => {
    calls += 1;
  });
  closeAllPopovers();
  claimPopover("row-a");
  closeAllPopovers();
  stop();
  assert.equal(calls, 2, "one claim, one close — never a redundant notification");
  assert.equal(currentPopover(), null);
});

test("unsubscribing stops the notifications", () => {
  resetPopoverStore();
  const seen: Array<string | null> = [];
  const stop = subscribePopover((open) => seen.push(open));
  claimPopover("row-a");
  stop();
  claimPopover("row-b");
  assert.deepEqual(seen, ["row-a"]);
});
