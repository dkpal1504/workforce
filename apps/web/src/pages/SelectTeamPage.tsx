import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { FilterBar, useWorkContext } from "../hooks/useWorkContext";
import "../styles/selectTeam.css";

type Section = { id: number; code: string; name: string; departmentId: number };
type Employee = { id: number; name: string; ecNo: string; sectionAssignment?: { section: Section } | null };

export function SelectTeamPage() {
  const navigate = useNavigate();
  const ctx = useWorkContext();
  const [pool, setPool] = useState<Employee[]>([]);
  const [team, setTeam] = useState<Employee[]>([]);
  const teamRef = useRef<Employee[]>([]);
  const loadedTeamContext = useRef("");
  const [carriedOver, setCarriedOver] = useState(false);
  const [poolSelected, setPoolSelected] = useState<Set<number>>(new Set());
  const [teamSelected, setTeamSelected] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!ctx.departmentId || !ctx.supervisorId || !ctx.sectionId) return;
    setLoading(true);
    setError("");
    try {
      const contextKey = `${ctx.supervisorId}|${ctx.date}`;
      if (loadedTeamContext.current !== contextKey) {
        const today = await api<{
          team: { employeeId: number; employee: Employee }[];
          carriedOver: boolean;
        }>(`/teams/today?supervisor_id=${ctx.supervisorId}&date=${ctx.date}`);
        teamRef.current = today.team.map((item) => item.employee);
        setTeam(teamRef.current);
        setCarriedOver(today.carriedOver);
        loadedTeamContext.current = contextKey;
      }

      const poolRes = await api<{ employees: Employee[] }>(
        `/teams/pool?department_id=${ctx.departmentId}&section_id=${ctx.sectionId}&date=${ctx.date}&supervisor_id=${ctx.supervisorId}`
      );
      const selectedIds = new Set(teamRef.current.map((employee) => employee.id));
      setPool(poolRes.employees.filter((employee) => !selectedIds.has(employee.id)));
      setPoolSelected(new Set());
      setTeamSelected(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load team");
    } finally {
      setLoading(false);
    }
  }, [ctx.departmentId, ctx.supervisorId, ctx.date, ctx.sectionId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => { teamRef.current = team; }, [team]);

  const filteredPool = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return pool;
    return pool.filter((e) => e.name.toLowerCase().includes(q) || e.ecNo.toLowerCase().includes(q));
  }, [pool, search]);

  function togglePool(id: number) {
    setPoolSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function addToTeam() {
    const moving = pool.filter((e) => poolSelected.has(e.id));
    if (!moving.length) return;
    setTeam((t) => [...t, ...moving]);
    setPool((p) => p.filter((e) => !poolSelected.has(e.id)));
    setPoolSelected(new Set());
    setCarriedOver(false);
  }

  function removeFromTeam() {
    const moving = team.filter((e) => teamSelected.has(e.id));
    if (!moving.length) return;
    setPool((p) => [...p, ...moving.filter((employee) => employee.sectionAssignment?.section.id === ctx.sectionId)].sort((a, b) => a.name.localeCompare(b.name)));
    setTeam((t) => t.filter((e) => !teamSelected.has(e.id)));
    setTeamSelected(new Set());
    setCarriedOver(false);
  }

  /** Select All — check every employee currently visible in the Department Pool. */
  function selectAllPool() {
    setPoolSelected(new Set(filteredPool.map((e) => e.id)));
  }

  /** Deselect All — move everyone from Today's Team back to the Department Pool. */
  function deselectAllTeam() {
    if (!team.length) return;
    setPool((p) => [...p, ...team.filter((employee) => employee.sectionAssignment?.section.id === ctx.sectionId)].sort((a, b) => a.name.localeCompare(b.name)));
    setTeam([]);
    setTeamSelected(new Set());
    setCarriedOver(false);
  }

  function removeChip(id: number) {
    const emp = team.find((e) => e.id === id);
    if (!emp) return;
    setTeam((t) => t.filter((e) => e.id !== id));
    if (emp.sectionAssignment?.section.id === ctx.sectionId) setPool((p) => [...p, emp].sort((a, b) => a.name.localeCompare(b.name)));
    setCarriedOver(false);
  }

  async function confirm() {
    if (!ctx.departmentId || !ctx.supervisorId) return;
    setError("");
    try {
      await api("/teams/today", {
        method: "POST",
        body: JSON.stringify({
          supervisorId: ctx.supervisorId,
          departmentId: ctx.departmentId,
          workDate: ctx.date,
          employeeIds: team.map((e) => e.id),
        }),
      });
      navigate(`/timesheet?date=${ctx.date}&departmentId=${ctx.departmentId}&supervisorId=${ctx.supervisorId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save team");
    }
  }

  return (
    <>
      <FilterBar
        {...ctx}
        trailing={
          <div className="filter-field">
            <label htmlFor="pool-search">Search</label>
            <input
              id="pool-search"
              className="search-input"
              placeholder="Search by name or ecNo…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        }
      />
      {error && <div className="error-banner">{error}</div>}
      {loading && <p className="muted">Loading…</p>}

      <div className="transfer">
        <section className="panel">
          <div className="panel__header">
            <span>Department Pool</span>
            <span className="panel__count">Available: {filteredPool.length}</span>
          </div>
          <div className="panel__body">
            <ul className="pool-list">
              {filteredPool.map((e) => (
                <li key={e.id}>
                  <input
                    type="checkbox"
                    checked={poolSelected.has(e.id)}
                    onChange={() => togglePool(e.id)}
                    id={`pool-${e.id}`}
                  />
                  <label htmlFor={`pool-${e.id}`}>{e.name} · {e.sectionAssignment?.section.name ?? "No Section"}</label>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <div className="transfer__controls">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={selectAllPool}
            disabled={!filteredPool.length}
            title="Select all employees in the Department Pool"
          >
            Select All
          </button>
          <button className="btn btn-primary" onClick={addToTeam} disabled={!poolSelected.size}>
            Add →
          </button>
          <button className="btn btn-secondary" onClick={removeFromTeam} disabled={!teamSelected.size}>
            ← Remove
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={deselectAllTeam}
            disabled={!team.length}
            title="Clear all employees from Today's Team"
          >
            Deselect All
          </button>
        </div>

        <section className="panel">
          <div className="panel__header">
            <span>Today&apos;s Team</span>
            <span className="panel__count">Selected: {team.length}</span>
          </div>
          <div className="panel__body">
            {carriedOver && (
              <div className="carry-banner">Defaulted from yesterday — edit as needed.</div>
            )}
            <div className="team-chips">
              {team.map((e) => (
                <span
                  key={e.id}
                  className="chip"
                  onClick={() =>
                    setTeamSelected((prev) => {
                      const next = new Set(prev);
                      if (next.has(e.id)) next.delete(e.id);
                      else next.add(e.id);
                      return next;
                    })
                  }
                  style={
                    teamSelected.has(e.id)
                      ? { outline: "2px solid var(--primary)", background: "var(--primary-soft)" }
                      : undefined
                  }
                >
                  {e.name}
                  <button type="button" aria-label={`Remove ${e.name}`} onClick={() => removeChip(e.id)}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          </div>
        </section>
      </div>

      <div className="footer-actions">
        <button className="btn btn-ghost" onClick={() => { loadedTeamContext.current = ""; void load(); }}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={confirm}>
          Confirm Team &amp; Go to Timesheet →
        </button>
      </div>
    </>
  );
}
