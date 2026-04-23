import { prisma } from "../utils/prisma.js";
import { EmailService } from "../services/email.service.js";
import { logError } from "../utils/logger.js";

const REP_EMAIL = process.env.REP_EMAIL ?? "";
const GRAPH_NOTIFY_URL = process.env.GRAPH_NOTIFY_URL ?? "";
const CLIENT_STATE = process.env.GRAPH_CLIENT_STATE_SECRET ?? "";

// Max for /mailFolders/{id}/messages is 4230 minutes; request slightly less
// to leave headroom for clock skew between Graph and our DB.
const MAX_EXPIRY_MINUTES = 4200;

// Don't renew if we still have this much headroom — reduces Graph API churn.
const RENEW_WHEN_REMAINING_HOURS = 12;

const RESOURCE = `/users/${REP_EMAIL}/mailFolders/SentItems/messages`;
const CHANGE_TYPE = "created,updated";

export interface SubscriptionOutcome {
  action: "none" | "created" | "renewed" | "recreated";
  subscriptionId: string;
  expirationDateTime: string;
  reason?: string;
}

export async function ensureGraphSubscription(): Promise<SubscriptionOutcome> {
  if (!GRAPH_NOTIFY_URL) {
    throw new Error("GRAPH_NOTIFY_URL env var is required to manage Graph subscriptions");
  }
  if (!CLIENT_STATE) {
    throw new Error("GRAPH_CLIENT_STATE_SECRET env var is required to manage Graph subscriptions");
  }
  if (!REP_EMAIL) {
    throw new Error("REP_EMAIL env var is required to manage Graph subscriptions");
  }

  const emailSvc = new EmailService();
  const token = await emailSvc.getGraphToken();
  const now = Date.now();
  const newExpiry = new Date(now + MAX_EXPIRY_MINUTES * 60_000);

  // Find the most recent subscription we've created for this resource
  const existing = await prisma.graphSubscription.findFirst({
    where: { resource: RESOURCE },
    orderBy: { expirationDateTime: "desc" },
  });

  // ── Case 1: fresh enough — skip ────────────────────────────────────────
  if (existing && existing.expirationDateTime.getTime() > now + RENEW_WHEN_REMAINING_HOURS * 3600_000) {
    return {
      action: "none",
      subscriptionId: existing.subscriptionId,
      expirationDateTime: existing.expirationDateTime.toISOString(),
      reason: `${Math.round((existing.expirationDateTime.getTime() - now) / 3600_000)}h headroom remaining`,
    };
  }

  // ── Case 2: try renewal in place ───────────────────────────────────────
  if (existing) {
    try {
      const res = await fetch(`https://graph.microsoft.com/v1.0/subscriptions/${existing.subscriptionId}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ expirationDateTime: newExpiry.toISOString() }),
      });
      if (res.ok) {
        await prisma.graphSubscription.update({
          where: { id: existing.id },
          data: { expirationDateTime: newExpiry, renewedAt: new Date() },
        });
        console.log(`[graph-sub] Renewed ${existing.subscriptionId} until ${newExpiry.toISOString()}`);
        return {
          action: "renewed",
          subscriptionId: existing.subscriptionId,
          expirationDateTime: newExpiry.toISOString(),
        };
      }

      const body = await res.text();
      console.warn(`[graph-sub] Renewal failed [${res.status}] for ${existing.subscriptionId}: ${body}. Falling back to create.`);
    } catch (err) {
      console.warn(`[graph-sub] Renewal errored: ${err instanceof Error ? err.message : String(err)}. Falling back to create.`);
    }

    // Renewal failed — delete the dead row so the next run creates cleanly
    await prisma.graphSubscription.delete({ where: { id: existing.id } }).catch(() => {});
  }

  // ── Case 3: create a fresh subscription ────────────────────────────────
  const createRes = await fetch("https://graph.microsoft.com/v1.0/subscriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      changeType: CHANGE_TYPE,
      notificationUrl: GRAPH_NOTIFY_URL,
      resource: RESOURCE,
      expirationDateTime: newExpiry.toISOString(),
      clientState: CLIENT_STATE,
    }),
  });

  if (!createRes.ok) {
    const body = await createRes.text();
    await logError({
      scenario: "S9_GraphSub",
      module: "subscription-manager",
      code: "CREATE_FAILED",
      message: `Graph returned ${createRes.status}: ${body}`,
    }).catch(() => {});
    throw new Error(`Graph subscription create failed [${createRes.status}]: ${body}`);
  }

  const data = (await createRes.json()) as { id: string; expirationDateTime: string };

  await prisma.graphSubscription.create({
    data: {
      subscriptionId: data.id,
      resource: RESOURCE,
      changeType: CHANGE_TYPE,
      expirationDateTime: new Date(data.expirationDateTime),
    },
  });

  console.log(`[graph-sub] Created ${data.id} until ${data.expirationDateTime}`);
  return {
    action: existing ? "recreated" : "created",
    subscriptionId: data.id,
    expirationDateTime: data.expirationDateTime,
  };
}

// ── Direct-exec entry point (local testing) ────────────────────────────────
const isDirectExecution = process.argv[1]?.includes("graph-subscription-manager");
if (isDirectExecution) {
  ensureGraphSubscription()
    .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
