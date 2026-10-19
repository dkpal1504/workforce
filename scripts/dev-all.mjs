#!/usr/bin/env node
/**
 * Run the WHOLE app from ONE terminal.
 *
 * WHY THIS EXISTS: `npm run dev` cannot do it. `npm run dev --workspaces --if-present` runs the
 * workspaces ONE AFTER ANOTHER, and the API's `tsx watch` never exits — so the web server is never
 * reached (verified: only the api half starts, then the port clash kills it). The alternative was
 * two terminal tabs, which is exactly the chore this script removes.
 *
 * It spawns both dev servers, prefixes every line with `[api]` / `[web]` so interleaved output stays
 * readable, and stops BOTH when either one dies or you press Ctrl+C.
 *
 * Usage:  npm run dev:all
 */
import { spawn } from "node:child_process";

const targets = [
  { name: "api", colour: "\x1b[36m", args: ["run", "dev", "-w", "@workforce/api"] },
  { name: "web", colour: "\x1b[35m", args: ["run", "dev", "-w", "@workforce/web"] },
];

const children = [];
let stopping = false;

function stop(reason) {
  if (stopping) return;
  stopping = true;
  if (reason) console.log(`\n${reason}`);
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    // Kill the whole process GROUP: npm -> tsx/vite -> node. Killing only npm leaves the real
    // server holding the port (the "old code keeps serving" trap on this mount).
    try {
      if (process.platform === "win32") child.kill("SIGTERM");
      else process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
  const force = setTimeout(() => {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    process.exit(0);
  }, 2000);
  force.unref();
}

for (const { name, colour, args } of targets) {
  const child = spawn("npm", args, { stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  children.push(child);
  const prefix = `${colour}[${name}]\x1b[0m `;
  for (const stream of [child.stdout, child.stderr]) {
    let pending = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) process.stdout.write(prefix + line + "\n");
    });
  }
  child.on("error", (error) => {
    console.error(prefix + error.message);
    stop("Could not start a dev server — stopping.");
  });
  child.on("exit", (code, signal) => {
    const how = signal ? `signal ${signal}` : `exit code ${code}`;
    console.log(`${prefix}stopped (${how})`);
    if (!stopping) {
      stop(
        code === 0
          ? "One dev server exited — stopping the other so no orphan keeps holding a port."
          : `One dev server failed (${how}) — stopping the other. Read the lines above for the reason.`
      );
    }
  });
}

process.on("SIGINT", () => stop("Ctrl+C — stopping both dev servers."));
process.on("SIGTERM", () => stop("Terminated — stopping both dev servers."));

console.log(
  `Starting ${targets.map((t) => t.name).join(" + ")} in this one terminal.\n` +
    "  API  http://localhost:4000   Web  http://localhost:5173   (Ctrl+C stops both)\n"
);
