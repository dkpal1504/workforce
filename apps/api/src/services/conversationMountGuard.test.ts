import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * THE MOUNT GUARD — a source-level test for a bug that unit tests could not see.
 *
 * `routes/conversations.ts` is mounted at "/" so it can answer both `/conversations/…` and
 * `/job-orders/…`. That means a ROUTER-LEVEL `use(requireRoles(...))` runs for every request that
 * reaches the mount — including `/departments` and `/teams/pool`, which belong to other routers. A
 * Supervisor is not a conversation role, so the blanket gate answered 403 before masters or teams was
 * consulted: the whole application died for Supervisors, Employees, HR and Finance, and it presented
 * as "the Department dropdown is blank" on Select Team.
 *
 * The gate therefore has to be applied per route, where a non-matching path falls through via next().
 * This test reads the source and refuses a regression, because the failure is a MOUNT behaviour and
 * shows up only when a role outside the list calls an unrelated endpoint.
 */

const apiRoot = process.cwd();
const routeSource = readFileSync(path.join(apiRoot, "src/routes/conversations.ts"), "utf8");
const indexSource = readFileSync(path.join(apiRoot, "src/index.ts"), "utf8");

test("the conversations router has NO router-level use() gate", () => {
  assert.equal(
    /conversationsRouter\.use\(/.test(routeSource),
    false,
    "a router-level use() on a router mounted at '/' gates every other route in the app"
  );
});

test("every route carries the guard itself", () => {
  const registrations = [...routeSource.matchAll(/conversationsRouter\.(get|post|put)\(([\s\S]{0,160})/g)];
  assert.ok(registrations.length >= 10, `expected the router's routes, found ${registrations.length}`);
  for (const [, method, after] of registrations) {
    assert.equal(
      after.includes("...guarded"),
      true,
      `conversationsRouter.${method}(...) is missing the guard — a role outside CONVERSATION_ROLES could reach it`
    );
  }
});

test("the router is still mounted at '/' and BEFORE masters, which is why the rule exists", () => {
  const conversationsAt = indexSource.indexOf('api.use("/", conversationsRouter)');
  const mastersAt = indexSource.indexOf('api.use("/", mastersRouter)');
  assert.equal(conversationsAt > -1, true, "conversationsRouter must be mounted at '/' for /job-orders/…");
  assert.equal(mastersAt > -1, true, "mastersRouter must be mounted at '/'");
  assert.equal(
    conversationsAt < mastersAt,
    true,
    "order changed: if masters now runs first, re-check that both routers still receive every path"
  );
});
