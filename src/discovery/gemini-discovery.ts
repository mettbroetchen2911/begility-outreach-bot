import { GoogleGenAI } from "@google/genai";
import { getNicheConfig, Region } from "../config/niche.js";
import { withRetry } from "../utils/retry.js";

export interface DiscoveredBusiness {
  businessName: string;
  city: string | null;
  country: string | null;
  website: string | null;
  description: string | null;
  ownerName: string | null;
  source: string;
}

export interface DiscoveryScanResult {
  businesses: DiscoveredBusiness[];
  query: string;
  region: string;
}

const MAX_PER_QUERY = parseInt(process.env.MAX_RESULTS_PER_QUERY ?? "15", 10);

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error("GEMINI_API_KEY environment variable is required");

const client = new GoogleGenAI({ apiKey });

export async function discoverBusinesses(
  query: string,
  region: Region
): Promise<DiscoveryScanResult> {
  const config = getNicheConfig();
  const regionLabel = region.label;
  const radiusKm = Math.round(region.radiusMeters / 1000);

  const prompt = `Search Google for real businesses matching "${query}" located within ${radiusKm}km of coordinates ${region.lat}, ${region.lng} (${regionLabel}).

Target profile: ${config.nicheTag}. We are looking for operations-heavy SMBs (roughly 10-200 staff) whose day-to-day work involves manual, repetitive, labour-intensive processes that an AI automation consultancy could help streamline. Prefer independent firms with a visible owner/founder/partner over faceless chains or enterprise subsidiaries.

Find up to ${MAX_PER_QUERY} REAL businesses that currently exist and plausibly fit this profile. For each one, extract:
- The exact business name as it appears on Google / Companies House / their own website
- City and country
- Website URL if available
- A 1-sentence description of what they do AND any visible hint of the manual/operational nature of their work (e.g. "10-partner accountancy doing year-end compliance for SMEs — heavy manual document work", "15-strong property management firm handling tenant intake by phone and email")
- Owner, founder, managing director, or senior partner name if publicly visible
- Where you found this information (Google Maps, Companies House, LinkedIn, their website, local press, etc.)

CRITICAL RULES:
- Only return businesses that ACTUALLY EXIST — do not invent or hallucinate names.
- Each business must be a real, currently operating entity you found via search.
- Skip pure-product e-commerce, SaaS startups, and large enterprise brands — they are not a fit for our consultancy's playbook.
- Skip solo operators (1-2 people) and enterprises (1000+ employees). Sweet spot is 10-200 staff.
- If you cannot find ${MAX_PER_QUERY} real businesses, return fewer — accuracy over quantity.
- Do not include national chains or franchise HQs.

Return a JSON array only. No markdown. No preamble. Example format:

[
  {
    "businessName": "Northfield Accountancy Partners",
    "city": "Manchester",
    "country": "UK",
    "website": "https://northfieldaccountancy.co.uk",
    "description": "12-partner accountancy practice serving SMEs across the North West — year-end, VAT, and payroll done in-house, describes extensive manual bookkeeping workflow.",
    "ownerName": "Rachel Northfield",
    "source": "Companies House + firm website"
  }
]

If you find zero matching businesses in this area, return an empty array: []`;

  return withRetry(async () => {
    const response = await client.models.generateContent({
      model: config.geminiModel,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        systemInstruction: "You are a B2B prospecting assistant for an AI automation consultancy. Return valid JSON arrays only. No preamble. Only include businesses you actually found via Google Search — never fabricate entries, and never include companies you cannot cite a public source for.",
        temperature: 0.1,
        maxOutputTokens: 4096,
        tools: [{ googleSearch: {} }],
      },
    });

    const rawText = response.text ?? "";
    const cleaned = rawText.replace(/^```(?:json)?\n?/g, "").replace(/\n?```$/g, "").trim();

    let parsed: unknown[];
    try {
      parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) parsed = [];
    } catch {
      console.error(`Discovery parse failed for "${query}" in ${regionLabel}. Raw: ${rawText.slice(0, 300)}`);
      parsed = [];
    }

    const businesses: DiscoveredBusiness[] = parsed
      .filter((item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null && typeof (item as any).businessName === "string"
      )
      .map((item) => ({
        businessName: String(item.businessName),
        city: typeof item.city === "string" ? item.city : null,
        country: typeof item.country === "string" ? item.country : null,
        website: typeof item.website === "string" ? item.website : null,
        description: typeof item.description === "string" ? item.description : null,
        ownerName: typeof item.ownerName === "string" ? item.ownerName : null,
        source: typeof item.source === "string" ? item.source : "Google Search",
      }))
      .slice(0, MAX_PER_QUERY);

    return { businesses, query, region: `${region.lat},${region.lng},${region.radiusMeters}` };
  }, `discovery:${query}:${regionLabel}`, { maxAttempts: 2, baseDelayMs: 3000 });
}
