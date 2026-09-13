import test from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import {
  defaultWorkforceCredentialState,
  hashDefaultWorkforcePassword,
  usesEcNoLogin,
} from "./defaultLoginCredentials";

test("new accounts do not use the published legacy rollout password", async () => {
  const hash = await hashDefaultWorkforcePassword(4);
  assert.equal(await bcrypt.compare("password@SDHI", hash), false);
  assert.equal(defaultWorkforceCredentialState.mustChangePassword, true);
});

test("linked operational roles use ecNo login", () => {
  assert.equal(usesEcNoLogin("EMPLOYEE", 10), true);
  assert.equal(usesEcNoLogin("SUPERVISOR", 10), true);
  assert.equal(usesEcNoLogin("HOD", 10), true);
  assert.equal(usesEcNoLogin("PM", 10), true);
  assert.equal(usesEcNoLogin("SUPERVISOR", null), false);
  assert.equal(usesEcNoLogin("ADMIN", 10), false);
});
