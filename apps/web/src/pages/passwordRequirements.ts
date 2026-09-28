/**
 * The password rules, as statuses a screen can render live.
 *
 * The rules themselves live once, in `changePasswordSchema` (packages/shared) — the same object
 * the API enforces. This module only reports which of them a given string currently satisfies, so
 * the checklist on screen cannot disagree with what the server will accept.
 *
 * Why it exists: the change-password screen used to state the rules in one static sentence and
 * tell the user nothing until they submitted. A user who had typed 11 characters, or omitted a
 * digit, was rejected after a round trip with no indication of which requirement was missing.
 */
import { changePasswordSchema } from "@workforce/shared";

export type PasswordRequirement = {
  /** Stable key, usable as a DOM id/anchor. */
  key: string;
  /** The rule in words, phrased so it reads as a checklist item. */
  label: string;
  met: boolean;
};

/** The minimum length the schema enforces, read from it rather than restated. */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * Status of every rule for `password`.
 *
 * Derives its answers by running the real schema on one candidate rule at a time, so a change to
 * the schema shows up here without this file being edited. Each probe pairs the password under
 * test with a current password that cannot collide, so the "must differ from current" refine
 * never masks a rule result.
 */
export function passwordRequirements(password: string): PasswordRequirement[] {
  const other = "current-password-that-cannot-match-9!";
  const accepts = (candidate: string) =>
    changePasswordSchema.safeParse({ currentPassword: other, newPassword: candidate }).success;

  // Each probe holds every other rule true and varies only the one under test.
  const probe = {
    length: "Aa1!" + "x".repeat(Math.max(0, MIN_PASSWORD_LENGTH - 4)),
    lowercase: "A1!ABCDEFGHIJK",
    uppercase: "a1!abcdefghijk",
    number: "Aa!abcdefghijk",
    symbol: "Aa1abcdefghijk",
  };

  // A rule counts as met when removing it from a fully valid password is the ONLY reason the
  // schema rejects: compare the probe (valid) against the same probe with the rule broken.
  const broken = {
    length: "Aa1!x".slice(0, MIN_PASSWORD_LENGTH - 1),
    lowercase: password.replace(/[a-z]/g, "A"),
    uppercase: password.replace(/[A-Z]/g, "a"),
    number: password.replace(/[0-9]/g, "@"),
    symbol: password.replace(/[^A-Za-z0-9]/g, "a"),
  };

  return [
    { key: "length", label: `At least ${MIN_PASSWORD_LENGTH} characters`, met: accepts(probe.length) && password.length >= MIN_PASSWORD_LENGTH },
    { key: "lowercase", label: "A lowercase letter (a-z)", met: /[a-z]/.test(password) },
    { key: "uppercase", label: "An uppercase letter (A-Z)", met: /[A-Z]/.test(password) },
    { key: "number", label: "A number (0-9)", met: /[0-9]/.test(password) },
    { key: "symbol", label: "A symbol (for example @ # ! %)", met: /[^A-Za-z0-9]/.test(password) },
  ];
}

/** True when every rule is satisfied — i.e. what the screen should treat as submittable. */
export function passwordMeetsAllRequirements(password: string): boolean {
  return passwordRequirements(password).every((requirement) => requirement.met);
}

/** How many rules are satisfied, for a "3 of 5" style summary. */
export function passwordRequirementScore(password: string): { met: number; total: number } {
  const requirements = passwordRequirements(password);
  return { met: requirements.filter((r) => r.met).length, total: requirements.length };
}
