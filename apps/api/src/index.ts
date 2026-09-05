import path from "path";
import dotenv from "dotenv";

// Load root .env then local
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
dotenv.config();

import express from "express";
import cors from "cors";
import { authRouter } from "./routes/auth";
import { mastersRouter } from "./routes/masters";
import { teamsRouter } from "./routes/teams";
import { timesheetRouter } from "./routes/timesheet";
import { summaryRouter } from "./routes/summary";
import { adminRouter } from "./routes/admin";
import { approvalsRouter } from "./routes/approvals";
import { supervisorRegistrationRouter } from "./routes/supervisorRegistration";
import { employeeAllocationRouter } from "./routes/employeeAllocation";
import { startBadgeViewSyncScheduler } from "./services/badgeViewSyncScheduler";

const app = express();
const port = Number(process.env.API_PORT || 4000);
const host = process.env.API_HOST || "0.0.0.0";

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "2mb" }));

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
app.use("/api", api);

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err.message || "Internal error" });
});

app.listen(port, host, () => {
  console.log(`API listening on http://${host}:${port}`);
  console.log(`LAN example: http://10.5.18.209:${port} (use Vite URL for the UI)`);
  startBadgeViewSyncScheduler();
});
