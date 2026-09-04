import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { todayDateString } from "../utils/date";

export type Department = { id: number; name: string; code: string };
export type Supervisor = { id: number; name: string; email: string; departmentId: number | null };

export function useWorkContext() {
  const { user } = useAuth();
  const [date, setDate] = useState(todayDateString);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [supervisors, setSupervisors] = useState<Supervisor[]>([]);
  const [departmentId, setDepartmentId] = useState<number | "">("");
  const [supervisorId, setSupervisorId] = useState<number | "">("");

  useEffect(() => {
    api<{ departments: Department[] }>("/departments").then((d) => {
      setDepartments(d.departments);
      const preferred =
        d.departments.find((x) => x.name === "Hull Production") ||
        d.departments.find((x) => x.id === user?.departmentId) ||
        d.departments[0];
      if (preferred) setDepartmentId(preferred.id);
    });
  }, [user?.departmentId]);

  useEffect(() => {
    if (!departmentId) return;
    api<{ supervisors: Supervisor[] }>(`/supervisors?department_id=${departmentId}`).then((d) => {
      setSupervisors(d.supervisors);
      // Only auto-select the logged-in user's OWN supervisor record. Never fall
      // back to a hardcoded name or another supervisor's id — the backend now
      // enforces owner (supervisorId === req.user.id), so sending someone else's
      // id would 403 NOT_OWNER. Non-supervisors (admin/HOD) may pick the first
      // supervisor to view.
      const me = d.supervisors.find((s) => s.id === user?.id);
      const pick = me || (user?.role === "SUPERVISOR" ? null : d.supervisors[0]);
      setSupervisorId(pick ? pick.id : "");
    });
  }, [departmentId, user?.id]);

  const dateInputValue = useMemo(() => date, [date]);

  return {
    date,
    setDate,
    dateInputValue,
    departments,
    departmentId,
    setDepartmentId,
    supervisors,
    supervisorId,
    setSupervisorId,
  };
}

export function FilterBar(props: {
  date: string;
  setDate: (v: string) => void;
  departments: Department[];
  departmentId: number | "";
  setDepartmentId: (v: number | "") => void;
  supervisors: Supervisor[];
  supervisorId: number | "";
  setSupervisorId: (v: number | "") => void;
  /** Replaces Supervisor dropdown for SUPERVISOR role (e.g. bulk-fill controls). */
  bulkFill?: ReactNode;
  trailing?: ReactNode;
}) {
  const { user } = useAuth();
  const isSupervisor = user?.role === "SUPERVISOR";

  return (
    <div className="filter-row">
      <div className="filter-field">
        <label>Date</label>
        <input type="date" value={props.date} onChange={(e) => props.setDate(e.target.value)} />
      </div>
      <div className="filter-field">
        <label>Department</label>
        <select
          value={props.departmentId}
          onChange={(e) => props.setDepartmentId(e.target.value ? Number(e.target.value) : "")}
        >
          {props.departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </div>
      {isSupervisor ? (
        props.bulkFill ?? null
      ) : (
        <div className="filter-field">
          <label>Supervisor</label>
          <select
            value={props.supervisorId}
            onChange={(e) => props.setSupervisorId(e.target.value ? Number(e.target.value) : "")}
          >
            {props.supervisors.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {props.trailing}
    </div>
  );
}
