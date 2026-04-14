const TIMEOUT_MS = parseInt(process.env.WEBSITE_VALIDATE_TIMEOUT_MS ?? "8000", 10);

// Domains that indicate a parked or placeholder page
const PARKED_DOMAINS = new Set([
  "sedoparking.com",
  "bodis.com",
  "hugedomains.com",
  "afternic.com",
  "dan.com",
  "godaddy.com/domainfind",
  "namecheap.com",
  "register.com",
  "parkingcrew.net",
  "domainmarket.com",
  "undeveloped.com",
  "1and1.com",
  "ionos.com",
]);

// If the final URL redirects to one of these, it's not a real business website
const SOCIAL_ONLY_DOMAINS = new Set([
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "tiktok.com",
  "linktr.ee",
  "linktree.com",
]);

export interface WebsiteValidationResult {
  valid: boolean;
  statusCode: number | null;
  finalUrl: string | null;
  reason: string | null;
  responseTimeMs: number;
}

export async function validateWebsite(url: string): Promise<WebsiteValidationResult> {
  const start = Date.now();

  // Normalize URL
  let normalized = url.trim();
  if (!normalized.startsWith("http")) {
    normalized = `https://${normalized}`;
  }

  // Quick check: is this already a social media link?
  try {
    const parsed = new URL(normalized);
    const host = parsed.hostname.replace(/^www\./, "");
    if (SOCIAL_ONLY_DOMAINS.has(host)) {
      return {
        valid: false,
        statusCode: null,
        finalUrl: normalized,
        reason: `Social media profile (${host}), not a business website`,
        responseTimeMs: Date.now() - start,
      };
    }
  } catch {
    return {
      valid: false,
      statusCode: null,
      finalUrl: null,
      reason: `Invalid URL format: ${url}`,
      responseTimeMs: Date.now() - start,
    };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    // Use GET with a small body limit rather than HEAD — many servers
    // block or misconfigure HEAD responses
    const res = await fetch(normalized, {
      method: "GET",
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": `Mozilla/5.0 (compatible; LeadEngine/1.0; +https://${process.env.BRAND_WEBSITE ?? "begility.com"})`,
        "Accept": "text/html",
      },
    });

    clearTimeout(timeout);

    const finalUrl = res.url;
    const statusCode = res.status;

    // Check if redirected to a parked domain
    try {
      const finalHost = new URL(finalUrl).hostname.replace(/^www\./, "");
      for (const parked of PARKED_DOMAINS) {
        if (finalHost.includes(parked)) {
          return {
            valid: false,
            statusCode,
            finalUrl,
            reason: `Redirected to parked domain: ${finalHost}`,
            responseTimeMs: Date.now() - start,
          };
        }
      }

      // Check if redirected to social media
      if (SOCIAL_ONLY_DOMAINS.has(finalHost)) {
        return {
          valid: false,
          statusCode,
          finalUrl,
          reason: `Redirected to social media: ${finalHost}`,
          responseTimeMs: Date.now() - start,
        };
      }
    } catch { /* URL parse failed on final — continue */ }

    // Check for error status codes
    if (statusCode >= 400) {
      return {
        valid: false,
        statusCode,
        finalUrl,
        reason: `HTTP ${statusCode}`,
        responseTimeMs: Date.now() - start,
      };
    }

    // Read a small chunk of body to check for parked domain indicators
    try {
      const body = await res.text();
      const snippet = body.slice(0, 3000).toLowerCase();

      const parkedIndicators = [
        "this domain is for sale",
        "domain is parked",
        "buy this domain",
        "domain has expired",
        "this site is under construction",
        "parked by",
        "domain parking",
        "godaddy.com/domainfind",
      ];

      for (const indicator of parkedIndicators) {
        if (snippet.includes(indicator)) {
          return {
            valid: false,
            statusCode,
            finalUrl,
            reason: `Parked domain indicator: "${indicator}"`,
            responseTimeMs: Date.now() - start,
          };
        }
      }
    } catch {
      // Body read failed — non-fatal, site responded so it's probably real
    }

    return {
      valid: true,
      statusCode,
      finalUrl,
      reason: null,
      responseTimeMs: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // Aborted = timeout
    if (msg.includes("abort")) {
      return {
        valid: false,
        statusCode: null,
        finalUrl: null,
        reason: `Timeout after ${TIMEOUT_MS}ms`,
        responseTimeMs: Date.now() - start,
      };
    }

    // DNS failures, connection refused, etc.
    return {
      valid: false,
      statusCode: null,
      finalUrl: null,
      reason: `Connection failed: ${msg}`,
      responseTimeMs: Date.now() - start,
    };
  }
}
