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
  sector: string | null;
  source: string;
}

export interface DiscoveryScanResult {
  businesses: DiscoveredBusiness[];
  query: string;
  region: string;
}

const MAX_PER_QUERY = parseInt(process.env.MAX_RESULTS_PER_QUERY ?? "15", 10);
const DISCOVERY_MAX_TOKENS = parseInt(process.env.DISCOVERY_MAX_TOKENS ?? "8192", 10);

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error("GEMINI_API_KEY environment variable is required");

const client = new GoogleGenAI({ apiKey });

function salvageJsonArray(raw: string): unknown[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch { /* fall through to salvage */ }

  const openIdx = raw.indexOf("[");
  if (openIdx === -1) return [];
  const body = raw.slice(openIdx + 1);

  const salvaged: unknown[] = [];
  let depth = 0, start = -1, inString = false, escape = false;

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") { if (depth === 0) start = i; depth++; }
    else if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        try { salvaged.push(JSON.parse(body.slice(start, i + 1))); } catch { /* skip incomplete */ }
        start = -1;
      }
    }
  }
  return salvaged;
}

export async function discoverBusinesses(
  query: string,
  region: Region
): Promise<DiscoveryScanResult> {
  const config = getNicheConfig();
  const regionLabel = region.label;
  const radiusKm = Math.round(region.radiusMeters / 1000);

  const prompt = `Search Google and LinkedIn for real UK ${config.nicheTag} matching "${query}", located within ${radiusKm}km of coordinates ${region.lat}, ${region.lng} (${regionLabel}).

TARGETING — we are looking for founder-led or owner-managed UK SMEs that would be a fit client for Begility, an operating intelligence company that sells operational change to businesses with visible admin / lead-handling / handoff drag. Roughly £1m–£20m turnover, 10–100 staff. Cashflow-positive. Not VC-backed startups. Not enterprises. Not microbusinesses under 5 staff.

Find up to ${MAX_PER_QUERY} REAL businesses that currently exist. For each one, extract:
- The exact registered / trading business name as it appears on Companies House or their website
- City and country (country should almost always be "United Kingdom")
- Website URL if available
- A 1-sentence description of what makes them notable — their positioning, specialism, or a signal of size / operational shape
- Owner, founder, MD, or senior decision-maker name if publicly visible (LinkedIn, team page, Companies House)
- Sector tag — one of: recruitment, estate_agent, lettings, trades, dental, cosmetic_clinic, wholesaler, distributor, dealership, other
- Where you found this information (Google, LinkedIn, Companies House, trade directory, etc.)

CRITICAL RULES:
- Only return businesses that ACTUALLY EXIST — do not invent or hallucinate names
- Each business must be a real, currently operating UK entity you found via search
- If you cannot find ${MAX_PER_QUERY} real businesses, return fewer — accuracy over quantity
- Exclude national chains and franchises unless they are independently owned / managed locations with local decision-making
- Exclude: agencies, competitors (other AI consultancies, automation agencies), VC-backed scale-ups, companies clearly under 5 staff, and obviously regulated edge cases (law firms, financial advisors) unless explicitly requested by the query

Return a JSON array only. No markdown. No preamble. Example format:

[
  {
    "businessName": "Mercer & Hughes Recruitment",
    "city": "Leeds",
    "country": "United Kingdom",
    "website": "https://mercerhughes.co.uk",
    "description": "Independent Leeds-based technical recruitment firm with a team of ~15 consultants across engineering and manufacturing.",
    "ownerName": "Sarah Mercer",
    "sector": "recruitment",
    "source": "Google + LinkedIn"
  }
]

If you find zero matching businesses in this area, return an empty array: []`;

  return withRetry(async () => {
    const response = await client.models.generateContent({
      model: config.geminiModel,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        systemInstruction:
          "You are a B2B business discovery researcher for a UK AI consultancy. Return valid JSON arrays only. No preamble. Only include businesses you found via Google or LinkedIn — never fabricate entries. Prefer UK founder-led / owner-managed SMEs.",
        temperature: 0.1,
        maxOutputTokens: DISCOVERY_MAX_TOKENS,
        tools: [{ googleSearch: {} }],
      },
    });

    const rawText = response.text ?? "";
    const cleaned = rawText.replace(/^```(?:json)?\n?/g, "").replace(/\n?```$/g, "").trim();

    const parsed = salvageJsonArray(cleaned);

    if (parsed.length === 0 && cleaned.length > 20) {
      console.error(
        `Discovery parse salvage empty for "${query}" in ${regionLabel}. ` +
        `Raw length=${rawText.length}. First 2000: ${rawText.slice(0, 2000)}`
      );
    } else if (parsed.length < MAX_PER_QUERY && rawText.length >= DISCOVERY_MAX_TOKENS * 3) {
      // Likely truncation — log the tail so we can see what got cut
      console.warn(
        `Discovery likely truncated for "${query}": salvaged ${parsed.length}, ` +
        `raw length=${rawText.length}. Tail: ${rawText.slice(-500)}`
      );
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
        sector: typeof item.sector === "string" ? item.sector : null,
        source: typeof item.source === "string" ? item.source : "Google Search",
      }))
      .slice(0, MAX_PER_QUERY);

    return { businesses, query, region: `${region.lat},${region.lng},${region.radiusMeters}` };
  }, `discovery:${query}:${regionLabel}`, { maxAttempts: 2, baseDelayMs: 3000 });
}
