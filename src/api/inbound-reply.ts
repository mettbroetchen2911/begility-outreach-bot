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

router.post("/webhooks/inbound-email", async (req: Request, res: Response) => {
  const { fromEmail, subject, textBody, receivedAt } = req.body as InboundPayload;

  if (!fromEmail || !textBody) {
    res.status(400).json({ error: "fromEmail and textBody are required" });
    return;
  }

  const normalEmail = fromEmail.toLowerCase().trim();
  const replyTime = receivedAt ? new Date(receivedAt) : new Date();

  try {
    // IMMEDIATE suppression — before any AI call
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
