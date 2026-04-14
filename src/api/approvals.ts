import { Router, Request, Response } from "express";
import { prisma } from "../utils/prisma.js";
import { verifyHmac } from "../utils/hmac.js";
import { logError } from "../utils/logger.js";
import { EmailService } from "../services/email.service.js";
import { ChatService } from "../services/chat.service.js";

const router = Router();
const emailService = new EmailService();
const chatService = new ChatService();

router.get("/tier1_approve", async (req: Request, res: Response) => {
  const { leadId, ts, token } = req.query as Record<string, string>;

  if (!leadId || !ts || !token) {
    res.status(400).json({ error: "Missing leadId, ts, or token" });
    return;
  }

  const hmac = verifyHmac(leadId, ts, token);
  if (!hmac.valid) {
    await logError({ scenario: "S2_Approval", module: "approve", code: "HMAC_FAILED", message: hmac.reason!, leadId });
    res.status(403).json({ error: "Link invalid or expired", reason: hmac.reason });
    return;
  }

  try {
    const lead = await prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }

    if (lead.status !== "waiting_concierge") {
      res.status(409).json({ error: `Lead status is '${lead.status}', expected 'waiting_concierge'` });
      return;
    }

    if (lead.outlookDraftId) {
      await emailService.sendDraft(lead.outlookDraftId);
    } else if (lead.email && lead.draftSubject && lead.draftBodyHtml) {
      await emailService.sendEmail(lead.email, lead.draftSubject, lead.draftBodyHtml);
    } else {
      res.status(422).json({ error: "Lead missing email, subject, or body — cannot send" });
      return;
    }

    if (lead.teamsCardActivityId) {
      try { await chatService.updateCard(lead.teamsCardActivityId, "approved", "Webhook Approver"); }
      catch (e) { console.error("Card update failed (non-fatal):", e); }
    }

    const now = new Date();
    await prisma.lead.update({
      where: { id: leadId },
      data: { status: "outreach_sent", lastContactedAt: now, sentBy: "webhook_approver", enrichmentLock: false },
    });

    res.status(200).json({ success: true, message: `Email sent for ${lead.businessName}`, sentAt: now.toISOString() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logError({ scenario: "S2_Approval", module: "approve", code: "APPROVE_FAILED", message: msg, leadId });
    res.status(500).json({ error: "Approval failed", detail: msg });
  }
});

router.get("/tier1_reject", async (req: Request, res: Response) => {
  const { leadId, ts, token } = req.query as Record<string, string>;

  if (!leadId || !ts || !token) {
    res.status(400).json({ error: "Missing leadId, ts, or token" });
    return;
  }

  const hmac = verifyHmac(leadId, ts, token);
  if (!hmac.valid) {
    await logError({ scenario: "S2_Rejection", module: "reject", code: "HMAC_FAILED", message: hmac.reason!, leadId });
    res.status(403).json({ error: "Link invalid or expired", reason: hmac.reason });
    return;
  }

  try {
    const lead = await prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }

    if (lead.status !== "waiting_concierge") {
      res.status(409).json({ error: `Lead status is '${lead.status}', expected 'waiting_concierge'` });
      return;
    }

    if (lead.outlookDraftId) {
  try { await emailService.deleteDraft(lead.outlookDraftId); }
  catch (e) { console.error("Draft deletion failed (non-fatal):", e); }
}

if (lead.teamsCardActivityId) {
  try { await chatService.updateCard(lead.teamsCardActivityId, "rejected", "Webhook Approver"); }
  catch (e) { console.error("Card update failed (non-fatal):", e); }
}

await prisma.lead.update({
  where: { id: leadId },
  data: { status: "rejected", outlookDraftId: null, enrichmentLock: false },
});

    res.status(200).json({ success: true, message: `${lead.businessName} rejected` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logError({ scenario: "S2_Rejection", module: "reject", code: "REJECT_FAILED", message: msg, leadId });
    res.status(500).json({ error: "Rejection failed", detail: msg });
  }
});

export default router;
