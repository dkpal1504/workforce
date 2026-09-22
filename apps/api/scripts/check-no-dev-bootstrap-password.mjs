#!/usr/bin/env node
// Production build gate: fail while a SHARED FIRST PASSWORD is hardcoded in the source.
//
// Contract workers and supervisors have no e-mail address, so a deployment may configure
// one shared first password that every new account starts with and must change at first
// login. That value belongs in the ENVIRONMENT (BOOTSTRAP_PASSWORD in .env /
// .env.production), never as a literal here: a literal ships inside the image and stays
// in git history, which is how a published secret leaks.
//
// This check therefore allows the environment-configured password and refuses only a
// literal assignment in src/services/defaultLoginCredentials.ts, i.e. the exact mistake
// that would put a shared secret back into the repository.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(here, "../src/services/defaultLoginCredentials.ts");

const offenders = [];
let source;
try {
  source = readFileSync(target, "utf8");
} catch (error) {
  console.error(`[build-gate] cannot read ${target}: ${error.message}`);
  process.exit(1);
}

source.split(/\r?\n/).forEach((line, index) => {
  // Ignore comment lines so the documentation can name the environment variable.
  if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
  // A literal password assigned in this module is the failure mode: the deployment may
  // read BOOTSTRAP_PASSWORD from the environment, but must never bake a value into git.
  if (/^\s*(export\s+)?const\s+\w*(BOOTSTRAP|PASSWORD)\w*[^=]*=\s*["'`][^"'`]+["'`]/.test(line)) {
    offenders.push(`  ${path.relative(process.cwd(), target)}:${index + 1}: ${line.trim()}`);
  }
});

if (offenders.length) {
  console.error(
    [
      "[build-gate] Refusing to build: a shared first password is hardcoded in the source.",
      ...offenders,
      "",
      "A shared first password must come from the environment, not from the repository:",
      "  BOOTSTRAP_PASSWORD=...        # .env / .env.production, never committed",
      "Remove the literal from src/services/defaultLoginCredentials.ts; every call site",
      "routes through initialCredentialState(), which reads the environment value and, when",
      "it is unset, falls back to random e-mailed one-time credentials.",
    ].join("\n"),
  );
  process.exit(1);
}

console.log("[build-gate] No hardcoded shared password in the source.");
