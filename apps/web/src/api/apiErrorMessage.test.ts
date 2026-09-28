import test from "node:test";
import assert from "node:assert/strict";
import { apiErrorMessage } from "./apiErrorMessage";

/**
 * The shape below is copied from a live 400: the API answers a Zod failure with a flattened
 * error whose messages live in `fieldErrors` and whose `formErrors` is EMPTY, which is why
 * the old extraction fell through to the HTTP reason phrase and the UI showed "Bad Request".
 */
test("a Zod field error is read from fieldErrors, not shown as 'Bad Request'", () => {
  const body = {
    error: { formErrors: [], fieldErrors: { newPassword: ["Password must contain a symbol"] } },
    code: "INVALID_PASSWORD",
  };
  assert.equal(apiErrorMessage(body.error, "Bad Request"), "Password must contain a symbol");
});

test("every rule the password schema enforces produces an actionable sentence", () => {
  const cases: [string, string][] = [
    ["Password must be at least 12 characters", "Password must be at least 12 characters"],
    ["Password must contain an uppercase letter", "Password must contain an uppercase letter"],
    ["Password must contain a number", "Password must contain a number"],
    ["Password must contain a symbol", "Password must contain a symbol"],
    ["New password must be different from the current password", "New password must be different from the current password"],
  ];
  for (const [api, expected] of cases) {
    const body = { error: { formErrors: [], fieldErrors: { newPassword: [api] } } };
    assert.equal(apiErrorMessage(body.error, "Bad Request"), expected, api);
  }
});

test("several field errors plus one form error are all surfaced", () => {
  const body = {
    error: {
      formErrors: ["Something went wrong"],
      fieldErrors: { newPassword: ["Password must contain a number"], currentPassword: ["Required"] },
    },
  };
  const text = apiErrorMessage(body.error, "Bad Request");
  assert.match(text, /Password must contain a number/);
  assert.match(text, /Current password: Required/);
});

test("a plain string error is passed through untouched", () => {
  assert.equal(apiErrorMessage("Current password is incorrect", "Bad Request"), "Current password is incorrect");
});

test("the HTTP reason phrase is only the last resort", () => {
  assert.equal(apiErrorMessage(undefined, "Bad Request"), "Bad Request");
  assert.equal(apiErrorMessage(null), "Request failed");
  assert.equal(apiErrorMessage({}), "Request failed");
  assert.equal(apiErrorMessage({ error: { formErrors: [], fieldErrors: {} } }, "Bad Request"), "Bad Request");
});

test("it never produces '[object Object]'", () => {
  const shapes: unknown[] = [
    { formErrors: [], fieldErrors: { newPassword: [{ nested: "nope" }] } },
    { formErrors: [{}], fieldErrors: undefined },
    { message: "" },
    42,
    [],
  ];
  for (const shape of shapes) {
    const text = apiErrorMessage(shape, "Bad Request");
    assert.ok(text.length > 0, "always a sentence");
    assert.ok(!text.includes("[object"), `no object coercion for ${JSON.stringify(shape)}`);
  }
});
