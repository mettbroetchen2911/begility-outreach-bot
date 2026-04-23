import { withRetry } from "../utils/retry.js";
import { wrapEmailInTemplate } from "../utils/email-template.js";
import { ensureHtml } from "../utils/text-utils.js";
import { prisma } from "../utils/prisma.js";

export interface DraftResult {
  messageId: string;
  webLink: string | null;
  conversationId: string | null;
}

export interface SendResult {
  messageId: string;
  sentAt: Date;
}

export interface GraphMessageSummary {
  id: string;
  subject: string | null;
  conversationId: string | null;
  isDraft: boolean;
  sentDateTime: string | null;
  from?: { emailAddress?: { address?: string; name?: string } };
  toRecipients?: Array<{ emailAddress?: { address?: string } }>;
  body?: { contentType: string; content: string };
}

export class EmailService {
  private tenantId: string;
  private clientId: string;
  private clientSecret: string;
  private senderEmail: string;

  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor() {
    this.tenantId = req("MS_GRAPH_TENANT_ID");
    this.clientId = req("MS_GRAPH_CLIENT_ID");
    this.clientSecret = req("MS_GRAPH_CLIENT_SECRET");
    this.senderEmail = req("REP_EMAIL");
  }

  async createDraft(to: string, subject: string, html: string): Promise<DraftResult> {
    return withRetry(async () => {
      const token = await this.getToken();

      const suppressed = await prisma.suppression.findUnique({ where: { email: to.toLowerCase() } });
      if (suppressed) throw new Error(`Email ${to} is suppressed — aborting draft`);
      
      const formattedHtml = wrapEmailInTemplate(ensureHtml(html));

      const res = await fetch(
        `https://graph.microsoft.com/v1.0/users/${this.senderEmail}/messages`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            subject,
            body: { contentType: "HTML", content: formattedHtml }, // Use formattedHtml
            toRecipients: [{ emailAddress: { address: to } }],
            isDraft: true,
          }),
        }
      );
      if (!res.ok) throw new Error(`Graph createDraft [${res.status}]: ${await res.text()}`);
      const data = (await res.json()) as { id: string; webLink?: string; conversationId?: string };
      const webLink = data.webLink
      ?? `https://outlook.office365.com/owa/?ItemID=${encodeURIComponent(data.id)}&exvsurl=1&viewmodel=ReadMessageItem`;
      return {
        messageId: data.id,
        webLink,
        conversationId: data.conversationId ?? null,
      };
    }, "createDraft");
  }

  async getMessageById(messageId: string): Promise<GraphMessageSummary | null> {
    return withRetry(async () => {
      const token = await this.getToken();
      const url =
        `https://graph.microsoft.com/v1.0/users/${this.senderEmail}/messages/${messageId}` +
        `?$select=id,subject,conversationId,isDraft,sentDateTime,from,toRecipients,body`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Graph getMessage [${res.status}]: ${await res.text()}`);
      return (await res.json()) as GraphMessageSummary;
    }, "getMessageById");
  }

  async getGraphToken(): Promise<string> {
    return this.getToken();
  }

  async sendDraft(messageId: string): Promise<SendResult> {
    return withRetry(async () => {
      const token = await this.getToken();
      const res = await fetch(
        `https://graph.microsoft.com/v1.0/users/${this.senderEmail}/messages/${messageId}/send`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        }
      );
      if (!res.ok) throw new Error(`Graph sendDraft [${res.status}]: ${await res.text()}`);
      return { messageId, sentAt: new Date() };
    }, "sendDraft");
  }

  async updateDraft(messageId: string, subject: string, bodyHtml: string): Promise<void> {
    return withRetry(async () => {
      const token = await this.getToken();
      const formattedHtml = wrapEmailInTemplate(ensureHtml(bodyHtml));
      const res = await fetch(
        `https://graph.microsoft.com/v1.0/users/${this.senderEmail}/messages/${messageId}`,
        {
          method: "PATCH",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            subject,
            body: { contentType: "HTML", content: formattedHtml },
          }),
        }
      );
      if (!res.ok) throw new Error(`Graph updateDraft [${res.status}]: ${await res.text()}`);
    }, "updateDraft");
  }

  async deleteDraft(messageId: string): Promise<void> {
  return withRetry(async () => {
    const token = await this.getToken();
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/users/${this.senderEmail}/messages/${messageId}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    if (!res.ok && res.status !== 404) {
      throw new Error(`Graph deleteDraft [${res.status}]: ${await res.text()}`);
    }
  }, "deleteDraft");
}

  async sendEmail(to: string, subject: string, html: string): Promise<SendResult> {
  const draft = await this.createDraft(to, subject, html);
  const sent  = await this.sendDraft(draft.messageId);
  return { messageId: draft.messageId, sentAt: sent.sentAt };
}

  private async getToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.tokenExpiresAt > now + 60_000) return this.cachedToken;

    const res = await fetch(
      `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          scope: "https://graph.microsoft.com/.default",
          grant_type: "client_credentials",
        }),
      }
    );
    if (!res.ok) throw new Error(`Graph token [${res.status}]: ${await res.text()}`);

    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) throw new Error("Graph token response missing access_token");

    this.cachedToken = data.access_token;
    this.tokenExpiresAt = now + (data.expires_in ?? 3600) * 1000;
    return this.cachedToken;
  } 
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} environment variable is required`);
  return v;
}
