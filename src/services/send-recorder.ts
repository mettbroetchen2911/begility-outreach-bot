import { prisma } from "../utils/prisma.js";

export type SendDirection = "outreach" | "follow_up" | "goodbye" | "reply" | "manual";

export interface SendRecord {
  leadId: string;
  direction: SendDirection;
  subject: string;
  bodyHash: string;
  messageId: string | null;
  sentAt: Date;
  sentBy: string;
  wasEdited: boolean;
  editSummary?: string;
}

export interface SendRecordRow {
  leadId: string;
  direction: SendDirection;
  subject: string;
  bodyHash: string;
  messageId: string | null;
  sentAt: Date;
  sentBy: string;
  wasEdited: boolean;
  editSummary: string | null;
}

const SCENARIO = "EMAIL_SENT";
const MODULE = "send-recorder";

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export async function recordSend(rec: SendRecord): Promise<void> {
  const payload = {
    leadId: rec.leadId,
    direction: rec.direction,
    subject: rec.subject.slice(0, 200),
    bodyHash: rec.bodyHash,
    messageId: rec.messageId,
    sentAt: rec.sentAt.toISOString(),
    sentBy: rec.sentBy,
    wasEdited: rec.wasEdited,
    editSummary: rec.editSummary ?? null,
  };

  try {
    await prisma.errorLog.create({
      data: {
        scenarioName: SCENARIO,
        moduleName: MODULE,
        errorCode: rec.direction.toUpperCase(),
        errorMessage: JSON.stringify(payload),
        leadId: rec.leadId,
        killSwitchFired: false,
      },
    });
  } catch (err) {
    // Never fail the caller — the Lead row is the authoritative sent state.
    console.warn(`[send-recorder] write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Read — for Teams "send history" card / daily digest / audit.
// ---------------------------------------------------------------------------

export async function getSendsForLead(leadId: string, limit = 20): Promise<SendRecordRow[]> {
  const rows = await prisma.errorLog.findMany({
    where: { scenarioName: SCENARIO, leadId },
    orderBy: { timestamp: "desc" },
    take: limit,
  });
  return rows.map(parseRow).filter((r): r is SendRecordRow => r !== null);
}

export async function getRecentSends(limit = 50): Promise<SendRecordRow[]> {
  const rows = await prisma.errorLog.findMany({
    where: { scenarioName: SCENARIO },
    orderBy: { timestamp: "desc" },
    take: limit,
  });
  return rows.map(parseRow).filter((r): r is SendRecordRow => r !== null);
}

export async function countSendsSince(since: Date, direction?: SendDirection): Promise<number> {
  return prisma.errorLog.count({
    where: {
      scenarioName: SCENARIO,
      timestamp: { gte: since },
      ...(direction && { errorCode: direction.toUpperCase() }),
    },
  });
}

/** Returns send count for the current UTC day — used by the daily_send_cap. */
export async function countSendsToday(direction?: SendDirection): Promise<number> {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  return countSendsSince(start, direction);
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

function parseRow(r: {
  errorMessage: string;
  timestamp: Date;
  leadId: string | null;
  errorCode: string;
}): SendRecordRow | null {
  try {
    const p = JSON.parse(r.errorMessage) as Partial<SendRecordRow> & { sentAt?: string };
    return {
      leadId: p.leadId ?? r.leadId ?? "",
      direction: (p.direction ?? (r.errorCode.toLowerCase() as SendDirection)),
      subject: p.subject ?? "",
      bodyHash: p.bodyHash ?? "",
      messageId: p.messageId ?? null,
      sentAt: p.sentAt ? new Date(p.sentAt) : r.timestamp,
      sentBy: p.sentBy ?? "unknown",
      wasEdited: Boolean(p.wasEdited),
      editSummary: p.editSummary ?? null,
    };
  } catch {
    return null;
  }
}
