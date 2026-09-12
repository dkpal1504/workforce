import path from "path";
import dotenv from "dotenv";

// Load root .env then local
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
dotenv.config();

import "express-async-errors";
import express from "express";
import cors from "cors";
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
import { startBadgeViewSyncScheduler } from "./services/badgeViewSyncScheduler";

const app = express();
const port = Number(process.env.API_PORT || 4000);
const host = process.env.API_HOST || "0.0.0.0";

const configuredOrigins = (process.env.CORS_ORIGINS || "").split(",").map((origin) => origin.trim()).filter(Boolean);
if (process.env.NODE_ENV === "production" && configuredOrigins.length === 0) {
  throw new Error("CORS_ORIGINS is required in production.");
}
app.use(cors({
  credentials: false,
  origin(origin, callback) {
    if (!origin || configuredOrigins.length === 0 || configuredOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Origin is not allowed by CORS."));
  },
}));
app.use(express.json({ limit: "2mb" }));
app.use("/api/auth/login", rateLimit({
  windowMs: Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000),
  limit: Number(process.env.AUTH_RATE_LIMIT_MAX || 10),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many login attempts. Try again later.", code: "RATE_LIMITED" },
}));

app.get("/health", (_req, res) => res.json({ ok: true, maxDailyHours: Number(process.env.MAX_DAILY_HOURS || 8) }));
app.get("/api/health", (_req, res) => res.json({ ok: true, maxDailyHours: Number(process.env.MAX_DAILY_HOURS || 8) }));

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
app.use("/api", api);

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : err.message || "Internal error" });
});

app.listen(port, host, () => {
  console.log(`API listening on http://${host}:${port}`);
  console.log(`LAN example: http://10.5.18.209:${port} (use Vite URL for the UI)`);
  startBadgeViewSyncScheduler();
});
