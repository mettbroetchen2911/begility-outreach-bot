import {
BotFrameworkAdapter,
TurnContext,
CardFactory,
ConversationReference,
Activity,
ActivityTypes,
MessageFactory,
StatusCodes,
} from "botbuilder";
import { Lead } from "@prisma/client";
import { prisma } from "../utils/prisma.js";
import { EmailService } from "./email.service.js";
import { CalendarService } from "./calendar.service.js";
import { getNicheConfig } from "../config/niche.js";
import { logError } from "../utils/logger.js";
import { withRetry } from "../utils/retry.js";
import { handleBotTextCommand } from "./bot-config-commands.js";
import { approveTier, approveFollowUp as approveFollowUpGuarded } from "./approve-guard.js";

// ── Types ──

export interface CardPostResult {
  activityId: string;
}

interface SubmitData {
  action: string;
  leadId?: string;
  queueId?: string;
  editedSubject?: string;
  editedBody?: string;
  tier?: string;
}

// ── Singleton adapter ──

let _adapter: BotFrameworkAdapter | null = null;

function getAdapter(): BotFrameworkAdapter {
  if (!_adapter) {
    _adapter = new BotFrameworkAdapter({
      appId: process.env.BOT_APP_ID ?? "",
      appPassword: process.env.BOT_APP_PASSWORD ?? "",
      channelAuthTenant: process.env.BOT_TENANT_ID ?? "",
    });

    // Global error handler
    _adapter.onTurnError = async (context: TurnContext, error: Error) => {
      console.error(`[Bot] Unhandled error: ${error.message}`);
      await logError({
        scenario: "BOT",
        module: "onTurnError",
        code: "BOT_ERROR",
        message: error.message,
      });
      try {
        await context.sendActivity("Something went wrong processing that action. The team has been notified.");
      } catch { /* swallow — might not be able to reply */ }
    };
  }
  return _adapter;
}

export function getBotAdapter(): BotFrameworkAdapter {
  return getAdapter();
}

// ============================================================================
// BOT SERVICE
// ============================================================================

export class BotService {
  private emailService: EmailService;
  private calendarService: CalendarService;

  constructor() {
    this.emailService = new EmailService();
    this.calendarService = new CalendarService();
  }

  // =========================================================================
  // ACTIVITY HANDLER — called from /api/messages route
  // =========================================================================

  async handleActivity(context: TurnContext): Promise<void> {
  const activity = context.activity;

  const channelName = context.activity.channelData?.channel?.name ?? "";
  const nameLower = channelName.toLowerCase();
  if (nameLower.includes("sales") || nameLower.includes("ops") || nameLower.includes("dev")) {
    const channelType = nameLower.includes("sales") ? "sales" : nameLower.includes("ops") ? "ops" : "devops";
    const ref = TurnContext.getConversationReference(context.activity);
    await prisma.botConversationRef.upsert({
      where: { channelType },
      create: { channelType, conversationReference: JSON.parse(JSON.stringify(ref)) },
      update: { conversationReference: JSON.parse(JSON.stringify(ref)) },
    });
    console.log(`[Bot] Saved conversation ref for channel: ${channelType}`);
  }

  if (activity.type === ActivityTypes.ConversationUpdate) {
    await this.handleConversationUpdate(context);
  } else if (activity.type === ActivityTypes.Message && activity.text) {
      // Clean the text by removing the @mention tags and making it lowercase
      const cleanText = TurnContext.removeRecipientMention(context.activity) || context.activity.text;
      const text = cleanText.trim().toLowerCase();

      // Use .includes() so we don't care where the word appears in the message
      if (text.includes("!register")) {
        let type = "";
        if (text.includes("sales")) type = "sales";
        else if (text.includes("devops")) type = "devops";
        else if (text.includes("ops")) type = "ops";

        if (type) {
          const ref = TurnContext.getConversationReference(context.activity);
          await prisma.botConversationRef.upsert({
            where: { channelType: type },
            create: { channelType: type, conversationReference: JSON.parse(JSON.stringify(ref)) },
            update: { conversationReference: JSON.parse(JSON.stringify(ref)) },
          });
          await context.sendActivity(`✅ Registered this channel as **${type}**. Approval cards will now route here.`);
        } else {
          await context.sendActivity("Usage: `@bot !register sales` / `@bot !register ops` / `@bot !register devops`");
        }
      } else {
        await context.sendActivity("I'm the Begility Lead Engine bot. I handle approval cards — no need to message me directly.");
      }
    } else if (activity.type === ActivityTypes.Message && activity.value) {
      await this.handleCardSubmit(context);
    } else if (activity.type === ActivityTypes.Invoke) {
      await this.handleInvoke(context);
    }
  }

  // =========================================================================
  // CONVERSATION UPDATE — store reference when bot is installed in a channel
  // =========================================================================

  private async handleConversationUpdate(context: TurnContext): Promise<void> {
    const added = context.activity.membersAdded ?? [];
    const botId = context.activity.recipient?.id;

    for (const member of added) {
      if (member.id === botId) {
        // Bot was added to a channel/conversation — store the reference
        const ref = TurnContext.getConversationReference(context.activity);
        const channelName = context.activity.channelData?.channel?.name ?? context.activity.conversation?.name ?? "unknown";

        console.log(`[Bot] Installed in channel: ${channelName} (${ref.conversation?.id})`);

        // Determine channel type from name or store as generic
        let channelType = "unknown";
        const nameLower = channelName.toLowerCase();
        if (nameLower.includes("sales") || nameLower.includes("lead")) channelType = "sales";
        else if (nameLower.includes("ops") || nameLower.includes("operation")) channelType = "ops";
        else if (nameLower.includes("dev") || nameLower.includes("error") || nameLower.includes("alert")) channelType = "devops";

        const refJson = JSON.parse(JSON.stringify(ref));

        await prisma.botConversationRef.upsert({
          where: { channelType },
          create: {
            channelType,
            conversationReference: refJson,
          },
          update: {
            conversationReference: refJson,
          },
        });

        await context.sendActivity(
          `Begility Lead Engine connected to **${channelType}** channel. ` +
          `Approval cards will appear here. If this is the wrong channel type, ` +
          `rename it to include "sales", "ops", or "devops" and re-add the bot.`
        );
      }
    }
  }

  // =========================================================================
  // CARD SUBMIT HANDLER — process approve/reject with edits
  // =========================================================================

  private async handleCardSubmit(context: TurnContext): Promise<void> {
    const data = context.activity.value as SubmitData;
    const userName = context.activity.from?.name ?? "Unknown";

    console.log(`[Bot] Card submit: action=${data.action}, user=${userName}`);

    try {
      switch (data.action) {
        case "approve_tier1":
          await this.approveTier1(context, data, userName);
          break;
        case "reject_tier1":
          await this.rejectTier1(context, data, userName);
          break;
        case "save_draft_tier1":
          await this.saveDraftTier1(context, data, userName);
          break;
        case "approve_tier2":
          await this.approveTier2(context, data, userName);
          break;
        case "reject_tier2":
          await this.rejectTier2(context, data, userName);
          break;
        case "save_draft_tier2":
          await this.saveDraftTier2(context, data, userName);
          break;
        case "approve_followup":
          await this.approveFollowUp(context, data, userName);
          break;
        case "reject_followup":
          await this.rejectFollowUp(context, data, userName);
          break;
        case "save_draft_followup":
          await this.saveDraftFollowUp(context, data, userName);
          break;
        default:
          await context.sendActivity(`Unknown action: ${data.action}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Bot] Submit handler error: ${msg}`);
      await logError({
        scenario: "BOT",
        module: data.action,
        code: "SUBMIT_FAILED",
        message: msg,
        leadId: data.leadId ?? data.queueId,
      });
      await context.sendActivity(`Action failed: ${msg}`);
    }
  }

  // ── Invoke handler (Teams may route some card actions here) ──

  private async handleInvoke(context: TurnContext): Promise<void> {
    // Respond with OK to prevent Teams showing an error
    await context.sendActivity({ type: ActivityTypes.InvokeResponse, value: { status: StatusCodes.OK } });
  }

  // =========================================================================
  // TIER 1 APPROVE — edit draft + update DB + send
  // =========================================================================

  private async approveTier1(context: TurnContext, data: SubmitData, userName: string): Promise<void> {
if (!data.leadId) throw new Error("Missing leadId");
const outcome = await approveTier({
kind: "tier1",
leadId: data.leadId,
decidedBy: userName,
editedSubject: data.editedSubject,
editedBody: data.editedBody,
});
if (!outcome.ok) {
await context.sendActivity(
`Could not approve: ${outcome.reason}${outcome.detail ? " — " + outcome.detail : ""}`
);
return;
}
const lead = await prisma.lead.findUnique({ where: { id: data.leadId } });
await this.replaceCardWithConfirmation(
context, "APPROVED",
lead?.businessName ?? "lead",
userName,
"Tier 1",
outcome.wasEdited,
);
}

  // =========================================================================
  // TIER 1 REJECT
  // =========================================================================

  private async rejectTier1(context: TurnContext, data: SubmitData, userName: string): Promise<void> {
    const { leadId } = data;
    if (!leadId) throw new Error("Missing leadId");

    const lead = await prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) throw new Error("Lead not found");
    if (lead.status !== "waiting_concierge") throw new Error(`Lead status is '${lead.status}', expected 'waiting_concierge'`);

    if (lead.outlookDraftId) {
      try { await this.emailService.deleteDraft(lead.outlookDraftId); }
      catch (e) { console.error("Draft deletion failed (non-fatal):", e); }
    }

    await prisma.lead.update({
      where: { id: leadId },
      data: { status: "rejected", outlookDraftId: null, enrichmentLock: false },
    });

    await this.replaceCardWithConfirmation(context, "REJECTED", lead.businessName, userName, "Tier 1");
  }

  // =========================================================================
  // TIER 2 APPROVE — same flow, different status transitions
  // =========================================================================

  private async approveTier2(context: TurnContext, data: SubmitData, userName: string): Promise<void> {
if (!data.leadId) throw new Error("Missing leadId");
const outcome = await approveTier({
kind: "tier2",
leadId: data.leadId,
decidedBy: userName,
editedSubject: data.editedSubject,
editedBody: data.editedBody,
});
if (!outcome.ok) {
await context.sendActivity(
`Could not approve: ${outcome.reason}${outcome.detail ? " — " + outcome.detail : ""}`
);
return;
}
const lead = await prisma.lead.findUnique({ where: { id: data.leadId } });
await this.replaceCardWithConfirmation(
context, "APPROVED",
lead?.businessName ?? "lead",
userName,
"Tier 2",
outcome.wasEdited,
);
}

  // =========================================================================
  // TIER 2 REJECT
  // =========================================================================

  private async rejectTier2(context: TurnContext, data: SubmitData, userName: string): Promise<void> {
    const { leadId } = data;
    if (!leadId) throw new Error("Missing leadId");

    const lead = await prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) throw new Error("Lead not found");

    if (lead.outlookDraftId) {
      try { await this.emailService.deleteDraft(lead.outlookDraftId); }
      catch (e) { console.error("Draft deletion failed (non-fatal):", e); }
    }

    await prisma.lead.update({
      where: { id: leadId },
      data: { status: "rejected", outlookDraftId: null, enrichmentLock: false },
    });

    await this.replaceCardWithConfirmation(context, "REJECTED", lead.businessName, userName, "Tier 2");
  }

  // =========================================================================
  // FOLLOW-UP APPROVE
  // =========================================================================

  private async approveFollowUp(context: TurnContext, data: SubmitData, userName: string): Promise<void> {
    if (!data.queueId) throw new Error("Missing queueId");

    const outcome = await approveFollowUpGuarded({
      kind: "followup",
      queueId: data.queueId,
      decidedBy: userName,
      editedSubject: data.editedSubject,
      editedBody: data.editedBody,
    });

    if (!outcome.ok) {
      await context.sendActivity(
        `Could not approve follow-up: ${outcome.reason}${outcome.detail ? " — " + outcome.detail : ""}`
      );
      return;
    }

    const entry = await prisma.followUpQueue.findUnique({ where: { id: data.queueId } });
    await this.replaceCardWithConfirmation(
      context, "APPROVED",
      entry?.businessName ?? "lead",
      userName,
      "Follow-up",
      outcome.wasEdited,
    );
  }

  // =========================================================================
  // FOLLOW-UP REJECT
  // =========================================================================

  private async rejectFollowUp(context: TurnContext, data: SubmitData, userName: string): Promise<void> {
    const { queueId } = data;
    if (!queueId) throw new Error("Missing queueId");

    const entry = await prisma.followUpQueue.findUnique({ where: { id: queueId } });
    if (!entry) throw new Error("Follow-up entry not found");
    if (entry.status !== "pending") throw new Error(`Entry status is '${entry.status}', expected 'pending'`);

    if (entry.draftId) {
      try { await this.emailService.deleteDraft(entry.draftId); }
      catch (e) { console.error("Draft deletion failed (non-fatal):", e); }
    }

    await prisma.followUpQueue.update({
      where: { id: queueId },
      data: { status: "rejected", approvedBy: userName, approvedAt: new Date() },
    });

    await prisma.lead.update({
      where: { id: entry.leadId },
      data: { status: "outreach_sent", followUpDraftId: null, followUpQueuedAt: null },
    });

    await this.replaceCardWithConfirmation(context, "REJECTED", entry.businessName, userName, "Follow-up");
  }

  // =========================================================================
  // SAVE DRAFT — patch Outlook draft without sending, replace card in Teams
  // =========================================================================

  private async saveDraftTier1(context: TurnContext, data: SubmitData, userName: string): Promise<void> {
    if (!data.leadId) throw new Error("Missing leadId");
    const lead = await prisma.lead.findUnique({ where: { id: data.leadId } });
    if (!lead) throw new Error("Lead not found");
    if (!lead.outlookDraftId) throw new Error("No Outlook draft found — cannot save");

    const finalSubject = data.editedSubject?.trim() || lead.draftSubject || "";
    const finalBody    = data.editedBody?.trim() || "";

    await this.emailService.updateDraft(lead.outlookDraftId, finalSubject, finalBody);
    await prisma.lead.update({
      where: { id: data.leadId },
      data: { draftSubject: finalSubject, draftBodyHtml: finalBody },
    });
    await this.replaceWithSavedCard(context, lead, "tier1", finalSubject, finalBody, userName);
  }

  private async saveDraftTier2(context: TurnContext, data: SubmitData, userName: string): Promise<void> {
    if (!data.leadId) throw new Error("Missing leadId");
    const lead = await prisma.lead.findUnique({ where: { id: data.leadId } });
    if (!lead) throw new Error("Lead not found");
    if (!lead.outlookDraftId) throw new Error("No Outlook draft found — cannot save");

    const finalSubject = data.editedSubject?.trim() || lead.draftSubject || "";
    const finalBody    = data.editedBody?.trim() || "";

    await this.emailService.updateDraft(lead.outlookDraftId, finalSubject, finalBody);
    await prisma.lead.update({
      where: { id: data.leadId },
      data: { draftSubject: finalSubject, draftBodyHtml: finalBody },
    });
    await this.replaceWithSavedCard(context, lead, "tier2", finalSubject, finalBody, userName);
  }

  private async saveDraftFollowUp(context: TurnContext, data: SubmitData, userName: string): Promise<void> {
    if (!data.queueId) throw new Error("Missing queueId");
    const entry = await prisma.followUpQueue.findUnique({ where: { id: data.queueId } });
    if (!entry) throw new Error("Follow-up entry not found");
    if (!entry.draftId) throw new Error("No Outlook draft found — cannot save");
    const lead = await prisma.lead.findUnique({ where: { id: entry.leadId } });
    if (!lead) throw new Error("Lead not found");

    const finalSubject = data.editedSubject?.trim() || lead.draftSubject || "";
    const finalBody    = data.editedBody?.trim() || "";

    await this.emailService.updateDraft(entry.draftId, finalSubject, finalBody);
    await prisma.lead.update({
      where: { id: entry.leadId },
      data: { draftSubject: finalSubject, draftBodyHtml: finalBody },
    });
    await this.replaceWithSavedFollowUpCard(
      context, data.queueId, entry.businessName, entry.email ?? "",
      finalSubject, finalBody, entry.geminiReasoning ?? "", userName,
    );
  }

  // =========================================================================
  // REPLACE WITH SAVED CARD — same editable card + green saved notice
  // =========================================================================

  private async replaceWithSavedCard(
    context: TurnContext,
    lead: Lead,
    tier: "tier1" | "tier2",
    savedSubject: string,
    savedBody: string,
    savedBy: string,
  ): Promise<void> {
    const config  = getNicheConfig();
    const savedAt = new Date().toLocaleString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" });
    const label   = tier === "tier1" ? "TIER 1 APPROVAL REQUIRED" : "TIER 2 APPROVAL";
    const color   = tier === "tier1" ? "Warning" : "Accent";

    const updatedCard = {
      type: "AdaptiveCard",
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      version: "1.4",
      body: [
        {
          type: "Container",
          style: "good",
          items: [{ type: "TextBlock", text: `💾 Saved to Outlook at ${savedAt} by ${savedBy}`, color: "Good", weight: "Bolder", size: "Small" }],
        },
        {
          type: "Container",
          style: "emphasis",
          items: [{ type: "TextBlock", text: label, color, weight: "Bolder", size: "Medium" }],
        },
        {
          type: "FactSet",
          facts: [
            { title: "Business",  value: lead.businessName },
            { title: "Owner",     value: lead.ownerName ?? "Unknown" },
            { title: "Location",  value: [lead.city, lead.country].filter(Boolean).join(", ") || "—" },
            { title: "Score",     value: `${lead.brandFitScore ?? "—"}/100 (${lead.tier ?? "Unscored"})` },
            { title: "Email",     value: lead.email ?? "—" },
            ...(tier === "tier1" ? [
              { title: "LinkedIn",  value: (lead as any).linkedin ?? "—" },
              { title: "Verified",  value: lead.emailVerified ? `Score ${lead.verificationScore}/100` : "Not verified" },
            ] : []),
          ],
        },
        { type: "TextBlock", text: `**${config.brandName} Rationale:**`, spacing: "Medium" },
        { type: "TextBlock", text: lead.brandFitRationale ?? "No rationale available.", size: "Small", wrap: true },
        { type: "TextBlock", text: "**Subject** *(edit below if needed):*", spacing: "Medium" },
        { type: "Input.Text", id: "editedSubject", value: savedSubject, placeholder: "Email subject line" },
        { type: "TextBlock", text: "**Email Body** *(edit below if needed):*", spacing: "Medium" },
        { type: "Input.Text", id: "editedBody", isMultiline: true, value: savedBody, placeholder: "Email body" },
      ],
      actions: [
        { type: "Action.Submit", title: "✅ Approve & Send", style: "positive", data: { action: `approve_${tier}`, leadId: lead.id } },
        { type: "Action.Submit", title: "💾 Save to Outlook Draft", data: { action: `save_draft_${tier}`, leadId: lead.id } },
        { type: "Action.Submit", title: "❌ Reject", style: "destructive", data: { action: `reject_${tier}`, leadId: lead.id } },
      ],
    };

    try {
      const updated = MessageFactory.attachment(CardFactory.adaptiveCard(updatedCard));
      updated.id = context.activity.replyToId;
      await context.updateActivity(updated);
    } catch {
      await context.sendActivity(MessageFactory.attachment(CardFactory.adaptiveCard(updatedCard)));
    }
  }

  private async replaceWithSavedFollowUpCard(
    context: TurnContext,
    queueId: string,
    businessName: string,
    email: string,
    savedSubject: string,
    savedBody: string,
    reasoning: string,
    savedBy: string,
  ): Promise<void> {
    const savedAt = new Date().toLocaleString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" });

    const updatedCard = {
      type: "AdaptiveCard",
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      version: "1.4",
      body: [
        {
          type: "Container",
          style: "good",
          items: [{ type: "TextBlock", text: `💾 Saved to Outlook at ${savedAt} by ${savedBy}`, color: "Good", weight: "Bolder", size: "Small" }],
        },
        {
          type: "Container",
          style: "emphasis",
          items: [{ type: "TextBlock", text: "FOLLOW-UP APPROVAL", color: "Warning", weight: "Bolder", size: "Medium" }],
        },
        {
          type: "FactSet",
          facts: [
            { title: "Business",     value: businessName },
            { title: "Email",        value: email },
            { title: "AI Reasoning", value: reasoning.slice(0, 200) },
          ],
        },
        { type: "TextBlock", text: "**Subject** *(edit below if needed):*", spacing: "Medium" },
        { type: "Input.Text", id: "editedSubject", value: savedSubject },
        { type: "TextBlock", text: "**Email Body** *(edit below if needed):*", spacing: "Medium" },
        { type: "Input.Text", id: "editedBody", isMultiline: true, value: savedBody },
      ],
      actions: [
        { type: "Action.Submit", title: "✅ Approve & Send", style: "positive", data: { action: "approve_followup", queueId } },
        { type: "Action.Submit", title: "💾 Save to Outlook Draft", data: { action: "save_draft_followup", queueId } },
        { type: "Action.Submit", title: "❌ Reject", style: "destructive", data: { action: "reject_followup", queueId } },
      ],
    };

    try {
      const updated = MessageFactory.attachment(CardFactory.adaptiveCard(updatedCard));
      updated.id = context.activity.replyToId;
      await context.updateActivity(updated);
    } catch {
      await context.sendActivity(MessageFactory.attachment(CardFactory.adaptiveCard(updatedCard)));
    }
  }

  // =========================================================================
  // CARD REPLACEMENT — update the original card after decision
  // =========================================================================

  private async replaceCardWithConfirmation(
    context: TurnContext,
    decision: "APPROVED" | "REJECTED",
    businessName: string,
    decidedBy: string,
    cardType: string,
    wasEdited = false,
  ): Promise<void> {
    const color = decision === "APPROVED" ? "Good" : "Attention";
    const emoji = decision === "APPROVED" ? "✅" : "❌";
    const editNote = wasEdited ? " *(email was edited before sending)*" : "";

    const confirmCard = {
      type: "AdaptiveCard",
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      version: "1.4",
      body: [
        {
          type: "Container",
          style: decision === "APPROVED" ? "good" : "attention",
          items: [
            {
              type: "TextBlock",
              text: `${emoji} ${cardType} — ${decision}`,
              weight: "Bolder",
              size: "Medium",
              color,
            },
          ],
        },
        {
          type: "FactSet",
          facts: [
            { title: "Business", value: businessName },
            { title: "Decision by", value: decidedBy },
            { title: "Time", value: new Date().toLocaleString("en-GB", { timeZone: "Europe/London" }) },
          ],
        },
        ...(editNote ? [{ type: "TextBlock", text: editNote, size: "Small", isSubtle: true, wrap: true }] : []),
      ],
    };

    try {
      const updatedActivity = MessageFactory.attachment(CardFactory.adaptiveCard(confirmCard));
      updatedActivity.id = context.activity.replyToId;
      await context.updateActivity(updatedActivity);
    } catch (e) {
      // Fallback: if we can't update, post a reply
      console.warn(`[Bot] Card update failed, posting reply instead: ${e}`);
      await context.sendActivity(MessageFactory.attachment(CardFactory.adaptiveCard(confirmCard)));
    }
  }

  // =========================================================================
  // PROACTIVE MESSAGING — send cards to channels
  // =========================================================================

  private async getConversationRef(channelType: string): Promise<ConversationReference> {
    const record = await prisma.botConversationRef.findUnique({ where: { channelType } });
    if (!record) {
      throw new Error(
        `No conversation reference for channel "${channelType}". ` +
        `The bot needs to be installed in a Teams channel with "${channelType}" in its name.`
      );
    }
    return record.conversationReference as unknown as ConversationReference;
  }

  private async proactiveSend(channelType: string, card: Record<string, unknown>): Promise<string> {
    const ref = await this.getConversationRef(channelType);
    const adapter = getAdapter();
    let activityId = `bot-${Date.now()}`;

    await adapter.continueConversation(ref, async (context) => {
      const response = await context.sendActivity(
        MessageFactory.attachment(CardFactory.adaptiveCard(card))
      );
      activityId = response?.id ?? activityId;
    });

    return activityId;
  }

  // =========================================================================
  // TIER 1 APPROVAL CARD — editable subject + body
  // =========================================================================

  async sendApprovalCard(lead: Lead): Promise<CardPostResult> {
    const config = getNicheConfig();
    const plainBody = lead.draftBodyHtml ? stripHtml(lead.draftBodyHtml) : "No preview";

    const card = {
      type: "AdaptiveCard",
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      version: "1.4",
      body: [
        {
          type: "Container",
          style: "emphasis",
          items: [
            { type: "TextBlock", text: "TIER 1 APPROVAL REQUIRED", color: "Warning", weight: "Bolder", size: "Medium" },
          ],
        },
        {
          type: "FactSet",
          facts: [
            { title: "Business", value: lead.businessName },
            { title: "Owner", value: lead.ownerName ?? "Unknown" },
            { title: "Location", value: [lead.city, lead.country].filter(Boolean).join(", ") || "—" },
            { title: "Score", value: `${lead.brandFitScore ?? "—"}/100 (${lead.tier ?? "Unscored"})` },
            { title: "LinkedIn", value: (lead as any).linkedin ?? "—" },
            { title: "Email", value: lead.email ?? "—" },
            { title: "Verified", value: lead.emailVerified ? `Score ${lead.verificationScore}/100` : "Not verified" },
          ],
        },
        { type: "TextBlock", text: `**${config.brandName} Rationale:**`, spacing: "Medium" },
        { type: "TextBlock", text: lead.brandFitRationale ?? "No rationale available.", size: "Small", wrap: true },
        { type: "TextBlock", text: "**Subject** *(edit below if needed):*", spacing: "Medium" },
        {
          type: "Input.Text",
          id: "editedSubject",
          value: lead.draftSubject ?? "",
          placeholder: "Email subject line",
        },
        { type: "TextBlock", text: "**Email Body** *(edit below if needed):*", spacing: "Medium" },
        {
          type: "Input.Text",
          id: "editedBody",
          isMultiline: true,
          value: plainBody,
          placeholder: "Email body",
        },
      ],
      actions: [
        {
          type: "Action.Submit",
          title: "✅ Approve & Send",
          style: "positive",
          data: { action: "approve_tier1", leadId: lead.id },
        },
        {
          type: "Action.Submit",
          title: "💾 Save to Outlook Draft",
          data: { action: "save_draft_tier1", leadId: lead.id },
        },
        {
          type: "Action.Submit",
          title: "❌ Reject",
          style: "destructive",
          data: { action: "reject_tier1", leadId: lead.id },
        },
      ],
    };

    const activityId = await this.proactiveSend("sales", card);
    return { activityId };
  }

  // =========================================================================
  // TIER 2 APPROVAL CARD — same editable format, different label
  // =========================================================================

  async sendTier2ApprovalCard(lead: Lead): Promise<CardPostResult> {
    const config = getNicheConfig();
    const plainBody = lead.draftBodyHtml ? stripHtml(lead.draftBodyHtml) : "No preview";

    const card = {
      type: "AdaptiveCard",
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      version: "1.4",
      body: [
        {
          type: "Container",
          style: "emphasis",
          items: [
            { type: "TextBlock", text: "TIER 2 APPROVAL", color: "Accent", weight: "Bolder", size: "Medium" },
          ],
        },
        {
          type: "FactSet",
          facts: [
            { title: "Business", value: lead.businessName },
            { title: "Owner", value: lead.ownerName ?? "Unknown" },
            { title: "Location", value: [lead.city, lead.country].filter(Boolean).join(", ") || "—" },
            { title: "Score", value: `${lead.brandFitScore ?? "—"}/100 (${lead.tier ?? "Unscored"})` },
            { title: "Email", value: lead.email ?? "—" },
          ],
        },
        { type: "TextBlock", text: `**${config.brandName} Rationale:**`, spacing: "Medium" },
        { type: "TextBlock", text: lead.brandFitRationale ?? "No rationale available.", size: "Small", wrap: true },
        { type: "TextBlock", text: "**Subject** *(edit below if needed):*", spacing: "Medium" },
        {
          type: "Input.Text",
          id: "editedSubject",
          value: lead.draftSubject ?? "",
        },
        { type: "TextBlock", text: "**Email Body** *(edit below if needed):*", spacing: "Medium" },
        {
          type: "Input.Text",
          id: "editedBody",
          isMultiline: true,
          value: plainBody,
        },
      ],
      actions: [
        {
          type: "Action.Submit",
          title: "✅ Approve & Send",
          style: "positive",
          data: { action: "approve_tier2", leadId: lead.id },
        },
        {
          type: "Action.Submit",
          title: "💾 Save to Outlook Draft",
          data: { action: "save_draft_tier2", leadId: lead.id },
        },
        {
          type: "Action.Submit",
          title: "❌ Reject",
          style: "destructive",
          data: { action: "reject_tier2", leadId: lead.id },
        },
      ],
    };

    const activityId = await this.proactiveSend("sales", card);
    return { activityId };
  }

  // =========================================================================
  // FOLLOW-UP APPROVAL CARD — editable
  // =========================================================================

  async sendFollowUpApprovalCard(
    queueId: string,
    businessName: string,
    email: string,
    draftSubject: string,
    draftBodyPlain: string,
    reasoning: string,
  ): Promise<CardPostResult> {
    const card = {
      type: "AdaptiveCard",
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      version: "1.4",
      body: [
        {
          type: "Container",
          style: "emphasis",
          items: [
            { type: "TextBlock", text: "FOLLOW-UP APPROVAL", color: "Warning", weight: "Bolder", size: "Medium" },
          ],
        },
        {
          type: "FactSet",
          facts: [
            { title: "Business", value: businessName },
            { title: "Email", value: email },
            { title: "AI Reasoning", value: reasoning.slice(0, 200) },
          ],
        },
        { type: "TextBlock", text: "**Subject** *(edit below if needed):*", spacing: "Medium" },
        {
          type: "Input.Text",
          id: "editedSubject",
          value: draftSubject,
        },
        { type: "TextBlock", text: "**Email Body** *(edit below if needed):*", spacing: "Medium" },
        {
          type: "Input.Text",
          id: "editedBody",
          isMultiline: true,
          value: draftBodyPlain,
        },
      ],
      actions: [
        {
          type: "Action.Submit",
          title: "✅ Approve & Send",
          style: "positive",
          data: { action: "approve_followup", queueId },
        },
        {
          type: "Action.Submit",
          title: "💾 Save to Outlook Draft",
          data: { action: "save_draft_followup", queueId },
        },
        {
          type: "Action.Submit",
          title: "❌ Reject",
          style: "destructive",
          data: { action: "reject_followup", queueId },
        },
      ],
    };

    const activityId = await this.proactiveSend("sales", card);
    return { activityId };
  }

  // =========================================================================
  // REPLY APPROVAL CARD (hard_no goodbye)
  // =========================================================================

  // =========================================================================
  // REPLY APPROVAL CARD (hard_no goodbye)
  // =========================================================================

  async sendReplyApprovalCard(opts: {
    queueId: string;
    businessName: string;
    email: string;
    sentiment: string;
    replySnippet: string;
    reasoning: string;
    draftSubject: string;
    draftBodyPlain: string;
  }): Promise<CardPostResult> {
    const sentimentLabel = opts.sentiment === "hard_no" ? "HARD NO — Goodbye Draft" : "Reply Draft";

    const card = {
      type: "AdaptiveCard",
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      version: "1.4",
      body: [
        {
          type: "Container",
          style: "attention",
          items: [
            { type: "TextBlock", text: sentimentLabel, color: "Attention", weight: "Bolder", size: "Medium" },
          ],
        },
        {
          type: "FactSet",
          facts: [
            { title: "Business", value: opts.businessName },
            { title: "Email", value: opts.email },
            { title: "Sentiment", value: opts.sentiment },
          ],
        },
        { type: "TextBlock", text: "**Their reply:**", spacing: "Medium" },
        { type: "TextBlock", text: opts.replySnippet, size: "Small", wrap: true },
        { type: "TextBlock", text: `**Reasoning:** ${opts.reasoning}`, wrap: true },
        { type: "TextBlock", text: "**Subject** *(edit below if needed):*", spacing: "Medium" },
        { type: "Input.Text", id: "editedSubject", value: opts.draftSubject },
        { type: "TextBlock", text: "**Response Body** *(edit below if needed):*", spacing: "Medium" },
        { type: "Input.Text", id: "editedBody", isMultiline: true, value: opts.draftBodyPlain },
      ],
      actions: [
        {
          type: "Action.Submit",
          title: "✅ Approve & Send",
          style: "positive",
          data: { action: "approve_followup", queueId: opts.queueId },
        },
        {
          type: "Action.Submit",
          title: "❌ Reject",
          style: "destructive",
          data: { action: "reject_followup", queueId: opts.queueId },
        },
      ],
    };

    const activityId = await this.proactiveSend("sales", card);
    return { activityId };
  }

  // =========================================================================
  // ALERT CARDS (non-editable, no approval needed)
  // =========================================================================

  async sendWarmReplyAlert(lead: Lead, reasoning: string, suggestedAction: string): Promise<CardPostResult> {
    const snippet = lead.replyBody
      ? lead.replyBody.slice(0, 300) + (lead.replyBody.length > 300 ? "…" : "")
      : "No reply body";

    const card = {
      type: "AdaptiveCard",
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      version: "1.4",
      body: [
        {
          type: "Container",
          style: "good",
          items: [{ type: "TextBlock", text: "WARM REPLY — CALL NOW", color: "Good", weight: "Bolder", size: "Medium" }],
        },
        {
          type: "FactSet",
          facts: [
            { title: "Business", value: lead.businessName },
            { title: "Owner", value: lead.ownerName ?? "Unknown" },
            { title: "Score", value: `${lead.brandFitScore ?? "—"}/100` },
          ],
        },
        { type: "TextBlock", text: "**Reply:**", spacing: "Medium" },
        { type: "TextBlock", text: snippet, size: "Small", wrap: true },
        { type: "TextBlock", text: `**Reasoning:** ${reasoning}`, wrap: true },
        { type: "TextBlock", text: `**Suggested:** ${suggestedAction}`, weight: "Bolder", wrap: true },
      ],
    };

    const activityId = await this.proactiveSend("sales", card);
    return { activityId };
  }

  async sendReplyAlert(lead: Lead, sentiment: string, reasoning: string, replySnippet: string): Promise<CardPostResult> {
    const card = {
      type: "AdaptiveCard",
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      version: "1.4",
      body: [
        {
          type: "Container",
          style: sentiment === "soft_no" ? "emphasis" : "default",
          items: [
            { type: "TextBlock", text: `REPLY — ${sentiment.toUpperCase()}`, weight: "Bolder", size: "Medium" },
          ],
        },
        {
          type: "FactSet",
          facts: [
            { title: "Business", value: lead.businessName },
            { title: "Owner", value: lead.ownerName ?? "Unknown" },
            { title: "Email", value: lead.email ?? "—" },
            { title: "Score", value: `${lead.brandFitScore ?? "—"}/100` },
            { title: "AI Reasoning", value: reasoning.slice(0, 200) },
          ],
        },
        { type: "TextBlock", text: "**Their reply:**", spacing: "Medium" },
        { type: "TextBlock", text: replySnippet, size: "Small", wrap: true },
        ...(sentiment === "soft_no"
          ? [{ type: "TextBlock", text: "_This lead declined softly — timing, uncertainty, or addressable objection. A call or tailored reply could convert them._", wrap: true, isSubtle: true }]
          : [{ type: "TextBlock", text: "_Review the reply and decide next steps manually._", wrap: true, isSubtle: true }]
        ),
      ],
    };

    const activityId = await this.proactiveSend("sales", card);
    return { activityId };
  }

  // =========================================================================
  // DAILY DIGEST
  // =========================================================================

  async sendDailyDigest(sections: {
    warmReplies: Array<{ businessName: string; ownerName: string | null; score: number | null }>;
    pendingApprovals: Array<{ businessName: string; score: number | null }>;
    tier2Drafts: Array<{ businessName: string; score: number | null }>;
    followUpQueue: Array<{ businessName: string; draftPreview: string | null }>;
    topLeads: Array<{ businessName: string; score: number | null; status: string }>;
  }): Promise<CardPostResult> {
    const fmt = (items: Array<Record<string, unknown>>, fn: (i: any) => string, empty: string) =>
      items.length === 0 ? `_${empty}_` : items.map((item, i) => `${i + 1}. ${fn(item)}`).join("\n\n");

    const card = {
      type: "AdaptiveCard",
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      version: "1.4",
      body: [
        { type: "TextBlock", text: `Daily Lead Briefing — ${new Date().toLocaleDateString("en-GB")}`, weight: "Bolder", size: "Large" },
        { type: "TextBlock", text: "**Warm Replies — call today**", spacing: "Large" },
        { type: "TextBlock", text: fmt(sections.warmReplies, (r) => `**${r.businessName}** (${r.ownerName ?? "?"}) — ${r.score ?? "—"}/100`, "None"), size: "Small", wrap: true },
        { type: "TextBlock", text: "**Tier 1 Pending**", spacing: "Medium" },
        { type: "TextBlock", text: fmt(sections.pendingApprovals, (a) => `**${a.businessName}** — ${a.score ?? "—"}/100`, "None"), size: "Small", wrap: true },
        { type: "TextBlock", text: "**Tier 2 Pending**", spacing: "Medium" },
        { type: "TextBlock", text: fmt(sections.tier2Drafts, (a) => `**${a.businessName}** — ${a.score ?? "—"}/100`, "None"), size: "Small", wrap: true },
        { type: "TextBlock", text: "**Follow-Up Queue**", spacing: "Medium" },
        { type: "TextBlock", text: fmt(sections.followUpQueue, (f) => `**${f.businessName}** — ${(f.draftPreview ?? "").slice(0, 80)}`, "Empty"), size: "Small", wrap: true },
        { type: "TextBlock", text: "**Top Active Leads**", spacing: "Medium" },
        { type: "TextBlock", text: fmt(sections.topLeads, (l) => `**${l.businessName}** — ${l.score ?? "—"}/100 (${l.status})`, "None"), size: "Small", wrap: true },
      ],
    };

    const activityId = await this.proactiveSend("sales", card);
    return { activityId };
  }

  // =========================================================================
  // OPS / DEVOPS ALERTS
  // =========================================================================

  async sendOpsAlert(channel: "sales" | "ops", title: string, facts: Array<{ title: string; value: string }>): Promise<CardPostResult> {
    const card = {
      type: "AdaptiveCard",
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      version: "1.4",
      body: [
        { type: "TextBlock", text: title, weight: "Bolder", size: "Medium" },
        { type: "FactSet", facts },
      ],
    };

    const activityId = await this.proactiveSend(channel, card);
    return { activityId };
  }

  async sendErrorAlert(opts: {
    scenarioName: string;
    errorCode: string;
    errorMessage: string;
    leadId?: string;
    killSwitchFired: boolean;
    bounceRate?: number;
    s5Confirmed?: boolean;
  }): Promise<CardPostResult> {
    const card = {
      type: "AdaptiveCard",
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      version: "1.4",
      body: [
        {
          type: "Container",
          style: opts.killSwitchFired ? "attention" : "emphasis",
          items: [
            {
              type: "TextBlock",
              text: opts.killSwitchFired ? "🛑 KILL SWITCH FIRED" : "⚠️ ERROR ALERT",
              color: opts.killSwitchFired ? "Attention" : "Warning",
              weight: "Bolder",
              size: "Medium",
            },
          ],
        },
        {
          type: "FactSet",
          facts: [
            { title: "Scenario", value: opts.scenarioName },
            { title: "Code", value: opts.errorCode },
            { title: "Message", value: opts.errorMessage.slice(0, 300) },
            ...(opts.leadId ? [{ title: "Lead ID", value: opts.leadId }] : []),
            ...(opts.bounceRate != null ? [{ title: "Bounce Rate", value: `${(opts.bounceRate * 100).toFixed(1)}%` }] : []),
          ],
        },
        {
          type: "TextBlock",
          text: opts.killSwitchFired
            ? "_Re-enable manually after investigation._"
            : "_Check logs._",
          wrap: true,
          isSubtle: true,
        },
      ],
    };

    const activityId = await this.proactiveSend("devops", card);
    return { activityId };
  }
}

// ── Utility ──

function stripHtml(html: string): string {
  return html
    .replace(/<\/(p|div)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .trim();
}
