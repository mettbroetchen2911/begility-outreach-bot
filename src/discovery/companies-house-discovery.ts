import {
  searchCompanies,
  getCompanyProfile,
  assessFinancialStanding,
  type CompanySearchHit,
} from "../utils/companies-house.js";

export interface CHDiscoveredBusiness {
  businessName: string;
  companiesHouseNumber: string;
  city: string | null;
  country: string;
  address: string | null;
  outwardPostcode: string | null;
  sicCodes: string[];
  accountsCategory: string | null;
  incorporatedOn: Date | null;
  companyStatus: string;
  source: "companies_house";
}

export interface CHDiscoveryResult {
  businesses: CHDiscoveredBusiness[];
  location: string;
  totalSearched: number;
  rejectedFinancialStanding: number;
}

const PAGE_SIZE = 100;
const MAX_PAGES = parseInt(process.env.CH_MAX_PAGES_PER_LOCATION ?? "5", 10);

/**
 * Discovery scan against Companies House for a given location + SIC set.
 *
 * Pipeline:
 *   1. advanced-search by SIC + location + status=active + incorporated_to
 *   2. for each hit, fetch the full profile (cached 7d)
 *   3. apply financial-standing filter (accounts category, overdue, insolvency)
 *   4. return only the survivors as CHDiscoveredBusiness
 *
 * Note: this returns business identity + registered address only.
 * Website / phone / email are obtained downstream by the existing Flash
 * research step + scraper.
 */
export async function discoverFromCompaniesHouse(opts: {
  location: string;
  sicCodes: string[];
  incorporatedBefore: string;
}): Promise<CHDiscoveryResult> {
  const result: CHDiscoveryResult = {
    businesses: [],
    location: opts.location,
    totalSearched: 0,
    rejectedFinancialStanding: 0,
  };

  for (let page = 0; page < MAX_PAGES; page++) {
    const startIndex = page * PAGE_SIZE;

    const { hits, totalResults } = await searchCompanies({
      sicCodes: opts.sicCodes,
      location: opts.location,
      incorporatedBefore: opts.incorporatedBefore,
      companyStatus: "active",
      companyType: "ltd",
      size: PAGE_SIZE,
      startIndex,
    });

    result.totalSearched += hits.length;
    if (hits.length === 0) break;

    for (const hit of hits) {
      const enriched = await assessHit(hit);
      if (enriched) {
        result.businesses.push(enriched);
      } else {
        result.rejectedFinancialStanding++;
      }
    }

    if (startIndex + hits.length >= totalResults) break;
  }

  return result;
}

async function assessHit(hit: CompanySearchHit): Promise<CHDiscoveredBusiness | null> {
  const profile = await getCompanyProfile(hit.company_number);
  if (!profile) return null;

  const standing = assessFinancialStanding(profile);
  if (!standing.passes) return null;

  const addr = profile.registered_office_address ?? hit.registered_office_address;
  const fullAddress = addr
    ? [addr.address_line_1, addr.address_line_2, addr.locality, addr.region, addr.postal_code, addr.country]
        .filter(Boolean)
        .join(", ")
    : null;
  const outward = addr?.postal_code
    ? addr.postal_code.toUpperCase().split(/\s+/)[0] || null
    : null;

  return {
    businessName: profile.company_name,
    companiesHouseNumber: profile.company_number,
    city: addr?.locality ?? null,
    country: addr?.country ?? "United Kingdom",
    address: fullAddress,
    outwardPostcode: outward,
    sicCodes: profile.sic_codes ?? hit.sic_codes ?? [],
    accountsCategory: standing.accountsCategory,
    incorporatedOn: profile.date_of_creation ? new Date(profile.date_of_creation) : null,
    companyStatus: profile.company_status,
    source: "companies_house",
  };
}
