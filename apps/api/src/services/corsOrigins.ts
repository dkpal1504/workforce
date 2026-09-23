/**
 * CORS origin policy.
 *
 * The SPA is served from the SAME origin as the API (nginx proxies /api/ to the api
 * container), and browsers send an `Origin` header on POST / PUT / PATCH / DELETE even for
 * same-origin requests. A configured list must therefore never be able to break same-origin
 * use - but a genuine cross-origin caller that is not on the list must still be refused.
 *
 * Two failure modes are ruled out here:
 *   1. The old code threw inside the CORS middleware when the origin was not listed. The
 *      global error handler turned that into `500 {"error":"Internal server error"}`, so a
 *      mis-typed CORS_ORIGINS looked like a broken login (and would break every write).
 *   2. A request with no Origin header at all (curl, health probes, server-to-server) is
 *      always allowed - it cannot be a browser cross-origin call.
 */

/** `http://host:port` as the browser sees it, honouring the proxy headers when trusted. */
export function requestOrigin(req: {
  protocol?: string;
  get?: (name: string) => string | undefined;
  headers?: Record<string, unknown>;
}): string {
  const header = (name: string): string => {
    const fromGet = typeof req.get === "function" ? req.get(name) : undefined;
    if (fromGet) return fromGet;
    const raw = req.headers?.[name.toLowerCase()] ?? req.headers?.[name];
    return Array.isArray(raw) ? String(raw[0] ?? "") : raw == null ? "" : String(raw);
  };
  const forwardedProto = header("x-forwarded-proto").split(",")[0]?.trim();
  const protocol = forwardedProto || req.protocol || "http";
  const host = header("host");
  return host ? `${protocol}://${host}` : "";
}

/** True when this Origin may proceed. `origin` undefined/empty means "not a browser call". */
export function isAllowedOrigin(
  origin: string | undefined | null,
  options: { configured: string[]; sameOrigin: string },
): boolean {
  if (!origin) return true;
  if (options.configured.includes(origin)) return true;
  // Same-origin POSTs carry an Origin header, so this is the case that must never fail.
  return options.sameOrigin !== "" && origin === options.sameOrigin;
}
