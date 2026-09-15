import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { todayDateString } from "../utils/date";

export type Department = { id: number; name: string; code: string };
export type Section = { id: number; code: string; name: string; departmentId: number };
export type Supervisor = { id: number; name: string; email: string; departmentId: number | null };

export function useWorkContext() {
  const { user } = useAuth();
  const [date, setDate] = useState(todayDateString);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [supervisors, setSupervisors] = useState<Supervisor[]>([]);
  const [departmentId, setDepartmentId] = useState<number | "">("");
  const [sectionId, setSectionId] = useState<number | "">("");
  const [sections, setSections] = useState<Section[]>([]);
  const [supervisorId, setSupervisorId] = useState<number | "">("");

  useEffect(() => {
    api<{ departments: Department[] }>("/departments").then((d) => {
      const available = user?.role === "SUPERVISOR" && user.departmentId
        ? d.departments.filter((department) => department.id === user.departmentId)
        : d.departments;
      setDepartments(available);
      // The authenticated Employee Department is authoritative. Do not fall
      // back to a legacy Department with a familiar display name.
      const preferred =
        available.find((department) => department.id === user?.departmentId) ||
        available[0];
      setDepartmentId(preferred?.id ?? "");
    });
  }, [user?.departmentId, user?.role]);

  useEffect(() => {
    if (!departmentId) return;

    // Department selects the employee pool. A Supervisor is fixed to the
    // Department of their linked canonical Employee.
    if (user?.role === "SUPERVISOR" && user.id) {
      setSupervisorId(user.id);
      setSupervisors([]);
      return;
    }

    api<{ supervisors: Supervisor[] }>(`/supervisors?department_id=${departmentId}`).then((d) => {
      setSupervisors(d.supervisors);
      // Non-supervisors (admin/HOD) may pick the first supervisor to view.
      const me = d.supervisors.find((s) => s.id === user?.id);
      const pick = me || d.supervisors[0];
      setSupervisorId(pick ? pick.id : "");
    });
  }, [departmentId, user?.id, user?.role]);

  useEffect(() => {
    if (!departmentId) { setSections([]); return; }
    let cancelled = false;
    api<{ sections: Section[] }>(`/sections?department_id=${departmentId}`)
      .then(({ sections: list }) => {
        if (cancelled) return;
        setSections(list);
        // Default to the Section this person is mapped to (supervisors are mapped
        // to one), otherwise the first Section of the Department.
        const mapped = user?.section?.id;
        setSectionId((current) => {
          if (current && list.some((section) => section.id === current)) return current;
          if (mapped && list.some((section) => section.id === mapped)) return mapped;
          return list[0]?.id ?? "";
        });
      })
      .catch(() => { if (!cancelled) setSections([]); });
    return () => { cancelled = true; };
  }, [departmentId, user?.section?.id]);

  const dateInputValue = useMemo(() => date, [date]);

  return {
    date,
    setDate,
    dateInputValue,
    departments,
    departmentId,
    setDepartmentId,
    sections,
    sectionId,
    setSectionId,
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
  /** Sections of the selected Department — the capture/working scope. */
  sections?: Section[];
  sectionId?: number | "";
  setSectionId?: (v: number | "") => void;
  supervisors: Supervisor[];
  supervisorId: number | "";
  setSupervisorId: (v: number | "") => void;
  /** Replaces Supervisor dropdown for SUPERVISOR role (e.g. bulk-fill controls). */
  bulkFill?: ReactNode;
  departmentLabel?: string;
  trailing?: ReactNode;
}) {
  const { user } = useAuth();
  const isSupervisor = user?.role === "SUPERVISOR";
  const sectionEditable = props.setSectionId != null && (props.sections?.length ?? 0) > 0;

  return (
    <div className="filter-row">
      <div className="filter-field">
        <label>Date</label>
        <input type="date" value={props.date} onChange={(e) => props.setDate(e.target.value)} />
      </div>
      <div className="filter-field">
        <label htmlFor="work-department">Department</label>
        <select
          id="work-department"
          value={props.departmentId}
          disabled={isSupervisor}
          onChange={(e) => props.setDepartmentId(e.target.value ? Number(e.target.value) : "")}
        >
          {props.departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </div>
      {sectionEditable && (
        <div className="filter-field">
          <label htmlFor="work-section">Section</label>
          <select
            id="work-section"
            aria-label="Section"
            value={props.sectionId ?? ""}
            onChange={(e) => props.setSectionId!(e.target.value ? Number(e.target.value) : "")}
          >
            {props.sections!.map((section) => (
              <option key={section.id} value={section.id}>
                {section.code} · {section.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {isSupervisor ? (
        props.bulkFill ?? null
      ) : (
        <div className="filter-field">
          <label htmlFor="work-supervisor">{props.departmentLabel ?? "Department"}</label>
          <select
            id="work-supervisor"
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
