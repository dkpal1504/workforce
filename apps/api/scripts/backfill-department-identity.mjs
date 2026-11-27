#!/usr/bin/env node
/**
 * Derive (plant, function) for every Department that does not have them yet — or whose stored value no
 * longer matches its name.
 *
 *   node apps/api/scripts/backfill-department-identity.mjs --dry-run
 *   node apps/api/scripts/backfill-department-identity.mjs
 *
 * WHY A SCRIPT AND NOT A MIGRATION: a migration that UPDATEs rows is a data change wearing a schema
 * change's clothes — it cannot be reviewed as DDL, it rewrites a table on deploy, and a wrong derivation
 * would have to be undone with another migration. The columns are added empty by
 * `20261126130000_department_identity`; this script fills them, prints exactly what it will write, and is
 * idempotent. It is also safe to re-run after the sync creates a new Department.
 *
 * WHAT IT WILL NOT DO: overwrite a value an Admin set by hand? It cannot tell. It therefore only touches
 * rows where the derived value DIFFERS from `departmentIdentity(name)` — which includes a manual
 * correction that disagrees with the name. Run with `--dry-run` first and read the plan; that is the whole
 * reason the plan is printed.
 */
import { prisma } from "../dist/db.js";
import { departmentIdentity } from "../dist/services/departmentIdentity.js";

const dryRun = process.argv.includes("--dry-run");

const departments = await prisma.department.findMany({
  orderBy: { name: "asc" },
  select: { id: true, name: true, businessUnit: true, functionGroup: true },
});

const changes = [];
const unchanged = [];
for (const department of departments) {
  const derived = departmentIdentity(department.name);
  if (department.businessUnit === derived.businessUnit && department.functionGroup === derived.functionGroup) {
    unchanged.push(department);
    continue;
  }
  changes.push({ ...department, derived });
}

console.log(`departments: ${departments.length}  unchanged: ${unchanged.length}  to write: ${changes.length}${dryRun ? "  (DRY RUN — nothing written)" : ""}`);
for (const change of changes) {
  console.log(
    `  ${change.name}\n      plant   ${change.businessUnit ?? "-"} -> ${change.derived.businessUnit ?? "-"}\n` +
      `      function ${change.functionGroup ?? "-"} -> ${change.derived.functionGroup || "-"}`
  );
}

if (!dryRun && changes.length) {
  for (const change of changes) {
    await prisma.department.update({
      where: { id: change.id },
      data: { businessUnit: change.derived.businessUnit, functionGroup: change.derived.functionGroup },
    });
  }
  console.log(`written: ${changes.length}`);
}

// The split the yard cares about: one function, two plants. Printed so an operator can see at a glance
// which functions are still missing one of their two Department rows.
const byFunction = new Map();
for (const department of departments) {
  const derived = departmentIdentity(department.name);
  const key = (derived.functionGroup ?? "").toLowerCase();
  const entry = byFunction.get(key) ?? { name: derived.functionGroup, plants: new Set() };
  if (derived.businessUnit) entry.plants.add(derived.businessUnit);
  byFunction.set(key, entry);
}
const paired = [...byFunction.values()].filter((entry) => entry.plants.size === 2);
const half = [...byFunction.values()].filter((entry) => entry.plants.size === 1);
console.log(`\nfunctions with BOTH plants: ${paired.length}  (${paired.map((e) => e.name).slice(0, 8).join(", ")}${paired.length > 8 ? " …" : ""})`);
console.log(`functions with ONE plant:   ${half.length}  (${half.map((e) => e.name).slice(0, 8).join(", ")}${half.length > 8 ? " …" : ""})`);

await prisma.$disconnect();
