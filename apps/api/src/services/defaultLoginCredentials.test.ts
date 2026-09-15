import test from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import {
  DEV_BOOTSTRAP_PASSWORD,
  assertDevBootstrapAllowed,
  defaultWorkforceCredentialState,
  hashDefaultWorkforcePassword,
  initialCredentialState,
  usesDevBootstrapPassword,
  usesEcNoLogin,
} from "./defaultLoginCredentials";

/** Run `body` with DATABASE_URL pinned, restoring whatever was there before. */
async function withDatabaseUrl<T>(url: string, body: () => Promise<T>): Promise<T> {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = url;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
}

test("queued accounts do not use the published legacy rollout password", async () => {
  const hash = await hashDefaultWorkforcePassword(4);
  assert.equal(await bcrypt.compare("password@SDHI", hash), false);
  assert.equal(defaultWorkforceCredentialState.mustChangePassword, true);
});

test("linked operational roles use ecNo login", () => {
  assert.equal(usesEcNoLogin("EMPLOYEE", 10), true);
  assert.equal(usesEcNoLogin("SUPERVISOR", 10), true);
  assert.equal(usesEcNoLogin("HOD", 10), true);
  assert.equal(usesEcNoLogin("PM", 10), true);
  assert.equal(usesEcNoLogin("DEPT_HEAD", 10), true);
  assert.equal(usesEcNoLogin("SUPERVISOR", null), false);
  assert.equal(usesEcNoLogin("ADMIN", 10), false);
});

// Both credential policies below must satisfy the same invariant: a new account is
// either handed the local dev bootstrap password with no forced change, or an
// unknown password that must be changed when the one-time credential arrives.
// The assertions hold whether or not DEV_BOOTSTRAP_PASSWORD is still set, so this
// suite stays green before AND after the removal step.
test("a registration credential is either the dev bootstrap password or an undelivered one", async () => {
  await withDatabaseUrl("file:./dev.db", async () => {
    const credential = await initialCredentialState();
    if (usesDevBootstrapPassword()) {
      assert.equal(await bcrypt.compare(String(DEV_BOOTSTRAP_PASSWORD), credential.passwordHash), true);
      assert.equal(credential.mustChangePassword, false);
    } else {
      assert.equal(defaultWorkforceCredentialState.mustChangePassword, true);
      assert.equal(credential.mustChangePassword, true);
      assert.equal(await bcrypt.compare("password@SDHI", credential.passwordHash), false);
    }
  });
});

test("the bootstrap password is refused against PostgreSQL, whatever NODE_ENV claims", async () => {
  await withDatabaseUrl("postgresql://user:pass@localhost:5432/workforce", async () => {
    if (usesDevBootstrapPassword()) {
      assert.throws(() => assertDevBootstrapAllowed(), /bootstrap password is enabled/);
      await assert.rejects(initialCredentialState(), /bootstrap password is enabled/);
    } else {
      // Removed: PostgreSQL is the expected production target, so nothing throws.
      assert.doesNotThrow(() => assertDevBootstrapAllowed());
      const credential = await initialCredentialState();
      assert.equal(credential.mustChangePassword, true);
    }
  });
});
