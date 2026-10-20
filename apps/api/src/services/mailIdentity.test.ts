import test from "node:test";
import assert from "node:assert/strict";
import { addressOf, fromModeFromEnv, isRoutableAddress, mailIdentity, roleLabel, safeDisplayName } from "./mailIdentity";

/**
 * The From line and the Reply-To. These strings are what a Section Head actually sees in Outlook, so
 * they are asserted here rather than discovered in a mailbox.
 */

const SERVICE = "noreply@swan.co.in";

test("display mode: the person's name on the From line, the robot's address behind it", () => {
  const identity = mailIdentity({
    authorName: "Sunil Babariya",
    authorRole: "PROJECT_MANAGER",
    authorEmail: "sunil.babariya@swan.co.in",
    serviceFrom: SERVICE,
  });
  assert.equal(identity.from, `"Sunil Babariya (Project Manager) - Workforce" <noreply@swan.co.in>`);
  assert.equal(identity.replyTo, "sunil.babariya@swan.co.in");
  assert.equal(identity.appliedMode, "display");
  assert.equal(identity.note, null);
});

test("display mode without a routable address: name still shown, replies fall back to the service mailbox", () => {
  const identity = mailIdentity({
    authorName: "Ramesh Mahalingam",
    authorRole: "HOD",
    authorEmail: "40032321@employee.local",
    serviceFrom: SERVICE,
  });
  assert.equal(identity.from, `"Ramesh Mahalingam (Section HOD) - Workforce" <noreply@swan.co.in>`);
  assert.equal(identity.replyTo, null);
  assert.equal(identity.note?.startsWith("The author has no routable address"), true);
});

test("sender mode uses the person's address, and degrades to display without one", () => {
  const withAddress = mailIdentity({
    authorName: "Sunil Babariya",
    authorRole: "PROJECT_MANAGER",
    authorEmail: "sunil.babariya@swan.co.in",
    serviceFrom: SERVICE,
    mode: "sender",
  });
  assert.equal(withAddress.from, `"Sunil Babariya (Project Manager) - Workforce" <sunil.babariya@swan.co.in>`);
  assert.equal(withAddress.appliedMode, "sender");

  const without = mailIdentity({
    authorName: "Ramesh Mahalingam",
    authorRole: "HOD",
    authorEmail: null,
    serviceFrom: SERVICE,
    mode: "sender",
  });
  assert.equal(without.from, `"Ramesh Mahalingam (Section HOD) - Workforce" <noreply@swan.co.in>`);
  assert.equal(without.appliedMode, "display");
});

test("a name cannot break the header", () => {
  assert.equal(safeDisplayName('Sunil "The Boss" <evil@x.y>'), "Sunil The Boss evil@x.y");
  assert.equal(safeDisplayName("   "), "Workforce");
  assert.equal(safeDisplayName("a\u0000b"), "a b");
});

test("the service mailbox may itself carry a display name", () => {
  assert.equal(addressOf('"Workforce" <noreply@swan.co.in>'), "noreply@swan.co.in");
  assert.equal(addressOf("noreply@swan.co.in"), "noreply@swan.co.in");
  const identity = mailIdentity({
    authorName: "Sunil Babariya",
    authorRole: "PROJECT_MANAGER",
    authorEmail: "sunil.babariya@swan.co.in",
    serviceFrom: '"Workforce" <noreply@swan.co.in>',
  });
  assert.equal(identity.from, '"Sunil Babariya (Project Manager) - Workforce" <noreply@swan.co.in>');
});

test("what counts as routable", () => {
  assert.equal(isRoutableAddress("sunil.babariya@swan.co.in"), true);
  assert.equal(isRoutableAddress("40032021@employee.local"), false);
  assert.equal(isRoutableAddress("noreply@swan.co.in"), false);
  assert.equal(isRoutableAddress("no-reply@swan.co.in"), false);
  assert.equal(isRoutableAddress(""), false);
  assert.equal(isRoutableAddress(null), false);
});

test("role labels read like a job title, and an unknown role is still legible", () => {
  assert.equal(roleLabel("PROJECT_MANAGER"), "Project Manager");
  assert.equal(roleLabel("HOD"), "Section HOD");
  assert.equal(roleLabel("PM"), "Project Head");
  assert.equal(roleLabel("DEPT_HEAD"), "Department Head");
  assert.equal(roleLabel("SOMETHING_NEW"), "something new");
});

test("the mode is display unless the environment says sender", () => {
  assert.equal(fromModeFromEnv(undefined), "display");
  assert.equal(fromModeFromEnv(""), "display");
  assert.equal(fromModeFromEnv("SENDER"), "sender");
  assert.equal(fromModeFromEnv("nonsense"), "display");
});
