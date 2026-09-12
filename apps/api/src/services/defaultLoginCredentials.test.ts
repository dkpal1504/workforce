import test from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import {
  DEFAULT_WORKFORCE_PASSWORD,
  hashDefaultWorkforcePassword,
  usesEcNoLogin,
} from "./defaultLoginCredentials";

test("rollout default password is configured exactly", () => {
  assert.equal(DEFAULT_WORKFORCE_PASSWORD, "password@SDHI");
});

test("only linked Employee and Supervisor roles use ecNo login", () => {
  assert.equal(usesEcNoLogin("EMPLOYEE", 10), true);
  assert.equal(usesEcNoLogin("SUPERVISOR", 10), true);
  assert.equal(usesEcNoLogin("SUPERVISOR", null), false);
  assert.equal(usesEcNoLogin("ADMIN", 10), false);
});

test("rollout password hash verifies without changing password case", async () => {
  const hash = await hashDefaultWorkforcePassword(4);
  assert.equal(await bcrypt.compare("password@SDHI", hash), true);
  assert.equal(await bcrypt.compare("PASSWORD@sdhi", hash), false);
});
