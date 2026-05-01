import { prisma } from "./prisma.js";
import {
  type CompanyProfile,
  type CompanyOfficer,
  type FilingHistoryResponse,
  type PscResponse,
} from "./companies-house.js";

// ---------------------------------------------------------------------------
// Tier-5 noise / risk filters — applied at discovery time so we don't waste
// scrape and Gemini tokens on companies that are structurally a poor fit.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Nominee / formation-agent registered office detection
//
// Companies whose registered office is a known accountant or formation-agent
// pass-through address are almost never trading from there. Pitching the
// "registered office" tells you nothing about the actual business. These are
// shells, dormants, holding entities, or registered abroad in practice.
//
// We match on a normalised address string. The default list covers the most
// common UK formation-agent buildings (~80% of the noise). Customers can
// extend via NOMINEE_ADDRESS_BLOCKLIST env (semicolon-separated address
// fragments — partial matches are sufficient, we lower-case both sides).
// ---------------------------------------------------------------------------

const DEFAULT_NOMINEE_FRAGMENTS = [
  // The big formation-agent buildings (1Stop, Made Simple, Companies Made
  // Simple, etc.) — known to host 100k+ companies between them.
  "20-22 wenlock road, london",
  "kemp house, 152-160 city road",
  "kemp house, 124 city road",
  "office 7338, 182-184 high street north",
  "27 old gloucester street, london",
  "85 great portland street",
  "5 brayford square",
  "71-75 shelton street",
  "international house, 24 holborn viaduct",
  "international house, 776-778 barking road",
  "international house, 142 cromwell road",
  "international house, 12 constance street",
  "58 peregrine road",
  "office 11528, po box 6945",
  "1 mayfair place",
  "37th floor, one canada square",
  "salatin house",
  "suite 305 griffin house",
  "the maltings, east tyndall street",
  "third floor, 207 regent street",
  "5 jupiter house",
];

function nomineeFragments(): string[] {
  const env = (process.env.NOMINEE_ADDRESS_BLOCKLIST ?? "")
    .split(";")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return [...DEFAULT_NOMINEE_FRAGMENTS, ...env];
}

export function isNomineeAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  const lower = address.toLowerCase();
  return nomineeFragments().some((frag) => lower.includes(frag));
}

// ---------------------------------------------------------------------------
// Dormant detection — orthogonal to accounts_category.
//
// A company can be in the "small" accounts_category (which we allow) but
// have most-recently filed dormant accounts. CH exposes the type via
// last_accounts.type ("DORMANT", "AA02", "MICRO_DORMANT"). These companies
// are not trading — pitching them is wasted effort.
// ---------------------------------------------------------------------------

const DORMANT_ACCOUNT_TYPES = new Set(["DORMANT", "AA02", "MICRO_DORMANT", "DORMANT_LBG"]);

export function isDormantFiler(profile: CompanyProfile): boolean {
  const t = profile.accounts?.last_accounts?.type;
  if (!t) return false;
  return DORMANT_ACCOUNT_TYPES.has(t.toUpperCase());
}

// ---------------------------------------------------------------------------
// Corporate-PSC detection — counts persons-with-significant-control whose
// kind is "corporate-entity-..." or "legal-person-...". A dominant corporate
// PSC means the entity is owned by another company, which usually means
// it's a subsidiary or holding structure where the real decision-maker
// isn't on the entity's own director list.
// ---------------------------------------------------------------------------

export function countCorporatePSCs(psc: PscResponse | null): { active: number; activeIndividuals: number } {
  if (!psc?.items) return { active: 0, activeIndividuals: 0 };
  let corporate = 0;
  let individual = 0;
  for (const p of psc.items) {
    if (p.ceased_on) continue;
    const kind = (p.kind ?? "").toLowerCase();
    if (kind.includes("corporate") || kind.includes("legal-person")) corporate++;
    else if (kind.includes("individual")) individual++;
  }
  return { active: corporate, activeIndividuals: individual };
}

// ---------------------------------------------------------------------------
// Recent name-change count — filings of category="change-of-name" in the
// last 5 years. >= 2 is a flag for shell-company churn / rebrand pattern.
// ---------------------------------------------------------------------------

const NAME_CHANGE_LOOKBACK_DAYS = 5 * 365;

export function countRecentNameChanges(filings: FilingHistoryResponse | null): number {
  if (!filings?.items) return 0;
  const cutoff = Date.now() - NAME_CHANGE_LOOKBACK_DAYS * 24 * 3600_000;
  return filings.items.filter((f) => {
    if (f.category !== "change-of-name") return false;
    if (!f.date) return false;
    return Date.parse(f.date) >= cutoff;
  }).length;
}

// ---------------------------------------------------------------------------
// Subsidiary detection — "is this lead structurally a subsidiary of an
// existing lead in our DB?"
//
// Heuristic: same registered office address AND ≥1 director name overlap.
// We compare normalised director names rather than (name, dobMonth, dobYear)
// because some CH filings omit DOB on smaller companies, and a name match
// at the same address is sufficient signal at this scale.
//
// Returns the parent lead's id if it looks like a subsidiary, null
// otherwise. Caller decides what to do: suppress, annotate, or pitch parent.
// ---------------------------------------------------------------------------

export async function detectParentLead(opts: {
  /** The new lead we're evaluating — not yet persisted. */
  registeredOfficeAddress: string;
  officers: CompanyOfficer[];
  /** Skip this lead id when looking for parents (used during re-enrichment). */
  excludeLeadId?: string | null;
}): Promise<{ parentLeadId: string; parentName: string; sharedDirectors: string[] } | null> {
  if (!opts.registeredOfficeAddress) return null;

  // Normalise the address — case-insensitive, collapsed whitespace.
  const normAddr = opts.registeredOfficeAddress.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normAddr) return null;

  // Pull leads sharing this exact address, with their active officers.
  const candidates = await prisma.lead.findMany({
    where: {
      address: { equals: opts.registeredOfficeAddress, mode: "insensitive" },
      ...(opts.excludeLeadId ? { id: { not: opts.excludeLeadId } } : {}),
      status: { notIn: ["suppressed", "rejected", "exclude"] },
    },
    select: {
      id: true,
      businessName: true,
      officers: {
        where: { isActive: true },
        include: { director: { select: { normalizedName: true } } },
      },
    },
    take: 5,
  });

  if (candidates.length === 0) return null;

  const newDirectorNames = new Set(
    opts.officers
      .filter((o) => !o.resigned_on && (o.officer_role === "director" || o.officer_role === "llp-member"))
      .map((o) => o.name?.toLowerCase().replace(/\s+/g, " ").trim())
      .filter((n): n is string => Boolean(n)),
  );
  if (newDirectorNames.size === 0) return null;

  for (const cand of candidates) {
    const shared: string[] = [];
    for (const off of cand.officers) {
      if (newDirectorNames.has(off.director.normalizedName)) {
        shared.push(off.director.normalizedName);
      }
    }
    if (shared.length >= 1) {
      return {
        parentLeadId: cand.id,
        parentName: cand.businessName,
        sharedDirectors: shared,
      };
    }
  }

  return null;
}
