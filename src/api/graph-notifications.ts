import { Router, Request, Response } from "express";
import crypto from "node:crypto";
import { prisma } from "../utils/prisma.js";
import { EmailService } from "../services/email.service.js";
import { recordSend } from "../services/send-recorder.js";
import { logError } from "../utils/logger.js";

const router = Router();
const emailSvc = new EmailService();

// ─── Types ──────────────────────────────────────────────────────────────────

interface GraphNotification {
  subscriptionId: string;
  clientState?: string;
  resource: string;
  resourceData?: { id: string; "@odata.type"?: string };
  changeType: string;
  tenantId?: string;
}

interface GraphNotificationBatch {
  value: GraphNotification[];
  validationTokens?: string[];
}

export interface GraphMessage {
  id: string;
  subject: string | null;
  conversationId: string | null;
  isDraft: boolean;
  sentDateTime: string | null;
  from?: { emailAddress?: { address?: string; name?: string } };
  toRecipients?: Array<{ emailAddress?: { address?: string } }>;
  body?: { contentType: string; content: string };
}

// ─── Validation handshake + batch ack ──────────────────────────────────────
// Graph calls POST /webhooks/graph-notifications?validationToken=... once on
// subscription creation. Echo verbatim as text/plain, 200, within 10 seconds.
// For normal notification batches, ack 202 fast, then process async.
router.post("/webhooks/graph-notifications", async (req: Request, res: Response) => {
  if (typeof req.query.validationToken === "string") {
    res.status(200).type("text/plain").send(req.query.validationToken);
    return;
  }

  // Ack immediately — Graph retries if we take longer than 3s
  res.status(202).send();

  const batch = req.body as GraphNotificationBatch;
  const notifications = Array.isArray(batch?.value) ? batch.value : [];
  if (notifications.length === 0) return;

  for (const n of notifications) {
    try {
      await processNotification(n);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logError({
        scenario: "S9_GraphSub",
        module: "notification",
        code: "PROCESS_FAILED",
        message: msg,
      }).catch(() => { /* swallow */ });
    }
  }
});

// ─── Per-notification processor ─────────────────────────────────────────────

async function processNotification(n: GraphNotification): Promise<void> {
  // Verify clientState matches the one we registered when creating the sub
  const expected = process.env.GRAPH_CLIENT_STATE_SECRET ?? "";
  if (n.clientState !== expected) {
    await logError({
      scenario: "S9_GraphSub",
      module: "notification",
      code: "BAD_CLIENT_STATE",
      message: `Subscription ${n.subscriptionId} sent mismatched clientState`,
    }).catch(() => {});
    return;
  }

  if (!n.resourceData?.id) return;

  const isRelevant = n.changeType === "created" || n.changeType === "updated";
  if (!isRelevant) return;

  // Fetch the full message
  let msg: GraphMessage | null;
  try {
    msg = await emailSvc.getMessageById(n.resourceData.id);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    // 404 = message deleted or moved since notification fired; nothing to do
    if (m.includes("[404]") || m.includes("404")) return;
    throw err;
  }

  if (!msg) return;

  // Drafts don't normally land in Sent Items, but guard defensively
  if (msg.isDraft) return;

  const lead = await findMatchingLead(msg);
  if (!lead) return;

  // Idempotency: if the lead has already transitioned, our own approval flow
  // handled it — skip. Only transition from the waiting states.
  if (lead.status === "waiting_concierge") {
    await transitionOutreach(lead.id, msg);
  } else if (lead.status === "follow_up_queued") {
    await transitionFollowUp(lead.id, msg);
  }
}

async function findMatchingLead(msg: GraphMessage) {
  // 1. Exact match on outlookDraftId — the draft ID survives the send
  const byDraftId = await prisma.lead.findFirst({
    where: {
      OR: [
        { outlookDraftId: msg.id },
        { followUpDraftId: msg.id },
      ],
    },
    orderBy: { lastContactedAt: "desc" },
  });
  if (byDraftId) return byDraftId;

  // 2. Same conversation thread
  if (msg.conversationId) {
    const byConv = await prisma.lead.findFirst({
      where: { conversationId: msg.conversationId },
      orderBy: { lastContactedAt: "desc" },
    });
    if (byConv) return byConv;
  }

  // 3. Pending follow-up queue entry (rare: draft ID match only via queue)
  const followUpEntry = await prisma.followUpQueue.findFirst({
    where: { draftId: msg.id, status: "pending" },
  });
  if (followUpEntry) {
    return prisma.lead.findUnique({ where: { id: followUpEntry.leadId } });
  }

  return null;
}

async function transitionOutreach(leadId: string, msg: GraphMessage): Promise<void> {
  const sentAt = msg.sentDateTime ? new Date(msg.sentDateTime) : new Date();
  const senderAddr = msg.from?.emailAddress?.address ?? "unknown";

  await prisma.lead.update({
    where: { id: leadId },
    data: {
      status: "outreach_sent",
      lastContactedAt: sentAt,
      outlookDraftId: null,
      sentBy: `outlook:${senderAddr}`,
      enrichmentLock: false,
      ...(msg.conversationId && { conversationId: msg.conversationId }),
      ...(msg.subject && { draftSubject: msg.subject }),
      ...(msg.body?.content && { draftBodyHtml: msg.body.content }),
    },
  });

  await recordSend({
    leadId,
    direction: "outreach",
    subject: msg.subject ?? "",
    bodyHash: quickHash(msg.body?.content ?? ""),
    messageId: msg.id,
    sentAt,
    sentBy: `outlook-direct:${senderAddr}`,
    wasEdited: true, // we can't diff what we don't have — assume yes
    editSummary: "sent from Outlook directly",
  }).catch((err) => {
    console.warn(`[graph-notifications] recordSend failed: ${err instanceof Error ? err.message : String(err)}`);
  });

  console.log(`[graph-sub] Reconciled outreach for lead ${leadId} — sent via Outlook by ${senderAddr}`);
}

async function transitionFollowUp(leadId: string, msg: GraphMessage): Promise<void> {
  const sentAt = msg.sentDateTime ? new Date(msg.sentDateTime) : new Date();
  const senderAddr = msg.from?.emailAddress?.address ?? "unknown";

  // Mark the pending follow-up queue entry as approved
  const entry = await prisma.followUpQueue.findFirst({
    where: { leadId, status: "pending" },
    orderBy: { queuedAt: "desc" },
  });

  if (entry) {
    await prisma.followUpQueue.update({
      where: { id: entry.id },
      data: {
        status: "approved",
        approvedBy: `outlook:${senderAddr}`,
        approvedAt: sentAt,
      },
    });
  }

  await prisma.lead.update({
    where: { id: leadId },
    data: {
      status: "follow_up_sent",
      lastContactedAt: sentAt,
      followUpDraftId: null,
      sentBy: `outlook:${senderAddr}`,
      ...(msg.conversationId && { conversationId: msg.conversationId }),
    },
  });

  await recordSend({
    leadId,
    direction: "follow_up",
    subject: msg.subject ?? "",
    bodyHash: quickHash(msg.body?.content ?? ""),
    messageId: msg.id,
    sentAt,
    sentBy: `outlook-direct:${senderAddr}`,
    wasEdited: true,
    editSummary: "follow-up sent from Outlook directly",
  }).catch((err) => {
    console.warn(`[graph-notifications] recordSend follow-up failed: ${err instanceof Error ? err.message : String(err)}`);
  });

  console.log(`[graph-sub] Reconciled follow-up for lead ${leadId} — sent via Outlook by ${senderAddr}`);
}

function quickHash(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
}

export default router;
