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
