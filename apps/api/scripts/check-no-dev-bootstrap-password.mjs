#!/usr/bin/env node
// Production build gate: fail while the local dev bootstrap password is still in
// the source. Every account registered from the web UI is provisioned with that
// one password, so a production image built with it in place would give every new
// employee a published, shared credential.
//
// Remove DEV_BOOTSTRAP_PASSWORD (and assertDevBootstrapAllowed) from
// src/services/defaultLoginCredentials.ts to satisfy this check.
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
  // Ignore comment lines so the removal instructions can name the constant.
  if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
  // Fail only while a literal password is assigned; the removal step is nulling it.
  if (/DEV_BOOTSTRAP_PASSWORD[^=]*=\s*["'`]/.test(line)) {
    offenders.push(`  ${path.relative(process.cwd(), target)}:${index + 1}: ${line.trim()}`);
  }
});

if (offenders.length) {
  console.error(
    [
      "[build-gate] Refusing to build: the local dev bootstrap password is still enabled.",
      ...offenders,
      "",
      "Every account created from the web UI currently gets one shared password.",
      "Set DEV_BOOTSTRAP_PASSWORD to null in",
      "src/services/defaultLoginCredentials.ts — all call sites route through",
      "initialCredentialState() and revert to random e-mailed credentials automatically.",
    ].join("\n"),
  );
  process.exit(1);
}

console.log("[build-gate] No dev bootstrap password in the source.");
