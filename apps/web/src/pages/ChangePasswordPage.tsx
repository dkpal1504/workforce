import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { changePasswordSchema } from "@workforce/shared";
import { apiErrorMessage } from "../api/apiErrorMessage";
import { useAuth } from "../auth/AuthContext";
import { MIN_PASSWORD_LENGTH, passwordRequirementScore, passwordRequirements } from "./passwordRequirements";

export function ChangePasswordPage() {
  const { user, changePassword, logout } = useAuth();
  const forced = Boolean(user?.mustChangePassword);
  const navigate = useNavigate();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  // Live status of every rule, so the user can see what is still missing while typing instead of
  // discovering it after a rejected round trip.
  const requirements = passwordRequirements(newPassword);
  const score = passwordRequirementScore(newPassword);
  const rulesSatisfied = score.met === score.total;
  const matches = confirmPassword.length > 0 && confirmPassword === newPassword;
  const readyToSubmit = rulesSatisfied && matches;
  // The button names the NEXT thing the user has to do, not merely a count: "0 rules left" was
  // technically true while the real blocker was the untouched confirm field.
  const buttonHint = !rulesSatisfied
    ? `Change password (${score.total - score.met} rule${score.total - score.met === 1 ? "" : "s"} left)`
    : "Confirm the new password to continue";

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    if (newPassword !== confirmPassword) {
      setError("New passwords do not match.");
      return;
    }
    // Validate against the API's OWN schema (packages/shared), not a copy of it, so the rules
    // can never drift: a user is told which rule they missed before any round trip.
    const parsed = changePasswordSchema.safeParse({ currentPassword, newPassword });
    if (!parsed.success) {
      setError(apiErrorMessage(parsed.error.flatten(), "Check your new password."));
      return;
    }
    setLoading(true);
    try {
      const user = await changePassword(currentPassword, newPassword);
      navigate(user.landingPath, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Password change failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-page">
      <section className="login-page__visual">
        <p className="login-page__brand">Workforce</p>
        <h1>{forced ? "Secure your account." : "Change your password."}</h1>
        <p>
          {forced
            ? "Your temporary password must be replaced before you can use Workforce."
            : "Your account started on a shared password. Replacing it now is optional but recommended."}
        </p>
      </section>
      <div className="login-page__form-wrap">
        <form className="login-card" onSubmit={submit}>
          <div className="login-card__top"><div><h1>Change password</h1><p className="login-card__lede">Your new password must meet all {score.total} requirements below. It is {MIN_PASSWORD_LENGTH} characters or more.{forced ? "" : " You may leave this page if you would rather keep the password you were given."}</p></div></div>
          {error && <div className="error-banner">{error}</div>}
          <label htmlFor="current-password">Temporary/current password</label>
          <input id="current-password" type="password" autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required />
          <label htmlFor="new-password">New password</label>
          <input
            id="new-password"
            type="password"
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LENGTH}
            aria-describedby="password-requirements password-length"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
          />
          {/* Live checklist: each rule flips to met as it is satisfied, so the user always knows
              what is left. Derived from the API's own schema, so this cannot promise something
              the server will reject. */}
          <ul id="password-requirements" className="password-rules">
            {requirements.map((requirement) => (
              <li key={requirement.key} id={`password-rule-${requirement.key}`} className={requirement.met ? "password-rules__item is-met" : "password-rules__item"}>
                <span className="password-rules__mark" aria-hidden="true">{requirement.met ? "✓" : "○"}</span>
                <span>{requirement.label}</span>
                <span className="password-rules__state">{requirement.met ? "met" : "not yet"}</span>
              </li>
            ))}
          </ul>
          <p id="password-length" className="password-rules__count">
            {newPassword.length} characters — minimum {MIN_PASSWORD_LENGTH}. {score.met} of {score.total} requirements met.
          </p>
          <label htmlFor="confirm-password">Confirm new password</label>
          <input id="confirm-password" type="password" autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required />
          {confirmPassword.length > 0 && confirmPassword !== newPassword && (
            <p className="password-rules__count password-rules__count--warn">The two passwords do not match yet.</p>
          )}
          <button className="btn btn-primary" style={{ width: "100%" }} disabled={loading || !readyToSubmit}>
            {loading ? "Changing…" : readyToSubmit ? "Change password" : buttonHint}
          </button>
          {!forced && (
            <button type="button" className="btn btn-secondary" style={{ width: "100%", marginTop: 8 }} onClick={() => navigate(user?.landingPath ?? "/", { replace: true })}>
              Keep my current password
            </button>
          )}
          <button type="button" className="btn btn-ghost" style={{ width: "100%", marginTop: 8 }} onClick={async () => { await logout(); navigate("/login", { replace: true }); }}>Logout</button>
        </form>
      </div>
    </div>
  );
}
