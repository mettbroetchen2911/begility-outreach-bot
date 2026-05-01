import { withRetry } from "./retry.js";
import { prisma } from "./prisma.js";

const API_BASE = "https://api.company-information.service.gov.uk";
const DOC_API_BASE = "https://document-api.company-information.service.gov.uk";

// Profile changes infrequently — long TTL is fine.
const PROFILE_CACHE_TTL_HOURS = 24 * 7;
// Officers/filings/charges/PSC change more often (new appointments, fresh
// filings). Shorter TTL keeps signals fresh without crushing the rate limit.
const SUB_RESOURCE_CACHE_TTL_HOURS = 24;

export interface AdvancedSearchOpts {
  sicCodes?: string[];
  location?: string;
  incorporatedBefore?: string;   // ISO date
  incorporatedAfter?: string;
  companyStatus?: string;        // "active" by default
  companyType?: string;          // "ltd", "plc", "llp", etc.
  size?: number;                 // page size (max 5000, default 20)
  startIndex?: number;           // pagination
}

export interface CompanySearchHit {
  company_number: string;
  company_name: string;
  company_status: string;
  company_type: string;
  date_of_creation: string;
  registered_office_address?: {
    address_line_1?: string;
    address_line_2?: string;
    locality?: string;
    region?: string;
    postal_code?: string;
    country?: string;
  };
  sic_codes?: string[];
}

export interface CompanyProfile {
  company_number: string;
  company_name: string;
  company_status: string;
  company_status_detail?: string;
  type: string;
  date_of_creation: string;
  jurisdiction?: string;
  registered_office_address?: CompanySearchHit["registered_office_address"];
  sic_codes?: string[];
  accounts?: {
    accounts_category?: string;
    next_due?: string;
    last_accounts?: {
      type?: string;
      made_up_to?: string;
    };
    overdue?: boolean;
  };
  confirmation_statement?: {
    overdue?: boolean;
    next_due?: string;
  };
  has_been_liquidated?: boolean;
  has_insolvency_history?: boolean;
}

function authHeader(): string {
  const key = process.env.COMPANIES_HOUSE_API_KEY;
  if (!key) {
    throw new Error("COMPANIES_HOUSE_API_KEY is not set");
  }
  return "Basic " + Buffer.from(`${key}:`).toString("base64");
}

export async function searchCompanies(opts: AdvancedSearchOpts): Promise<{
  hits: CompanySearchHit[];
  totalResults: number;
}> {
  const params = new URLSearchParams();
  if (opts.sicCodes && opts.sicCodes.length) params.set("sic_codes", opts.sicCodes.join(","));
  if (opts.location) params.set("location", opts.location);
  if (opts.incorporatedBefore) params.set("incorporated_to", opts.incorporatedBefore);
  if (opts.incorporatedAfter) params.set("incorporated_from", opts.incorporatedAfter);
  params.set("company_status", opts.companyStatus ?? "active");
  if (opts.companyType) params.set("company_type", opts.companyType);
  params.set("size", String(opts.size ?? 100));
  if (opts.startIndex) params.set("start_index", String(opts.startIndex));

  const url = `${API_BASE}/advanced-search/companies?${params.toString()}`;

  return withRetry(
    async () => {
      const res = await fetch(url, { headers: { Authorization: authHeader() } });
      if (res.status === 429) throw new Error("CH rate-limited");
      if (!res.ok) {
        throw new Error(`CH advanced-search ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      const data = (await res.json()) as {
        items?: CompanySearchHit[];
        hits?: number;
        total_results?: number;
      };
      return {
        hits: data.items ?? [],
        totalResults: data.hits ?? data.total_results ?? 0,
      };
    },
    `ch:advanced-search:${opts.location ?? "all"}`,
    { maxAttempts: 3, baseDelayMs: 2500 }
  );
}

/**
 * Fetch full company profile, with 7-day DB cache to limit CH rate use.
 */
export async function getCompanyProfile(companyNumber: string): Promise<CompanyProfile | null> {
  const num = companyNumber.replace(/\s/g, "").toUpperCase();

  const cached = await prisma.companiesHouseCache.findUnique({ where: { companyNumber: num } });
  if (cached && cached.expiresAt > new Date()) {
    return cached.payload as unknown as CompanyProfile;
  }

  const profile = await withRetry(
    async () => {
      const res = await fetch(`${API_BASE}/company/${num}`, {
        headers: { Authorization: authHeader() },
      });
      if (res.status === 404) return null;
      if (res.status === 429) throw new Error("CH rate-limited");
      if (!res.ok) {
        throw new Error(`CH profile ${num} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      return (await res.json()) as CompanyProfile;
    },
    `ch:profile:${num}`,
    { maxAttempts: 3, baseDelayMs: 2000 }
  );

  if (profile) {
    const expiresAt = new Date(Date.now() + PROFILE_CACHE_TTL_HOURS * 3600_000);
    await prisma.companiesHouseCache
      .upsert({
        where: { companyNumber: num },
        create: { companyNumber: num, payload: profile as unknown as object, expiresAt },
        update: { payload: profile as unknown as object, fetchedAt: new Date(), expiresAt },
      })
      .catch(() => { /* cache is best-effort */ });
  }

  return profile;
}

// ---------------------------------------------------------------------------
// Sub-resources: officers, filing history, persons-with-significant-control,
// charges. All cached in a separate generic JSON blob keyed by
// `${companyNumber}:${resource}` to avoid colliding with the profile cache.
//
// We re-use the CompaniesHouseCache table by prefixing the resource name —
// no new table required, and the existing cleanup index on `expiresAt` works.
// ---------------------------------------------------------------------------

export interface CompanyOfficer {
  name: string;
  officer_role: string;        // "director" | "secretary" | "llp-member" | ...
  appointed_on?: string;
  resigned_on?: string;
  occupation?: string;
  nationality?: string;
  country_of_residence?: string;
  date_of_birth?: { month?: number; year?: number };
}

export interface OfficersResponse {
  items?: CompanyOfficer[];
  total_results?: number;
  active_count?: number;
  resigned_count?: number;
}

export interface FilingHistoryItem {
  type?: string;
  category?: string;
  date?: string;
  description?: string;
  description_values?: Record<string, unknown>;
  transaction_id?: string;
  links?: { document_metadata?: string };
}

export interface FilingHistoryResponse {
  items?: FilingHistoryItem[];
  total_count?: number;
}

export interface ChargeItem {
  charge_number?: number;
  status?: string;             // "outstanding" | "satisfied" | "part-satisfied"
  created_on?: string;
  satisfied_on?: string;
  delivered_on?: string;
  classification?: { description?: string };
  persons_entitled?: Array<{ name?: string }>;
}

export interface ChargesResponse {
  items?: ChargeItem[];
  total_count?: number;
  unfiltered_count?: number;
  satisfied_count?: number;
  part_satisfied_count?: number;
}

export interface PscItem {
  name?: string;
  kind?: string;
  natures_of_control?: string[];
  notified_on?: string;
  ceased_on?: string;
}

export interface PscResponse {
  items?: PscItem[];
  active_count?: number;
  ceased_count?: number;
  total_results?: number;
}

export async function getCompanyOfficers(companyNumber: string): Promise<OfficersResponse | null> {
  return getSubResource<OfficersResponse>(companyNumber, "officers");
}

export async function getCompanyFilingHistory(companyNumber: string): Promise<FilingHistoryResponse | null> {
  return getSubResource<FilingHistoryResponse>(companyNumber, "filing-history?items_per_page=50");
}

export async function getCompanyCharges(companyNumber: string): Promise<ChargesResponse | null> {
  return getSubResource<ChargesResponse>(companyNumber, "charges");
}

export async function getCompanyPSC(companyNumber: string): Promise<PscResponse | null> {
  return getSubResource<PscResponse>(companyNumber, "persons-with-significant-control");
}

async function getSubResource<T>(companyNumber: string, path: string): Promise<T | null> {
  const num = companyNumber.replace(/\s/g, "").toUpperCase();
  const cacheKey = `${num}:${path}`;

  const cached = await prisma.companiesHouseCache.findUnique({ where: { companyNumber: cacheKey } }).catch(() => null);
  if (cached && cached.expiresAt > new Date()) {
    return cached.payload as unknown as T;
  }

  const data = await withRetry(
    async () => {
      const res = await fetch(`${API_BASE}/company/${num}/${path}`, {
        headers: { Authorization: authHeader() },
      });
      if (res.status === 404) return null;
      if (res.status === 429) throw new Error("CH rate-limited");
      if (!res.ok) {
        throw new Error(`CH ${path} ${num} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      return (await res.json()) as T;
    },
    `ch:${path}:${num}`,
    { maxAttempts: 3, baseDelayMs: 2000 },
  );

  if (data) {
    const expiresAt = new Date(Date.now() + SUB_RESOURCE_CACHE_TTL_HOURS * 3600_000);
    await prisma.companiesHouseCache
      .upsert({
        where: { companyNumber: cacheKey },
        create: { companyNumber: cacheKey, payload: data as unknown as object, expiresAt },
        update: { payload: data as unknown as object, fetchedAt: new Date(), expiresAt },
      })
      .catch(() => { /* best-effort */ });
  }

  return data;
}

// ---------------------------------------------------------------------------
// Document API — fetches the actual filed document content (iXBRL accounts).
// Uses a different host (document-api.*) and a different field for the body.
// Returns the iXBRL HTML/XML as a UTF-8 string, ready to feed to the parser.
// ---------------------------------------------------------------------------

export async function fetchAccountsDocument(filing: FilingHistoryItem): Promise<{
  documentId: string;
  content: string;
} | null> {
  const docMetaUrl = filing.links?.document_metadata;
  if (!docMetaUrl) return null;

  // document_metadata link is something like:
  //   "/document/MzM2Mzc2NTk2OWFkaXF6a2N4"
  // We need to call /document/{id}/content on the document-api host.
  const m = docMetaUrl.match(/\/document\/([^/?#]+)/);
  if (!m) return null;
  const documentId = m[1];

  return withRetry(
    async () => {
      const res = await fetch(`${DOC_API_BASE}/document/${documentId}/content`, {
        headers: {
          Authorization: authHeader(),
          // application/xhtml+xml = iXBRL filings; pdf = older scans (we ignore those).
          Accept: "application/xhtml+xml, application/xml;q=0.9",
        },
        redirect: "follow",
      });
      if (res.status === 404 || res.status === 410) return null;
      if (res.status === 429) throw new Error("CH document rate-limited");
      if (!res.ok) {
        throw new Error(`CH document ${documentId} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      const ctype = res.headers.get("content-type") ?? "";
      if (ctype.includes("pdf")) {
        // Older scanned filings are PDFs, not iXBRL. We can't parse those.
        return null;
      }
      const content = await res.text();
      return { documentId, content };
    },
    `ch:document:${documentId}`,
    { maxAttempts: 3, baseDelayMs: 2500 },
  );
}

/**
 * Return true if the company looks like a candidate worth pursuing:
 *   - active
 *   - not in liquidation / insolvency
 *   - not overdue on accounts or confirmation statement
 *   - accounts category is in the allow-list (size proxy)
 */
export interface FinancialStandingResult {
  passes: boolean;
  reason?: string;
  accountsCategory: string | null;
}

export function assessFinancialStanding(profile: CompanyProfile): FinancialStandingResult {
  const allowList = (process.env.COMPANIES_HOUSE_ACCOUNTS_ALLOW ?? "small,medium,full,unaudited-abridged,audited-abridged")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

  const cat = (profile.accounts?.accounts_category ?? "").toLowerCase().trim() || null;
  const lastAccountsType = profile.accounts?.last_accounts?.type ?? null;

  if (profile.company_status !== "active") {
    return { passes: false, reason: `status=${profile.company_status}`, accountsCategory: cat };
  }
  if (profile.has_been_liquidated || profile.has_insolvency_history) {
    return { passes: false, reason: "insolvency-history", accountsCategory: cat };
  }
  if (profile.accounts?.overdue) {
    return { passes: false, reason: "accounts-overdue", accountsCategory: cat };
  }
  if (profile.confirmation_statement?.overdue) {
    return { passes: false, reason: "confirmation-statement-overdue", accountsCategory: cat };
  }
  // The accounts_category gate doesn't catch "active company that filed
  // dormant last year" — last_accounts.type does. AA02 / DORMANT / MICRO_DORMANT
  // mean the entity isn't trading; pitching them is wasted spend.
  if (lastAccountsType && /DORMANT|AA02/i.test(lastAccountsType)) {
    return { passes: false, reason: `last-accounts-type=${lastAccountsType}`, accountsCategory: cat };
  }
  if (!cat) {
    return { passes: false, reason: "no-accounts-category", accountsCategory: cat };
  }
  if (!allowList.includes(cat)) {
    return { passes: false, reason: `accounts-category=${cat}`, accountsCategory: cat };
  }
  return { passes: true, accountsCategory: cat };
}
