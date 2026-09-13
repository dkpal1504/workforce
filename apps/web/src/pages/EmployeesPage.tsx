import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import "../styles/supervisors.css";

type Department = { id: number; name: string };
type Section = { id: number; departmentId: number; code: string; name: string; costCenter: { code: string } | null };
type Hod = { id: number; name: string; email: string; departmentId: number | null; sectionId: number | null; department: Department | null; scopeSection: Section | null; employeeId: number | null };
type HodCandidate = {
  id: number; ecNo: string; name: string; designation: string; departmentId: number;
  department: Department;
  sectionAssignment: { sectionId: number; section: { id: number; name: string; code: string } } | null;
  user: { id: number; role: string; active: boolean } | null;
};
type Employee = {
  id: number; ecNo: string; name: string; designation: string; category: string; mobile: string | null;
  employmentType: string; department: Department; sectionAssignment: { section: Section } | null;
  user: { id: number; role: string; active: boolean } | null;
};

export function EmployeesPage() {
  const { user } = useAuth();
  const isHod = user?.role === "HOD";
  const canTransfer = Boolean(user?.capabilities.transferEmployees);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [hods, setHods] = useState<Hod[]>([]);
  const [departmentId, setDepartmentId] = useState("");
  const [sectionId, setSectionId] = useState("");
  const [ecNo, setEcNo] = useState(""); const [name, setName] = useState("");
  const [designation, setDesignation] = useState(""); const [category, setCategory] = useState("PAYROLL");
  const [mobile, setMobile] = useState(""); const [email, setEmail] = useState("");
  const [search, setSearch] = useState(""); const [error, setError] = useState("");
  const [notice, setNotice] = useState(""); const [busy, setBusy] = useState(false);
  const [transfer, setTransfer] = useState<Employee | null>(null);
  const [targetDepartmentId, setTargetDepartmentId] = useState("");
  const [targetSectionId, setTargetSectionId] = useState("");
  const [transferReason, setTransferReason] = useState("");
  const [hodMapping, setHodMapping] = useState<Hod | null>(null);
  const [hodDepartmentId, setHodDepartmentId] = useState("");
  const [hodSectionId, setHodSectionId] = useState("");
  const [hodCandidates, setHodCandidates] = useState<HodCandidate[]>([]);
  const [newHodId, setNewHodId] = useState("");
  const [newHodDepartmentId, setNewHodDepartmentId] = useState("");
  const [newHodSectionId, setNewHodSectionId] = useState("");
  const [newHodSectionFilter, setNewHodSectionFilter] = useState("");

  async function load() {
    const [d, s, e] = await Promise.all([
      api<{ departments: Department[] }>("/departments"),
      api<{ sections: Section[] }>("/sections"),
      api<{ employees: Employee[] }>("/employees"),
    ]);
    setDepartments(d.departments); setSections(s.sections); setEmployees(e.employees);
    if (canTransfer) {
      const [result, candidates] = await Promise.all([
        api<{ hods: Hod[] }>("/admin/hods"),
        api<{ candidates: HodCandidate[] }>("/admin/hod-candidates"),
      ]);
      setHods(result.hods);
      setHodCandidates(candidates.candidates);
    }
  }
  useEffect(() => { void load().catch((e) => setError(e instanceof Error ? e.message : "Could not load employees.")); }, []);
  useEffect(() => {
    if (!isHod) return;
    setDepartmentId(user?.departmentId ? String(user.departmentId) : "");
    setSectionId(user?.sectionId ? String(user.sectionId) : "");
  }, [isHod, user?.departmentId, user?.sectionId]);

  const eligible = sections.filter((section) => String(section.departmentId) === departmentId);
  const targetSections = sections.filter((section) => String(section.departmentId) === targetDepartmentId);
  const hodSections = sections.filter((section) => String(section.departmentId) === hodDepartmentId);
  const newHodSections = sections.filter((section) => String(section.departmentId) === newHodDepartmentId);
  // Optional Section narrow-down so a PM/Admin can see exactly who occupies one section.
  const newHodCandidates = hodCandidates.filter((candidate) =>
    String(candidate.departmentId) === newHodDepartmentId &&
    (!newHodSectionFilter || String(candidate.sectionAssignment?.sectionId ?? "") === newHodSectionFilter)
  );
  const selectedCandidate = hodCandidates.find((candidate) => String(candidate.id) === newHodId) || null;
  const shown = useMemo(() => employees.filter((employee) =>
    [employee.ecNo, employee.name, employee.department.name, employee.sectionAssignment?.section.name, employee.user?.role]
      .some((value) => value?.toLowerCase().includes(search.toLowerCase()))
  ), [employees, search]);
  const hodMissingScope = isHod && (!user?.departmentId || !user?.sectionId);
  const transferChanged = Boolean(transfer && (String(transfer.department.id) !== targetDepartmentId || String(transfer.sectionAssignment?.section.id ?? "") !== targetSectionId));

  async function registerEmployee(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      await api("/admin/employees", { method: "POST", body: JSON.stringify({ ecNo, name, departmentId: Number(departmentId), sectionId: Number(sectionId), designation, category, mobile: mobile || null, email: email || null }) });
      setEcNo(""); setName(""); setDesignation(""); setMobile(""); setEmail("");
      setNotice("Employee registered."); await load();
    } catch (err) { setError(err instanceof Error ? err.message : "Registration failed."); }
    finally { setBusy(false); }
  }

  function openTransfer(employee: Employee) {
    setTransfer(employee); setTargetDepartmentId(String(employee.department.id));
    setTargetSectionId(String(employee.sectionAssignment?.section.id ?? "")); setTransferReason("");
  }
  async function saveTransfer() {
    if (!transfer || !targetDepartmentId || !targetSectionId) return;
    setBusy(true); setError("");
    try {
      await api(`/admin/employees/${transfer.id}/organisation`, { method: "PUT", body: JSON.stringify({ departmentId: Number(targetDepartmentId), sectionId: Number(targetSectionId), reason: transferReason || "Organisation transfer" }) });
      setNotice(`${transfer.name} transferred successfully.`); setTransfer(null); await load();
    } catch (err) { setError(err instanceof Error ? err.message : "Transfer failed."); }
    finally { setBusy(false); }
  }

  function openHodMapping(hod: Hod) {
    setHodMapping(hod); setHodDepartmentId(String(hod.departmentId ?? "")); setHodSectionId(String(hod.sectionId ?? ""));
  }
  /** Pre-fill the HOD form from an existing payroll employee (from the candidates list). */
  function openHodRegistration(candidate: HodCandidate) {
    setNewHodId(String(candidate.id));
    setNewHodDepartmentId(String(candidate.departmentId));
    setNewHodSectionId(String(candidate.sectionAssignment?.sectionId ?? ""));
  }
  async function registerHod() {
    if (!newHodId || !newHodDepartmentId || !newHodSectionId) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await api<{ created: boolean; user: { name: string } }>("/admin/hods", {
        method: "POST",
        body: JSON.stringify({ employeeId: Number(newHodId), departmentId: Number(newHodDepartmentId), sectionId: Number(newHodSectionId) }),
      });
      setNotice(result.created
        ? `${result.user.name} registered as HOD. A one-time credential was queued for delivery.`
        : `${result.user.name} already had an HOD account — scope updated and a fresh credential queued.`);
      setNewHodId(""); setNewHodDepartmentId(""); setNewHodSectionId("");
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : "HOD registration failed."); }
    finally { setBusy(false); }
  }
  /** From the Active Employees list: pre-fill the HOD registration form with this employee. */
  function startHodFromEmployee(employee: Employee) {
    setNewHodId(String(employee.id));
    setNewHodDepartmentId(String(employee.department.id));
    setNewHodSectionId(String(employee.sectionAssignment?.section.id ?? ""));
    setNotice(`Ready to register ${employee.name} (${employee.ecNo}) as HOD — confirm the Section below.`);
  }
  async function saveHodMapping() {
    if (!hodMapping || !hodDepartmentId || !hodSectionId) return;
    setBusy(true); setError("");
    try {
      await api(`/admin/users/${hodMapping.id}/hod-scope`, { method: "PUT", body: JSON.stringify({ departmentId: Number(hodDepartmentId), sectionId: Number(hodSectionId) }) });
      setNotice(`${hodMapping.name} scope updated.`); setHodMapping(null); await load();
    } catch (err) { setError(err instanceof Error ? err.message : "HOD mapping failed."); }
    finally { setBusy(false); }
  }

  return <>
    <div className="supervisors-toolbar"><p className="muted">Register payroll employees. HOD access is restricted to the assigned Department and Section.</p><input className="search-input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search employees…" /></div>
    {hodMissingScope && <div className="error-banner">Your HOD account has no Department/Section mapping. Ask PM or Admin to assign it.</div>}
    {error && <div className="error-banner">{error}</div>}{notice && <div className="alloc-note">{notice}</div>}
    <div className="panel"><div className="panel__header"><span>Register Payroll Employee</span></div>
      <form className="panel__body sup-form" onSubmit={registerEmployee}>
        <div className="sup-form__grid">
          <div className="sup-field"><label>Canonical ecNo</label><input required value={ecNo} onChange={(e) => setEcNo(e.target.value)} /></div>
          <div className="sup-field"><label>Full name</label><input required value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="sup-field"><label>Department</label><select required disabled={isHod} value={departmentId} onChange={(e) => { setDepartmentId(e.target.value); setSectionId(""); }}><option value="">Select Department</option>{departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select></div>
          <div className="sup-field"><label>Section</label><select required disabled={isHod} value={sectionId} onChange={(e) => setSectionId(e.target.value)}><option value="">Select Section</option>{eligible.map((section) => <option key={section.id} value={section.id}>{section.code} · {section.name}{section.costCenter ? ` (${section.costCenter.code})` : ""}</option>)}</select></div>
          <div className="sup-field"><label>Designation</label><input value={designation} onChange={(e) => setDesignation(e.target.value)} /></div>
          <div className="sup-field"><label>Category</label><input value={category} onChange={(e) => setCategory(e.target.value)} /></div>
          <div className="sup-field"><label>Mobile</label><input value={mobile} onChange={(e) => setMobile(e.target.value)} /></div>
          <div className="sup-field"><label>Login email (optional)</label><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        </div><button className="btn btn-primary" disabled={busy || hodMissingScope}>{busy ? "Saving…" : "Register Employee"}</button>
      </form>
    </div>
    {canTransfer && <div className="panel" style={{ marginTop: 16 }}><div className="panel__header"><span>HOD Registration &amp; Department / Section Mapping</span><span className="panel__count">{hods.length}</span></div>
      <form className="panel__body sup-form" onSubmit={(e) => { e.preventDefault(); void registerHod(); }}>
        <p className="muted" style={{ margin: "0 0 8px" }}>An HOD is an existing payroll Employee promoted to a Department/Section scope — register the Employee first, then create the HOD account here. HOD login uses the employee&apos;s ecNo. A one-time credential is queued; no password is shown or emailed until delivery is configured.</p>
        <div className="sup-form__grid">
          <div className="sup-field"><label>Department</label><select required value={newHodDepartmentId} onChange={(e) => { setNewHodDepartmentId(e.target.value); setNewHodSectionId(""); setNewHodId(""); setNewHodSectionFilter(""); }}><option value="">Select Department</option>{departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select></div>
          <div className="sup-field"><label>Filter by Section (optional)</label><select disabled={!newHodDepartmentId} value={newHodSectionFilter} onChange={(e) => { setNewHodSectionFilter(e.target.value); setNewHodId(""); }}><option value="">All sections</option>{newHodSections.map((section) => <option key={section.id} value={section.id}>{section.code} · {section.name}</option>)}</select></div>
          <div className="sup-field"><label>Employee (payroll in this Department)</label><select required disabled={!newHodDepartmentId} value={newHodId} onChange={(e) => { const c = newHodCandidates.find((x) => String(x.id) === e.target.value); if (c) openHodRegistration(c); else setNewHodId(e.target.value); }}><option value="">{newHodDepartmentId ? (newHodCandidates.length ? "Select Employee" : "No eligible payroll employee matches this Department/Section") : "Select a Department first"}</option>{newHodCandidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.ecNo} · {candidate.name}{candidate.sectionAssignment ? ` · ${candidate.sectionAssignment.section.name}` : ""}{candidate.user ? ` (${candidate.user.role})` : ""}</option>)}</select></div>
          <div className="sup-field"><label>Section (HOD scope)</label><select required disabled={!newHodDepartmentId} value={newHodSectionId} onChange={(e) => setNewHodSectionId(e.target.value)}><option value="">{newHodDepartmentId ? "Select Section" : "Select a Department first"}</option>{newHodSections.map((section) => <option key={section.id} value={section.id}>{section.code} · {section.name}</option>)}</select></div>
        </div>
        {selectedCandidate && <p className="muted" style={{ margin: "0 0 8px" }}>{selectedCandidate.ecNo} · {selectedCandidate.name} · {selectedCandidate.department.name}{selectedCandidate.sectionAssignment ? ` · currently ${selectedCandidate.sectionAssignment.section.name}` : " · no Section assigned"}{selectedCandidate.user?.role === "EMPLOYEE" ? " · will be promoted from Employee to HOD" : selectedCandidate.user?.role === "HOD" ? " · already an HOD (scope will be updated)" : ""}</p>}
        <button className="btn btn-primary" disabled={busy || !newHodId || !newHodDepartmentId || !newHodSectionId}>{busy ? "Saving…" : "Register HOD"}</button>
      </form>
      <table className="sup-table"><thead><tr><th>HOD</th><th>ecNo</th><th>Department</th><th>Section</th><th>Action</th></tr></thead><tbody>{hods.map((hod) => <tr key={hod.id}><td>{hod.name}</td><td>{employees.find((employee) => employee.user?.id === hod.id)?.ecNo || "—"}</td><td>{hod.department?.name || "Not mapped"}</td><td>{hod.scopeSection?.name || "Not mapped"}</td><td><button className="btn btn-secondary" onClick={() => openHodMapping(hod)}>Map scope</button></td></tr>)}</tbody></table>
      <p className="muted" style={{ margin: "0 8px 8px" }}>Credential e-mail is off in this environment (CREDENTIAL_DELIVERY_ENABLED=false), so a newly registered HOD cannot log in until a password is set locally: <code>node apps/api/set-dev-password.cjs &lt;ecNo&gt;</code>.</p>
      {!hods.length && <div className="empty-state">No HOD accounts yet. Register one above.</div>}
    </div>}
    <div className="panel" style={{ marginTop: 16 }}><div className="panel__header"><span>Active Employees</span><span className="panel__count">{shown.length}</span></div>
      {shown.length ? <table className="sup-table"><thead><tr><th>ecNo</th><th>Name</th><th>Type / Role</th><th>Department</th><th>Section</th><th>Designation</th>{canTransfer && <th>Action</th>}</tr></thead><tbody>
        {shown.map((employee) => <tr key={employee.id}><td><strong>{employee.ecNo}</strong></td><td>{employee.name}</td><td>{employee.user?.role === "SUPERVISOR" ? "Supervisor" : employee.user?.role === "HOD" ? "HOD" : employee.employmentType}</td><td>{employee.department.name}</td><td>{employee.sectionAssignment?.section.name || "Not assigned"}</td><td>{employee.designation || "—"}</td>{canTransfer && <td><button className="btn btn-secondary" onClick={() => openTransfer(employee)}>Transfer</button>{employee.employmentType === "PAYROLL" && <button className="btn btn-secondary" style={{ marginLeft: 6 }} onClick={() => startHodFromEmployee(employee)}>{employee.user?.role === "HOD" ? "Change HOD scope" : "Set as HOD"}</button>}</td>}</tr>)}
      </tbody></table> : <div className="empty-state">No employees found.</div>}
    </div>
    {hodMapping && <div className="modal-backdrop" onClick={() => setHodMapping(null)}><div className="modal" onClick={(e) => e.stopPropagation()}>
      <h3>Map HOD scope: {hodMapping.name}</h3><div className="sup-form__grid">
      <div className="sup-field"><label>Department</label><select value={hodDepartmentId} onChange={(e) => { setHodDepartmentId(e.target.value); setHodSectionId(""); }}><option value="">Select Department</option>{departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select></div>
      <div className="sup-field"><label>Section</label><select value={hodSectionId} onChange={(e) => setHodSectionId(e.target.value)}><option value="">Select Section</option>{hodSections.map((section) => <option key={section.id} value={section.id}>{section.code} · {section.name}</option>)}</select></div></div>
      <div className="modal-actions"><button className="btn btn-ghost" onClick={() => setHodMapping(null)}>Cancel</button><button className="btn btn-primary" disabled={busy || !hodDepartmentId || !hodSectionId} onClick={() => void saveHodMapping()}>Save Mapping</button></div>
    </div></div>}
    {transfer && <div className="modal-backdrop" onClick={() => setTransfer(null)}><div className="modal" onClick={(e) => e.stopPropagation()}>
      <h3>Transfer {transfer.name}</h3><p className="muted">{transfer.ecNo} · {transfer.user?.role === "SUPERVISOR" ? "Supervisor" : transfer.employmentType}</p>
      <div className="sup-form__grid"><div className="sup-field"><label>Target Department</label><select value={targetDepartmentId} onChange={(e) => { setTargetDepartmentId(e.target.value); setTargetSectionId(""); }}><option value="">Select Department</option>{departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select></div>
      <div className="sup-field"><label>Target Section</label><select value={targetSectionId} onChange={(e) => setTargetSectionId(e.target.value)}><option value="">Select Section</option>{targetSections.map((section) => <option key={section.id} value={section.id}>{section.code} · {section.name}</option>)}</select></div>
      <div className="sup-field"><label>Reason</label><input value={transferReason} onChange={(e) => setTransferReason(e.target.value)} placeholder="Organisation transfer" /></div></div>
      <div className="modal-actions"><button className="btn btn-ghost" onClick={() => setTransfer(null)}>Cancel</button><button className="btn btn-primary" disabled={busy || !targetDepartmentId || !targetSectionId || !transferChanged} onClick={() => void saveTransfer()}>Confirm Transfer</button></div>
    </div></div>}
  </>;
}
