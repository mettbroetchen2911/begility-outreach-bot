import { prisma } from "../utils/prisma.js";
import { EmailService } from "./email.service.js";
import { recordSend } from "./send-recorder.js";
import { logError } from "../utils/logger.js";
import { stripHtml, ensureHtml } from "../utils/text-utils.js";

const email = new EmailService();

export type ApproveReason =
  | "already_actioned" | "missing_draft" | "send_failed"
  | "lead_not_found"  | "suppressed";

export interface ApproveOutcome {
  ok: boolean;
  reason?: ApproveReason;
  detail?: string;
  wasEdited: boolean;
  messageId?: string | null;
}

export interface ApproveInputTier {
  kind: "tier1" | "tier2";
  leadId: string;
  decidedBy: string;
  editedSubject?: string;
  editedBody?: string;
}

export interface ApproveInputFollowUp {
  kind: "followup";
  queueId: string;
  decidedBy: string;
  editedSubject?: string;
  editedBody?: string;
}

export type ApproveInput = ApproveInputTier | ApproveInputFollowUp;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function computeDiffSummary(oldStr: string | null, newStr: string | null): string {
  if (!oldStr && !newStr) return "none";
  if (!oldStr) return "created";
  if (!newStr) return "cleared";
  if (oldStr === newStr) return "none";
  const delta = newStr.length - oldStr.length;
  const sign = delta > 0 ? "+" : "";
  return `${sign}${delta} chars`;
}

// ---------------------------------------------------------------------------
// Tier 1 / Tier 2 approve
// ---------------------------------------------------------------------------

export async function approveTier(input: ApproveInputTier): Promise<ApproveOutcome> {
  const flipped = await prisma.lead.updateMany({
    where: { id: input.leadId, status: "waiting_concierge" },
    data: { status: "enriching" },
  });
  if (flipped.count === 0) {
    return { ok: false, reason: "already_actioned", wasEdited: false };
  }

  const lead = await prisma.lead.findUnique({ where: { id: input.leadId } });
  if (!lead) {
    return { ok: false, reason: "lead_not_found", wasEdited: false };
  }

  // Re-check suppression — a reply may have landed since the draft was created
  if (lead.email) {
    const suppressed = await prisma.suppression.findUnique({
      where: { email: lead.email.toLowerCase() },
    });
    if (suppressed) {
      await rollbackToWaiting(input.leadId);
      return {
        ok: false,
        reason: "suppressed",
        wasEdited: false,
        detail: `${lead.email} is suppressed (${suppressed.reason ?? "unknown reason"})`,
      };
    }
  }

  // Normalise edits
  const finalSubject = input.editedSubject?.trim() || lead.draftSubject || "";
  const rawBody      = input.editedBody?.trim() || "";
  const wasEdited = Boolean(
    (input.editedSubject?.trim() && input.editedSubject.trim() !== lead.draftSubject) ||
    (rawBody && rawBody !== stripHtml(lead.draftBodyHtml ?? ""))
  );
  const finalBody    = wasEdited ? ensureHtml(rawBody) : (lead.draftBodyHtml ?? "");

  try {
    if (!lead.outlookDraftId) {
      // Fallback: no draft exists. Send directly only if we have everything.
      if (!lead.email || !finalSubject || !finalBody) {
        await rollbackToWaiting(input.leadId);
        return { ok: false, reason: "missing_draft", wasEdited, detail: "no outlookDraftId and no complete fallback content" };
      }
      const result = await email.sendEmail(lead.email, finalSubject, finalBody);
      await persistSent(input.leadId, input.decidedBy, finalSubject, finalBody, wasEdited, result.messageId, lead);
      return { ok: true, wasEdited, messageId: result.messageId };
    }

    if (wasEdited) {
      await email.updateDraft(lead.outlookDraftId, finalSubject, finalBody);
    }
    const sent = await email.sendDraft(lead.outlookDraftId);
    await persistSent(input.leadId, input.decidedBy, finalSubject, finalBody, wasEdited, sent.messageId, lead);
    return { ok: true, wasEdited, messageId: sent.messageId };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await rollbackToWaiting(input.leadId).catch(() => { /* best-effort */ });
    await logError({
      scenario: input.kind === "tier1" ? "TIER1_APPROVE" : "TIER2_APPROVE",
      module: "approve-guard",
      code: "SEND_FAILED",
      message: msg,
      leadId: input.leadId,
    }).catch(() => { /* swallow */ });
    return { ok: false, reason: "send_failed", detail: msg, wasEdited };
  }
}

async function rollbackToWaiting(leadId: string): Promise<void> {
  await prisma.lead.update({
    where: { id: leadId },
    data: { status: "waiting_concierge" },
  });
}

async function persistSent(
  leadId: string,
  decidedBy: string,
  finalSubject: string,
  finalBody: string,
  wasEdited: boolean,
  messageId: string | null,
  lead: { draftSubject: string | null; draftBodyHtml: string | null; lastContactedAt: Date | null },
): Promise<void> {
  const now = new Date();
  const diff = computeDiffSummary(lead.draftBodyHtml, finalBody);

  await prisma.lead.update({
    where: { id: leadId },
    data: {
      status: "outreach_sent",
      lastContactedAt: now,
      sentBy: decidedBy,
      enrichmentLock: false,
      outlookDraftId: null,
      ...(wasEdited && { draftSubject: finalSubject, draftBodyHtml: finalBody }),
    },
  });

  await recordSend({
    leadId,
    direction: "outreach",
    subject: finalSubject,
    bodyHash: quickHash(finalBody),
    messageId,
    sentAt: now,
    sentBy: decidedBy,
    wasEdited,
    editSummary: diff,
  }).catch((err) => {
    // Non-fatal — the Lead row is the authoritative sent state, send log is supplementary.
    console.warn(`[approve-guard] recordSend failed: ${err?.message ?? err}`);
  });
}

// ---------------------------------------------------------------------------
// Follow-up approve
// ---------------------------------------------------------------------------

export async function approveFollowUp(input: ApproveInputFollowUp): Promise<ApproveOutcome> {
  const flipped = await prisma.followUpQueue.updateMany({
    where: { id: input.queueId, status: "pending" },
    data: { status: "approved" }, // sentinel — idempotent
  });
  if (flipped.count === 0) {
    return { ok: false, reason: "already_actioned", wasEdited: false };
  }

  const entry = await prisma.followUpQueue.findUnique({ where: { id: input.queueId } });
  if (!entry) {
    return { ok: false, reason: "lead_not_found", wasEdited: false };
  }
  const lead = await prisma.lead.findUnique({ where: { id: entry.leadId } });
  if (!lead) {
    return { ok: false, reason: "lead_not_found", wasEdited: false };
  }

  // Goodbyes are a response to hard_no — suppression is expected and we must still send.
  const isGoodbye = entry.geminiReasoning?.startsWith("Hard no detected") ?? false;

  if (!isGoodbye && lead.email) {
    const suppressed = await prisma.suppression.findUnique({
      where: { email: lead.email.toLowerCase() },
    });
    if (suppressed) {
      await rollbackFollowUp(input.queueId);
      return {
        ok: false,
        reason: "suppressed",
        wasEdited: false,
        detail: `${lead.email} is suppressed (${suppressed.reason ?? "unknown reason"})`,
      };
    }
  }

  const finalSubject = input.editedSubject?.trim() || (lead.draftSubject ?? "");
  const rawBody      = input.editedBody?.trim() || "";
  const wasEdited = Boolean(
    (input.editedSubject?.trim() && input.editedSubject.trim() !== lead.draftSubject) ||
    (rawBody && rawBody !== stripHtml(lead.draftBodyHtml ?? ""))
  );
  const finalBody    = wasEdited ? ensureHtml(rawBody) : (lead.draftBodyHtml ?? "");

  try {
    if (!entry.draftId) {
      await rollbackFollowUp(input.queueId);
      return { ok: false, reason: "missing_draft", wasEdited };
    }

    if (wasEdited) {
      await email.updateDraft(entry.draftId, finalSubject, finalBody);
      await prisma.lead.update({
        where: { id: lead.id },
        data: {
          ...(input.editedSubject?.trim() && { draftSubject: finalSubject }),
          ...(rawBody && { draftBodyHtml: finalBody }),
        },
      });
    }

    const sent = await email.sendDraft(entry.draftId);

    const now = new Date();
    await prisma.followUpQueue.update({
      where: { id: input.queueId },
      data: { approvedBy: input.decidedBy, approvedAt: now },
    });
    await prisma.lead.update({
      where: { id: entry.leadId },
      data: { status: "follow_up_sent", lastContactedAt: now },
    });

    await recordSend({
      leadId: entry.leadId,
      direction: "follow_up",
      subject: finalSubject,
      bodyHash: quickHash(finalBody),
      messageId: sent.messageId,
      sentAt: now,
      sentBy: input.decidedBy,
      wasEdited,
      editSummary: computeDiffSummary(lead.draftBodyHtml, finalBody),
    }).catch((err) => {
      console.warn(`[approve-guard] recordSend (follow-up) failed: ${err?.message ?? err}`);
    });

    return { ok: true, wasEdited, messageId: sent.messageId };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await rollbackFollowUp(input.queueId).catch(() => { /* best-effort */ });
    await logError({
      scenario: "FOLLOWUP_APPROVE",
      module: "approve-guard",
      code: "SEND_FAILED",
      message: msg,
      leadId: entry.leadId,
    }).catch(() => { /* swallow */ });
    return { ok: false, reason: "send_failed", detail: msg, wasEdited };
  }
}

async function rollbackFollowUp(queueId: string): Promise<void> {
  await prisma.followUpQueue.update({
    where: { id: queueId },
    data: { status: "pending" },
  });
}

function plainToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map((para) => `<p>${para.replace(/\n/g, "<br/>")}</p>`)
    .join("\n");
}

function quickHash(s: string): string {
  // Fast non-cryptographic digest — purely to detect "did the content change"
  // without persisting full bodies twice.
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}
