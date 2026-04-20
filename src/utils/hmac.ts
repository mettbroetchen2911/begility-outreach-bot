import crypto from "crypto";

const EXPIRY_SECONDS = parseInt(process.env.HMAC_EXPIRY_SECONDS ?? "900", 10);

function getSecret(): string {
  const s = process.env.HMAC_SECRET;
  if (!s) throw new Error("HMAC_SECRET environment variable is required");
  return s;
}

export function computeHmac(payload: string): string {
  return crypto.createHmac("sha256", getSecret()).update(payload).digest("hex");
}

export function verifyHmac(leadId: string, ts: string, token: string): { valid: boolean; reason?: string } {
  const expected = computeHmac(`${leadId}${ts}`);
  const a = Buffer.from(token, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return { valid: false, reason: "Invalid token length" };
  if (!crypto.timingSafeEqual(a, b)) return { valid: false, reason: "Invalid HMAC signature" };

  const timestamp = parseInt(ts, 10);
  if (isNaN(timestamp)) return { valid: false, reason: "Invalid timestamp" };
  const age = Math.floor(Date.now() / 1000) - timestamp;
  if (age > EXPIRY_SECONDS) return { valid: false, reason: `Expired (${age}s old, max ${EXPIRY_SECONDS}s)` };
  if (age < 0) return { valid: false, reason: "Future timestamp" };
  return { valid: true };
}

export function generateHmacUrls(leadId: string): { approveUrl: string; rejectUrl: string; ts: string; token: string } {
  const baseUrl = process.env.BASE_URL;
  if (!baseUrl) throw new Error("BASE_URL environment variable is required");
  const ts = Math.floor(Date.now() / 1000).toString();
  const token = computeHmac(`${leadId}${ts}`);
  const params = new URLSearchParams({ leadId, ts, token });
  return {
    approveUrl: `${baseUrl}/tier1_approve?${params}`,
    rejectUrl: `${baseUrl}/tier1_reject?${params}`,
    ts, token,
  };
}
