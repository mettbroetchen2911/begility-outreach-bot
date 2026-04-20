// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NicheConfig {
  // ── What we're looking for ──
  nicheTag: string;
  brandName: string;
  brandDescription: string;
  scoringCriteria: string[];

  // ── Where to look ──
  discoveryQueries: string[];
  discoveryRegions: Region[];

  // ── Who's sending ──
  senderName: string;
  senderTitle: string;
  senderEmailDomain: string;

  // ── AI config ──
  geminiModel: string;

  // ── Outreach tone ──
  outreachTone: string;

  // ── Scoring thresholds ──
  tier1Threshold: number;   // score >= this → Tier1 (default 70)
  tier2Threshold: number;   // score >= this → Tier2 (default 50)
  verificationThreshold: number; // email verification score minimum (default 40)
}

export interface Region {
  lat: number;
  lng: number;
  radiusMeters: number;
  label: string;
}

// ---------------------------------------------------------------------------
// Singleton — parsed once, cached for the process lifetime
// ---------------------------------------------------------------------------
let cachedConfig: NicheConfig | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getNicheConfig(): NicheConfig {
  if (cachedConfig) return cachedConfig;

  const nicheTag = requireEnv("NICHE_TAG");
  const brandName = requireEnv("BRAND_NAME");
  const brandDescription = requireEnv("BRAND_DESCRIPTION");
  const senderName = requireEnv("SENDER_NAME");
  const senderTitle = requireEnv("SENDER_TITLE");
  const senderEmailDomain = process.env.SENDER_EMAIL_DOMAIN ?? "";
  // Flash model remains Gemini 2.5 Flash — used for high-volume, lower-stakes calls
  const geminiModel = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
  const outreachTone = process.env.OUTREACH_TONE ?? "dry, honest, founder-first — plain English, zero consultant jargon, operator-to-operator";
  const tier1Threshold = parseInt(process.env.TIER1_THRESHOLD ?? "70", 10);
  const tier2Threshold = parseInt(process.env.TIER2_THRESHOLD ?? "50", 10);
  const verificationThreshold = parseInt(process.env.VERIFICATION_THRESHOLD ?? "40", 10);

  // ── Scoring criteria: comma-separated string → array ──
  const scoringRaw = requireEnv("SCORING_CRITERIA");
  const scoringCriteria = scoringRaw.split(",").map((s) => s.trim()).filter(Boolean);
  if (scoringCriteria.length === 0) {
    throw new Error("SCORING_CRITERIA must contain at least one criterion (comma-separated)");
  }

  // ── Discovery queries: comma-separated string → array ──
  const queriesRaw = requireEnv("DISCOVERY_QUERIES");
  const discoveryQueries = queriesRaw.split(",").map((s) => s.trim()).filter(Boolean);
  if (discoveryQueries.length === 0) {
    throw new Error("DISCOVERY_QUERIES must contain at least one search term (comma-separated)");
  }

  // ── Discovery regions: semicolon-separated "lat,lng,radius" strings ──
  const regionsRaw = requireEnv("DISCOVERY_REGIONS");
  const discoveryRegions = regionsRaw.split(";").map((s) => s.trim()).filter(Boolean).map(parseRegion);
  if (discoveryRegions.length === 0) {
    throw new Error("DISCOVERY_REGIONS must contain at least one region");
  }

  if (brandDescription.length < 20) {
    throw new Error("BRAND_DESCRIPTION is too short — provide at least 2 sentences");
  }

  if (tier1Threshold <= tier2Threshold) {
    throw new Error(`TIER1_THRESHOLD (${tier1Threshold}) must be greater than TIER2_THRESHOLD (${tier2Threshold})`);
  }

  cachedConfig = {
    nicheTag, brandName, brandDescription, scoringCriteria,
    discoveryQueries, discoveryRegions,
    senderName, senderTitle, senderEmailDomain,
    geminiModel, outreachTone,
    tier1Threshold, tier2Threshold, verificationThreshold,
  };

  return cachedConfig;
}

export function getScoringCriteriaPrompt(): string {
  return getNicheConfig().scoringCriteria.join(", ");
}

/**
 * Full Begility context block. Injected into every Pro-model prompt so
 * Claude understands what Begility is, how it sells, which pains it solves,
 * and which lanes of work it does.
 *
 * This block deliberately contains NO pricing — pricing is never mentioned
 * in cold outbound.
 */
export function getBrandContextPrompt(): string {
  const config = getNicheConfig();
  return [
    `BRAND: ${config.brandName}`,
    `TAGLINE: Operating intelligence company. Built in a live lab. Proven in real companies. Sold to yours.`,
    ``,
    `WHAT WE ACTUALLY SELL:`,
    `We don't sell AI consulting. We sell businesses that run better — less admin, faster response, tighter handoffs, cleaner reporting, better operational control. AI is the tool; operational change is the product.`,
    ``,
    `HOW WE'RE DIFFERENT:`,
    `Most AI consultants have never run a business. We run four: Begility (holding / ops core), Garlic Shop (e-commerce, 500+ recipes fully automated), allium. (premium supplements with UK regulatory compliance), and Skillity (AI-native HR with realtime interviews). Every playbook we sell has been tested on our own P&L first.`,
    ``,
    `THREE DELIVERY LANES:`,
    `1. LEAD SYSTEMS — stop leaking leads. Capture, qualify, respond, book. Missed-call recovery. CRM discipline. Pipeline visibility where there was none.`,
    `2. WORKFLOW AUTOMATION — remove admin. Handoffs, approvals, routing, reminders. Back-office work that doesn't need a human, done without one.`,
    `3. OPERATIONAL VISIBILITY — decide from data, not vibes. Dashboards that tell you what's actually happening. Reporting that runs itself.`,
    ``,
    `WHAT WE DO NOT DO: bespoke ERPs, enterprise data warehouses, generic "digital transformation", endless retainers dressed up as projects, strategy decks without implementation.`,
    ``,
    `IDEAL CLIENT: UK founder-led or owner-managed businesses, £1m–£20m turnover, 10–100 staff, cashflow-positive, specific nameable operational pain, bias for action, decision-maker identifiable on the first call.`,
    ``,
    `COMMERCIAL PROCESS (never put prices in outbound):`,
    `- Free 30-minute discovery call to qualify pain and fit.`,
    `- Paid two-week Operations Diagnostic: workflow map, bottleneck audit, ROI-ranked roadmap. Fully credited against any build commissioned shortly after.`,
    `- Fixed-fee implementation build, scoped to one lane at a time unless phasing is clearly justified.`,
    `- Optional Systems Partnership for ongoing optimisation after go-live (not the foundation of the model).`,
    ``,
    `SECTOR PRIORITIES (wave 1 outbound): recruitment; estate agents / lettings; trades businesses with teams.`,
    `SECTOR PRIORITIES (wave 2 available): dentists / cosmetic clinics; wholesalers / distributors; dealerships.`,
    ``,
    `PAINS WE SELL AGAINST: missed calls and missed leads; slow or inconsistent follow-up; too much manual admin across staff; poor handoffs between people, teams or stages; booking / scheduling / quoting / reminder friction; weak visibility over pipeline, operations or staff output.`,
    ``,
    `VOICE: dry, honest, founder-first, zero jargon. We'd rather be quoted than polished. If a sentence sounds like a McKinsey deck, we delete it. Operator-to-operator.`,
    ``,
    `BRAND DESCRIPTION (verbatim): ${config.brandDescription}`,
    `TARGET NICHE: ${config.nicheTag}`,
    `SCORING CRITERIA: ${config.scoringCriteria.join(", ")}`,
  ].join("\n");
}

export function getEmailSignature(): string {
  const config = getNicheConfig();
  const firstName = config.senderName.split(/\s+/)[0];
  return `Kindest regards,<br>${firstName}`;
}

export function resetConfigCache(): void {
  cachedConfig = null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing required environment variable: ${name}\n` +
      `Set this in your .env file or GCP Secret Manager.\n` +
      `See src/config/niche.ts for documentation and examples.`
    );
  }
  return value.trim();
}

function parseRegion(raw: string): Region {
  const parts = raw.split(",").map((s) => s.trim());
  if (parts.length !== 3) {
    throw new Error(`Invalid region format: "${raw}". Expected "lat,lng,radiusMeters"`);
  }

  const lat = parseFloat(parts[0]);
  const lng = parseFloat(parts[1]);
  const radiusMeters = parseInt(parts[2], 10);

  if (isNaN(lat) || lat < -90 || lat > 90) throw new Error(`Invalid latitude in region "${raw}"`);
  if (isNaN(lng) || lng < -180 || lng > 180) throw new Error(`Invalid longitude in region "${raw}"`);
  if (isNaN(radiusMeters) || radiusMeters < 100 || radiusMeters > 50000) {
    throw new Error(`Invalid radius in region "${raw}" (must be 100-50000 meters)`);
  }

  const latDir = lat >= 0 ? "N" : "S";
  const lngDir = lng >= 0 ? "E" : "W";
  const label = `${Math.abs(lat).toFixed(2)}°${latDir}, ${Math.abs(lng).toFixed(2)}°${lngDir} (${(radiusMeters / 1000).toFixed(0)}km)`;

  return { lat, lng, radiusMeters, label };
}
