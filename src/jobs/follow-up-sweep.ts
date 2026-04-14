import { prisma } from "../utils/prisma.js";
import { AIService } from "../services/ai.service.js";
import { EmailService } from "../services/email.service.js";
import { ChatService } from "../services/chat.service.js";
import { isKillSwitchActive } from "./bounce-monitor.js";
import { logError } from "../utils/logger.js";
import { generateHmacUrls } from "../utils/hmac.js";

const ai = new AIService();
const emailSvc = new EmailService();
const chatSvc = new ChatService();

const FOLLOW_UP_DELAY_MS = parseInt(process.env.FOLLOW_UP_DELAY_DAYS ?? "4", 10) * 24 * 60 * 60 * 1000;
const MAX_PER_SWEEP = parseInt(process.env.FOLLOW_UP_MAX_PER_SWEEP ?? "10", 10);

function stripHtml(html: string): string {
  return html
    .replace(/<\/(p|div)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .trim();
}

export async function runFollowUpSweep(): Promise<{
  processed: number;
  killSwitchBlocked: boolean;
  results: Array<{ leadId: string; businessName: string; outcome: string }>;
}> {
  if (await isKillSwitchActive()) {
    console.log("Follow-up sweep: BLOCKED by kill-switch.");
    return { processed: 0, killSwitchBlocked: true, results: [] };
  }

  const results: Array<{ leadId: string; businessName: string; outcome: string }> = [];
  const cutoff = new Date(Date.now() - FOLLOW_UP_DELAY_MS);

  const leads = await prisma.lead.findMany({
    where: {
      status: "outreach_sent",
      replyReceived: false,
      lastContactedAt: { lt: cutoff, not: null },
      followUpDraftId: null,
    },
    take: MAX_PER_SWEEP,
    orderBy: { lastContactedAt: "asc" },
  });

  if (leads.length === 0) {
    console.log("Follow-up sweep: No eligible leads.");
    return { processed: 0, killSwitchBlocked: false, results };
  }

  console.log(`Follow-up sweep: ${leads.length} eligible leads.`);

  for (const lead of leads) {
    try {
      // Re-check suppression
      if (lead.email) {
        const suppressed = await prisma.suppression.findUnique({ where: { email: lead.email.toLowerCase() } });
        if (suppressed) {
          results.push({ leadId: lead.id, businessName: lead.businessName, outcome: "suppressed" });
          continue;
        }
      } else {
        results.push({ leadId: lead.id, businessName: lead.businessName, outcome: "no_email" });
        continue;
      }

      const days = lead.lastContactedAt
        ? Math.floor((Date.now() - lead.lastContactedAt.getTime()) / (1000 * 60 * 60 * 24))
        : 4;

      const research = (lead.geminiResearchJson && typeof lead.geminiResearchJson === "object")
        ? lead.geminiResearchJson as Record<string, unknown>
        : {};

      // Draft follow-up via Gemini
      const followUp = await ai.draftFollowUp({
        businessName: lead.businessName,
        daysSinceContact: days,
        originalSubject: lead.draftSubject ?? "Partnership enquiry",
        originalBodyPlain: lead.draftBodyHtml ? stripHtml(lead.draftBodyHtml) : "",
        researchContext: {
          description: typeof research.description === "string" ? research.description : undefined,
          instagram: typeof research.instagram === "string" ? research.instagram : undefined,
          location: typeof research.location === "string" ? research.location : undefined,
        },
      });

      const draft = await emailSvc.createDraft(lead.email, followUp.subject_line, followUp.email_body_html);
      const preview = `${followUp.subject_line}\n\n${stripHtml(followUp.email_body_html)}`;

      // Create follow-up queue entry
      const queueEntry = await prisma.followUpQueue.create({
        data: {
          leadId: lead.id,
          businessName: lead.businessName,
          email: lead.email,
          draftId: draft.messageId,
          draftPreview: preview,
          geminiReasoning: followUp.reasoning,
          status: "pending",
        },
      });

      // Update lead — prevents re-queuing
      await prisma.lead.update({
        where: { id: lead.id },
        data: { followUpDraftId: draft.messageId, followUpQueuedAt: new Date(), status: "follow_up_queued" },
      });

      // Send HMAC-secured approval card to Teams
      try {
        const { approveUrl, rejectUrl } = generateHmacUrls(queueEntry.id);
        await chatSvc.sendFollowUpApprovalCard(
          queueEntry.id,
          lead.businessName,
          lead.email,
          preview,
          followUp.reasoning,
          approveUrl.replace("tier1_approve", "followup_approve"),
          rejectUrl.replace("tier1_reject", "followup_reject"),
          draft.webLink
        );
      } catch (e) {
        console.error(`  Teams card failed (non-fatal): ${e}`);
      }

      console.log(`  Done: ${lead.businessName} queued (${followUp.reasoning})`);
      results.push({ leadId: lead.id, businessName: lead.businessName, outcome: "follow_up_queued" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logError({ scenario: "S5_FollowUp", module: "sweep", code: "FOLLOW_UP_FAILED", message: msg, leadId: lead.id });
      results.push({ leadId: lead.id, businessName: lead.businessName, outcome: `error: ${msg.slice(0, 100)}` });
    }
  }

  console.log(`Follow-up sweep complete: ${results.length} processed.`);
  return { processed: results.length, killSwitchBlocked: false, results };
}

const isDirectExecution = process.argv[1]?.includes("follow-up-sweep");
if (isDirectExecution) {
  runFollowUpSweep().then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(0); }).catch((e) => { console.error(e); process.exit(1); });
}
