// ============================================================================
// Lead Engine — Follow-Up Approval Webhooks
// GET /followup_approve  — HMAC verify → send follow-up draft → mark sent
// GET /followup_reject   — HMAC verify → mark rejected, delete draft
//
// These are the MISSING endpoints that close the loop on follow-up approvals.
// The follow-up sweep creates Outlook drafts and Teams cards with HMAC buttons
// pointing here. Without these, the team could see pending follow-ups but
// couldn't act on them.
// ============================================================================

import { Router, Request, Response } from "express";
import { prisma } from "../utils/prisma.js";
import { verifyHmac } from "../utils/hmac.js";
import { logError } from "../utils/logger.js";
import { EmailService } from "../services/email.service.js";

const router = Router();
const emailService = new EmailService();

// ---------------------------------------------------------------------------
// GET /followup_approve
// ---------------------------------------------------------------------------
router.get("/followup_approve", async (req: Request, res: Response) => {
  const { leadId: queueId, ts, token } = req.query as Record<string, string>;

  if (!queueId || !ts || !token) {
    res.status(400).json({ error: "Missing queueId, ts, or token" });
    return;
  }

  const hmac = verifyHmac(queueId, ts, token);
  if (!hmac.valid) {
    await logError({ scenario: "S5_FollowUp", module: "approve", code: "HMAC_FAILED", message: hmac.reason!, leadId: queueId });
    res.status(403).json({ error: "Link invalid or expired", reason: hmac.reason });
    return;
  }

  try {
    const entry = await prisma.followUpQueue.findUnique({ where: { id: queueId } });
    if (!entry) { res.status(404).json({ error: "Follow-up entry not found" }); return; }

    if (entry.status !== "pending") {
      res.status(409).json({ error: `Entry status is '${entry.status}', expected 'pending'` });
      return;
    }

    // Send the Outlook draft
    if (entry.draftId) {
      await emailService.sendDraft(entry.draftId);
    } else {
      res.status(422).json({ error: "No draft ID — cannot send" });
      return;
    }

    // Update queue entry
    await prisma.followUpQueue.update({
      where: { id: queueId },
      data: { status: "approved", approvedBy: "webhook_approver", approvedAt: new Date() },
    });

    // Transition lead
    const now = new Date();
    await prisma.lead.update({
      where: { id: entry.leadId },
      data: { status: "follow_up_sent", lastContactedAt: now },
    });

    res.status(200).json({ success: true, message: `Follow-up sent for ${entry.businessName}`, sentAt: now.toISOString() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logError({ scenario: "S5_FollowUp", module: "approve", code: "FOLLOWUP_APPROVE_FAILED", message: msg, leadId: queueId });
    res.status(500).json({ error: "Follow-up approval failed", detail: msg });
  }
});

// ---------------------------------------------------------------------------
// GET /followup_reject
// ---------------------------------------------------------------------------
router.get("/followup_reject", async (req: Request, res: Response) => {
  const { leadId: queueId, ts, token } = req.query as Record<string, string>;

  if (!queueId || !ts || !token) {
    res.status(400).json({ error: "Missing queueId, ts, or token" });
    return;
  }

  const hmac = verifyHmac(queueId, ts, token);
  if (!hmac.valid) {
    await logError({ scenario: "S5_FollowUp", module: "reject", code: "HMAC_FAILED", message: hmac.reason!, leadId: queueId });
    res.status(403).json({ error: "Link invalid or expired", reason: hmac.reason });
    return;
  }

  try {
    const entry = await prisma.followUpQueue.findUnique({ where: { id: queueId } });
    if (!entry) { res.status(404).json({ error: "Follow-up entry not found" }); return; }

    if (entry.status !== "pending") {
      res.status(409).json({ error: `Entry status is '${entry.status}', expected 'pending'` });
      return;
    }

    if (entry.draftId) {
      try { await emailService.deleteDraft(entry.draftId); }
      catch (e) { console.error("Draft deletion failed (non-fatal):", e); }
    }

    await prisma.followUpQueue.update({
      where: { id: queueId },
      data: { status: "rejected", approvedBy: "webhook_approver", approvedAt: new Date() },
    });

    // Return lead to outreach_sent so it can be re-evaluated later
    await prisma.lead.update({
      where: { id: entry.leadId },
      data: { status: "outreach_sent", followUpDraftId: null, followUpQueuedAt: null },
    });

    res.status(200).json({ success: true, message: `Follow-up rejected for ${entry.businessName}` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logError({ scenario: "S5_FollowUp", module: "reject", code: "FOLLOWUP_REJECT_FAILED", message: msg, leadId: queueId });
    res.status(500).json({ error: "Follow-up rejection failed", detail: msg });
  }
});

export default router;
