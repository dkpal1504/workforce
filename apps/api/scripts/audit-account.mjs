#!/usr/bin/env node
/**
 * Read-only audit of ONE person's account: can he sign in, and what approval work does the system think he owns?
 *
 *   docker compose -f infra/docker/compose.production.yml --env-file infra/docker/.env.production \
 *     exec api node apps/api/scripts/audit-account.mjs 40032455
 *
 * Writes nothing. Prints no secret: the password hash and the connection string never appear.
 *
 * WHY THIS EXISTS: "he cannot log in" and "it says he has N pending approvals" are two questions about the same
 * row, and both are answered by facts the screen does not show — the role, whether an employee is linked, whether
 * an e-mail is stored, and which of the two login doors that combination opens. Without them the argument goes
 * round in circles; with them it is one line.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/** Roles POST /auth/login lets in with an e-mail address rather than an EC No. */
const EMAIL_LOGIN_ROLES = ["ADMIN", "HR", "HOD", "DEPT_HEAD", "PM", "PROJECT_MANAGER", "FINANCE", "COO"];
/** Roles that can ACTION an approval queue — DECIDER_ROLES in routes/approvals.ts. */
const QUEUE_ACTION_ROLES = ["HOD", "PM"];
/** Roles that may READ a queue without acting on it. */
const QUEUE_READ_ROLES = ["HOD", "PM", "ADMIN"];

function mask(value) {
  return value == null || value === "" ? "<none>" : value;
}

async function main() {
  const ecNo = (process.argv[2] ?? "").trim();
  if (!ecNo) {
    console.error("usage: node apps/api/scripts/audit-account.mjs <EC No>");
    process.exit(2);
  }

  const url = String(process.env.DATABASE_URL || "");
  const host = url.replace(/^[a-z]+:\/\//i, "").split("@").pop()?.split("/")[0] ?? "(unset)";
  console.log(`database: ${host}  (NODE_ENV=${process.env.NODE_ENV ?? "unset"})  ecNo: ${ecNo}`);

  const employee = await prisma.employee.findFirst({
    where: { ecNo: { equals: ecNo, mode: "insensitive" } },
    select: {
      id: true, ecNo: true, name: true, employmentType: true, active: true, terminatedAt: true,
      department: { select: { name: true } },
      sectionAssignment: { select: { section: { select: { name: true } } } },
    },
  });
  if (!employee) {
    console.log("EMPLOYEE: no such EC No in this database.");
    return;
  }
  console.log(
    `\nEMPLOYEE  ${employee.ecNo}  ${employee.name}  ` +
      `${employee.employmentType}  ${employee.active ? "active" : "INACTIVE"}` +
      `${employee.terminatedAt ? `  terminated ${employee.terminatedAt.toISOString().slice(0, 10)}` : ""}`
  );
  console.log(`          department: ${employee.department?.name ?? "<none>"}  section: ${employee.sectionAssignment?.section?.name ?? "<none>"}`);

  const user = await prisma.user.findUnique({
    where: { employeeId: employee.id },
    select: {
      id: true, name: true, email: true, role: true, active: true, mustChangePassword: true,
      passwordExpiresAt: true, tokenVersion: true, departmentId: true, sectionId: true,
      scopeSections: { select: { sectionId: true } },
    },
  });
  if (!user) {
    console.log("\nACCOUNT:   none — this employee has no login at all.");
    return;
  }

  console.log(`\nACCOUNT   id ${user.id}  ${user.name}  role ${user.role}  ${user.active ? "active" : "INACTIVE"}`);
  console.log(`          email: ${mask(user.email)}   must-change-password: ${user.mustChangePassword}   tokenVersion: ${user.tokenVersion}`);
  console.log(`          credential expiry: ${user.passwordExpiresAt ? user.passwordExpiresAt.toISOString() : "<never>"}`);
  console.log(`          departmentId: ${user.departmentId ?? "<none>"}  sectionId: ${user.sectionId ?? "<none>"}  scopeSections: [${user.scopeSections.map((s) => s.sectionId).join(", ")}]`);

  // ---- the two doors ----
  const ecNoDoor = true; // usesEcNoLogin(employeeId): any linked account
  const emailDoor = EMAIL_LOGIN_ROLES.includes(user.role) && Boolean(user.email);
  console.log("\nLOGIN");
  console.log(`          EC No  (${employee.ecNo}): ${ecNoDoor ? "OPEN" : "CLOSED"}`);
  console.log(`          e-mail: ${emailDoor ? `OPEN (${user.email})` : `CLOSED — ${EMAIL_LOGIN_ROLES.includes(user.role) ? "no e-mail stored" : `role ${user.role} is not an e-mail-login role`}`}`);
  const blockers = [];
  if (!user.active) blockers.push("the account is inactive");
  if (!employee.active) blockers.push("the linked Employee is inactive");
  if (user.passwordExpiresAt && user.passwordExpiresAt.getTime() <= Date.now()) blockers.push("the temporary credential has EXPIRED");
  if (blockers.length) console.log(`          BLOCKED: ${blockers.join("; ")}`);

  // ---- approvals ----
  const statuses = user.role === "HOD" ? ["SUBMITTED"] : user.role === "PM" ? ["HOD_APPROVED"] : null;
  const queueRole = QUEUE_ACTION_ROLES.includes(user.role);
  console.log("\nAPPROVALS");
  console.log(`          may READ a queue:  ${QUEUE_READ_ROLES.includes(user.role) ? "yes" : "no"}`);
  console.log(`          may DECIDE a queue: ${queueRole ? "yes" : "no"}`);
  if (!queueRole) {
    console.log(
      `          queue size for this account: 0 — ${
        QUEUE_READ_ROLES.includes(user.role)
          ? "it reads every queue and decides none, so a pending count is not work it can do"
          : "it is not an approver"
      }`
    );
  } else {
    const where = { status: { in: statuses } };
    if (user.role === "HOD") {
      const scopeIds = user.scopeSections.map((s) => s.sectionId);
      if (user.departmentId == null || scopeIds.length === 0) {
        console.log("          queue size for this account: 0 — an HOD with no Section scope fails closed");
      } else {
        where.employee = { sectionAssignment: { sectionId: { in: scopeIds } } };
        const count = await prisma.timesheetDay.count({ where });
        console.log(`          queue size for this account: ${count}  (${statuses.join("/")} routed to sections [${scopeIds.join(", ")}])`);
      }
    } else {
      const count = await prisma.timesheetDay.count({ where });
      console.log(`          queue size for this account: ${count}  (${statuses.join("/")}, whole organisation)`);
    }
  }

  // ---- the plant-wide figures the screens quote ----
  const [submitted, hodApproved] = await Promise.all([
    prisma.timesheetDay.count({ where: { status: "SUBMITTED" } }),
    prisma.timesheetDay.count({ where: { status: "HOD_APPROVED" } }),
  ]);
  console.log(`\nWHOLE ORGANISATION  SUBMITTED ${submitted}  HOD_APPROVED ${hodApproved}  together ${submitted + hodApproved}`);

  // ---- his own hours ----
  const [allocationDays, timesheetDays] = await Promise.all([
    prisma.employeeAllocationDay.count({ where: { employeeId: employee.id } }),
    prisma.timesheetDay.count({ where: { employeeId: employee.id } }),
  ]);
  console.log(`HIS OWN WORK      My Hours days ${allocationDays}  timesheet days ${timesheetDays}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
