#!/usr/bin/env node
/**
 * Make the dev database reachable BEFORE the dev servers start.
 *
 * WHY THIS EXISTS: on this machine the dev Postgres is the PostgreSQL 18 cluster that runs
 * INSIDE WSL (`pg_lsclusters` -> 18/main on port 5433, the restored production copy). Windows
 * reaches it only through WSL's localhost relay: netstat on Windows shows
 *   127.0.0.1:5433 LISTENING wslrelay.exe
 * so when the distro is not running there is NO listener at all and Prisma answers
 *   Can't reach database server at `127.0.0.1:5433`
 * — a sentence about the database for a problem that is entirely "WSL was not up when the app
 * started" (measured: the API was started at 04:16:55 UTC, the distro booted at 04:20:30 UTC).
 * WSL also stops the distro ~a minute after its last process exits, so an app left running
 * across that idle timeout loses its database mid-session with the same error.
 *
 * So: probe DATABASE_URL's host:port, wake the distro when it is ours to wake, wait for the
 * port instead of racing it, and hand back a keep-alive child that holds the distro open for
 * as long as the dev servers run. Never guess a credential: only the port is probed here.
 *
 * Imported by `scripts/dev-all.mjs`; also runnable alone:
 *   node scripts/dev-db-preflight.mjs
 *   DEV_DB_WAIT_MS=3000 node scripts/dev-db-preflight.mjs   # don't wait long
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** DATABASE_URL resolution ORDER must match the API's: root .env wins, then apps/api/.env. */
export function readDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const file of [join(repoRoot, ".env"), join(repoRoot, "apps", "api", ".env")]) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line.startsWith("DATABASE_URL=")) continue;
      return line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
    }
  }
  return null;
}

function probe(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok, reason) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve({ ok, reason });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false, "timed out"));
    socket.once("error", (error) => done(false, error.code || error.message));
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Windows: boot the distro (and thus its Postgres cluster) without needing a password. */
function wakeWsl() {
  return new Promise((resolve) => {
    const child = spawn("wsl.exe", ["-e", "true"], { stdio: "ignore", windowsHide: true });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}

/**
 * `sleep infinity` inside the distro holds it open: WSL only tears the VM down once its last
 * process exits, which is what killed the database under a running app.
 */
function startWslKeepAlive() {
  const child = spawn("wsl.exe", ["-e", "sleep", "infinity"], {
    stdio: "ignore",
    windowsHide: true,
  });
  child.once("error", () => {});
  return child;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);

/**
 * @returns {Promise<{ok: true, url: string, host: string, port: string, keepAlive?: import('node:child_process').ChildProcess} | {ok: false, message: string}>}
 */
export async function ensureDatabaseReachable({ log = console.log, waitMs } = {}) {
  const url = readDatabaseUrl();
  if (!url) {
    return { ok: false, message: "DATABASE_URL is not set in the environment, .env or apps/api/.env." };
  }
  if (url.startsWith("file:")) {
    log(`[db] SQLite (${url}) — no server to reach.`);
    return { ok: true, url, host: "", port: "" };
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, message: `DATABASE_URL is not a URL this check understands: ${url}` };
  }
  const host = parsed.hostname;
  const port = parsed.port || "5432";
  const budget = Number(waitMs ?? process.env.DEV_DB_WAIT_MS ?? 30000);

  const first = await probe(host, port);
  if (first.ok) {
    log(`[db] ${host}:${port} reachable.`);
    return { ok: true, url, host, port };
  }

  log(`[db] ${host}:${port} is not accepting connections (${first.reason}).`);

  const onWindows = process.platform === "win32";
  const isWslBacked = onWindows && LOOPBACK.has(host);
  if (!isWslBacked) {
    return {
      ok: false,
      message:
        `Database server at ${host}:${port} is not reachable (${first.reason}).\n` +
        "  Start it (WSL/Docker/service) and run this again — the dev servers were NOT started,\n" +
        "  because every screen would only fail with the same Prisma error.",
    };
  }

  // WSL-backed loopback: wake the distro, then POLL the port rather than sleeping a fixed guess.
  log("[db] waking WSL (the local Postgres cluster lives inside it)…");
  const woke = await wakeWsl();
  if (!woke) {
    return {
      ok: false,
      message:
        "Could not run `wsl.exe` to start the distro that hosts the dev Postgres.\n" +
        "  Check `wsl -l -v` lists Ubuntu, then run `wsl -e true` by hand.",
    };
  }

  const deadline = Date.now() + budget;
  let last = first.reason;
  while (Date.now() < deadline) {
    const attempt = await probe(host, port);
    if (attempt.ok) {
      log(`[db] ${host}:${port} reachable after waking WSL.`);
      return { ok: true, url, host, port, keepAlive: startWslKeepAlive() };
    }
    last = attempt.reason;
    await sleep(500);
  }

  return {
    ok: false,
    message:
      `WSL started but nothing is listening on ${host}:${port} after ${Math.round(budget / 1000)}s (${last}).\n` +
      "  The cluster did not come up. Inside WSL check: `pg_lsclusters` should show `18  main  5433  online`,\n" +
      "  and start it with `sudo pg_ctlcluster 18 main start`. The dev servers were NOT started.",
  };
}

// Direct run: report and exit, useful as a pre-flight on its own.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = await ensureDatabaseReachable();
  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
  }
  if (result.keepAlive) {
    // One-shot check: don't hold WSL open on the operator's behalf.
    result.keepAlive.kill();
  }
}
