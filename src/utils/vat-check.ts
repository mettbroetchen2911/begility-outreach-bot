import { withRetry } from "./retry.js";

// ---------------------------------------------------------------------------
// HMRC "Check a UK VAT number" API
//   https://developer.service.hmrc.gov.uk/api-documentation/docs/api/service/check-vat-number-api
//
// This is an "application-restricted" endpoint — it requires a server token
// from HMRC's developer hub. We treat the token as optional: if it's not set,
// VAT lookup silently degrades to "unknown" and other CH signals continue
// to drive scoring. That keeps the system robust if a key rotation lapses.
//
// VRN normalisation:
//   - Strip "GB " / "gb" prefix and all whitespace
//   - Accept 9 or 12 digit forms (the latter is "GB123456789012" — group/branch)
// ---------------------------------------------------------------------------

const ENDPOINT = "https://api.service.hmrc.gov.uk/organisations/vat/check-vat-number/lookup";

export interface VatLookupResult {
  vrn: string;
  registered: boolean | null;     // null = lookup unavailable / inconclusive
  effectiveFrom: Date | null;
  registeredName: string | null;
  registeredAddress: string | null;
  reason?: string;                // populated when registered === null
}

/**
 * Normalise a raw string into a 9- or 12-digit VRN, or null if invalid.
 */
export function normaliseVrn(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.toUpperCase().replace(/^GB/, "").replace(/\s+/g, "").replace(/[^0-9]/g, "");
  if (cleaned.length === 9 || cleaned.length === 12) return cleaned;
  return null;
}

/**
 * Extract VAT numbers from arbitrary scraped page text. Common forms:
 *   "VAT No: GB 123 4567 89"
 *   "VAT registration: 123456789"
 *   "VAT: GB123456789"
 * Returns the first plausible match or null.
 */
export function extractVrnFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  // Match patterns where the word VAT precedes 9 digits within ~40 chars.
  const re = /\bVAT[^A-Za-z0-9]{0,40}((?:GB)?\s*\d[\d\s]{7,14}\d)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const vrn = normaliseVrn(m[1]);
    if (vrn) return vrn;
  }
  // Also accept a bare GB-prefixed 9-digit run anywhere on the page (some
  // sites just print "GB123456789" in the footer with no "VAT" label).
  const bareRe = /\bGB\s*(\d{9})\b/g;
  while ((m = bareRe.exec(text)) !== null) {
    const vrn = normaliseVrn(m[1]);
    if (vrn) return vrn;
  }
  return null;
}

/**
 * Check a VRN with HMRC. Returns `registered: null` if no token is configured
 * or the call fails for any non-404 reason — callers should treat null as
 * "unknown" rather than "not registered".
 */
export async function checkVatNumber(rawVrn: string): Promise<VatLookupResult> {
  const vrn = normaliseVrn(rawVrn);
  if (!vrn) {
    return { vrn: rawVrn, registered: null, effectiveFrom: null, registeredName: null, registeredAddress: null, reason: "invalid-vrn-format" };
  }

  const token = process.env.HMRC_VAT_API_TOKEN;
  if (!token) {
    return { vrn, registered: null, effectiveFrom: null, registeredName: null, registeredAddress: null, reason: "no-hmrc-token" };
  }

  try {
    return await withRetry(
      async () => {
        const res = await fetch(`${ENDPOINT}/${vrn}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.hmrc.2.0+json",
          },
        });
        if (res.status === 404) {
          return { vrn, registered: false, effectiveFrom: null, registeredName: null, registeredAddress: null };
        }
        if (res.status === 429) throw new Error("HMRC VAT rate-limited");
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(`HMRC VAT ${vrn} → ${res.status}: ${body.slice(0, 200)}`);
        }
        const data = (await res.json()) as {
          target?: {
            name?: string;
            vatNumber?: string;
            address?: { line1?: string; line2?: string; line3?: string; line4?: string; postcode?: string; countryCode?: string };
          };
          processingDate?: string;
        };
        const t = data.target ?? {};
        const addr = t.address
          ? [t.address.line1, t.address.line2, t.address.line3, t.address.line4, t.address.postcode, t.address.countryCode].filter(Boolean).join(", ")
          : null;
        return {
          vrn,
          registered: true,
          effectiveFrom: null,    // HMRC's check API doesn't expose registration date
          registeredName: t.name ?? null,
          registeredAddress: addr,
        };
      },
      `hmrc:vat:${vrn}`,
      { maxAttempts: 2, baseDelayMs: 1500 },
    );
  } catch (err) {
    return {
      vrn,
      registered: null,
      effectiveFrom: null,
      registeredName: null,
      registeredAddress: null,
      reason: (err as Error).message.slice(0, 120),
    };
  }
}
