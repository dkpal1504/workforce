#!/usr/bin/env node
/**
 * Set the NOTIFICATION address of existing accounts, keyed by Employee ecNo.
 *
 * WHY `notification_email` AND NOT `users.email`: `users.email` is the LOGIN handle. For a payroll
 * account it holds `40032078@employee.local` — the name the person signs in with, which the import
 * wrote. Replacing it with a real address would change how that person signs in and would make
 * `@employee.local` stop being a reliable "this came from an import" marker. `notification_email` is
 * the address the application actually delivers to: conversation escalation, the Job Order owner, and
 * the new Email column on Supervisors → Employees all read it first and fall back to the login only
 * when it is absent.
 *
 * The ecNo is the key because it is unique on Employee and stable; the name in the file is a GUARD,
 * not a key. A row whose name does not match the person that ecNo resolves to is SKIPPED and reported,
 * because that is the shape of a transposed digit and silently mailing the wrong person is worse than
 * not mailing anybody. `--allow-name-mismatch` overrides it for rows that were checked by hand.
 *
 * DEFAULT IS A DRY RUN.
 *
 *   docker compose --env-file infra/docker/.env.production \
 *     -f infra/docker/compose.production.yml exec api \
 *     node apps/api/scripts/set-notification-emails.mjs \
 *       --file apps/api/scripts/data/notification-emails-2026-10-21.csv
 *
 * Add `--apply` to write. `--rollback <auditId>` restores the previous values exactly.
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";

const prisma = new PrismaClient();

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const apply = process.argv.includes("--apply");
const allowMismatch = process.argv.includes("--allow-name-mismatch");
const rollbackId = arg("rollback");
const file = arg("file", "apps/api/scripts/data/notification-emails-2026-10-21.csv");

function die(message) {
  console.error(`\n  ABORT: ${message}\n`);
  process.exit(1);
}
function line(label, value) {
  console.log(`  ${String(label).padEnd(30)} ${value}`);
}
const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// ── --rollback <auditId> ─────────────────────────────────────────────────────────────────────────
if (rollbackId) {
  const audit = await prisma.auditLog.findUnique({ where: { id: Number(rollbackId) } });
  if (!audit || audit.action !== "NOTIFICATION_EMAIL_SET") die(`audit row ${rollbackId} is not a NOTIFICATION_EMAIL_SET run.`);
  const meta = JSON.parse(audit.metadata);
  if (meta.rolledBackAt) die(`audit row ${rollbackId} was already rolled back at ${meta.rolledBackAt}.`);
  console.log(`\n  ROLLING BACK audit ${rollbackId} — ${meta.rows.length} account(s)\n`);
  const result = await prisma.$transaction(async (tx) => {
    let restored = 0;
    for (const row of meta.rows) {
      if (!row.updated) continue;
      await tx.user.update({ where: { id: row.userId }, data: { notificationEmail: row.before } });
      restored += 1;
    }
    await tx.auditLog.update({
      where: { id: Number(rollbackId) },
      data: { metadata: JSON.stringify({ ...meta, rolledBackAt: new Date().toISOString(), restored }) },
    });
    return restored;
  });
  line("accounts restored", result);
  console.log("\n  Done.\n");
  await prisma.$disconnect();
  process.exit(0);
}

// ── read the file ────────────────────────────────────────────────────────────────────────────────
let text;
try {
  text = readFileSync(file, "utf8");
} catch {
  die(`cannot read ${file}. Pass --file <csv> with columns ecNo,name,email.`);
}
const rows = text
  .replace(/^\uFEFF/, "")
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !/^ecno\s*,/i.test(l))
  .map((l, i) => {
    const [ecNo, name, email] = l.split(",").map((v) => (v ?? "").trim().replace(/^"|"$/g, ""));
    return { ecNo, name, email, row: i + 2 };
  });

if (rows.length === 0) die(`${file} contains no rows.`);

const badEmail = rows.filter((r) => !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(r.email ?? ""));
if (badEmail.length) die(`row(s) ${badEmail.map((r) => r.row).join(", ")} do not carry a valid address.`);

const duplicateEc = rows.map((r) => r.ecNo).filter((v, i, a) => a.indexOf(v) !== i);
if (duplicateEc.length) die(`ecNo ${[...new Set(duplicateEc)].join(", ")} appears more than once in the file.`);

console.log(`\n  ${apply ? "APPLY" : "DRY RUN"} — ${rows.length} row(s) from ${file}\n`);
line("ecNo", "name in file");
console.log("  " + "".padEnd(96, "─"));

const plan = [];
for (const r of rows) {
  const found = await prisma.employee.findUnique({
    where: { ecNo: r.ecNo },
    select: { id: true, name: true, active: true, user: { select: { id: true, email: true, notificationEmail: true, role: true, active: true } } },
  });

  if (!found) {
    console.log(`  ${r.ecNo.padEnd(12)} ${r.name.padEnd(28)} NOT FOUND — no Employee with this ecNo`);
    plan.push({ ...r, status: "not-found" });
    continue;
  }
  if (!found.user) {
    console.log(`  ${r.ecNo.padEnd(12)} ${r.name.padEnd(28)} NO ACCOUNT — employee ${found.name} has no login yet`);
    plan.push({ ...r, status: "no-account", employee: found });
    continue;
  }

  const nameMatches = norm(found.name) === norm(r.name);
  const current = found.user.notificationEmail;
  const same = current === r.email;
  const status = same ? "unchanged" : nameMatches || allowMismatch ? "update" : "name-mismatch";

  console.log(
    `  ${r.ecNo.padEnd(12)} ${r.name.padEnd(28)} ${String(found.name).padEnd(26)} ` +
      `${String(found.user.role).padEnd(16)} login ${String(found.user.email).padEnd(26)} → ${r.email}` +
      `${same ? "   (already set)" : ""}${nameMatches ? "" : `   NAME IN DATABASE: "${found.name}"`}`
  );
  plan.push({ ...r, status, employee: found, userId: found.user.id, before: current });
}

const count = (s) => plan.filter((p) => p.status === s).length;
const updatable = plan.filter((p) => p.status === "update" || p.status === "unchanged");

console.log("");
line("to update", count("update"));
line("already correct", count("unchanged"));
line("name mismatch (skipped)", count("name-mismatch"));
line("no account", count("no-account"));
line("employee not found", count("not-found"));

if (count("name-mismatch") && !allowMismatch) {
  console.log(
    "\n  Rows with a name mismatch were NOT updated: the ecNo and the name disagree, which is what a\n" +
      "  transposed digit looks like. Check those rows, then re-run with --allow-name-mismatch.\n"
  );
}

if (!apply) {
  console.log("\n  This was a DRY RUN. Re-run the same command with --apply to write.\n");
  await prisma.$disconnect();
  process.exit(0);
}
if (updatable.length === 0) {
  console.log("\n  Nothing to write.\n");
  await prisma.$disconnect();
  process.exit(0);
}

// ── write, and record the exact before/after so the undo is a replay, not a guess ────────────────
const { updated, auditId } = await prisma.$transaction(async (tx) => {
  const auditRows = [];
  let n = 0;
  for (const p of plan) {
    if (p.status !== "update" && p.status !== "unchanged") {
      auditRows.push({ ecNo: p.ecNo, userId: null, before: null, after: p.email, updated: false, why: p.status });
      continue;
    }
    if (p.status === "update") {
      await tx.user.update({ where: { id: p.userId }, data: { notificationEmail: p.email } });
      n += 1;
    }
    auditRows.push({ ecNo: p.ecNo, userId: p.userId, before: p.before, after: p.email, updated: p.status === "update" });
  }
  const audit = await tx.auditLog.create({
    data: {
      userId: null,
      action: "NOTIFICATION_EMAIL_SET",
      entityType: "user",
      entityId: null,
      metadata: JSON.stringify({ file, rows: auditRows, updated: n }),
    },
    select: { id: true },
  });
  return { updated: n, auditId: audit.id };
});

// Read it back. An updateMany count is a statement of intent; the row is the fact.
let verified = 0;
let mismatched = [];
for (const p of plan) {
  if (p.status !== "update" && p.status !== "unchanged") continue;
  const check = await prisma.user.findUnique({ where: { id: p.userId }, select: { notificationEmail: true } });
  if (check?.notificationEmail === p.email) verified += 1;
  else mismatched.push(`${p.ecNo} (expected ${p.email}, found ${check?.notificationEmail ?? "null"})`);
}

console.log("");
line("accounts written", updated);
line("read back and verified", verified);
line("audit id (the undo)", `--rollback ${auditId}`);
if (mismatched.length) {
  console.log(`\n  VERIFY FAILED for ${mismatched.length}: ${mismatched.join("; ")}\n`);
  process.exitCode = 1;
} else {
  console.log("\n  VERIFIED: every written account now carries the address in the file.\n");
}
await prisma.$disconnect();
