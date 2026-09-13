#!/usr/bin/env node
/**
 * Provider-aware database schema step.
 *
 * - PostgreSQL DATABASE_URL  -> `prisma migrate deploy` (production path; uses the
 *   reviewed SQL under prisma/migrations, whose migration_lock is postgresql).
 * - file: DATABASE_URL       -> `prisma db push` (local SQLite test database; the
 *   PostgreSQL migration SQL cannot be applied to SQLite).
 *
 * This keeps `npm run db:setup` working in both environments without weakening the
 * production migration flow.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(here, "..");
const repoRoot = path.resolve(apiDir, "../..");

// Same precedence as src/index.ts: the root .env wins, apps/api/.env fills gaps.
dotenv.config({ path: path.join(repoRoot, ".env") });
dotenv.config({ path: path.join(apiDir, ".env") });

const url = process.env.DATABASE_URL || "";
const isSqlite = url.startsWith("file:");

if (!isSqlite && !url.startsWith("postgresql://") && !url.startsWith("postgres://")) {
  console.error(
    `DATABASE_URL must be a PostgreSQL URL, or a file: URL for local SQLite testing (got: ${url || "<unset>"}).`
  );
  process.exit(1);
}

const args = isSqlite ? ["db", "push", "--skip-generate"] : ["migrate", "deploy"];
console.log(
  `db:migrate -> prisma ${args.join(" ")}  [${isSqlite ? "SQLite local test database" : "PostgreSQL"}]`
);

const result = spawnSync("npx", ["prisma", ...args], {
  cwd: apiDir,
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(result.status ?? 1);
