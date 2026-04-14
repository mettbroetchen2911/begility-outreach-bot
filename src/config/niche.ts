// ============================================================================
// Lead Engine — Niche Configuration
//
// This is the ONLY place the business vertical is defined.
// Every AI prompt, scoring criteria, discovery query, and email signature
// downstream reads from this config. Change these env vars and the entire
// engine adapts to a new B2B vertical — no code changes required.
//
// Example .env for Begility (AI consultancy targeting labour-intensive SMBs):
//
//   NICHE_TAG=operations-heavy SMB with manual, labour-intensive processes
//   BRAND_NAME=Begility
//   BRAND_DESCRIPTION=Begility is a UK-based AI consultancy and integration
//     studio. We help operations-heavy companies identify the repetitive,
//     labour-intensive work inside their business and replace it with
//     bespoke AI automation, agents, and integrations. We run a portfolio
//     of fully-automated companies ourselves, and bring that same playbook
//     to clients as consulting, build, and ongoing integration services.
//   SCORING_CRITERIA=visible manual/repetitive back-office work (quoting, data entry, scheduling, reporting, compliance, invoicing),evidence of growth or hiring pressure that automation would relieve,service-based or ops-heavy business model (not pure e-commerce/product-only),decision-maker or founder is publicly identifiable,UK/EU/US based and trading at a size where a 5-figure engagement is realistic
//   DISCOVERY_QUERIES=independent accountancy firm,law firm small practice,property management company,recruitment agency,logistics and freight forwarder,insurance broker,independent financial adviser,architecture practice,surveying firm,engineering consultancy,medical or dental group practice,bookkeeping firm,construction and fit-out contractor,managed service provider,customs and compliance broker
//   DISCOVERY_REGIONS=51.5074,-0.1278,30000;53.4808,-2.2426,25000;52.4862,-1.8904,25000;55.9533,-3.1883,20000;53.3498,-6.2603,20000
//   SENDER_NAME=Ashim
//   SENDER_TITLE=Founder
//   SENDER_EMAIL_DOMAIN=begility.com
//   GEMINI_MODEL=gemini-2.5-flash
//   GEMINI_PRO_MODEL=gemini-2.5-pro
//   OUTREACH_TONE=direct, technically credible, founder-to-founder — never salesy, never corporate-consultant jargon
//
// Example .env for a different vertical (SaaS targeting agencies):
//
//   NICHE_TAG=digital marketing agency
//   BRAND_NAME=AcmeAI
//   BRAND_DESCRIPTION=AcmeAI builds AI-powered content tools...
//   SCORING_CRITERIA=manages multiple client accounts,...
//   DISCOVERY_QUERIES=digital marketing agency,...
//   DISCOVERY_REGIONS=51.5074,-0.1278,30000;40.7128,-74.0060,30000
//   SENDER_NAME=Sarah
//   SENDER_TITLE=Head of Growth
//   SENDER_EMAIL_DOMAIN=acmeai.com
//   GEMINI_MODEL=gemini-2.5-flash
//   OUTREACH_TONE=professional and consultative, data-driven
// ============================================================================

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
  const geminiModel = process.env.GEMINI_MODEL ?? "gemini-3-flash-preview";
  const outreachTone = process.env.OUTREACH_TONE ?? "direct, warm, peer-to-peer — not salesy or corporate";
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

export function getBrandContextPrompt(): string {
  const config = getNicheConfig();
  return [
    `Brand: ${config.brandName}`,
    `Description: ${config.brandDescription}`,
    `Target niche: ${config.nicheTag}`,
    `Scoring criteria: ${config.scoringCriteria.join(", ")}`,
  ].join("\n");
}

export function getEmailSignature(): string {
  const config = getNicheConfig();
  // First name only — the HTML email template footer already contains
  // the full name, title, brand, and company details.
  return config.senderName;
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
