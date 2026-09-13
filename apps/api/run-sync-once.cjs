// TEMPORARY one-off LabourWorks -> SQLite sync runner (dev testing).
//
// Reuses the production sync service unchanged: ../../dist/services/badgeViewSync
//   fetchBadgeViewRows() -> syncBadgeViewRows()  (same guards, same upserts)
//
// Extra behaviour for this local test only:
//   * every account the sync would have given an unknown random password is
//     re-hashed with DEV_SYNC_PASSWORD (default "password@SDHI"), so the newly
//     synced workers can actually be logged into on this dev box;
//   * mustChangePassword is cleared for those accounts (no credential e-mail);
//   * queued credential-delivery rows are cancelled, so no e-mail is ever attempted.
//
// Nothing in apps/api/src is modified. Delete this file after use.
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });
require("dotenv").config();

const fs = require("fs");
const bcrypt = require("bcryptjs");
const { PrismaClient } = require("@prisma/client");
const { runBadgeViewSync } = require("./dist/services/badgeViewSync");

const prisma = new PrismaClient();
const DEV_PASSWORD = process.env.DEV_SYNC_PASSWORD || "password@SDHI";
const DB_FILE = path.resolve(__dirname, "prisma/dev.db");

function mask(url) {
  return String(url || "").replace(/:\/\/([^:]*):[^@]*@/, "://$1:***@");
}

(async () => {
  console.log("== one-off LabourWorks -> SQLite sync ==");
  console.log("DATABASE_URL :", mask(process.env.DATABASE_URL));
  console.log("NODE_ENV     :", process.env.NODE_ENV || "(unset)");
  console.log("source       :", `${process.env.BADGEVIEW_DB_HOST}:${process.env.BADGEVIEW_DB_PORT}/${process.env.BADGEVIEW_DB_NAME} [${process.env.BADGEVIEW_DB_VIEW}]`);
  console.log("mail         : disabled for this run (SMTP_HOST/SMTP_FROM are present, but delivery is never invoked and queued rows are cancelled)");
  console.log("");

  if (!String(process.env.DATABASE_URL || "").startsWith("file:")) {
    throw new Error("Refusing to run: this runner is for the local SQLite database only.");
  }

  // Safety net: pre-sync copy of the SQLite file.
  const backup = `${DB_FILE}.presync-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(DB_FILE, backup);
  console.log("pre-sync backup:", backup);

  const before = {
    employees: await prisma.employee.count(),
    syncEmployees: await prisma.employee.count({ where: { source: "SYNC" } }),
    activeSyncEmployees: await prisma.employee.count({ where: { source: "SYNC", active: true } }),
    users: await prisma.user.count(),
    supervisors: await prisma.user.count({ where: { role: "SUPERVISOR" } }),
    queuedCredentials: await prisma.credentialDelivery.count({ where: { status: { in: ["PENDING", "PROCESSING"] } } }),
  };
  console.log("before:", JSON.stringify(before));

  console.log("\n-- running sync (fetch + apply, snapshot guards active) --");
  const result = await runBadgeViewSync();
  console.log("sync result:", JSON.stringify(result, null, 2));

  if (!result.ok) {
    console.log("\nSync FAILED — no password or mail changes attempted.");
    await prisma.$disconnect();
    process.exit(1);
  }

  // 1. Cancel the mail queue so nothing can be delivered.
  const cancelled = await prisma.credentialDelivery.updateMany({
    where: { status: { in: ["PENDING", "PROCESSING"] } },
    data: { status: "CANCELLED", lastError: "Local dev one-off sync: no credential e-mail was sent by design." },
  });
  console.log(`cancelled queued credential deliveries: ${cancelled.count}`);

  // 2. Give every account the dev password. Accounts created/updated by this sync
  //    carry mustChangePassword=true (the "credential not delivered yet" state).
  const passwordHash = await bcrypt.hash(DEV_PASSWORD, 10);
  const reset = await prisma.user.updateMany({
    where: { mustChangePassword: true },
    data: { passwordHash, mustChangePassword: false, passwordExpiresAt: null },
  });
  console.log(`accounts set to the dev password "${DEV_PASSWORD}": ${reset.count}`);

  const after = {
    employees: await prisma.employee.count(),
    syncEmployees: await prisma.employee.count({ where: { source: "SYNC" } }),
    activeSyncEmployees: await prisma.employee.count({ where: { source: "SYNC", active: true } }),
    users: await prisma.user.count(),
    supervisors: await prisma.user.count({ where: { role: "SUPERVISOR" } }),
    queuedCredentials: await prisma.credentialDelivery.count({ where: { status: { in: ["PENDING", "PROCESSING"] } } }),
    cancelledCredentials: await prisma.credentialDelivery.count({ where: { status: "CANCELLED" } }),
    exceptionsOpen: await prisma.syncException.count({ where: { status: "OPEN" } }),
  };
  console.log("after :", JSON.stringify(after, null, 2));

  console.log("\n-- OPEN sync exceptions --");
  const exceptions = await prisma.syncException.findMany({
    where: { status: "OPEN" }, orderBy: { lastSeenAt: "desc" }, take: 50,
    select: { errorCode: true, ecNo: true, message: true, occurrences: true },
  });
  for (const e of exceptions) console.log(`  [${e.errorCode}] ${e.ecNo || "-"} x${e.occurrences} — ${e.message}`);

  console.log("\n-- newly synced supervisors (SUPERVISOR accounts linked to a SYNC employee) --");
  const syncedSupervisors = await prisma.user.findMany({
    where: { role: "SUPERVISOR", employee: { source: "SYNC" } },
    select: { email: true, name: true, employee: { select: { ecNo: true, designation: true, department: { select: { name: true } } } } },
    orderBy: { id: "asc" }, take: 40,
  });
  for (const u of syncedSupervisors) {
    console.log(`  login ${u.employee.ecNo.padEnd(12)} ${u.name.padEnd(34)} ${u.employee.designation || ""} @ ${u.employee.department.name}`);
  }
  console.log(`  total: ${syncedSupervisors.length}`);

  await prisma.$disconnect();
})().catch(async (e) => {
  console.error("RUNNER FAILED:", e);
  await prisma.$disconnect();
  process.exit(1);
});
