#!/usr/bin/env node
/**
 * Create the FIRST administrator of a fresh deployment.
 *
 * Why this exists: a fresh database has NO accounts, and every user-creating screen
 * needs an existing ADMIN or HR token - so a new deployment cannot be logged into at
 * all until one account exists. The seeds are blocked in production on purpose
 * (`prisma/seed.ts` refuses when NODE_ENV=production, because it creates accounts with
 * a known development password), and there is deliberately no bootstrap HTTP route.
 *
 * Run it INSIDE the api container, which already has the database connection, Prisma
 * and bcryptjs:
 *
 *   docker compose --env-file infra/docker/.env.production \
 *     -f infra/docker/compose.production.yml run --rm api \
 *     node apps/api/scripts/create-first-admin.mjs
 *
 * Reads (from the environment / .env.production):
 *   ADMIN_EMAIL     required, e.g. admin@swan.co.in
 *   ADMIN_NAME      optional, default "Platform Admin"
 *   ADMIN_PASSWORD  optional; falls back to BOOTSTRAP_PASSWORD when unset
 *
 * Safety rails: it refuses when an ADMIN already exists (so it can never be used later
 * to add another one), refuses an e-mail that is already taken, refuses a password
 * shorter than 8 characters, and forces a password change at the first login. It writes
 * an audit row (BOOTSTRAP_FIRST_ADMIN) with a null actor, which is what "created by the
 * deployment, not by a user" means.
 */
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function fail(message, hint) {
  console.error(`[first-admin] ${message}`);
  if (hint) console.error(`[first-admin] ${hint}`);
  process.exitCode = 1;
}

const email = String(process.env.ADMIN_EMAIL ?? "").trim().toLowerCase();
const name = String(process.env.ADMIN_NAME ?? "").trim() || "Platform Admin";
const password = String(process.env.ADMIN_PASSWORD || process.env.BOOTSTRAP_PASSWORD || "").trim();

try {
  if (!email) {
    fail("ADMIN_EMAIL is required.", "Set it in .env.production or pass -e ADMIN_EMAIL=... to the run command.");
  } else if (!password) {
    fail(
      "No password available.",
      "Set ADMIN_PASSWORD, or set BOOTSTRAP_PASSWORD and the new admin will start with that shared first password."
    );
  } else if (password.length < 8) {
    fail("The password must be at least 8 characters.", "Use a longer ADMIN_PASSWORD, or unset it and use BOOTSTRAP_PASSWORD.");
  } else {
    const existingAdmin = await prisma.user.findFirst({ where: { role: "ADMIN" }, select: { id: true, email: true } });
    if (existingAdmin) {
      fail(
        `An ADMIN already exists (id ${existingAdmin.id}).`,
        "Log in with that account and create further users from the application; this script is only for the very first one."
      );
    } else {
      const taken = await prisma.user.findUnique({ where: { email }, select: { id: true } });
      if (taken) {
        fail(`The e-mail ${email} is already used by account id ${taken.id}.`, "Choose another ADMIN_EMAIL.");
      } else {
        const admin = await prisma.user.create({
          data: {
            email,
            name,
            role: "ADMIN",
            source: "MANUAL",
            active: true,
            passwordHash: await bcrypt.hash(password, 10),
            // Deliberate: whoever holds this password must set their own at first login.
            mustChangePassword: true,
            tokenVersion: 0,
          },
          select: { id: true, email: true, name: true, role: true },
        });
        await prisma.auditLog.create({
          data: {
            userId: null,
            action: "BOOTSTRAP_FIRST_ADMIN",
            entityType: "user",
            entityId: String(admin.id),
            metadata: JSON.stringify({ email: admin.email, name: admin.name, source: "create-first-admin.mjs" }),
          },
        });
        console.log(`[first-admin] Created ADMIN #${admin.id} <${admin.email}> (${admin.name}).`);
        console.log(`[first-admin] Log in at the web UI with this e-mail and the password you supplied;`);
        console.log("[first-admin] the app will ask you to set your own password before anything else.");
        console.log("[first-admin] Next: Employees -> register the PM staff as payroll employees, then Role Assignment -> set their role to PM.");
      }
    }
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  await prisma.$disconnect();
}
