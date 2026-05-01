import { prisma } from "./prisma.js";

// ---------------------------------------------------------------------------
// Name normalisation — DELIBERATELY MINIMAL
//
// We only strip:
//   - Legal entity suffixes (ltd, limited, plc, llp, etc.)
//   - Punctuation
//   - Excess whitespace
//
// We do NOT strip sector words (recruitment, estate, lettings, etc.) because
// they are often the only thing distinguishing two unrelated businesses
// in the same town. "Mercer Recruitment" and "Mercer Estates" must NOT
// collide.
// ---------------------------------------------------------------------------

const LEGAL_SUFFIXES = [
  "ltd", "limited", "llc", "llp", "lp", "inc", "incorporated",
  "plc", "corp", "corporation", "gmbh", "pty",
  "co", "company", "cic", "cio", "sarl", "sa", "ag", "bv",
];

const LEGAL_SUFFIX_REGEX = new RegExp(
  `\\b(${LEGAL_SUFFIXES.join("|")})\\b\\.?`,
  "gi"
);

export function normalizeBusinessName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[''`""]/g, "")            // strip apostrophes / smart quotes
    .replace(/&/g, " and ")             // & → "and"
    .replace(LEGAL_SUFFIX_REGEX, "")    // strip "ltd", "limited", etc.
    .replace(/[^\w\s]/g, " ")           // non-alphanumeric → space
    .replace(/\s+/g, " ")               // collapse whitespace
    .trim();
}

// ---------------------------------------------------------------------------
// Domain extraction — registered-root aware
//
// Treats `www.foo.co.uk`, `foo.co.uk`, `shop.foo.co.uk` as the same domain.
// ---------------------------------------------------------------------------

const STRIP_SUBDOMAINS = ["www", "m", "shop", "blog", "news", "careers", "jobs"];

const COMPOUND_TLDS = [
  "co.uk", "org.uk", "ltd.uk", "plc.uk", "me.uk", "net.uk", "ac.uk", "gov.uk",
  "co.jp", "co.nz", "co.za", "com.au", "com.sg", "com.br",
];

export function extractDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    let normalized = url.trim().toLowerCase();
    if (!normalized.startsWith("http")) normalized = `https://${normalized}`;
    const parsed = new URL(normalized);
    let host = parsed.hostname;

    const parts = host.split(".");
    while (parts.length > 2 && STRIP_SUBDOMAINS.includes(parts[0])) {
      parts.shift();
    }
    host = parts.join(".");

    const isCompound = COMPOUND_TLDS.some((tld) => host.endsWith(`.${tld}`));
    const segments = host.split(".");
    if (isCompound && segments.length > 3) {
      return segments.slice(-3).join(".");
    }
    if (!isCompound && segments.length > 2) {
      return segments.slice(-2).join(".");
    }
    return host || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// E.164 phone normalisation (UK-default)
// ---------------------------------------------------------------------------

export function normalizePhoneE164(raw: string | null | undefined, defaultRegion = "GB"): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, "");
  if (!digits) return null;

  if (digits.startsWith("+")) {
    return digits.length >= 8 ? digits : null;
  }
  if (defaultRegion === "GB") {
    if (digits.startsWith("44")) return `+${digits}`;
    if (digits.startsWith("0")) return `+44${digits.slice(1)}`;
    if (digits.length >= 10) return `+44${digits}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// UK outward postcode (first half: "LS1", "M1", "EC1A")
// ---------------------------------------------------------------------------

export function extractOutwardPostcode(input: string | null | undefined): string | null {
  if (!input) return null;
  const m = input.toUpperCase().match(/\b([A-Z]{1,2}\d{1,2}[A-Z]?)\s*\d[A-Z]{2}\b/);
  if (m) return m[1];
  const o = input.toUpperCase().match(/^([A-Z]{1,2}\d{1,2}[A-Z]?)$/);
  return o ? o[1] : null;
}

// ---------------------------------------------------------------------------
// Email normalisation — bulletproof
//
// Two emails are "the same inbox" if they normalise to the same string.
//   - lowercase, trim
//   - strip plus-tag (foo+anything@x.com → foo@x.com)
//   - gmail.com / googlemail.com: strip dots in local part, treat googlemail
//     as gmail
//   - reject anything that isn't a syntactically valid address
//
// We deliberately do NOT compare just by domain — info@example.com vs
// hello@example.com are different inboxes (and may even be different people).
// We compare by full normalised inbox.
// ---------------------------------------------------------------------------

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  if (!EMAIL_REGEX.test(trimmed)) return null;

  const [localRaw, domainRaw] = trimmed.split("@");
  if (!localRaw || !domainRaw) return null;

  // Strip plus-addressing universally (Gmail, Outlook 365, FastMail, ProtonMail all support it).
  let local = localRaw.split("+")[0];

  // Gmail-specific: dots in the local part are ignored, googlemail.com == gmail.com
  let domain = domainRaw;
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") {
    local = local.replace(/\./g, "");
  }

  if (!local) return null;
  return `${local}@${domain}`;
}

// ---------------------------------------------------------------------------
// Dedup result type
// ---------------------------------------------------------------------------

export type DedupMatchType =
  | "place_id"
  | "companies_house_number"
  | "domain"
  | "email"
  | "phone"
  | "exact_name"
  | "name_postcode"
  | "fuzzy_trigram";

export interface DedupResult {
  isDuplicate: boolean;
  matchedLeadId: string | null;
  matchType: DedupMatchType | null;
  matchedBusinessName: string | null;
  similarity: number | null;
}

export interface DedupInput {
  businessName: string;
  website?: string | null;
  city?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  outwardPostcode?: string | null;
  companiesHouseNumber?: string | null;
  /** Google Places ID — globally unique, cheapest authoritative match. */
  googlePlaceId?: string | null;
  /** When dedup-ing an enrichment update for an existing lead, exclude that
   * lead's own id from the matchers — otherwise it always matches itself. */
  excludeLeadId?: string | null;
}

const SIMILARITY_THRESHOLD = parseFloat(process.env.DEDUP_SIMILARITY_THRESHOLD ?? "0.7");
const TRIGRAM_LIMIT = parseInt(process.env.DEDUP_TRIGRAM_LIMIT ?? "50", 10);

// ---------------------------------------------------------------------------
// Main check — layered, strongest signal first
// ---------------------------------------------------------------------------

export async function checkDuplicate(opts: DedupInput): Promise<DedupResult> {
  const normName = normalizeBusinessName(opts.businessName);
  const domain = extractDomain(opts.website);
  const phoneE164 = normalizePhoneE164(opts.phone);
  const emailNorm = normalizeEmail(opts.email);
  const outwardPostcode =
    opts.outwardPostcode ?? extractOutwardPostcode(opts.address ?? null);
  const chNumber = opts.companiesHouseNumber?.replace(/\s/g, "").toUpperCase() || null;
  const exclude = opts.excludeLeadId
    ? { id: { not: opts.excludeLeadId } }
    : {};

  // ── L0: Google Place ID — globally unique, skip everything else ────────
  if (opts.googlePlaceId) {
    const m = await prisma.lead.findFirst({
      where: { googlePlaceId: opts.googlePlaceId, ...exclude },
      select: { id: true, businessName: true },
    });
    if (m) return hit(m.id, m.businessName, "place_id", 1);
  }

  // ── L1: Companies House number — definitive ───────────────────────────
  if (chNumber) {
    const m = await prisma.lead.findFirst({
      where: { companiesHouseNumber: chNumber, ...exclude },
      select: { id: true, businessName: true },
    });
    if (m) return hit(m.id, m.businessName, "companies_house_number", 1);
  }

  // ── L2: Email — definitive (same inbox cannot belong to two SMEs) ─────
  // Case-insensitive equality so legacy rows stored with mixed-case emails
  // still collide against the canonical lower-cased form we produce now.
  if (emailNorm) {
    const m = await prisma.lead.findFirst({
      where: {
        email: { equals: emailNorm, mode: "insensitive" },
        ...exclude,
      },
      select: { id: true, businessName: true },
    });
    if (m) return hit(m.id, m.businessName, "email", 1);
  }

  // ── L3: Registered domain root — very strong ─────────────────────────
  if (domain) {
    const m = await prisma.lead.findFirst({
      where: { websiteDomain: domain, ...exclude },
      select: { id: true, businessName: true },
    });
    if (m) return hit(m.id, m.businessName, "domain", 1);
  }

  // ── L4: E.164 phone — very strong (typo-resistant) ────────────────────
  if (phoneE164) {
    const m = await prisma.lead.findFirst({
      where: { phoneE164, ...exclude },
      select: { id: true, businessName: true },
    });
    if (m) return hit(m.id, m.businessName, "phone", 1);
  }

  // ── L5: Exact normalised name match ───────────────────────────────────
  if (normName.length >= 2) {
    const m = await prisma.lead.findFirst({
      where: { normalizedName: normName, ...exclude },
      select: { id: true, businessName: true },
    });
    if (m) return hit(m.id, m.businessName, "exact_name", 1);
  }

  // ── L6: Name + outward postcode (handles word reordering) ─────────────
  if (outwardPostcode && normName.length >= 3) {
    const fuzzy = await trigramFuzzyMatch(normName, { outwardPostcode }, opts.excludeLeadId ?? null);
    if (fuzzy) return fuzzy;
  }

  // ── L7: Trigram fuzzy match (city-bounded if available) ───────────────
  if (normName.length >= 4) {
    const fuzzy = await trigramFuzzyMatch(normName, { city: opts.city ?? null }, opts.excludeLeadId ?? null);
    if (fuzzy) return fuzzy;
  }

  return {
    isDuplicate: false,
    matchedLeadId: null,
    matchType: null,
    matchedBusinessName: null,
    similarity: null,
  };
}

// ---------------------------------------------------------------------------
// Trigram fuzzy match — Postgres pg_trgm via raw query
//
// Requires the GIN index from the migration (idx_lead_normalized_name_trgm).
// ---------------------------------------------------------------------------

interface FuzzyScope {
  outwardPostcode?: string | null;
  city?: string | null;
}

async function trigramFuzzyMatch(
  normName: string,
  scope: FuzzyScope,
  excludeLeadId: string | null,
): Promise<DedupResult | null> {
  const conditions: string[] = [`"normalizedName" IS NOT NULL`];
  const params: unknown[] = [normName, normName, SIMILARITY_THRESHOLD, TRIGRAM_LIMIT];

  if (scope.outwardPostcode) {
    conditions.push(`"outwardPostcode" = $${params.length + 1}`);
    params.push(scope.outwardPostcode);
  } else if (scope.city) {
    conditions.push(`"city" = $${params.length + 1}`);
    params.push(scope.city);
  }

  if (excludeLeadId) {
    conditions.push(`"id" <> $${params.length + 1}::uuid`);
    params.push(excludeLeadId);
  }

  const where = conditions.join(" AND ");

  const rows = await prisma.$queryRawUnsafe<
    Array<{ id: string; businessName: string; similarity: number }>
  >(
    `
    SELECT id,
           "businessName",
           similarity("normalizedName", $1) AS similarity
      FROM "Lead"
     WHERE ${where}
       AND similarity("normalizedName", $2) >= $3
     ORDER BY similarity DESC
     LIMIT $4
    `,
    ...params
  );

  if (rows.length === 0) return null;
  const best = rows[0];
  return {
    isDuplicate: true,
    matchedLeadId: best.id,
    matchType: scope.outwardPostcode ? "name_postcode" : "fuzzy_trigram",
    matchedBusinessName: best.businessName,
    similarity: Number(best.similarity),
  };
}

function hit(
  id: string,
  name: string,
  type: DedupMatchType,
  similarity: number
): DedupResult {
  return {
    isDuplicate: true,
    matchedLeadId: id,
    matchType: type,
    matchedBusinessName: name,
    similarity,
  };
}
