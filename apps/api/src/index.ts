import path from "path";
import dotenv from "dotenv";

// Load root .env then local
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
dotenv.config();

import "express-async-errors";
import express from "express";
import cors from "cors";
import { isAllowedOrigin, requestOrigin } from "./services/corsOrigins";
import { rateLimit } from "express-rate-limit";
import { authRouter } from "./routes/auth";
import { mastersRouter } from "./routes/masters";
import { teamsRouter } from "./routes/teams";
import { timesheetRouter } from "./routes/timesheet";
import { summaryRouter } from "./routes/summary";
import { adminRouter } from "./routes/admin";
import { approvalsRouter } from "./routes/approvals";
import { supervisorRegistrationRouter } from "./routes/supervisorRegistration";
import { employeeAllocationRouter } from "./routes/employeeAllocation";
import { csvUploadRouter } from "./routes/csvUpload";
import { masterDataRouter } from "./routes/masterData";
import { jobOrderCsvRouter } from "./routes/jobOrderCsv";
import { jobOrderProgressRouter } from "./routes/jobOrderProgress";
import { delegationRouter } from "./routes/delegations";
import { startBadgeViewSyncScheduler, stopBadgeViewSyncScheduler } from "./services/badgeViewSyncScheduler";
import { attendanceHoursRouter } from "./routes/attendanceHours";
import { startAttendanceHoursScheduler, stopAttendanceHoursScheduler } from "./services/attendanceHoursScheduler";
import { prisma } from "./db";
import { assertBootstrapPasswordUsable, bootstrapPasswordNotice } from "./services/defaultLoginCredentials";

const app = express();
const port = Number(process.env.API_PORT || 4000);
const host = process.env.API_HOST || "0.0.0.0";
const databaseUrl = process.env.DATABASE_URL || "";
// `file:` URLs select the local test database (SQLite dev build only). They are
// rejected outright in production, where a PostgreSQL URL is required.
const isLocalTestDb = databaseUrl.startsWith("file:");
if (isLocalTestDb && process.env.NODE_ENV === "production") {
  throw new Error("SQLite is not permitted in production. A PostgreSQL DATABASE_URL is required.");
}
if (!isLocalTestDb && !databaseUrl.startsWith("postgresql://") && !databaseUrl.startsWith("postgres://")) {
  throw new Error("DATABASE_URL must be a PostgreSQL URL, or a file: URL for local SQLite testing.");
}
// BOOTSTRAP_PASSWORD (see services/defaultLoginCredentials.ts) provisions every new
// contract account with one shared first password that MUST be changed at first
// login. It is configuration, never a literal in the source, so the only checks
// here are that the value is usable and that the deployment is told it is in use.
assertBootstrapPasswordUsable();
const bootstrapNotice = bootstrapPasswordNotice();
if (bootstrapNotice) console.warn(`[auth] ${bootstrapNotice}`);
let shuttingDown = false;

app.disable("x-powered-by");
if (process.env.TRUST_PROXY === "true") app.set("trust proxy", 1);

const configuredOrigins = (process.env.CORS_ORIGINS || "").split(",").map((origin) => origin.trim()).filter(Boolean);
if (process.env.NODE_ENV === "production") {
  const secret = process.env.JWT_SECRET || "";
  if (secret.length < 32 || /change-me|replace/i.test(secret)) {
    throw new Error("JWT_SECRET must be a non-placeholder secret of at least 32 characters in production.");
  }
  if (!process.env.DATABASE_URL?.startsWith("postgresql://")) {
    throw new Error("A PostgreSQL DATABASE_URL is required in production.");
  }
  if (configuredOrigins.length === 0 || configuredOrigins.some((origin) => {
    try { return new URL(origin).origin !== origin; } catch { return true; }
  })) {
    throw new Error("CORS_ORIGINS must contain exact, valid origins in production.");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("API_PORT must be an integer from 1 to 65535.");
  }
}
// CORS. The SPA is served from the SAME origin as the API, and browsers send an `Origin`
// header on POST/PUT/PATCH/DELETE even then - so a CORS_ORIGINS list that names only the
// eventual hostname must never break same-origin use. That mistake used to surface as
// `500 Internal server error` on every login and every save (the CORS middleware threw and the
// global error handler hid the reason). It is now checked before CORS runs:
//   - no Origin header  -> allowed (curl, health probes, server-to-server)
//   - a listed origin   -> allowed (CORS_ORIGINS accepts a comma-separated list)
//   - the API's own origin -> allowed, because that is the SPA itself
//   - anything else     -> 403 ORIGIN_NOT_ALLOWED with the origin in the body and the log,
//                          instead of an opaque 500
// An EMPTY CORS_ORIGINS means "not configured": every origin is allowed, which is what local
// development needs (Vite serves the SPA on 5173 and proxies to the API on 4000, so the call
// arrives cross-origin). Production cannot run with an empty list - the boot gate above refuses.
app.use((req, res, next) => {
  const origin = req.get("origin");
  const sameOrigin = requestOrigin(req);
  if (origin && !isAllowedOrigin(origin, { configured: configuredOrigins, sameOrigin })) {
    console.warn(
      `[cors] refused origin "${origin}" (this API is served as "${sameOrigin || "unknown"}"); ` +
        `CORS_ORIGINS=${configuredOrigins.join(",") || "(empty)"}`
    );
    return res.status(403).json({
      error: "This origin is not allowed to call the API.",
      code: "ORIGIN_NOT_ALLOWED",
      origin,
    });
  }
  next();
});
app.use(cors({ credentials: false, origin: true }));
app.use(express.json({ limit: "2mb" }));
// Brute-force protection on login. In production the strict default matters, so it
// stays enforced unless it is disabled explicitly. For local testing set
// AUTH_RATE_LIMIT_ENABLED=false in .env to remove it.
const authRateLimitEnabled = process.env.AUTH_RATE_LIMIT_ENABLED !== "false";
if (!authRateLimitEnabled && process.env.NODE_ENV === "production") {
  throw new Error("AUTH_RATE_LIMIT_ENABLED must be true in production.");
}
if (authRateLimitEnabled) {
  app.use("/api/auth/login", rateLimit({
    windowMs: Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000),
    limit: Number(process.env.AUTH_RATE_LIMIT_MAX || 10),
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Too many login attempts. Try again later.", code: "RATE_LIMITED" },
  }));
} else {
  console.warn("[auth] Login rate limiting is DISABLED (AUTH_RATE_LIMIT_ENABLED=false). Local testing only — never use this in production.");
}

const live = (_req: express.Request, res: express.Response) =>
  res.status(shuttingDown ? 503 : 200).json({ ok: !shuttingDown });
const ready = async (_req: express.Request, res: express.Response) => {
  if (shuttingDown) return res.status(503).json({ ok: false });
  try {
    await prisma.$queryRaw`SELECT 1`;
    return res.json({ ok: true });
  } catch (error) {
    console.error("Database readiness check failed:", error);
    return res.status(503).json({ ok: false, error: "Database unavailable" });
  }
};
app.get("/health/live", live);
app.get("/health/ready", ready);
app.get("/health", ready);
app.get("/api/health/live", live);
app.get("/api/health/ready", ready);
app.get("/api/health", ready);

// All app APIs under /api so Vite SPA routes (/timesheet, /summary, /approvals) are not proxied away
const api = express.Router();
api.use("/auth", authRouter);
api.use("/", mastersRouter);
api.use("/teams", teamsRouter);
api.use("/timesheet", timesheetRouter);
api.use("/summary", summaryRouter);
api.use("/approvals", approvalsRouter);
api.use("/admin", adminRouter);
api.use("/supervisors", supervisorRegistrationRouter);
api.use("/allocations", employeeAllocationRouter);
api.use("/csv-upload", csvUploadRouter);
// CR master data: Job Order upload, quantity progress, Project/WBS/UoM/Network masters
api.use("/job-order-upload", jobOrderCsvRouter);
api.use("/job-order-progress", jobOrderProgressRouter);
api.use("/master-data", masterDataRouter);
api.use("/delegations", delegationRouter);
// Clocked attendance hours (in/out) for submitted timesheets, ADMIN only.
api.use("/attendance-hours", attendanceHoursRouter);
app.use("/api", api);

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : err.message || "Internal error" });
});

const server = app.listen(port, host, () => {
  console.log(`API listening on http://${host}:${port}`);
  startBadgeViewSyncScheduler();
  startAttendanceHoursScheduler();
});

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received; shutting down.`);
  stopBadgeViewSyncScheduler();
  stopAttendanceHoursScheduler();
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
process.on("SIGINT", () => { void shutdown("SIGINT"); });
