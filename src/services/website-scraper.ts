import { GoogleGenAI } from "@google/genai";
import { getNicheConfig } from "../config/niche.js";
import { withRetry } from "../utils/retry.js";

const SCRAPE_TIMEOUT_MS = parseInt(process.env.SCRAPE_TIMEOUT_MS ?? "10000", 10);
const MAX_HTML_CHARS = parseInt(process.env.MAX_SCRAPE_HTML_CHARS ?? "15000", 10);

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error("GEMINI_API_KEY environment variable is required");

const client = new GoogleGenAI({ apiKey });

export interface ScrapedData {
  owner_name: string | null;
  email: string | null;
  phone: string | null;
  instagram: string | null;
  description: string | null;
  website: string;
  location: string | null;
  confidence: "high" | "medium" | "low";
  pages_scraped: string[];
}

// ---------------------------------------------------------------------------
// Fetch + clean a single page
// ---------------------------------------------------------------------------
async function fetchPage(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SCRAPE_TIMEOUT_MS);

    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": `Mozilla/5.0 (compatible; LeadEngine/1.0; +https://${process.env.BRAND_WEBSITE ?? "begility.com"})`,
        "Accept": "text/html",
      },
    });

    clearTimeout(timeout);
    if (!res.ok) return null;

    const html = await res.text();
    return stripToText(html);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Strip HTML to readable text, keeping structure hints
// ---------------------------------------------------------------------------
function stripToText(html: string): string {
  return html
    // Remove scripts and styles entirely
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    // Keep href values for links (emails, social links)
    .replace(/<a\s[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, "$2 [$1]")
    // Replace block elements with newlines
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    // Strip remaining tags
    .replace(/<[^>]*>/g, " ")
    // Decode common entities
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#?\w+;/g, " ")
    // Collapse whitespace
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n/g, "\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Find likely subpage URLs for contact/about/team pages
// ---------------------------------------------------------------------------
function extractSubpageUrls(html: string, baseUrl: string): string[] {
  const patterns = [
    /href=["'](\/(?:about|team|contact|our-team|about-us|meet-the-team|staff|people|leadership|partners|founders|services|what-we-do|how-we-work|process|careers|jobs)[^"']*?)["']/gi,
    /href=["'](https?:\/\/[^"']*?\/(?:about|team|contact|our-team|about-us|meet-the-team|staff|people|leadership|partners|founders|services|what-we-do|how-we-work|process|careers|jobs)[^"']*?)["']/gi,
  ];

  const found = new Set<string>();
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      let url = match[1];
      if (url.startsWith("/")) {
        try {
          const base = new URL(baseUrl);
          url = `${base.origin}${url}`;
        } catch { continue; }
      }
      found.add(url);
    }
  }

  return [...found].slice(0, 3); // Max 3 subpages
}

// ---------------------------------------------------------------------------
// Main scrape function
// ---------------------------------------------------------------------------
export async function scrapeBusinessWebsite(
  websiteUrl: string,
  businessName: string,
  city?: string
): Promise<ScrapedData | null> {
  // Normalize URL
  let normalized = websiteUrl.trim();
  if (!normalized.startsWith("http")) normalized = `https://${normalized}`;

  // Fetch homepage
  const homepageHtml = await fetchPageRaw(normalized);
  if (!homepageHtml) return null;

  const homepageText = stripToText(homepageHtml);

  // Find and fetch relevant subpages (about, contact, team)
  const subpageUrls = extractSubpageUrls(homepageHtml, normalized);
  const subpageTexts: string[] = [];
  const pagesScraped = [normalized];

  for (const subUrl of subpageUrls) {
    const text = await fetchPage(subUrl);
    if (text) {
      subpageTexts.push(`--- PAGE: ${subUrl} ---\n${text}`);
      pagesScraped.push(subUrl);
    }
  }

  // Combine all content, truncate to stay within token limits
  const combined = [
    `--- HOMEPAGE: ${normalized} ---`,
    homepageText,
    ...subpageTexts,
  ].join("\n\n").slice(0, MAX_HTML_CHARS);

  // Send to Gemini WITHOUT grounding — just text analysis
  const config = getNicheConfig();

  return withRetry(async () => {
    const response = await client.models.generateContent({
      model: config.geminiModel,
      contents: [{ role: "user", parts: [{ text: `Extract business information from these website pages for "${businessName}"${city ? ` in ${city}` : ""}. This research will be used by an AI automation consultancy to propose specific automations in a personalised cold email, so pay attention to any visible operational / workflow detail, not just contact info.

WEBSITE CONTENT:
${combined}

Extract the following. If a field is not found on any page, return null. Do NOT guess or fabricate.

{
  "owner_name": "Full name of the founder, managing director, managing partner, or senior decision-maker. Look for About pages, team pages, 'Meet the team', leadership bios. null if not found.",
  "email": "Best direct contact email. Prefer a named personal address (firstname@, firstname.lastname@) over generic info@ / hello@ / contact@ — but return the generic one if that's all you find. Look in contact pages, footers, about pages. null if not found.",
  "phone": "Phone number from contact page or footer. null if not found.",
  "instagram": "Instagram handle without @. Look for social media links in header/footer. null if not found.",
  "description": "2-3 sentences: what this business does, who they serve, and anything visible about HOW they deliver (process, workflow, tooling). Base this ONLY on what their website actually says.",
  "location": "City and country from the website. null if not found.",
  "confidence": "high if you found owner + email + clear operational detail. medium if some fields missing. low if very little useful info."
}

Return ONLY the JSON object. No markdown. No preamble.` }] }],
      config: {
        systemInstruction: "You are a data extraction assistant. Extract structured information from website content. Return valid JSON only. Never fabricate information — if something isn't on the page, return null.",
        temperature: 0.1,
        maxOutputTokens: 2048,
        // NO tools — no grounding. This is the whole point.
      },
    });

    const rawText = response.text ?? "";
    const cleaned = rawText.replace(/^```(?:json)?\n?/g, "").replace(/\n?```$/g, "").trim();

    try {
      const parsed = JSON.parse(cleaned) as Record<string, unknown>;
      return {
        owner_name: typeof parsed.owner_name === "string" ? parsed.owner_name : null,
        email: typeof parsed.email === "string" ? parsed.email : null,
        phone: typeof parsed.phone === "string" ? parsed.phone : null,
        instagram: typeof parsed.instagram === "string" ? parsed.instagram : null,
        description: typeof parsed.description === "string" ? parsed.description : null,
        website: normalized,
        location: typeof parsed.location === "string" ? parsed.location : null,
        confidence: (parsed.confidence === "high" || parsed.confidence === "medium" || parsed.confidence === "low")
          ? parsed.confidence
          : "low",
        pages_scraped: pagesScraped,
      };
    } catch {
      console.error(`Scrape parse failed for ${businessName}. Raw: ${rawText.slice(0, 300)}`);
      return null;
    }
  }, `scrape:${businessName}`, { maxAttempts: 2, baseDelayMs: 2000 });
}

// Raw fetch that returns HTML (not stripped) — needed for link extraction
async function fetchPageRaw(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SCRAPE_TIMEOUT_MS);

    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": `Mozilla/5.0 (compatible; LeadEngine/1.0; +https://${process.env.BRAND_WEBSITE ?? "begility.com"})`,
        "Accept": "text/html",
      },
    });

    clearTimeout(timeout);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}
