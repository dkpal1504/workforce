import test from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import {
  assertBootstrapPasswordUsable,
  bootstrapPassword,
  bootstrapPasswordNotice,
  defaultWorkforceCredentialState,
  hashDefaultWorkforcePassword,
  initialCredentialState,
  usesBootstrapPassword,
  usesEcNoLogin,
} from "./defaultLoginCredentials";

/** Run `body` with BOOTSTRAP_PASSWORD pinned, restoring whatever was there before. */
async function withBootstrapPassword<T>(value: string | null, body: () => Promise<T>): Promise<T> {
  const previous = process.env.BOOTSTRAP_PASSWORD;
  if (value === null) delete process.env.BOOTSTRAP_PASSWORD;
  else process.env.BOOTSTRAP_PASSWORD = value;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.BOOTSTRAP_PASSWORD;
    else process.env.BOOTSTRAP_PASSWORD = previous;
  }
}

test("queued accounts never get an unknown password they are not told about", async () => {
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

test("no BOOTSTRAP_PASSWORD means a random credential that must be changed", async () => {
  await withBootstrapPassword(null, async () => {
    assert.equal(bootstrapPassword(), null);
    assert.equal(usesBootstrapPassword(), false);
    assert.equal(bootstrapPasswordNotice(), null);
    const credential = await initialCredentialState();
    assert.equal(credential.mustChangePassword, true, "the e-mailed credential is temporary");
    assert.equal(await bcrypt.compare("password@SDHI", credential.passwordHash), false);
  });
});

test("BOOTSTRAP_PASSWORD gives every new contract account the shared first password", async () => {
  await withBootstrapPassword("password@SDHI", async () => {
    assert.equal(usesBootstrapPassword(), true);
    const credential = await initialCredentialState();
    assert.equal(
      await bcrypt.compare("password@SDHI", credential.passwordHash),
      true,
      "supervisors and employees log in with the shared first password"
    );
    assert.equal(
      credential.mustChangePassword,
      true,
      "and the API forces a change at first login"
    );
    assert.match(String(bootstrapPasswordNotice()), /MUST change it at their first login/);
  });
});

test("the value is read from the environment on every call, not captured at import", async () => {
  await withBootstrapPassword(null, async () => {
    assert.equal(usesBootstrapPassword(), false);
    await withBootstrapPassword("AnotherFirstPassword1", async () => {
      assert.equal(usesBootstrapPassword(), true);
      assert.equal(bootstrapPassword(), "AnotherFirstPassword1");
    });
    assert.equal(usesBootstrapPassword(), false);
  });
});

test("a shared first password shorter than 8 characters is refused at boot", async () => {
  await withBootstrapPassword("short", async () => {
    assert.throws(() => assertBootstrapPasswordUsable(), /at least 8 characters/);
  });
  await withBootstrapPassword("          ", async () => {
    // Whitespace means "not configured", never an empty password for everyone.
    assert.equal(bootstrapPassword(), null);
    assert.doesNotThrow(() => assertBootstrapPasswordUsable());
  });
});
