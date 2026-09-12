import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { useTheme } from "../theme/ThemeContext";
import { ThemePanel } from "../components/ThemePanel";

export function LoginPage() {
  const { login, user } = useAuth();
  const { openPanel } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!user) return;
    const requested = (location.state as { from?: { pathname?: string } } | null)?.from?.pathname;
    navigate(user.mustChangePassword ? "/change-password" : requested || user.landingPath, { replace: true });
  }, [user, navigate, location.state]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const loggedIn = await login(email, password);
      if (loggedIn.mustChangePassword) {
        navigate("/change-password", { replace: true });
      } else {
        const requested = (location.state as { from?: { pathname?: string } } | null)?.from?.pathname;
        navigate(requested && requested !== "/login" ? requested : loggedIn.landingPath, { replace: true });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-page">
      <section className="login-page__visual">
        <p className="login-page__brand">Workforce</p>
        <h1>Manpower & timesheet, refined for the yard floor.</h1>
        <p>
          Select teams, tag hours across projects, and move approvals with a clear daily rhythm — built for supervisors,
          HODs, and finance in one place.
        </p>
      </section>
      <div className="login-page__form-wrap">
        <form className="login-card" onSubmit={onSubmit}>
          <div className="login-card__top">
            <div>
              <h1>Sign in</h1>
              <p className="login-card__lede">Welcome back. Pick a theme anytime from the panel.</p>
            </div>
            <button type="button" className="btn btn-ghost" onClick={openPanel}>
              Themes
            </button>
          </div>
          {error && <div className="error-banner">{error}</div>}
          <label htmlFor="email">Email</label>
          <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <button className="btn btn-primary" style={{ width: "100%" }} disabled={loading}>
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
      <ThemePanel />
    </div>
  );
}
