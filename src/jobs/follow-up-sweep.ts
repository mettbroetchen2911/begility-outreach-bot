import { prisma } from "../utils/prisma.js";
import { EmailService } from "../services/email.service.js";
import { BotService } from "../services/bot.service.js";
import { AIService } from "../services/ai.service.js";
import { logError } from "../utils/logger.js";
import { isKillSwitchActive } from "./bounce-monitor.js";
import { stripHtml } from "../utils/text-utils.js";

const emailSvc = new EmailService();
const botSvc = new BotService();
const ai = new AIService();

export async function runFollowUpSweep(): Promise<{
  processed: number;
  results: Array<{ leadId: string; businessName: string; outcome: string }>;
  skipped?: string;
}> {
  if (await isKillSwitchActive()) {
    console.warn("Follow-up sweep: kill switch active — aborting.");
    return { processed: 0, results: [], skipped: "kill_switch" };
  }

  const minDays = parseInt(process.env.FOLLOW_UP_MIN_DAYS ?? "3", 10);
  const cutoff = new Date(Date.now() - minDays * 24 * 60 * 60 * 1000);

  const leads = await prisma.lead.findMany({
    where: {
      status: "outreach_sent",
      replyReceived: false,
      lastContactedAt: { lt: cutoff },
      followUpDraftId: null,
    },
    orderBy: { lastContactedAt: "asc" },
    take: parseInt(process.env.FOLLOW_UP_BATCH_SIZE ?? "5", 10),
  });

  if (leads.length === 0) {
    console.log("Follow-up sweep: no leads eligible.");
    return { processed: 0, results: [] };
  }

  console.log(`Follow-up sweep: ${leads.length} leads eligible.`);
  const results: Array<{ leadId: string; businessName: string; outcome: string }> = [];

  for (const lead of leads) {
    try {
      console.log(`  Processing: ${lead.businessName}`);

      // Guard: email is required for drafting + queue entry + Teams card
      if (!lead.email) {
        console.log(`  No email on record — skipping.`);
        results.push({ leadId: lead.id, businessName: lead.businessName, outcome: "skipped_no_email" });
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
      const bodyPlain = stripHtml(followUp.email_body_html);

      // Create follow-up queue entry
      const queueEntry = await prisma.followUpQueue.create({
        data: {
          leadId: lead.id,
          businessName: lead.businessName,
          email: lead.email,
          draftId: draft.messageId,
          draftPreview: `${followUp.subject_line}\n\n${bodyPlain}`,
          geminiReasoning: followUp.reasoning,
          status: "pending",
        },
      });

      // Update lead — prevents re-queuing
      await prisma.lead.update({
        where: { id: lead.id },
        data: { followUpDraftId: draft.messageId, followUpQueuedAt: new Date(), status: "follow_up_queued" },
      });

      // Send editable approval card via bot (no HMAC URLs needed)
      try {
        await botSvc.sendFollowUpApprovalCard(
          queueEntry.id,
          lead.businessName,
          lead.email,
          followUp.subject_line,
          bodyPlain,
          followUp.reasoning,
        );
      } catch (e) {
        console.error(`  Teams card failed (non-fatal): ${e}`);
      }

      console.log(`  Done: ${lead.businessName} queued (${followUp.reasoning})`);
      results.push({ leadId: lead.id, businessName: lead.businessName, outcome: "follow_up_queued" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ERROR for ${lead.businessName}: ${msg}`);
      await logError({
        scenario: "S5_FollowUp",
        module: "sweep",
        code: "FOLLOW_UP_FAILED",
        message: msg,
        leadId: lead.id,
      });
      results.push({ leadId: lead.id, businessName: lead.businessName, outcome: `error: ${msg.slice(0, 100)}` });
    }
  }

  console.log(`Follow-up sweep complete: ${results.length} processed.`);
  return { processed: results.length, results };
}

const isDirectExecution = process.argv[1]?.includes("follow-up-sweep");
if (isDirectExecution) {
  runFollowUpSweep().then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(0); }).catch((e) => { console.error(e); process.exit(1); });
}
