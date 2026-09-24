import test from "node:test";
import assert from "node:assert/strict";
import { isAllowedOrigin, requestOrigin } from "./corsOrigins";

const configured = ["http://10.5.1.193:8099", "https://workforce.swan.co.in"];

test("a request with no Origin header is allowed (curl, health probes)", () => {
  assert.equal(isAllowedOrigin(undefined, { configured, sameOrigin: "http://10.5.1.193:8099" }), true);
  assert.equal(isAllowedOrigin("", { configured, sameOrigin: "http://10.5.1.193:8099" }), true);
});

test("a listed origin is allowed", () => {
  assert.equal(isAllowedOrigin("https://workforce.swan.co.in", { configured, sameOrigin: "" }), true);
});

test("the SAME origin is allowed even when it is missing from the list", () => {
  // The production trap: browsers send Origin on same-origin POSTs, so a list that names only
  // the eventual HTTPS name must not break login over the LAN IP.
  assert.equal(
    isAllowedOrigin("http://10.5.1.193:8099", { configured: ["https://workforce.swan.co.in"], sameOrigin: "http://10.5.1.193:8099" }),
    true
  );
  assert.equal(
    isAllowedOrigin("http://10.5.1.193:8099", { configured: [], sameOrigin: "http://10.5.1.193:8099" }),
    true
  );
});

test("a different cross-origin caller is refused", () => {
  assert.equal(isAllowedOrigin("http://evil.example.com", { configured, sameOrigin: "http://10.5.1.193:8099" }), false);
  assert.equal(isAllowedOrigin("http://10.5.1.193:8098", { configured, sameOrigin: "http://10.5.1.193:8099" }), false);
});

test("requestOrigin reads the proxy headers when they are present", () => {
  const proxied = {
    protocol: "http",
    get: (name: string) =>
      name.toLowerCase() === "host" ? "workforce.swan.co.in" : name.toLowerCase() === "x-forwarded-proto" ? "https" : undefined,
  };
  assert.equal(requestOrigin(proxied), "https://workforce.swan.co.in");
  const direct = { protocol: "http", get: (name: string) => (name.toLowerCase() === "host" ? "10.5.1.193:8099" : undefined) };
  assert.equal(requestOrigin(direct), "http://10.5.1.193:8099");
  assert.equal(requestOrigin({ protocol: "http", get: () => undefined, headers: {} }), "");
});

test("an EMPTY list means not configured, which is local development (Vite on another port)", () => {
  assert.equal(isAllowedOrigin("http://localhost:5173", { configured: [], sameOrigin: "http://localhost:4000" }), true);
  assert.equal(isAllowedOrigin("http://10.5.1.193:8099", { configured: [], sameOrigin: "http://127.0.0.1:4000" }), true);
  // Production always has a list (the boot gate refuses an empty one), so the strict path holds there.
  assert.equal(
    isAllowedOrigin("http://localhost:5173", { configured: ["http://10.5.1.193:8099"], sameOrigin: "http://10.5.1.193:8099" }),
    false
  );
});

test("a forwarded host that KEEPS the port makes the same-origin check work (nginx $http_host)", () => {
  // The proxy used to send `Host: workforce.swan.co.in` (no port) while the browser sent
  // `Origin: http://workforce.swan.co.in:8099`, so a same-origin POST looked foreign and was
  // refused unless that exact origin was listed too. nginx now forwards $http_host.
  const req = {
    protocol: "http",
    get: (name: string) => (name.toLowerCase() === "host" ? "workforce.swan.co.in:8099" : undefined),
  };
  assert.equal(requestOrigin(req), "http://workforce.swan.co.in:8099");
  assert.equal(
    isAllowedOrigin("http://workforce.swan.co.in:8099", { configured: ["https://workforce.swan.co.in"], sameOrigin: requestOrigin(req) }),
    true
  );
  // And a bare host (the old behaviour) does NOT match a ported origin - which is the bug.
  assert.equal(
    isAllowedOrigin("http://workforce.swan.co.in:8099", { configured: ["https://workforce.swan.co.in"], sameOrigin: "http://workforce.swan.co.in" }),
    false
  );
});
