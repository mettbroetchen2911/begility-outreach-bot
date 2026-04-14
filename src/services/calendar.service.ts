// ============================================================================
// Lead Engine — Calendar Service
// Provider: Microsoft Graph Calendar API
// ============================================================================

import { Lead } from "@prisma/client";
import { getNicheConfig } from "../config/niche.js";
import { withRetry } from "../utils/retry.js";

export class CalendarService {
  private tenantId: string;
  private clientId: string;
  private clientSecret: string;
  private calendarUser: string;

  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor() {
    this.tenantId = req("MS_GRAPH_TENANT_ID");
    this.clientId = req("MS_GRAPH_CLIENT_ID");
    this.clientSecret = req("MS_GRAPH_CLIENT_SECRET");
    this.calendarUser = req("REP_EMAIL");
  }

  async createCallTask(lead: Lead, dueDate: Date, reason: string = "Follow-up call"): Promise<{ eventId: string }> {
    const config = getNicheConfig();

    return withRetry(async () => {
      const token = await this.getToken();
      const bodyLines = [
        `<h2>CALL — ${lead.businessName}</h2>`,
        `<p><strong>Reason:</strong> ${reason}</p>`,
        `<p><strong>Owner:</strong> ${lead.ownerName ?? "Unknown"}</p>`,
        `<p><strong>Email:</strong> ${lead.email ?? "—"}</p>`,
        `<p><strong>Phone:</strong> ${lead.phone ?? "—"}</p>`,
        `<p><strong>Instagram:</strong> ${lead.instagram ? `@${lead.instagram}` : "—"}</p>`,
        `<p><strong>Location:</strong> ${[lead.city, lead.country].filter(Boolean).join(", ") || "—"}</p>`,
        `<p><strong>Score:</strong> ${lead.brandFitScore ?? "—"}/100 (${lead.tier ?? "—"})</p>`,
        lead.brandFitRationale ? `<p><strong>Rationale:</strong> ${lead.brandFitRationale}</p>` : "",
        lead.replyBody ? `<hr/><p><strong>Their reply:</strong></p><p>${lead.replyBody.slice(0, 500)}</p>` : "",
        `<hr/><p><em>Created by ${config.brandName} Lead Engine</em></p>`,
      ].filter(Boolean).join("\n");

      const startTime = dueDate.toISOString();
      const endTime = new Date(dueDate.getTime() + 30 * 60 * 1000).toISOString();

      const res = await fetch(
        `https://graph.microsoft.com/v1.0/users/${this.calendarUser}/events`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            subject: `CALL — ${lead.businessName}`,
            body: { contentType: "HTML", content: bodyLines },
            start: { dateTime: startTime, timeZone: "UTC" },
            end: { dateTime: endTime, timeZone: "UTC" },
            importance: "high",
            isReminderOn: true,
            reminderMinutesBeforeStart: 15,
          }),
        }
      );
      if (!res.ok) throw new Error(`Graph createEvent [${res.status}]: ${await res.text()}`);
      const data = (await res.json()) as { id: string };
      return { eventId: data.id };
    }, "createCallTask");
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
          client_id: this.clientId, client_secret: this.clientSecret,
          scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials",
        }),
      }
    );
    if (!res.ok) throw new Error(`Graph token [${res.status}]: ${await res.text()}`);
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) throw new Error("Graph token missing access_token");
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
