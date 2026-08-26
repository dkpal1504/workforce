import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { useTheme } from "../theme/ThemeContext";
import { ThemePanel } from "../components/ThemePanel";

export function LoginPage() {
  const { login, user } = useAuth();
  const { openPanel } = useTheme();
  const navigate = useNavigate();
  const [email, setEmail] = useState("r.sharma@company.com");
  const [password, setPassword] = useState("password123");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (user) navigate("/select-team", { replace: true });
  }, [user, navigate]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(email, password);
      navigate("/select-team");
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
          <p className="muted" style={{ marginTop: 14, fontSize: 12 }}>
            Demo: r.sharma@company.com · HOD: hod@company.com · Project Head: pm@company.com / password123
          </p>
        </form>
      </div>
      <ThemePanel />
    </div>
  );
}
