import {
  searchCompanies,
  getCompanyProfile,
  getCompanyOfficers,
  getCompanyFilingHistory,
  getCompanyCharges,
  getCompanyPSC,
  fetchAccountsDocument,
  assessFinancialStanding,
  type CompanySearchHit,
  type CompanyProfile,
  type FilingHistoryItem,
} from "../utils/companies-house.js";
import {
  summariseCh,
  computeNextSendWindow,
  type ChSignalSummary,
} from "../utils/ch-signals.js";
import { parseIxbrlAccounts, type ParsedAccounts } from "../utils/ixbrl-parser.js";
import {
  isNomineeAddress,
  isDormantFiler,
  detectParentLead,
  countCorporatePSCs,
  countRecentNameChanges,
} from "../utils/lead-quality.js";
import { prisma } from "../utils/prisma.js";

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

  // ── Enriched signals (populated when CH_ENRICH_AT_DISCOVERY=true) ──
  ownerName: string | null;
  signals: ChSignalSummary | null;
  accounts: ParsedAccounts | null;
  nextOutreachWindow: Date | null;
  nextOutreachWindowReason: string | null;

  // ── Tier-5 audit fields ──
  lastAccountsType: string | null;
  nomineeAddress: boolean;
  subsidiaryOfLeadId: string | null;
  corporatePscCount: number | null;
  recentNameChangeCount: number | null;
}

export interface CHDiscoveryResult {
  businesses: CHDiscoveredBusiness[];
  location: string;
  totalSearched: number;
  rejectedFinancialStanding: number;
  rejectedPreScore: number;
  rejectedNomineeAddress: number;
  rejectedDormant: number;
  flaggedSubsidiary: number;
}

const PAGE_SIZE = 100;
const MAX_PAGES = parseInt(process.env.CH_MAX_PAGES_PER_LOCATION ?? "5", 10);
const ENRICH_AT_DISCOVERY = (process.env.CH_ENRICH_AT_DISCOVERY ?? "true").toLowerCase() === "true";
const FETCH_ACCOUNTS_DOC = (process.env.CH_FETCH_ACCOUNTS_DOC ?? "true").toLowerCase() === "true";
const PRE_SCORE_FLOOR = parseInt(process.env.CH_PRE_SCORE_FLOOR ?? "30", 10);
const REJECT_NOMINEE_ADDRESS = (process.env.CH_REJECT_NOMINEE_ADDRESS ?? "true").toLowerCase() === "true";
// "reject" — drop subsidiaries entirely. "flag" — keep them, mark for operator
// review. "ignore" — don't even check. Default "flag" so operators see them.
const SUBSIDIARY_POLICY = (process.env.CH_SUBSIDIARY_POLICY ?? "flag").toLowerCase();

/**
 * Discovery scan against Companies House for a given location + SIC set.
 *
 * Pipeline:
 *   1. advanced-search by SIC + location + status=active + incorporated_to
 *   2. for each hit, fetch the full profile (cached 7d)
 *   3. apply financial-standing filter (accounts category, overdue, insolvency)
 *   4. enrich: officers, filings, charges, PSC, latest filed accounts (iXBRL)
 *   5. compute composite signals + pre-score; drop anything below floor
 *   6. compute send-window
 *   7. upsert Director / Officer rows for the director graph
 *   8. return survivors as CHDiscoveredBusiness
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
    rejectedPreScore: 0,
    rejectedNomineeAddress: 0,
    rejectedDormant: 0,
    flaggedSubsidiary: 0,
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
      if (!enriched) {
        result.rejectedFinancialStanding++;
        continue;
      }
      // Tier-5: rejected because last_accounts.type was DORMANT/AA02 etc.
      // assessFinancialStanding() rolls this into rejectedFinancialStanding,
      // but we surface the dormant subset separately when it's the only reason.
      if (enriched.lastAccountsType && /DORMANT|AA02/i.test(enriched.lastAccountsType)) {
        // never reaches here because assessHit already returned null for dormant
        // — kept defensive in case of taxonomy change.
        result.rejectedDormant++;
        continue;
      }
      if (enriched.nomineeAddress && REJECT_NOMINEE_ADDRESS) {
        result.rejectedNomineeAddress++;
        continue;
      }
      if (enriched.subsidiaryOfLeadId && SUBSIDIARY_POLICY === "reject") {
        result.flaggedSubsidiary++;
        continue;
      }
      if (enriched.subsidiaryOfLeadId) {
        result.flaggedSubsidiary++;
        // fall through — let it persist with the parent flag
      }
      if (enriched.signals && enriched.signals.preScore < PRE_SCORE_FLOOR) {
        result.rejectedPreScore++;
        continue;
      }
      result.businesses.push(enriched);
    }

    if (startIndex + hits.length >= totalResults) break;
  }

  return result;
}

async function assessHit(hit: CompanySearchHit): Promise<CHDiscoveredBusiness | null> {
  const profile = await getCompanyProfile(hit.company_number);
  if (!profile) return null;

  // Tier-5: dormant filers fail the standing check via assessFinancialStanding.
  if (isDormantFiler(profile)) return null;

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

  // Tier-5: nominee / formation-agent registered office.
  const nominee = isNomineeAddress(fullAddress);

  const base: CHDiscoveredBusiness = {
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
    ownerName: null,
    signals: null,
    accounts: null,
    nextOutreachWindow: null,
    nextOutreachWindowReason: null,
    lastAccountsType: profile.accounts?.last_accounts?.type ?? null,
    nomineeAddress: nominee,
    subsidiaryOfLeadId: null,
    corporatePscCount: null,
    recentNameChangeCount: null,
  };

  if (!ENRICH_AT_DISCOVERY) return base;

  // Short-circuit: nominee-addressed companies aren't worth enriching when
  // we're going to reject them anyway. Skip the API spend.
  if (nominee && REJECT_NOMINEE_ADDRESS) return base;

  // ── Enrichment: officers / filings / charges / PSC / accounts ──
  const [officers, filings, charges, psc] = await Promise.all([
    getCompanyOfficers(profile.company_number).catch(() => null),
    getCompanyFilingHistory(profile.company_number).catch(() => null),
    getCompanyCharges(profile.company_number).catch(() => null),
    getCompanyPSC(profile.company_number).catch(() => null),
  ]);

  let accounts: ParsedAccounts | null = null;
  if (FETCH_ACCOUNTS_DOC && filings) {
    accounts = await tryParseLatestAccounts(profile.company_number, filings.items ?? []);
  }

  const signals = summariseCh({ profile, officers, filings, charges, psc, accounts });
  if (signals.hardExclude) return null;

  // Persist parsed financials separately (keyed by company number) for re-use
  await persistCompanyFinancials(profile.company_number, accounts).catch(() => { /* best-effort */ });

  // Director-graph upsert
  if (officers) {
    await upsertDirectorsForLater(profile.company_number, officers.items ?? []).catch(() => { /* best-effort */ });
  }

  // ── Tier-5: subsidiary detection ──
  // Same registered office + ≥1 active director overlap with an existing
  // lead = likely a subsidiary. We flag (or reject, depending on policy)
  // so we don't pitch the same group twice and don't waste outreach on
  // an entity whose decision-maker sits at the parent.
  let subsidiaryOfLeadId: string | null = null;
  if (
    SUBSIDIARY_POLICY !== "ignore" &&
    fullAddress &&
    officers?.items &&
    officers.items.length > 0
  ) {
    try {
      const parent = await detectParentLead({
        registeredOfficeAddress: fullAddress,
        officers: officers.items,
      });
      if (parent) {
        subsidiaryOfLeadId = parent.parentLeadId;
        console.log(
          `[CH] ${profile.company_name} (${profile.company_number}) appears to be a subsidiary of ${parent.parentName} ` +
          `(shared director: ${parent.sharedDirectors.join(", ")})`,
        );
      }
    } catch (err) {
      console.warn(`[CH] subsidiary detection failed: ${(err as Error).message}`);
    }
  }

  const corporatePsc = countCorporatePSCs(psc);
  const recentNameChanges = countRecentNameChanges(filings);

  const window = computeNextSendWindow({
    incorporatedOn: base.incorporatedOn,
    accountsLastMadeUpTo: signals.accountsLastMadeUpTo,
    accountsNextDue: signals.accountsNextDue,
    latestDirectorAppointedOn: signals.latestDirectorAppointedOn,
  });

  return {
    ...base,
    ownerName: signals.primaryDirectorName,
    signals,
    accounts,
    nextOutreachWindow: window?.at ?? null,
    nextOutreachWindowReason: window?.reason ?? null,
    subsidiaryOfLeadId,
    corporatePscCount: corporatePsc.active || null,
    recentNameChangeCount: recentNameChanges || null,
  };
}

// ---------------------------------------------------------------------------
// iXBRL accounts fetch — find the most recent "accounts" filing in history,
// then fetch+parse the document. Returns null if anything fails (no document,
// PDF-only filing, parse error, no usable tags).
// ---------------------------------------------------------------------------

async function tryParseLatestAccounts(
  companyNumber: string,
  filings: FilingHistoryItem[],
): Promise<ParsedAccounts | null> {
  const accountsFilings = filings
    .filter((f) => f.category === "accounts" && f.links?.document_metadata)
    .sort((a, b) => {
      const da = a.date ? Date.parse(a.date) : 0;
      const db = b.date ? Date.parse(b.date) : 0;
      return db - da;
    });

  for (const f of accountsFilings.slice(0, 2)) {
    try {
      const doc = await fetchAccountsDocument(f);
      if (!doc) continue;
      const parsed = parseIxbrlAccounts(doc.content);
      if (parsed.hasFinancials) return parsed;
    } catch (err) {
      // Try the next filing rather than abort the whole assessment.
      console.warn(`[CH] iXBRL parse failed for ${companyNumber}: ${(err as Error).message}`);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Persistence helpers — keep best-effort, never fail the discovery scan.
// ---------------------------------------------------------------------------

async function persistCompanyFinancials(companyNumber: string, accounts: ParsedAccounts | null): Promise<void> {
  if (!accounts) return;
  await prisma.companyFinancials.upsert({
    where: { companyNumber },
    create: {
      companyNumber,
      madeUpTo: accounts.madeUpTo,
      turnover: accounts.turnover,
      employeeCount: accounts.employeeCount,
      profitLoss: accounts.profitLoss,
      priorTurnover: accounts.priorTurnover,
      priorEmployeeCount: accounts.priorEmployeeCount,
      priorProfitLoss: accounts.priorProfitLoss,
      parseError: accounts.reason ?? null,
    },
    update: {
      madeUpTo: accounts.madeUpTo,
      turnover: accounts.turnover,
      employeeCount: accounts.employeeCount,
      profitLoss: accounts.profitLoss,
      priorTurnover: accounts.priorTurnover,
      priorEmployeeCount: accounts.priorEmployeeCount,
      priorProfitLoss: accounts.priorProfitLoss,
      parseError: accounts.reason ?? null,
      fetchedAt: new Date(),
    },
  });
}

/**
 * Stage director rows in CompanyFinancials-adjacent storage. We can't link
 * to the Lead until it's been created, so we just upsert the Director rows
 * here (idempotent on (normalizedName, dobMonth, dobYear)) and the
 * Officer junction rows are filled in when the Lead gets persisted —
 * see linkOfficersToLead in this same module.
 */
async function upsertDirectorsForLater(_companyNumber: string, _officers: import("../utils/companies-house.js").CompanyOfficer[]): Promise<void> {
  // No-op for now; we do the upsert in linkOfficersToLead() once we have the
  // leadId. Keeping this hook in place so callers don't need to know.
}

/**
 * Called by the discovery-sweep right after `prisma.lead.create({...})` so
 * we can attach Officer rows pointing to the freshly created Lead.id.
 */
export async function linkOfficersToLead(leadId: string, officers: import("../utils/companies-house.js").CompanyOfficer[]): Promise<void> {
  for (const o of officers) {
    if (!o.name) continue;
    if (o.officer_role !== "director" && o.officer_role !== "llp-member") continue;
    const normalizedName = o.name.toLowerCase().replace(/\s+/g, " ").trim();
    if (!normalizedName) continue;

    const dobMonth = o.date_of_birth?.month ?? 0;
    const dobYear = o.date_of_birth?.year ?? 0;

    try {
      const director = await prisma.director.upsert({
        where: {
          normalizedName_dobMonth_dobYear: {
            normalizedName,
            dobMonth,
            dobYear,
          },
        },
        create: {
          normalizedName,
          fullName: o.name,
          dobMonth,
          dobYear,
          nationality: o.nationality ?? null,
          occupation: o.occupation ?? null,
          countryOfResidence: o.country_of_residence ?? null,
        },
        update: {
          fullName: o.name,
          nationality: o.nationality ?? null,
          occupation: o.occupation ?? null,
          countryOfResidence: o.country_of_residence ?? null,
        },
      });

      await prisma.officer.upsert({
        where: {
          leadId_directorId_role: {
            leadId,
            directorId: director.id,
            role: o.officer_role,
          },
        },
        create: {
          leadId,
          directorId: director.id,
          role: o.officer_role,
          appointedOn: o.appointed_on ? new Date(o.appointed_on) : null,
          resignedOn: o.resigned_on ? new Date(o.resigned_on) : null,
          isActive: !o.resigned_on,
        },
        update: {
          appointedOn: o.appointed_on ? new Date(o.appointed_on) : null,
          resignedOn: o.resigned_on ? new Date(o.resigned_on) : null,
          isActive: !o.resigned_on,
        },
      });
    } catch (err) {
      // Director graph is best-effort — don't kill the discovery for a
      // unique-violation race or schema drift.
      console.warn(`[CH] director-graph upsert failed for ${o.name}: ${(err as Error).message}`);
    }
  }
}

/**
 * Re-export raw officer access so the discovery-sweep can pass officers
 * straight into linkOfficersToLead without re-fetching.
 */
export { getCompanyOfficers };
