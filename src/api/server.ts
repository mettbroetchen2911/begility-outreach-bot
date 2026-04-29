import express, { Request, Response, NextFunction } from "express";
import { prisma } from "../utils/prisma.js";
import { apiKeyGuard } from "../middleware/auth.js";
import { preflightBedrock } from "../utils/bedrock.js";

// Routers
import botMessagesRouter from "./bot-messages.js";
import inboundReplyRouter from "./inbound-reply.js";
import webhooksRouter from "./webhooks.js";
import graphNotificationsRouter from "./graph-notifications.js";

// Jobs
import { runDiscoverySweep } from "../discovery/discovery-sweep.js";
import { runOrchestrator } from "../jobs/orchestrator.js";
import { runFollowUpSweep } from "../jobs/follow-up-sweep.js";
import { runDailyDigest } from "../jobs/daily-digest.js";
import { runBounceMonitor } from "../jobs/bounce-monitor.js";
import { ensureGraphSubscription } from "../jobs/graph-subscription-manager.js";

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

// ── Bot Framework endpoint — BEFORE apiKeyGuard (bot uses its own auth) ──
app.use("/", botMessagesRouter);

// Graph change notifications webhook — BEFORE apiKeyGuard
// (authenticated via clientState + validationToken handshake, not API key)
app.use("/", graphNotificationsRouter);

// API key guard — protects remaining endpoints except /health
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

// Graph subscription lifecycle endpoint — called by Cloud Scheduler every 12h
app.post("/jobs/graph-subscription-renew", async (_req, res) => {
  try { res.json(await ensureGraphSubscription()); }
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

app.post("/admin/seed-bot-ref", async (req, res) => {
  try {
    const { channelType, conversationId, serviceUrl, tenantId, botId } = req.body;
    if (!channelType || !conversationId || !serviceUrl || !tenantId || !botId) {
      res.status(400).json({ error: "Missing required fields: channelType, conversationId, serviceUrl, tenantId, botId" });
      return;
    }
    const ref = {
      channelId: "msteams",
      serviceUrl,
      conversation: { id: conversationId, isGroup: true, conversationType: "channel", tenantId },
      bot: { id: botId, name: "Begility Lead Engine" },
    };
    await prisma.botConversationRef.upsert({
      where: { channelType },
      create: { channelType, conversationReference: ref },
      update: { conversationReference: ref },
    });
    res.json({ ok: true, channelType, conversationId });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
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

let server: ReturnType<typeof app.listen>;

async function bootstrap() {
  await preflightBedrock();

  server = app.listen(PORT, () => {
    console.log(`Lead Engine on :${PORT} (${process.env.NODE_ENV ?? "dev"})`);

    // Bootstrap the Graph sent-items subscription on boot if configured.
    // No-op if the existing sub still has enough headroom.
    if (process.env.GRAPH_NOTIFY_URL && process.env.GRAPH_CLIENT_STATE_SECRET) {
      ensureGraphSubscription()
        .then((r) => console.log(`[graph-sub] bootstrap: ${r.action} ${r.subscriptionId}${r.reason ? " (" + r.reason + ")" : ""}`))
        .catch((e) => console.error(`[graph-sub] bootstrap failed: ${e instanceof Error ? e.message : String(e)}`));
    }
  });
}

bootstrap().catch((err) => {
  console.error("Bootstrap failed:", err);
  process.exit(1);
});

// ── Graceful shutdown (Cloud Run sends SIGTERM) ──
function shutdown(sig: string) {
  console.log(`${sig} — draining…`);
  if (server) {
    server.close(async () => { await prisma.$disconnect(); process.exit(0); });
  } else {
    prisma.$disconnect().finally(() => process.exit(0));
  }
  setTimeout(() => process.exit(1), 10_000);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export default app;
