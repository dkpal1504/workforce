#!/usr/bin/env node
/**
 * READ-ONLY scope-and-queue report for ONE approver account.
 *
 *   node apps/api/scripts/hod-scope-report.mjs 40030342
 *   node apps/api/scripts/hod-scope-report.mjs 40030342 --match="yard"
 *   node apps/api/scripts/hod-scope-report.mjs --user-id 122 --all
 *
 * Writes nothing — no update, no create, no delete, no migration. Safe on production.
 *
 * WHY IT EXISTS
 * "He is HOD of Yardservice - EOU, can he also head Yardservice - SEZ?" is currently answered by
 * screens that show one Department at a time, so the numbers that decide it — how many SUBMITTED
 * days are sitting in each Section, and how many of them his account cannot reach — are never on
 * one line. This prints that line, using the SAME routing fragment the product uses
 * (`hodRoutingScope` / `routingSectionScope` from services/approvalRouting.ts, imported from the
 * compiled dist so a drift between script and product is impossible).
 *
 * WHAT THE THREE NUMBERS MEAN
 *   TODAY                     what the running product enforces for this account right now.
 *   WITH WHOLE DEPARTMENT      the same account granted the second Department IN FULL
 *                             (`sectionIds: []`) — covers every Section, including ones added by
 *                             the BadgeView sync later, and sheets whose tagger has no Section.
 *   WITH NAMED SECTIONS ONLY   the same account granted the second Department's CURRENT Sections by
 *                             name. The gap between this and the whole-Department figure is work
 *                             that is routed to the Department but sits on no Section — nobody would
 *                             see it under a named-Section scope.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { hodRoutingScope, hodRoutingScopeFor, routingSectionScope } from "../dist/services/approvalRouting.js";
import { hodEmployeeScopeFor, hodScopeMatchesScope } from "../dist/services/roleAccess.js";
import { hodScopeDepartmentIds, hodScopeFromRows } from "../dist/services/hodScope.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(here, "..");
const repoRoot = path.resolve(apiDir, "../..");
// Same precedence as src/index.ts and scripts/migrate.mjs: the root .env wins.
dotenv.config({ path: path.join(repoRoot, ".env") });
dotenv.config({ path: path.join(apiDir, ".env") });

const prisma = new PrismaClient();

const EMPTY = { id: -1 };

function parseArgs(argv) {
  const options = { match: "yard", all: false, userId: null, positional: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--all") {
      options.all = true;
      continue;
    }
    const flag = /^--([a-z-]+)(?:=(.*))?$/i.exec(arg);
    if (flag) {
      const [, name, inline] = flag;
      const value = inline ?? argv[index + 1];
      if (inline == null && value != null && !value.startsWith("--")) index += 1;
      if (name === "match") options.match = value ?? options.match;
      if (name === "user-id") options.userId = Number(value);
      continue;
    }
    options.positional.push(arg);
  }
  return options;
}

/** The connection string, with any password removed — this output gets pasted into tickets. */
function databaseLabel() {
  const url = String(process.env.DATABASE_URL || "");
  const withoutCredentials = url.replace(/^[a-z]+:\/\/([^@/]*@)?/i, "");
  return `${withoutCredentials || "(unset)"}  (NODE_ENV=${process.env.NODE_ENV ?? "unset"})`;
}

function pad(value, width) {
  const text = String(value ?? "");
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function padLeft(value, width) {
  const text = String(value ?? "");
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

/** The grant set, exactly as `middleware/auth.ts` builds it (the authority). */
function hodScopeOf(user) {
  return hodScopeFromRows({
    departmentId: user.departmentId,
    legacySectionId: user.sectionId,
    departmentGrants: (user.scopeDepartments ?? []).map((grant) => grant.departmentId),
    sectionRows: (user.scopeSections ?? []).map((row) => ({ sectionId: row.sectionId, departmentId: row.section.departmentId })),
  });
}

/**
 * The section scope exactly as `middleware/auth.ts` hydrates it: the ROWS win, and the legacy
 * scalar is only a fallback for an account that has none. Getting this wrong in a diagnostic is
 * how a script ends up reporting a scope the product does not enforce.
 */
function sectionScopeOf(user) {
  if (user.scopeSections.length > 0) return user.scopeSections.map((row) => row.sectionId);
  return user.sectionId != null ? [user.sectionId] : [];
}

async function countSubmitted(where) {
  return prisma.timesheetDay.count({ where: { status: "SUBMITTED", ...where } });
}

async function countEmployees(where) {
  return prisma.employee.count({ where: { active: true, ...where } });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const ecNo = options.positional[0] ?? null;
  if (!ecNo && !options.userId) {
    console.error('usage: node apps/api/scripts/hod-scope-report.mjs <EC No> [--match="yard"] [--all]');
    console.error("       node apps/api/scripts/hod-scope-report.mjs --user-id <id> [--match=...] [--all]");
    process.exit(2);
  }

  console.log(`database: ${databaseLabel()}`);
  console.log("mode:     READ-ONLY (this script performs no writes)\n");

  const user = options.userId
    ? await prisma.user.findUnique({
        where: { id: options.userId },
        select: {
          id: true, name: true, email: true, role: true, active: true,
          departmentId: true, sectionId: true,
          scopeSections: { select: { sectionId: true, section: { select: { departmentId: true } } } },
          scopeDepartments: { select: { departmentId: true } },
          department: { select: { id: true, name: true } },
          employee: {
            select: {
              id: true, ecNo: true, name: true, employmentType: true, active: true,
              department: { select: { id: true, name: true } },
              sectionAssignment: { select: { section: { select: { id: true, name: true } } } },
            },
          },
        },
      })
    : await (async () => {
        const employee = await prisma.employee.findFirst({
          where: { ecNo: { equals: ecNo.trim(), mode: "insensitive" } },
          select: { user: { select: { id: true } }, ecNo: true },
        });
        if (!employee) return { notFound: "employee" };
        if (!employee.user) return { notFound: "account", employee };
        return prisma.user.findUnique({
          where: { id: employee.user.id },
          select: {
            id: true, name: true, email: true, role: true, active: true,
            departmentId: true, sectionId: true,
            scopeSections: { select: { sectionId: true, section: { select: { departmentId: true } } } },
          scopeDepartments: { select: { departmentId: true } },
            department: { select: { id: true, name: true } },
            employee: {
              select: {
                id: true, ecNo: true, name: true, employmentType: true, active: true,
                department: { select: { id: true, name: true } },
                sectionAssignment: { select: { section: { select: { id: true, name: true } } } },
              },
            },
          },
        });
      })();

  if (user?.notFound === "employee") {
    console.log(`No Employee has EC No ${ecNo} in this database.`);
    return;
  }
  if (user?.notFound === "account") {
    console.log(`${user.employee.ecNo} has no login at all — there is no approval scope to report.`);
    return;
  }
  if (!user) {
    console.log("No such account.");
    return;
  }

  const scopeIds = sectionScopeOf(user);
  const hodScope = hodScopeOf(user);
  const isApprover = user.role === "HOD" || user.role === "PM";

  console.log("ACCOUNT");
  console.log(`  ${user.name}  (user ${user.id})  role ${user.role}  ${user.active ? "active" : "INACTIVE"}`);
  if (user.employee) {
    console.log(
      `  employee ${user.employee.ecNo}  ${user.employee.employmentType}  ` +
        `home department: ${user.employee.department?.name ?? "<none>"}  ` +
        `home section: ${user.employee.sectionAssignment?.section?.name ?? "<none>"}`
    );
  }
  console.log(
    `  stored scope: departmentId ${user.departmentId ?? "<none>"}  ` +
      `legacy sectionId ${user.sectionId ?? "<none>"}  ` +
      `section rows [${scopeIds.join(", ")}]` +
      (scopeIds.length === 0 ? "   <- EMPTY means the whole Department" : "")
  );
  console.log(
    `  AUTHORITY (grants): ${
      hodScope.grants.length === 0
        ? "none -> matches nothing"
        : hodScope.grants
            .map((grant) =>
              grant.sectionIds.length === 0
                ? `Department ${grant.departmentId} (all Sections)`
                : `Department ${grant.departmentId} (Sections ${grant.sectionIds.join(", ")})`
            )
            .join("; ")
    }`
  );
  if (hodScopeDepartmentIds(hodScope).length > 1) {
    console.log(`  MULTI-DEPARTMENT: this account heads ${hodScopeDepartmentIds(hodScope).length} Departments.`);
  }
  if (!isApprover) {
    console.log(`\n  NOTE: role ${user.role} does not action an approval queue; the queue figures below are for context only.`);
  }

  // ---- which Departments this report compares ------------------------------------------------
  const match = options.match ? new RegExp(options.match, "i") : null;
  // Filtered in JS, not SQL: `mode: "insensitive"` does not exist on the SQLite dev provider, and a
  // `contains` on a lowercased term matches on SQLite but not on PostgreSQL — see the repo note on
  // employee search. The table is ~30 rows, so reading it and filtering here is also cheaper.
  const allDepartments = await prisma.department.findMany({
    select: { id: true, name: true, active: true },
    orderBy: { name: "asc" },
  });
  const departments = options.all
    ? allDepartments
    : allDepartments.filter(
        (department) => department.id === user.departmentId || (match ? match.test(department.name) : false)
      );
  if (departments.length === 0) {
    console.log("\nNo Department matched. Widen the search with --all or a broader --match.");
    return;
  }

  const ownDepartmentId = user.departmentId;
  const otherDepartments = departments.filter((department) => department.id !== ownDepartmentId);

  // Who covers each Section today. The same precedence the product uses: the scope ROWS win and the
  // legacy scalar is only a fallback. Counted here because "he will head all three Sections" is
  // usually asked about Sections that have NO head at all, and the queue figures alone cannot show
  // that — an uncovered Section and a quiet one both read as 0 pending days.
  const hodAccounts = await prisma.user.findMany({
    where: { role: "HOD", active: true },
    select: {
      id: true, name: true, departmentId: true, sectionId: true,
      scopeSections: { select: { sectionId: true, section: { select: { departmentId: true } } } },
      scopeDepartments: { select: { departmentId: true } },
    },
  });
  const hodsForSection = (departmentId, sectionId) =>
    hodAccounts.filter((account) => hodScopeMatchesScope(hodScopeOf(account), departmentId, sectionId));

  // ---- per-Section table ----------------------------------------------------------------------
  console.log("\nSECTIONS IN THE COMPARED DEPARTMENTS");
  console.log(
    `  ${pad("dept", 4)} ${pad("department", 30)} ${pad("section", 16)} ${padLeft("sect id", 7)} ` +
      `${padLeft("emp", 4)} ${padLeft("SUBMITTED", 9)} ${padLeft("HODs", 5)}  ${pad("in scope today", 16)}`
  );

  const sectionIdsByDepartment = new Map();
  for (const department of departments) {
    const sections = await prisma.section.findMany({
      where: { departmentId: department.id },
      select: { id: true, name: true, code: true, active: true },
      orderBy: [{ active: "desc" }, { name: "asc" }],
    });
    sectionIdsByDepartment.set(
      department.id,
      sections.filter((section) => section.active).map((section) => section.id)
    );

    for (const section of sections) {
      const [sectionEmployees, sectionSubmitted] = await Promise.all([
        countEmployees({ sectionAssignment: { sectionId: section.id } }),
        countSubmitted(routingSectionScope([section.id])),
      ]);
      const inScope = hodScopeMatchesScope(hodScope, department.id, section.id);
      const sectionHods = hodsForSection(department.id, section.id);
      console.log(
        `  ${pad(department.id, 4)} ${pad(department.name, 30)} ${pad(section.active ? section.name : `${section.name} (inactive)`, 16)} ` +
          `${padLeft(section.id, 7)} ${padLeft(sectionEmployees, 4)} ${padLeft(sectionSubmitted, 9)} ` +
          `${padLeft(sectionHods.length, 5)}  ${pad(inScope ? "yes" : "no", 16)}` +
          (sectionHods.length === 0 ? "  <- NO HOD" : `  ${sectionHods.map((account) => account.name).join(", ")}`)
      );
    }

    // The Department-wide figure is not the sum of its Sections: a sheet whose tagger AND employee
    // both lack a Section is routed to the Department and is invisible to every named-Section head.
    const [departmentEmployees, departmentSubmitted, namedOnly] = await Promise.all([
      countEmployees({ departmentId: department.id }),
      countSubmitted(hodRoutingScope(department.id, [])),
      (async () => {
        const ids = sectionIdsByDepartment.get(department.id) ?? [];
        const perSection = await Promise.all(ids.map((id) => countSubmitted(routingSectionScope([id]))));
        return perSection.reduce((total, value) => total + value, 0);
      })(),
    ]);
    console.log(
      `  ${pad("", 4)} ${pad(`${department.name} — WHOLE DEPARTMENT`, 30)} ${pad("", 16)} ` +
        `${padLeft("", 7)} ${padLeft(departmentEmployees, 4)} ${padLeft(departmentSubmitted, 9)}  ` +
        `${pad(hodScopeMatchesScope(hodScope, department.id, null) ? "yes" : "no", 16)}`
    );
    if (departmentSubmitted !== namedOnly) {
      console.log(
        `         ↳ ${departmentSubmitted - namedOnly} of them are routed to the Department but sit on NO Section ` +
          `(tagger and employee both unmapped): a named-Section scope cannot see these.`
      );
    }
  }

  // ---- the three totals -----------------------------------------------------------------------
  const currentQueue = await countSubmitted(hodRoutingScopeFor(hodScope));
  const currentEmployees = await countEmployees(hodEmployeeScopeFor(hodScope));
  const othersWhole = otherDepartments.map((department) => hodRoutingScope(department.id, []));
  const othersNamed = otherDepartments.flatMap((department) => sectionIdsByDepartment.get(department.id) ?? []);

  const wholeQueue = await countSubmitted(othersWhole.length ? { OR: [hodRoutingScopeFor(hodScope), ...othersWhole] } : hodRoutingScopeFor(hodScope));
  const namedQueue = await countSubmitted(
    othersNamed.length
      ? { OR: [hodRoutingScopeFor(hodScope), routingSectionScope(othersNamed)] }
      : hodRoutingScopeFor(hodScope)
  );
  const wholeEmployees = await countEmployees({
    OR: [
      hodEmployeeScopeFor(hodScope),
      ...otherDepartments.map((department) => ({ departmentId: department.id })),
    ],
  });

  console.log("\nQUEUE (SUBMITTED days this account may decide)");
  console.log(`  TODAY                     ${padLeft(currentQueue, 6)} days   ${padLeft(currentEmployees, 6)} active employees`);
  console.log(`  WITH WHOLE DEPARTMENT     ${padLeft(wholeQueue, 6)} days   ${padLeft(wholeEmployees, 6)} active employees   (+${wholeQueue - currentQueue} days)`);
  console.log(`  WITH NAMED SECTIONS ONLY  ${padLeft(namedQueue, 6)} days                          (+${namedQueue - currentQueue} days)`);
  if (wholeQueue !== namedQueue) {
    console.log(
      `  the two proposed figures differ by ${wholeQueue - namedQueue} day(s): whole-Department covers sheets on no Section, named Sections do not.`
    );
  }

  console.log("\nPROPOSED GRANTS (what a save would store)");
  // The home Department is listed first because it is the legacy mirror. When it is ALSO granted
  // whole-Department, say so: after the multi-plant grant a bare "legacy mirror" label reads as
  // "this one is not really granted", which is the opposite of the truth.
  const homeWholeGrant = hodScope.grants.some(
    (grant) => grant.departmentId === ownDepartmentId && grant.sectionIds.length === 0
  );
  console.log(
    `  { departmentId: ${ownDepartmentId ?? "?"}, sectionIds: [${scopeIds.join(", ")}] }   // ` +
      `${user.department?.name ?? "home department"} — ${homeWholeGrant ? "already granted whole Department" : "legacy mirror"}`
  );
  for (const department of otherDepartments) {
    const ids = sectionIdsByDepartment.get(department.id) ?? [];
    console.log(`  { departmentId: ${department.id}, sectionIds: [] }            // ${department.name} — whole Department (self-maintaining)`);
    console.log(`  { departmentId: ${department.id}, sectionIds: [${ids.join(", ")}] }   // OR the same Department by named Section (does not inherit new Sections)`);
  }

  // A zero is only meaningful with the organisation's own figure beside it: "0 days" in an empty
  // test database and "0 days" on a quiet Sunday look identical otherwise.
  const comparedDepartmentIds = departments.map((department) => department.id);
  const [organisationSubmitted, comparedSubmitted] = await Promise.all([
    prisma.timesheetDay.count({ where: { status: "SUBMITTED" } }),
    prisma.timesheetDay.count({
      where: { status: "SUBMITTED", employee: { departmentId: { in: comparedDepartmentIds } } },
    }),
  ]);
  const uncoveredSections = [...sectionIdsByDepartment.entries()]
    .flatMap(([departmentId, sectionIds]) => sectionIds.map((sectionId) => ({ departmentId, sectionId })))
    .filter(({ departmentId, sectionId }) => hodsForSection(departmentId, sectionId).length === 0);

  console.log("\nCONTEXT");
  console.log(`  whole organisation SUBMITTED: ${organisationSubmitted} days; in the compared Departments: ${comparedSubmitted} (by employee's Department)`);
  console.log(
    `  Sections compared: ${[...sectionIdsByDepartment.values()].reduce((total, ids) => total + ids.length, 0)}` +
      `   without any HOD: ${uncoveredSections.length}` +
      (uncoveredSections.length ? `   -> ${uncoveredSections.map(({ departmentId, sectionId }) => `${departmentId}/${sectionId}`).join(", ")}` : "")
  );
  if (comparedSubmitted === 0) {
    console.log("  nothing is pending in these Departments right now, so the queue deltas above are 0 — re-run when work is live,");
    console.log("  or run with --match to compare other Departments.");
  }

  console.log("\nRead-only. Nothing was written.");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
