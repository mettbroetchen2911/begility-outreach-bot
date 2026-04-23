import { Router, Request, Response } from "express";
import { prisma } from "../utils/prisma.js";
import { AIService } from "../services/ai.service.js";
import { EmailService } from "../services/email.service.js";
import { BotService } from "../services/bot.service.js";
import { CalendarService } from "../services/calendar.service.js";
import { logError } from "../utils/logger.js";
import { getNicheConfig } from "../config/niche.js";
import { generateHmacUrls } from "../utils/hmac.js";

const router = Router();
const ai = new AIService();
const emailSvc = new EmailService();
const botSvc = new BotService();
const calendarSvc = new CalendarService();

interface InboundPayload {
  fromEmail: string;
  subject: string;
  textBody: string;
  receivedAt?: string;
}

// ─── Auto-responder detection ───────────────────────────────────────────────
const AUTO_SUBJECT_PATTERNS: RegExp[] = [
  /^(auto(matic)?[- ]?(reply|response)|out of (the )?office|ooo\b|away from)/i,
  /\bauto[- ]?reply\b/i,
  /\bon holiday\b/i,
  /\bannual leave\b/i,
];

const AUTO_BODY_PATTERNS: RegExp[] = [
  /currently (out of the office|on annual leave|on holiday)/i,
  /i (am|'m) (currently )?(out of (the )?office|away|on leave)/i,
  /thank you for (your email|reaching out|contacting us).{0,80}(will (get back|respond|reply)|within \d+ (hours|business days))/i,
  /this is an automated (reply|response|message)/i,
  /(we'll|we will|someone will) be (in touch|with you) (within|shortly|soon)/i,
];

function detectAutoResponder(subject: string, body: string): { isAuto: boolean; reason?: string } {
  for (const re of AUTO_SUBJECT_PATTERNS) {
    if (re.test(subject)) return { isAuto: true, reason: `subject:${re.source.slice(0, 40)}` };
  }
  for (const re of AUTO_BODY_PATTERNS) {
    if (re.test(body)) return { isAuto: true, reason: `body:${re.source.slice(0, 40)}` };
  }
  return { isAuto: false };
}

// ─── Bounce detection ───────────────────────────────────────────────────────
const BOUNCE_FROM_PATTERNS: RegExp[] = [
  /^(postmaster|mailer-daemon|mail-daemon|no-?reply)@/i,
];

const BOUNCE_SUBJECT_PATTERNS: RegExp[] = [
  /^(undeliverable|delivery (status notification|has failed)|mail delivery (failed|system))/i,
  /failure notice/i,
  /returned mail/i,
];

function isBounceMessage(fromEmail: string, subject: string): boolean {
  return (
    BOUNCE_FROM_PATTERNS.some((re) => re.test(fromEmail)) ||
    BOUNCE_SUBJECT_PATTERNS.some((re) => re.test(subject))
  );
}

function extractBouncedAddress(body: string): string | null {
  const patterns = [
    /Original-Recipient:\s*rfc822;\s*([^\s;]+)/i,
    /Final-Recipient:\s*rfc822;\s*([^\s;]+)/i,
    /(?:to|for)\s+<?([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})>?\s+(?:because|failed|could not)/i,
    /<([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})>/i,
  ];
  for (const re of patterns) {
    const m = body.match(re);
    if (m?.[1]) return m[1].toLowerCase().trim();
  }
  return null;
}

router.post("/webhooks/inbound-email", async (req: Request, res: Response) => {
  const { fromEmail, subject, textBody, receivedAt } = req.body as InboundPayload;
  if (!fromEmail || !textBody) {
    res.status(400).json({ error: "fromEmail and textBody are required" });
    return;
  }
  const normalEmail = fromEmail.toLowerCase().trim();
  const replyTime = receivedAt ? new Date(receivedAt) : new Date();

  try {
    // ─── BOUNCE ROUTING (no suppression on the sender; suppression on bounced recipient) ───
    if (isBounceMessage(normalEmail, subject ?? "")) {
      const bounced = extractBouncedAddress(textBody);
      if (bounced) {
        const lead = await prisma.lead.findFirst({
          where: { email: bounced },
          orderBy: { lastContactedAt: "desc" },
        });
        await prisma.suppression.upsert({
          where: { email: bounced },
          create: { email: bounced, reason: "bounced", leadId: lead?.id },
          update: { reason: "bounced", leadId: lead?.id },
        });
        if (lead) {
          await prisma.lead.update({
            where: { id: lead.id },
            data: {
              status: "verification_failed",
              emailVerified: false,
              outlookDraftId: null,
              notes: `${lead.notes ?? ""}\n[${replyTime.toISOString()}] Bounced — address ${bounced} is dead`.trim(),
            },
          });
          await botSvc.sendReplyAlert(
            lead,
            "bounced",
            `Email bounced — ${bounced} is dead. Research a replacement contact or close.`,
            textBody.slice(0, 300),
          ).catch(() => { /* swallow */ });
        }
        await logError({
          scenario: "S4_Reply", module: "bounce", code: "BOUNCE_DETECTED",
          message: `Bounce for ${bounced}`, leadId: lead?.id,
        }).catch(() => {});
      }
      res.status(200).json({ success: true, classification: "bounce", bouncedAddress: bounced });
      return;
    }

    // ─── AUTO-RESPONDER ROUTING (no suppression — lead stays in the sequence) ───
    const auto = detectAutoResponder(subject ?? "", textBody);
    if (auto.isAuto) {
      const lead = await prisma.lead.findFirst({
        where: {
          email: normalEmail,
          status: { in: ["outreach_sent", "follow_up_queued", "follow_up_sent"] },
        },
        orderBy: { lastContactedAt: "desc" },
      });
      if (lead) {
        await prisma.lead.update({
          where: { id: lead.id },
          data: {
            notes: `${lead.notes ?? ""}\n[${replyTime.toISOString()}] Auto-responder (${auto.reason}) — left in sequence`.trim(),
          },
        });
        await botSvc.sendReplyAlert(
          lead,
          "auto_reply",
          `Auto-responder detected (${auto.reason}). Lead left in sequence, no suppression applied.`,
          textBody.slice(0, 300),
        ).catch(() => {});
      }
      res.status(200).json({ success: true, classification: "auto_responder", reason: auto.reason, leadMatched: Boolean(lead) });
      return;
    }

    // ─── REAL REPLY — existing flow below, unchanged ────────────────────────
    await prisma.suppression.upsert({
      where: { email: normalEmail },
      create: { email: normalEmail, reason: "replied" },
      update: {},
    });

    // Match sender to an active lead
    const lead = await prisma.lead.findFirst({
      where: {
        email: normalEmail,
        status: { in: ["outreach_sent", "follow_up_queued", "follow_up_sent"] },
      },
      orderBy: { lastContactedAt: "desc" },
    });

    if (!lead) {
      res.status(200).json({ success: true, message: "Suppressed. No matching active lead.", leadMatched: false });
      return;
    }

    await prisma.suppression.update({
      where: { email: normalEmail },
      data: { leadId: lead.id },
    });

    // AI sentiment analysis
    let sentiment;
    try {
      sentiment = await ai.analyzeReplySentiment(textBody, lead.businessName, lead.draftSubject ?? subject);
    } catch (aiErr) {
      const msg = aiErr instanceof Error ? aiErr.message : String(aiErr);
      await logError({ scenario: "S4_Reply", module: "sentiment", code: "AI_FAILED", message: msg, leadId: lead.id });
      sentiment = {
        sentiment: "neutral" as const,
        confidence: "low" as const,
        reasoning: "AI classification failed — manual review required",
        suggested_action: "manual_review" as const,
      };
    }

    const newStatus =
      sentiment.sentiment === "positive" ? "interested" :
      sentiment.sentiment === "hard_no" ? "not_interested" :
      "needs_review"; // soft_no and neutral both go to human review

    const updated = await prisma.lead.update({
      where: { id: lead.id },
      data: {
        replyReceived: true,
        replyBody: textBody,
        replySentiment: sentiment.sentiment,
        replyReasoning: sentiment.reasoning,
        lastReplyAt: replyTime,
        status: newStatus,
      },
    });

    if (sentiment.sentiment === "positive") {
      // ── POSITIVE: Teams alert + calendar task ──
      // No email to send — human calls or replies manually
      try {
        await botSvc.sendWarmReplyAlert(updated, sentiment.reasoning, sentiment.suggested_action);
      } catch (e) {
        await logError({ scenario: "S4_Reply", module: "warm_alert", code: "TEAMS_FAILED", message: String(e), leadId: lead.id });
      }

      try {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(10, 0, 0, 0);
        await calendarSvc.createCallTask(updated, tomorrow, "Warm reply — call ASAP");
      } catch (e) {
        await logError({ scenario: "S4_Reply", module: "calendar", code: "CALENDAR_FAILED", message: String(e), leadId: lead.id });
      }

    } else if (sentiment.sentiment === "hard_no") {
      // ── HARD NO: Draft goodbye email → Teams approval card ──
      // Email is drafted but NOT sent — requires human click
      try {
        const config = getNicheConfig();
        const goodbye = await ai.draftGoodbye({
          businessName: lead.businessName,
          ownerName: lead.ownerName,
          originalSubject: lead.draftSubject ?? subject,
          replyBody: textBody,
        });

        // Create Outlook draft (NOT sent)
        const draft = await emailSvc.createDraft(
          normalEmail,
          goodbye.subject_line,
          goodbye.email_body_html
        );

        if (draft.conversationId && draft.conversationId !== lead.conversationId) {
          await prisma.lead.update({
            where: { id: lead.id },
            data: { conversationId: draft.conversationId },
          });
        }

        // Store draft on a follow-up queue entry for approval tracking
        const queueEntry = await prisma.followUpQueue.create({
          data: {
            leadId: lead.id,
            businessName: lead.businessName,
            email: normalEmail,
            draftId: draft.messageId,
            draftPreview: `[GOODBYE] ${goodbye.subject_line} — ${stripHtml(goodbye.email_body_html).slice(0, 150)}`,
            geminiReasoning: `Hard no detected: ${sentiment.reasoning}`,
            status: "pending",
          },
        });

        // Send Teams approval card — human must click to send
        const { approveUrl, rejectUrl } = generateHmacUrls(queueEntry.id);
        await botSvc.sendReplyApprovalCard({
          queueId: queueEntry.id,
          businessName: lead.businessName,
          email: normalEmail,
          sentiment: "hard_no",
          replySnippet: textBody.slice(0, 300),
          reasoning: sentiment.reasoning,
          draftSubject: goodbye.subject_line,
          draftBodyPlain: stripHtml(goodbye.email_body_html).slice(0, 200),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await logError({ scenario: "S4_Reply", module: "hard_no_draft", code: "DRAFT_FAILED", message: msg, leadId: lead.id });
        // Fallback: still alert the team even if draft creation fails
        try {
          await botSvc.sendReplyAlert(updated, sentiment.sentiment, sentiment.reasoning, textBody.slice(0, 300));
        } catch { /* swallow */ }
      }

    } else if (sentiment.sentiment === "soft_no") {
      // ── SOFT NO: Teams alert only — human decides next move ──
      // No draft created. Rep reads the reply and decides whether to
      // call, send a tailored reply, or close.
      try {
        await botSvc.sendReplyAlert(updated, "soft_no", sentiment.reasoning, textBody.slice(0, 300));
      } catch (e) {
        await logError({ scenario: "S4_Reply", module: "soft_no_alert", code: "TEAMS_FAILED", message: String(e), leadId: lead.id });
      }

    } else {
      // ── NEUTRAL: Teams alert — human triages ──
      try {
        await botSvc.sendReplyAlert(updated, "neutral", sentiment.reasoning, textBody.slice(0, 300));
      } catch (e) {
        await logError({ scenario: "S4_Reply", module: "neutral_alert", code: "TEAMS_FAILED", message: String(e), leadId: lead.id });
      }
    }

    res.status(200).json({
      success: true,
      leadId: lead.id,
      businessName: lead.businessName,
      sentiment: sentiment.sentiment,
      confidence: sentiment.confidence,
      reasoning: sentiment.reasoning,
      suggestedAction: sentiment.suggested_action,
      newStatus,
      autoSent: false, // Nothing auto-sends — ever
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logError({ scenario: "S4_Reply", module: "inbound-reply", code: "REPLY_FAILED", message: msg });
    res.status(500).json({ error: "Reply processing failed", detail: msg });
  }
});

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

export default router;
