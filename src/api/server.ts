// ============================================================================
// Lead Engine — Express Server
// Host: Google Cloud Run
//
// Routes:
//   GET  /health                    Cloud Run probe (unauthenticated)
//   POST /leads                     Manual lead ingestion
//   GET  /tier1_approve             HMAC-secured Tier 1 approval (unauthenticated — own auth)
//   GET  /tier1_reject              HMAC-secured Tier 1 rejection (unauthenticated — own auth)
//   GET  /followup_approve          HMAC-secured follow-up approval (unauthenticated — own auth)
//   GET  /followup_reject           HMAC-secured follow-up rejection (unauthenticated — own auth)
//   POST /webhooks/inbound-email    Reply triage + sentiment + calendar
//   POST /jobs/discovery-sweep      Cloud Scheduler: every 6 hours
//   POST /jobs/orchestrate          Cloud Scheduler: every 15 min
//   POST /jobs/follow-up-sweep      Cloud Scheduler: every 6 hours
//   POST /jobs/daily-digest         Cloud Scheduler: daily 08:00
//   POST /jobs/bounce-monitor       Cloud Scheduler: every 15 min
// ============================================================================

import express, { Request, Response, NextFunction } from "express";
import { prisma } from "../utils/prisma.js";
import { apiKeyGuard } from "../middleware/auth.js";

// Routers
import approvalsRouter from "./approvals.js";
import followUpApprovalsRouter from "./follow-up-approvals.js";
import inboundReplyRouter from "./inbound-reply.js";
import webhooksRouter from "./webhooks.js";

// Jobs
import { runDiscoverySweep } from "../discovery/discovery-sweep.js";
import { runOrchestrator } from "../jobs/orchestrator.js";
import { runFollowUpSweep } from "../jobs/follow-up-sweep.js";
import { runDailyDigest } from "../jobs/daily-digest.js";
import { runBounceMonitor } from "../jobs/bounce-monitor.js";

const app = express();

// ── Middleware ──
app.use(express.json({ limit: "1mb" }));

// Request logging
app.use((req: Request, _res: Response, next: NextFunction) => {
  const start = Date.now();
  _res.on("finish", () => {
    console.log(`${req.method} ${req.originalUrl} → ${_res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

// API key guard — protects all endpoints except /health and HMAC-secured ones
app.use(apiKeyGuard);

// ── Health check (exempt from API key) ──
app.get("/health", async (_req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ status: "healthy", service: "lead-engine", ts: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: "unhealthy", reason: "Database unreachable" });
  }
});

// ── API routers ──
app.use("/", approvalsRouter);
app.use("/", followUpApprovalsRouter);
app.use("/", inboundReplyRouter);
app.use("/", webhooksRouter);

// ── Cloud Scheduler job endpoints ──
app.post("/jobs/discovery-sweep", async (_req, res) => {
  try { res.json(await runDiscoverySweep()); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post("/jobs/orchestrate", async (_req, res) => {
  try { res.json(await runOrchestrator()); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post("/jobs/follow-up-sweep", async (_req, res) => {
  try { res.json(await runFollowUpSweep()); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post("/jobs/daily-digest", async (_req, res) => {
  try { res.json(await runDailyDigest()); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post("/jobs/bounce-monitor", async (_req, res) => {
  try { res.json(await runBounceMonitor()); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post("/jobs/cleanup", async (_req, res) => {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [errors, runs] = await Promise.all([
      prisma.errorLog.deleteMany({ where: { timestamp: { lt: cutoff } } }),
      prisma.discoveryRun.deleteMany({ where: { ranAt: { lt: cutoff } } }),
    ]);
    res.json({ deleted: { errorLogs: errors.count, discoveryRuns: runs.count } });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ── 404 ──
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found", path: `${_req.method} ${_req.originalUrl}` });
});

// ── Global error handler (Express 5 compatible) ──
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled:", err);
  try {
    prisma.errorLog.create({
      data: {
        scenarioName: "SERVER",
        moduleName: `${req.method} ${req.originalUrl}`,
        errorCode: "UNHANDLED",
        errorMessage: err.message,
        killSwitchFired: false,
      },
    }).catch(() => { /* swallow */ });
  } catch { /* swallow */ }
  if (!res.headersSent) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Start ──
const PORT = parseInt(process.env.PORT ?? "8080", 10);
const server = app.listen(PORT, () => {
  console.log(`Lead Engine on :${PORT} (${process.env.NODE_ENV ?? "dev"})`);
});

// ── Graceful shutdown (Cloud Run sends SIGTERM) ──
function shutdown(sig: string) {
  console.log(`${sig} — draining…`);
  server.close(async () => { await prisma.$disconnect(); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export default app;
