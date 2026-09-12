import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";

type Section = { id: number; code: string; name: string; costCenter: { code: string; name: string } | null };

export function SectionSelectionPage() {
  const { user, selectSection, logout } = useAuth();
  const navigate = useNavigate();
  const [sections, setSections] = useState<Section[]>([]);
  const [sectionId, setSectionId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!user?.departmentId) return;
    api<{ sections: Section[] }>(`/sections?department_id=${user.departmentId}`)
      .then((data) => setSections(data.sections))
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load Sections."));
  }, [user?.departmentId]);

  return <div className="login-page">
    <section className="login-page__visual"><p className="login-page__brand">Workforce</p><h1>Select your Section.</h1><p>Your Section must belong to {user?.department?.name || "your Department"}. Cost Center is derived automatically.</p></section>
    <div className="login-page__form-wrap"><form className="login-card" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setError("");
      try { const next = await selectSection(Number(sectionId)); navigate(next.landingPath, { replace: true }); }
      catch (err) { setError(err instanceof Error ? err.message : "Could not save Section."); }
      finally { setBusy(false); }
    }}><div className="login-card__top"><div><h1>Section registration</h1><p className="login-card__lede">This assignment controls your organization and Cost Center.</p></div></div>
      {error && <div className="error-banner">{error}</div>}
      <label htmlFor="section">Section</label><select id="section" required value={sectionId} onChange={(e) => setSectionId(e.target.value)}><option value="">Select Section</option>{sections.map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name}{s.costCenter ? ` (${s.costCenter.code})` : ""}</option>)}</select>
      {!sections.length && <p className="muted">No active Section is available. Ask an administrator to create one.</p>}
      <button className="btn btn-primary" style={{ width: "100%" }} disabled={busy || !sectionId}>{busy ? "Saving…" : "Continue"}</button>
      <button type="button" className="btn btn-ghost" style={{ width: "100%", marginTop: 8 }} onClick={async () => { await logout(); navigate("/login", { replace: true }); }}>Logout</button>
    </form></div>
  </div>;
}
