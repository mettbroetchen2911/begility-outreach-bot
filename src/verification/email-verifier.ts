// ============================================================================
// Lead Engine — Email Verification Waterfall
//
// 3-step verification:
//   1. DNS MX Lookup — domain has valid mail servers
//   2. SMTP Connection Probe — RCPT TO accepted by mail server
//   3. Catch-All Detection — domain accepts any address
//
// IMPORTANT: Step 2 (SMTP) will fail on most cloud providers (GCP, AWS, Azure)
// because port 25 outbound is blocked. The system degrades gracefully:
//   - MX-only score = 20 (enough to not auto-reject, but low confidence)
//   - Set SMTP_VERIFICATION_ENABLED=false to skip SMTP entirely
//   - Consider using a dedicated email verification API for production
//     (set EXTERNAL_VERIFIER_URL to proxy through a verification service)
// ============================================================================

import dns from "dns";
import net from "net";
import crypto from "crypto";

const dnsPromises = dns.promises;

export interface VerificationResult {
  mxValid: boolean;
  mxHosts: string[];
  smtpValid: boolean;
  smtpResponseCode: number | null;
  smtpResponseText: string | null;
  isCatchAll: boolean;
  verificationScore: number;
  error: string | null;
}

const SMTP_TIMEOUT_MS = parseInt(process.env.SMTP_TIMEOUT_MS ?? "10000", 10);
const SMTP_PORT = 25;
const EHLO_DOMAIN = process.env.VERIFICATION_EHLO_DOMAIN ?? "verify.leadengine.local";
const PROBE_FROM = process.env.VERIFICATION_PROBE_FROM ?? "verify@leadengine.local";
const SMTP_ENABLED = (process.env.SMTP_VERIFICATION_ENABLED ?? "true").toLowerCase() === "true";

export async function verifyEmail(email: string): Promise<VerificationResult> {
  const result: VerificationResult = {
    mxValid: false,
    mxHosts: [],
    smtpValid: false,
    smtpResponseCode: null,
    smtpResponseText: null,
    isCatchAll: false,
    verificationScore: 0,
    error: null,
  };

  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) {
    result.error = "Invalid email format — no domain found";
    return result;
  }

  // =========================================================================
  // STEP 1: DNS MX Lookup
  // =========================================================================
  let mxRecords: dns.MxRecord[];
  try {
    mxRecords = await dnsPromises.resolveMx(domain);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENODATA" || code === "ENOTFOUND") {
      result.error = `No MX records found for domain: ${domain}`;
    } else {
      result.error = `DNS MX lookup failed: ${code ?? String(err)}`;
    }
    return result;
  }

  if (!mxRecords || mxRecords.length === 0) {
    result.error = `No MX records found for domain: ${domain}`;
    return result;
  }

  mxRecords.sort((a, b) => a.priority - b.priority);
  result.mxValid = true;
  result.mxHosts = mxRecords.map((r) => r.exchange);

  const mxHost = mxRecords[0].exchange;

  // =========================================================================
  // STEP 2: SMTP Connection Probe (skipped if disabled or on cloud)
  // =========================================================================
  if (!SMTP_ENABLED) {
    console.log(`  SMTP verification disabled — MX-only score for ${domain}`);
    result.verificationScore = 20; // MX-only baseline
    return result;
  }

  try {
    const smtpResult = await probeSmtp(mxHost, email);
    result.smtpResponseCode = smtpResult.code;
    result.smtpResponseText = smtpResult.text;

    if (smtpResult.code === 250) {
      result.smtpValid = true;
    } else if (smtpResult.code >= 500 && smtpResult.code < 600) {
      result.smtpValid = false;
    } else {
      result.smtpValid = false;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Detect port-25-blocked scenario and degrade gracefully
    if (msg.includes("ETIMEDOUT") || msg.includes("ECONNREFUSED") || msg.includes("timeout")) {
      console.warn(`  SMTP probe blocked (likely port 25 restricted): ${msg}`);
      result.error = `SMTP blocked — port 25 likely restricted on this host. MX-only verification.`;
      // MX-only baseline score
      result.verificationScore = 20;
      return result;
    }
    result.error = `SMTP probe failed: ${msg}`;
  }

  // =========================================================================
  // STEP 3: Catch-All Detection
  // =========================================================================
  if (result.smtpValid) {
    try {
      const randomUser = `xprobe_${crypto.randomBytes(6).toString("hex")}`;
      const fakeEmail = `${randomUser}@${domain}`;
      const catchAllResult = await probeSmtp(mxHost, fakeEmail);
      if (catchAllResult.code === 250) {
        result.isCatchAll = true;
      }
    } catch {
      // Non-fatal
    }
  }

  // =========================================================================
  // COMPOSITE SCORE
  // =========================================================================
  let score = 0;
  if (result.mxValid) score += 20;
  if (result.smtpValid) {
    score += 50;
    if (result.isCatchAll) {
      score -= 20;
    } else {
      score += 20;
    }
  } else if (result.smtpResponseCode !== null && result.smtpResponseCode < 500) {
    score += 10;
  }

  result.verificationScore = Math.max(0, Math.min(100, score));
  return result;
}

// ---------------------------------------------------------------------------
// SMTP Probe — low-level socket
// ---------------------------------------------------------------------------

interface SmtpProbeResult {
  code: number;
  text: string;
}

function probeSmtp(mxHost: string, targetEmail: string): Promise<SmtpProbeResult> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let phase: "greeting" | "ehlo" | "mail_from" | "rcpt_to" | "quit" = "greeting";
    let buffer = "";
    let settled = false;

    const finish = (code: number, text: string) => {
      if (settled) return;
      settled = true;
      try { socket.write("QUIT\r\n"); socket.end(); } catch { /* */ }
      resolve({ code, text });
    };

    const fail = (reason: string) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* */ }
      reject(new Error(reason));
    };

    socket.setTimeout(SMTP_TIMEOUT_MS);
    socket.on("timeout", () => fail(`SMTP timeout after ${SMTP_TIMEOUT_MS}ms`));
    socket.on("error", (err) => fail(`SMTP socket error: ${err.message}`));

    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\r\n");
      const lastComplete = lines.slice(0, -1);

      for (const line of lastComplete) {
        if (line.length < 3) continue;
        const code = parseInt(line.slice(0, 3), 10);
        const isContinuation = line[3] === "-";
        if (isContinuation) continue;

        if (phase === "greeting") {
          if (code >= 200 && code < 300) { phase = "ehlo"; socket.write(`EHLO ${EHLO_DOMAIN}\r\n`); }
          else { finish(code, line); }
        } else if (phase === "ehlo") {
          if (code >= 200 && code < 300) { phase = "mail_from"; socket.write(`MAIL FROM:<${PROBE_FROM}>\r\n`); }
          else { finish(code, line); }
        } else if (phase === "mail_from") {
          if (code >= 200 && code < 300) { phase = "rcpt_to"; socket.write(`RCPT TO:<${targetEmail}>\r\n`); }
          else { finish(code, line); }
        } else if (phase === "rcpt_to") {
          finish(code, line);
        }
      }
      buffer = lines[lines.length - 1];
    });

    socket.connect(SMTP_PORT, mxHost);
  });
}
