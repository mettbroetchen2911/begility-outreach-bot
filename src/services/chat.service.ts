import { Lead } from "@prisma/client";
import { getNicheConfig } from "../config/niche.js";
import { withRetry } from "../utils/retry.js";

export interface CardPostResult {
  activityId: string;
}

export class ChatService {
  private salesWebhook: string;
  private opsWebhook: string;
  private devopsWebhook: string;

  constructor() {
    this.salesWebhook = req("TEAMS_WEBHOOK_SALES");
    this.opsWebhook = req("TEAMS_WEBHOOK_OPS");
    this.devopsWebhook = req("TEAMS_WEBHOOK_DEVOPS");
  }

  async sendApprovalCard(lead: Lead, approveUrl: string, rejectUrl: string, editUrl?: string | null): Promise<CardPostResult> {
    const config = getNicheConfig();
    const fullEmail = lead.draftBodyHtml
  ? stripHtml(lead.draftBodyHtml)
  : "No preview";

    const card = adaptiveCard([
      container("emphasis", [text("TIER 1 APPROVAL REQUIRED", "Warning", "Bolder", "Medium")]),
      {
        type: "FactSet",
        facts: [
          { title: "Business", value: lead.businessName },
          { title: "Owner", value: lead.ownerName ?? "Unknown" },
          { title: "Location", value: [lead.city, lead.country].filter(Boolean).join(", ") || "—" },
          { title: "Score", value: `${lead.brandFitScore ?? "—"}/100 (${lead.tier ?? "Unscored"})` },
          { title: "Instagram", value: lead.instagram ? `@${lead.instagram}` : "—" },
          { title: "Email", value: lead.email ?? "—" },
          { title: "Verified", value: lead.emailVerified ? `Score ${lead.verificationScore}/100` : "Not verified" },
        ],
      },
      text(`**${config.brandName} Rationale:**`, undefined, undefined, "Medium"),
      text(lead.brandFitRationale ?? "No rationale available.", undefined, "Small"),
      text("**Email Preview:**", undefined, undefined, "Medium"),
      text(`**Subject:** ${lead.draftSubject ?? "—"}`, undefined, "Small"),
text(fullEmail, undefined, "Small", undefined, true),
    ], [
      ...(editUrl ? [{ type: "Action.OpenUrl", title: "Edit in Outlook", url: editUrl }] : []),
      { type: "Action.OpenUrl", title: "Approve & Send", url: approveUrl, style: "positive" },
      { type: "Action.OpenUrl", title: "Reject", url: rejectUrl, style: "destructive" },
    ]);
    return this.postCard(this.salesWebhook, card);
  }

  async updateCard(activityId: string, decision: "approved" | "rejected", decidedBy: string): Promise<void> {
    // Incoming Webhooks don't support updating posted cards.
    // The approval/rejection is confirmed via the webhook response page instead.
    console.log(`Card update skipped (webhooks don't support updates): ${decision} by ${decidedBy} for activity ${activityId}`);
  }

  async sendWarmReplyAlert(lead: Lead, reasoning: string, suggestedAction: string): Promise<CardPostResult> {
    const snippet = lead.replyBody
      ? lead.replyBody.slice(0, 300) + (lead.replyBody.length > 300 ? "…" : "")
      : "No reply body";

    const card = adaptiveCard([
      container("good", [text("WARM REPLY — CALL NOW", "Good", "Bolder", "Medium")]),
      {
        type: "FactSet",
        facts: [
          { title: "Business", value: lead.businessName },
          { title: "Owner", value: lead.ownerName ?? "Unknown" },
          { title: "Score", value: `${lead.brandFitScore ?? "—"}/100` },
        ],
      },
      text("**Reply:**", undefined, undefined, "Medium"),
      text(snippet, undefined, "Small", undefined, true),
      text(`**Reasoning:** ${reasoning}`),
      text(`**Suggested:** ${suggestedAction}`, undefined, undefined, undefined, false, "Bolder"),
    ]);

    return this.postCard(this.salesWebhook, card);
  }

  async sendFollowUpApprovalCard(
    queueId: string,
    businessName: string,
    email: string,
    draftPreview: string,
    reasoning: string,
    approveUrl: string,
    rejectUrl: string,
    editUrl?: string | null // <-- ADDED THIS PARAMETER
  ): Promise<CardPostResult> {
    const card = adaptiveCard([
      container("emphasis", [text("FOLLOW-UP APPROVAL", "Warning", "Bolder", "Medium")]),
      {
        type: "FactSet",
        facts: [
          { title: "Business", value: businessName },
          { title: "Email", value: email },
          { title: "AI Reasoning", value: reasoning.slice(0, 200) },
        ],
      },
      text("**Draft Preview:**", undefined, undefined, "Medium"),
      text(draftPreview, undefined, "Small", undefined, true), 
    ], [
  ...(editUrl ? [{ type: "Action.OpenUrl", title: "Edit in Outlook", url: editUrl }] : []),
  { type: "Action.OpenUrl", title: "Approve & Send", url: approveUrl, style: "positive" },
  { type: "Action.OpenUrl", title: "Reject", url: rejectUrl, style: "destructive" },
]);

    return this.postCard(this.salesWebhook, card);
  }

  async sendReplyApprovalCard(opts: {
    queueId: string;
    businessName: string;
    email: string;
    sentiment: string;
    replySnippet: string;
    reasoning: string;
    draftPreview: string;
    approveUrl: string;
    rejectUrl: string;
  }): Promise<CardPostResult> {
    const sentimentLabel = opts.sentiment === "hard_no" ? "HARD NO" : opts.sentiment.toUpperCase();

    const card = adaptiveCard([
      container("attention", [text(`REPLY — ${sentimentLabel}`, "Attention", "Bolder", "Medium")]),
      {
        type: "FactSet",
        facts: [
          { title: "Business", value: opts.businessName },
          { title: "Email", value: opts.email },
          { title: "AI Classification", value: `${opts.sentiment} — ${opts.reasoning.slice(0, 150)}` },
        ],
      },
      text("**Their reply:**", undefined, undefined, "Medium"),
      text(opts.replySnippet, undefined, "Small", undefined, true),
      text("**Drafted goodbye:**", undefined, undefined, "Medium"),
      text(opts.draftPreview, undefined, "Small", undefined, true),
      text("_Approve sends the goodbye email. Reject keeps the lead open for manual handling._", undefined, undefined, undefined, true),
    ], [
      { type: "Action.OpenUrl", title: "Send Goodbye", url: opts.approveUrl, style: "positive" },
      { type: "Action.OpenUrl", title: "Don't Send — Keep Open", url: opts.rejectUrl, style: "destructive" },
    ]);

    return this.postCard(this.salesWebhook, card);
  }

  async sendReplyAlert(lead: Lead, sentiment: string, reasoning: string, replySnippet: string): Promise<CardPostResult> {
    const colorMap: Record<string, string> = {
      soft_no: "Warning",
      neutral: "Default",
      hard_no: "Attention",
      positive: "Good",
    };
    const color = colorMap[sentiment] ?? "Default";

    const actionLabel =
      sentiment === "soft_no" ? "SALVAGEABLE — needs human touch" :
      sentiment === "neutral" ? "NEEDS TRIAGE — unclear intent" :
      sentiment.toUpperCase();

    const card = adaptiveCard([
      container(sentiment === "soft_no" ? "warning" : "emphasis", [
        text(`REPLY — ${actionLabel}`, color, "Bolder", "Medium"),
      ]),
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
      text("**Their reply:**", undefined, undefined, "Medium"),
      text(replySnippet, undefined, "Small", undefined, true),
      text(
        sentiment === "soft_no"
          ? "_This lead declined softly — timing, uncertainty, or addressable objection. A call or tailored reply could convert them._"
          : "_Review the reply and decide next steps manually._",
        undefined, undefined, undefined, true
      ),
    ]);

    return this.postCard(this.salesWebhook, card);
  }

  async sendDailyDigest(sections: {
    warmReplies: Array<{ businessName: string; ownerName: string | null; score: number | null }>;
    pendingApprovals: Array<{ businessName: string; score: number | null }>;
    tier2Drafts: Array<{ businessName: string; score: number | null }>;
    followUpQueue: Array<{ businessName: string; draftPreview: string | null }>;
    topLeads: Array<{ businessName: string; score: number | null; status: string }>;
  }): Promise<CardPostResult> {
    const fmt = (items: Array<Record<string, unknown>>, fn: (i: any) => string, empty: string) =>
      items.length === 0 ? `_${empty}_` : items.map((item, i) => `${i + 1}. ${fn(item)}`).join("\n\n");

    const card = adaptiveCard([
      text(`Daily Lead Briefing — ${new Date().toLocaleDateString("en-GB")}`, undefined, "Bolder", "Large"),
      text("**Warm Replies — call today**", undefined, undefined, "Large"),
      text(fmt(sections.warmReplies, (r) => `**${r.businessName}** (${r.ownerName ?? "?"}) — ${r.score ?? "—"}/100`, "None"), undefined, "Small"),
      text("**Tier 1 Pending**", undefined, undefined, "Medium"),
      text(fmt(sections.pendingApprovals, (a) => `**${a.businessName}** — ${a.score ?? "—"}/100`, "None"), undefined, "Small"),
      
      // NEW: Add Adaptive Card text blocks for Tier 2 Drafts
      text("**Tier 2 Drafts (Ready in Outlook)**", undefined, undefined, "Medium"),
      text(fmt(sections.tier2Drafts, (a) => `**${a.businessName}** — ${a.score ?? "—"}/100`, "None"), undefined, "Small"),
      
      text("**Follow-Up Queue**", undefined, undefined, "Medium"),
      text(fmt(sections.followUpQueue, (f) => `**${f.businessName}** — ${(f.draftPreview ?? "").slice(0, 80)}`, "Empty"), undefined, "Small"),
      text("**Top Active Leads**", undefined, undefined, "Medium"),
      text(fmt(sections.topLeads, (l) => `**${l.businessName}** — ${l.score ?? "—"}/100 (${l.status})`, "None"), undefined, "Small"),
    ]);

    return this.postCard(this.salesWebhook, card);
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
    const facts: Array<{ title: string; value: string }> = [
      { title: "Scenario", value: opts.scenarioName },
      { title: "Error Code", value: opts.errorCode },
      { title: "Error", value: opts.errorMessage.slice(0, 300) },
    ];
    if (opts.leadId) facts.push({ title: "Lead ID", value: opts.leadId });
    if (opts.killSwitchFired) {
      facts.push(
        { title: "Kill-Switch", value: "FOLLOW-UP PAUSED" },
        { title: "Bounce Rate", value: `${opts.bounceRate?.toFixed(1) ?? "?"}%` },
        { title: "Confirmed OFF", value: opts.s5Confirmed ? "Yes" : "Manual check required" }
      );
    }

    const title = opts.killSwitchFired ? "KILL-SWITCH FIRED" : "ERROR ALERT";
    const card = adaptiveCard([
      container("attention", [text(title, "Attention", "Bolder", "Medium")]),
      { type: "FactSet", facts },
      text(opts.killSwitchFired ? "_Re-enable manually after investigation._" : "_Check logs._", undefined, undefined, undefined, true),
    ]);

    return this.postCard(this.devopsWebhook, card);
  }

  async sendOpsAlert(channel: "sales" | "operations", title: string, facts: Array<{ title: string; value: string }>): Promise<CardPostResult> {
    const card = adaptiveCard([
      text(title, undefined, "Bolder", "Medium"),
      { type: "FactSet", facts },
    ]);
    return this.postCard(channel === "operations" ? this.opsWebhook : this.salesWebhook, card);
  }

  // =========================================================================
  // Webhook helper — simple POST, no auth needed
  // =========================================================================

  private async postCard(webhookUrl: string, card: Record<string, unknown>): Promise<CardPostResult> {
    return withRetry(async () => {
      const payload = {
        type: "message",
        attachments: [{
          contentType: "application/vnd.microsoft.card.adaptive",
          contentUrl: null,
          content: card,
        }],
      };

      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Teams webhook [${res.status}]: ${body}`);
      }

      // Webhooks don't return an activity ID — generate a reference for logging
      const activityId = `webhook-${Date.now()}`;
      return { activityId };
    }, "postCard");
  }
}

// ── Adaptive Card builder helpers ──

function adaptiveCard(body: unknown[], actions?: unknown[]): Record<string, unknown> {
  return { type: "AdaptiveCard", $schema: "http://adaptivecards.io/schemas/adaptive-card.json", version: "1.4", body, actions: actions ?? [] };
}

function container(style: string, items: unknown[]): Record<string, unknown> {
  return { type: "Container", style, items };
}

function text(content: string, color?: string, size?: string, spacing?: string, wrap?: boolean, weight?: string): Record<string, unknown> {
  return { type: "TextBlock", text: content, wrap: wrap ?? true, ...(color && { color }), ...(size && { size }), ...(spacing && { spacing }), ...(weight && { weight }) };
}

function stripHtml(html: string): string {
  return html
    .replace(/<\/(p|div)>/gi, "\n\n") // Convert closing tags to double line breaks
    .replace(/<br\s*\/?>/gi, "\n")    // Convert line breaks
    .replace(/<[^>]*>/g, "")          // Strip remaining HTML
    .replace(/&nbsp;/g, " ")
    .trim();
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} environment variable is required`);
  return v;
}
