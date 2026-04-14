import { prisma } from "./prisma.js";

// ---------------------------------------------------------------------------
// Name Normalization
// ---------------------------------------------------------------------------

// Common suffixes and noise words stripped during normalization
const STRIP_SUFFIXES = [
  // Legal entities
  "ltd", "limited", "llc", "llp", "inc", "incorporated", "plc", "corp", "corporation",
  "gmbh", "pty", "co", "company",
  // Business type noise
  "studio", "studios", "gym", "gyms", "fitness", "wellness", "health", "club",
  "centre", "center", "academy", "training", "space", "hub", "house", "room",
  "pilates", "yoga", "crossfit", "boutique", "box", "unit", "facility",
  "physiotherapy", "physio", "clinic", "clinics", "therapy", "therapies",
  "performance", "movement", "athletic", "athletics", "sports", "sport",
  // Location noise
  "london", "manchester", "bristol", "uk",
  // Generic
  "the", "and", "&",
];

const STRIP_REGEX = new RegExp(
  `\\b(${STRIP_SUFFIXES.join("|")})\\b`,
  "gi"
);

export function normalizeBusinessName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[''`]/g, "")              // Strip apostrophes
    .replace(/[^\w\s]/g, " ")           // Non-alphanumeric → space
    .replace(STRIP_REGEX, "")           // Strip noise words
    .replace(/\s+/g, " ")              // Collapse whitespace
    .trim();
}

// ---------------------------------------------------------------------------
// Domain Extraction
// ---------------------------------------------------------------------------

export function extractDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    let normalized = url.trim().toLowerCase();
    if (!normalized.startsWith("http")) normalized = `https://${normalized}`;
    const parsed = new URL(normalized);
    // Strip www. and return root domain
    return parsed.hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Similarity — Sørensen–Dice coefficient on bigrams
// Fast, no dependencies, good for business name matching
// ---------------------------------------------------------------------------

function bigrams(str: string): Set<string> {
  const s = new Set<string>();
  for (let i = 0; i < str.length - 1; i++) {
    s.add(str.slice(i, i + 2));
  }
  return s;
}

export function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const bigramsA = bigrams(a);
  const bigramsB = bigrams(b);
  let intersect = 0;
  for (const bg of bigramsA) {
    if (bigramsB.has(bg)) intersect++;
  }
  return (2 * intersect) / (bigramsA.size + bigramsB.size);
}

// Threshold: 0.75+ means very likely the same business
const SIMILARITY_THRESHOLD = parseFloat(process.env.DEDUP_SIMILARITY_THRESHOLD ?? "0.75");

// ---------------------------------------------------------------------------
// Main Dedup Check
// ---------------------------------------------------------------------------

export interface DedupResult {
  isDuplicate: boolean;
  matchedLeadId: string | null;
  matchType: "domain" | "exact_name" | "fuzzy_name" | null;
  matchedBusinessName: string | null;
  similarity: number | null;
}

export async function checkDuplicate(opts: {
  businessName: string;
  website?: string | null;
  city?: string | null;
}): Promise<DedupResult> {
  const normName = normalizeBusinessName(opts.businessName);
  const domain = extractDomain(opts.website);

  // ── Layer 1: Domain match (strongest signal) ──
  if (domain) {
    const domainMatch = await prisma.lead.findFirst({
      where: { websiteDomain: domain },
      select: { id: true, businessName: true },
    });
    if (domainMatch) {
      return {
        isDuplicate: true,
        matchedLeadId: domainMatch.id,
        matchType: "domain",
        matchedBusinessName: domainMatch.businessName,
        similarity: 1,
      };
    }
  }

  // ── Layer 2: Exact normalized name match ──
  const exactMatch = await prisma.lead.findFirst({
    where: { normalizedName: normName },
    select: { id: true, businessName: true },
  });
  if (exactMatch) {
    return {
      isDuplicate: true,
      matchedLeadId: exactMatch.id,
      matchType: "exact_name",
      matchedBusinessName: exactMatch.businessName,
      similarity: 1,
    };
  }

  // ── Layer 3: Fuzzy name match within same city (or globally if no city) ──
  // Pull candidates with similar short normalized names to limit comparison set
  // We use a prefix search (first 3 chars) to narrow the field, then Dice on each
  const prefix = normName.slice(0, 3);
  if (prefix.length >= 2) {
    const candidates = await prisma.lead.findMany({
      where: {
        normalizedName: { startsWith: prefix },
        ...(opts.city ? { city: opts.city } : {}),
      },
      select: { id: true, businessName: true, normalizedName: true },
      take: 100,
    });

    for (const candidate of candidates) {
      if (!candidate.normalizedName) continue;
      const sim = diceCoefficient(normName, candidate.normalizedName);
      if (sim >= SIMILARITY_THRESHOLD) {
        return {
          isDuplicate: true,
          matchedLeadId: candidate.id,
          matchType: "fuzzy_name",
          matchedBusinessName: candidate.businessName,
          similarity: sim,
        };
      }
    }
  }

  // Also check without prefix constraint but with city, for names that start differently
  // e.g. "The Iron Temple" (normalized: "iron temple") vs "Temple Iron" (normalized: "temple iron")
  if (opts.city && normName.length >= 4) {
    const cityMatches = await prisma.lead.findMany({
      where: {
        city: opts.city,
        normalizedName: { not: null },
      },
      select: { id: true, businessName: true, normalizedName: true },
      take: 200,
    });

    for (const candidate of cityMatches) {
      if (!candidate.normalizedName) continue;
      const sim = diceCoefficient(normName, candidate.normalizedName);
      if (sim >= SIMILARITY_THRESHOLD) {
        return {
          isDuplicate: true,
          matchedLeadId: candidate.id,
          matchType: "fuzzy_name",
          matchedBusinessName: candidate.businessName,
          similarity: sim,
        };
      }
    }
  }

  return {
    isDuplicate: false,
    matchedLeadId: null,
    matchType: null,
    matchedBusinessName: null,
    similarity: null,
  };
}
