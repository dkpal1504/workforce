import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import "../styles/supervisors.css";

type Department = { id: number; name: string };
type Section = { id: number; departmentId: number; code: string; name: string };
type HodUser = { id: number; name: string; email: string; employee: { ecNo: string } | null };
type Delegation = {
  id: number; departmentId: number; sectionId: number; fromDate: string; toDate: string;
  reason: string; revokedAt: string | null;
  department: Department; section: Section;
  delegator: HodUser; delegateUser: HodUser;
};

/**
 * HOD approval cover. ADMIN/PM may arrange cover for any Section; an HOD only for
 * its own. The delegate must already be an HOD of that same Section — approval
 * authorization is unchanged, this just records who is standing in, for how long.
 */
export function DelegationsPanel() {
  const { user } = useAuth();
  const isHod = user?.role === "HOD";
  const [departments, setDepartments] = useState<Department[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [rows, setRows] = useState<Delegation[]>([]);
  const [candidates, setCandidates] = useState<HodUser[]>([]);
  const [departmentId, setDepartmentId] = useState("");
  const [sectionId, setSectionId] = useState("");
  const [delegateUserId, setDelegateUserId] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [reason, setReason] = useState("");
  const [coverage, setCoverage] = useState<{ coveringMe: Delegation[]; iAmCovering: Delegation[]; isDeputyToday: boolean } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const [d, s, list, cov] = await Promise.all([
      api<{ departments: Department[] }>("/departments"),
      api<{ sections: Section[] }>("/sections"),
      api<{ delegations: Delegation[] }>("/delegations"),
      api<{ coveringMe: Delegation[]; iAmCovering: Delegation[]; isDeputyToday: boolean }>("/delegations/coverage"),
    ]);
    setDepartments(d.departments);
    setSections(s.sections);
    setRows(list.delegations);
    setCoverage(cov);
  }
  useEffect(() => {
    // An HOD works only in its own Department/Section; ADMIN/PM choose freely.
    if (isHod && user?.departmentId && user?.sectionId) {
      setDepartmentId(String(user.departmentId));
      setSectionId(String(user.sectionId));
    }
    void load().catch((e) => setError(e instanceof Error ? e.message : "Could not load delegations."));
  }, [isHod, user?.departmentId, user?.sectionId]);

  useEffect(() => {
    const department = Number(departmentId), section = Number(sectionId);
    if (!department || !section) { setCandidates([]); return; }
    void api<{ candidates: HodUser[] }>(`/delegations/candidates?departmentId=${department}&sectionId=${section}`)
      .then((r) => setCandidates(r.candidates))
      .catch(() => setCandidates([]));
  }, [departmentId, sectionId]);

  const eligible = sections.filter((section) => String(section.departmentId) === departmentId);

  async function create() {
    setBusy(true); setError(""); setNotice("");
    try {
      await api("/delegations", { method: "POST", body: JSON.stringify({
        departmentId: Number(departmentId), sectionId: Number(sectionId),
        delegateUserId: Number(delegateUserId), fromDate, toDate, reason,
      }) });
      setNotice("Approval cover recorded.");
      setDelegateUserId(""); setFromDate(""); setToDate(""); setReason("");
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : "Could not create the delegation."); }
    finally { setBusy(false); }
  }
  async function revoke(id: number) {
    setBusy(true); setError(""); setNotice("");
    try {
      await api(`/delegations/${id}`, { method: "DELETE" });
      setNotice("Cover revoked."); await load();
    } catch (err) { setError(err instanceof Error ? err.message : "Could not revoke the delegation."); }
    finally { setBusy(false); }
  }

  const today = new Date().toISOString().slice(0, 10);
  const isActive = (d: Delegation) => !d.revokedAt && d.fromDate.slice(0, 10) <= today && d.toDate.slice(0, 10) >= today;

  return <div className="panel" style={{ marginTop: 16 }}>
    <div className="panel__header"><span>HOD Approval Cover (delegation)</span><span className="panel__count">{rows.filter(isActive).length} active</span></div>
    {coverage && (coverage.isDeputyToday || coverage.coveringMe.length > 0) && <div className="alloc-note" style={{ margin: "0 8px 8px" }}>
      {coverage.isDeputyToday && <div><strong>You are acting as deputy HOD</strong> for {coverage.iAmCovering.map((d) => d.section.name).join(", ")} until {coverage.iAmCovering[0]?.toDate.slice(0, 10)}.</div>}
      {coverage.coveringMe.length > 0 && <div>Approval cover today: {coverage.coveringMe.map((d) => `${d.delegateUser.name} (${d.section.name})`).join(", ")}. You retain your own approval rights.</div>}
    </div>}
    <form className="panel__body sup-form" onSubmit={(e) => { e.preventDefault(); void create(); }}>
      <p className="muted" style={{ margin: "0 0 8px" }}>
        {isHod
          ? "Arrange cover for your own Section. The deputy must already be an HOD of that Section; your own approval rights are unchanged."
          : "Arrange approval cover for any Section. The deputy must already be an HOD mapped to that Section."}
      </p>
      <div className="sup-form__grid">
        <div className="sup-field"><label>Department</label><select required disabled={isHod} value={departmentId} onChange={(e) => { setDepartmentId(e.target.value); setSectionId(""); setDelegateUserId(""); }}><option value="">Select Department</option>{departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></div>
        <div className="sup-field"><label>Section</label><select required disabled={isHod} value={sectionId} onChange={(e) => { setSectionId(e.target.value); setDelegateUserId(""); }}><option value="">Select Section</option>{eligible.map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}</select></div>
        <div className="sup-field"><label>Deputy HOD (must already be an HOD of this Section)</label><select required disabled={!sectionId} value={delegateUserId} onChange={(e) => setDelegateUserId(e.target.value)}><option value="">{sectionId ? (candidates.length ? "Select Deputy HOD" : "No other HOD in this Section") : "Select a Section first"}</option>{candidates.map((c) => <option key={c.id} value={c.id}>{c.employee?.ecNo || c.email} · {c.name}</option>)}</select></div>
        <div className="sup-field"><label>From</label><input type="date" required value={fromDate} onChange={(e) => setFromDate(e.target.value)} /></div>
        <div className="sup-field"><label>To</label><input type="date" required value={toDate} onChange={(e) => setToDate(e.target.value)} /></div>
        <div className="sup-field"><label>Reason</label><input required value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. HOD on leave" /></div>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="alloc-note">{notice}</div>}
      <button className="btn btn-primary" disabled={busy || !departmentId || !sectionId || !delegateUserId || !fromDate || !toDate || !reason.trim()}>{busy ? "Saving…" : "Record Approval Cover"}</button>
    </form>
    <table className="sup-table"><thead><tr><th>Section</th><th>Delegating HOD</th><th>Deputy HOD</th><th>Period</th><th>Reason</th><th>Status</th><th>Action</th></tr></thead><tbody>
      {rows.map((d) => <tr key={d.id}>
        <td>{d.department?.name} · {d.section?.name}</td>
        <td>{d.delegator?.name}</td>
        <td>{d.delegateUser?.name}</td>
        <td>{d.fromDate.slice(0, 10)} → {d.toDate.slice(0, 10)}</td>
        <td>{d.reason}</td>
        <td>{d.revokedAt ? "Revoked" : isActive(d) ? "Active" : "Scheduled / expired"}</td>
        <td>{!d.revokedAt && <button className="btn btn-secondary" disabled={busy} onClick={() => void revoke(d.id)}>Revoke</button>}</td>
      </tr>)}
    </tbody></table>
    {!rows.length && <div className="empty-state">No approval cover recorded.</div>}
  </div>;
}
