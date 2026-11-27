/**
 * Department → (plant, function) — the ONE derivation of the two facts the name only implies.
 *
 * WHY IT EXISTS: the yard runs two facilities (EOU and SEZ) and one function is therefore two
 * Department rows — "Yardservice - EOU" and "Yardservice - SEZ", "Safety - EOU" and "Safety - SEZ",
 * and so on for Civil, Health & Wellness, Administration. Until these columns existed the split lived
 * only in the name suffix, so nothing could answer "how is Yardservice doing across both plants" and a
 * single HOD over both plants looked like two unrelated grants. Parsing the name in one place, with
 * tests, is what stops the master data and the BadgeView sync from disagreeing about what the plant of
 * a new Department is.
 *
 * THE RULE: a Department name is "<function> - <PLANT>", and a function may itself contain hyphens
 * ("Training Center - BCS - SEZ", "Production - Hull and Febrication - SEZ"). Only a TRAILING EOU/SEZ
 * token is the facility; everything before it is the function. A name with no trailing plant token is a
 * Department that is not part of a plant split: `businessUnit` stays null and the whole name is its
 * function, which keeps a manually created Department usable without an edit.
 */

export type BusinessUnit = "EOU" | "SEZ";

export type DepartmentIdentity = {
  /** EOU | SEZ, or null when the name carries no facility suffix. */
  businessUnit: BusinessUnit | null;
  /** The function without its plant suffix, e.g. "Yardservice" or "Production - Hull and Febrication". */
  functionGroup: string;
};

const PLANT_TOKENS: readonly BusinessUnit[] = ["EOU", "SEZ"];

/** Trim, collapse inner whitespace, and drop trailing separators. */
function tidy(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/[\s-]+$/, "");
}

/**
 * Split a Department name into its facility and its function.
 *
 * `functionGroup` is NEVER empty: a name of only " - EOU" is not a Department name, and an empty
 * function would make every such row group together. It falls back to the trimmed name.
 */
export function departmentIdentity(name: string): DepartmentIdentity {
  const clean = tidy(name ?? "");
  if (!clean) return { businessUnit: null, functionGroup: "" };
  const match = /^(.*?)[\s-]+(EOU|SEZ)$/i.exec(clean);
  if (!match) return { businessUnit: null, functionGroup: clean };
  const businessUnit = match[2].toUpperCase() as BusinessUnit;
  const functionGroup = tidy(match[1]);
  if (!functionGroup) return { businessUnit, functionGroup: clean };
  return { businessUnit: PLANT_TOKENS.includes(businessUnit) ? businessUnit : null, functionGroup };
}

/**
 * The values to write on INSERT of a Department. Null is a real answer (no plant suffix), so the caller
 * must store both columns rather than "falling back" to a guess.
 */
export function departmentIdentityColumns(name: string): { businessUnit: BusinessUnit | null; functionGroup: string } {
  return departmentIdentity(name);
}

/** Stable sort key so the UI can group functions together and plants in a known order. */
export function departmentSortKey(identity: { functionGroup: string | null; businessUnit: string | null }): string {
  const plant = identity.businessUnit === "EOU" ? "0" : identity.businessUnit === "SEZ" ? "1" : "2";
  return `${(identity.functionGroup ?? "").toLowerCase()}|${plant}`;
}
