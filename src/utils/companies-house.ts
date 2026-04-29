import { withRetry } from "./retry.js";
import { prisma } from "./prisma.js";

const API_BASE = "https://api.company-information.service.gov.uk";
const CACHE_TTL_HOURS = 24 * 7;  // 1 week — accounts data rarely changes mid-week

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
    const expiresAt = new Date(Date.now() + CACHE_TTL_HOURS * 3600_000);
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
  if (!cat) {
    return { passes: false, reason: "no-accounts-category", accountsCategory: cat };
  }
  if (!allowList.includes(cat)) {
    return { passes: false, reason: `accounts-category=${cat}`, accountsCategory: cat };
  }
  return { passes: true, accountsCategory: cat };
}
