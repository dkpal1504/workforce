import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

export function ChangePasswordPage() {
  const { user, changePassword, logout } = useAuth();
  const forced = Boolean(user?.mustChangePassword);
  const navigate = useNavigate();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    if (newPassword !== confirmPassword) {
      setError("New passwords do not match.");
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
          <div className="login-card__top"><div><h1>Change password</h1><p className="login-card__lede">Use at least 12 characters with uppercase, lowercase, a number, and a symbol.{forced ? "" : " Leave this page if you would rather keep the password you were given."}</p></div></div>
          {error && <div className="error-banner">{error}</div>}
          <label htmlFor="current-password">Temporary/current password</label>
          <input id="current-password" type="password" autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required />
          <label htmlFor="new-password">New password</label>
          <input id="new-password" type="password" autoComplete="new-password" minLength={12} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required />
          <label htmlFor="confirm-password">Confirm new password</label>
          <input id="confirm-password" type="password" autoComplete="new-password" minLength={12} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required />
          <button className="btn btn-primary" style={{ width: "100%" }} disabled={loading}>{loading ? "Changing…" : "Change password"}</button>
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
