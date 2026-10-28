/**
 * The three filters at the top of the approvals screen: Department, Supervisor, Project.
 *
 * WHY THIS IS A MODULE AND NOT THREE EXPRESSIONS IN THE PAGE: the queue has four different row shapes (a
 * supervisor's timesheet group, a planning-returned day, a job-order consumption row, and a payroll My Hours
 * day), and each carries its people and its projects differently — a department NAME, a supervisor ID, hours
 * keyed by project colour key, a list of allocations. Written inline, the same filter is written four times
 * and drifts the first time a shape changes; here each row is reduced to one small `FilterSubject` and the
 * matching happens once.
 *
 * THE RULE THAT MUST NOT BEND: a filter only ever NARROWS what the reader may already see. Nothing here adds
 * rows, and nothing here asks the server for a wider scope — the queue is scoped server-side, this is a lens
 * on top of it.
 */

export type ApprovalFilters = {
  department: string;
  supervisor: string;
  project: string;
};

export const NO_FILTERS: ApprovalFilters = { department: "", supervisor: "", project: "" };

export function anyFilterActive(filters: ApprovalFilters): boolean {
  return Boolean(filters.department || filters.supervisor || filters.project);
}

/**
 * The minimum a row has to say about itself to be filtered.
 *
 * `supervisorIds` is a SET because a payroll My Hours day can be filled by more than one account, while a
 * timesheet group is one supervisor. Projects are always real project IDs: the timesheet queues know a project
 * only by the colour key they print in the column header, so the caller translates the key with
 * `projectIdsFromKeys` first. ONE way to name a project, not two — two ways drift.
 */
export type FilterSubject = {
  department: string | null;
  supervisorIds: number[];
  projectIds: number[];
};

/** Ids arrive from a `<select>` as strings; "" means "no filter", which is not the same as id 0. */
function wanted(value: string): number | null {
  if (!value) return null;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function matchesFilters(filters: ApprovalFilters, subject: FilterSubject): boolean {
  if (filters.department) {
    // Exact, because the queue prints the department as a label and a manager picks it from a list of those
    // labels. A substring match would make "Production" also show "Production - EOU", which is a different
    // department with a different chain of approval.
    if ((subject.department ?? "") !== filters.department) return false;
  }

  const supervisor = wanted(filters.supervisor);
  if (supervisor !== null && !subject.supervisorIds.includes(supervisor)) return false;

  const project = wanted(filters.project);
  if (project !== null && !subject.projectIds.includes(project)) return false;

  return true;
}

/** The project ids a row carries hours on, from hours keyed by colour key. */
export function projectIdsFromKeys(
  hours: Record<string, number> | undefined,
  keyToId: ReadonlyMap<string, number>
): number[] {
  if (!hours) return [];
  const ids: number[] = [];
  for (const [key, value] of Object.entries(hours)) {
    if (!value) continue;
    const id = keyToId.get(key);
    if (id != null) ids.push(id);
  }
  return ids;
}

/** The distinct values the dropdowns may offer, taken from the data actually loaded. */
export function optionLists(input: {
  departments: Array<string | null | undefined>;
  supervisors: Array<{ id: number; name: string } | null | undefined>;
  projects: Array<{ id: number; code: string; name: string } | null | undefined>;
}): {
  departments: string[];
  supervisors: Array<{ id: number; name: string }>;
  projects: Array<{ id: number; code: string; name: string }>;
} {
  const departments = [...new Set(input.departments.filter((value): value is string => Boolean(value)))].sort(
    (a, b) => a.localeCompare(b)
  );

  const supervisorMap = new Map<number, string>();
  for (const supervisor of input.supervisors) {
    if (supervisor) supervisorMap.set(supervisor.id, supervisor.name);
  }
  const supervisors = [...supervisorMap.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const projectMap = new Map<number, { id: number; code: string; name: string }>();
  for (const project of input.projects) {
    if (project) projectMap.set(project.id, project);
  }
  const projects = [...projectMap.values()].sort((a, b) => a.code.localeCompare(b.code));

  return { departments, supervisors, projects };
}

/**
 * A count worth printing: "12 of 40". A filter that leaves the screen unchanged looks broken; a filter that
 * says what it hid is a filter the reader trusts.
 */
export function filteredCount(shown: number, total: number): string {
  return shown === total ? String(total) : `${shown} of ${total}`;
}
