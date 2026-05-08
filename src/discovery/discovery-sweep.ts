import { prisma } from "../utils/prisma.js";
import { getNicheConfig } from "../config/niche.js";
import {
  checkDuplicate,
  normalizeBusinessName,
  extractDomain,
  normalizePhoneE164,
} from "../utils/dedup.js";
import { validateWebsite } from "../utils/website-validator.js";
import {
  discoverFromCompaniesHouse,
  linkOfficersToLead,
  getCompanyOfficers,
} from "./companies-house-discovery.js";
import { discoverFromPlaces } from "./places-discovery.js";
import { buildCompanyFactsBlock } from "../utils/ch-signals.js";

const TARGET_NEW = parseInt(process.env.MAX_NEW_LEADS_PER_SWEEP ?? "50", 10);
const MAX_ATTEMPTS = parseInt(process.env.MAX_DISCOVERY_ATTEMPTS ?? "30", 10);
const MAX_RUNTIME_MS = parseInt(process.env.DISCOVERY_MAX_RUNTIME_MS ?? "1500000", 10);
const SCAN_COOLDOWN_HOURS = parseInt(process.env.SCAN_COOLDOWN_HOURS ?? "48", 10);
const VALIDATE_WEBSITES = (process.env.VALIDATE_WEBSITES ?? "true").toLowerCase() === "true";
const USE_PLACES_FALLBACK = (process.env.DISCOVERY_USE_PLACES_FALLBACK ?? "true").toLowerCase() === "true";
const MAX_CONSECUTIVE_ZERO_YIELD = parseInt(process.env.CH_MAX_CONSECUTIVE_ZERO_YIELD ?? "3", 10);

type StopReason = "target_hit" | "attempts_exhausted" | "timeout" | "no_progress";
interface SweepState {
  totalNew: number;
  totalDiscovered: number;
  totalDuplicates: number;
  totalSkipped: number;
  totalInvalidWebsites: number;
  totalRejectedFinancialStanding: number;
  totalRejectedProfileFetchFailed: number;
  totalRejectedDormant: number;
  totalRejectedInsolvency: number;
  totalRejectedOverdue: number;
  totalRejectedAccountsCategory: number;
  totalRejectedNoAccountsCategory: number;
  totalRejectedStatusInactive: number;
  totalRejectedHardExclude: number;

  totalRejectedPreScore: number;
  totalRejectedNomineeAddress: number;
  totalFlaggedSubsidiary: number;

  consecutiveZeroYieldScans: number;
  attempts: number;
  runs: Array<{
    source: string;
    location: string;
    discovered: number;
    new: number;
    skipped?: boolean;
  }>;
  startTime: number;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function shouldStop(s: SweepState): StopReason | null {
  if (s.totalNew >= TARGET_NEW) return "target_hit";
  if (s.attempts >= MAX_ATTEMPTS) return "attempts_exhausted";
  if (Date.now() - s.startTime >= MAX_RUNTIME_MS) return "timeout";
  if (s.consecutiveZeroYieldScans >= MAX_CONSECUTIVE_ZERO_YIELD) return "consecutive_zero_yield";
  return null;
}

async function scanCompaniesHouse(
  location: string,
  sicCodes: string[],
  incorporatedBefore: string,
  state: SweepState,
): Promise<void> {
  state.attempts++;
  const start = Date.now();
  console.log(`  [CH] Scanning ${location} (${sicCodes.length} SIC codes, incorporated before ${incorporatedBefore})...`);

  let scanNew = 0, scanDuplicates = 0;

  try {
    const cooldownCutoff = new Date(Date.now() - SCAN_COOLDOWN_HOURS * 3600_000);
    const recent = await prisma.discoveryRun.findFirst({
      where: {
        source: "companies_house",
        query: sicCodes.join(","),
        region: location,
        ranAt: { gte: cooldownCutoff },
      },
      orderBy: { ranAt: "desc" },
    });
    if (recent) {
      console.log(`    Skipping CH/${location} — scanned ${Math.round((Date.now() - recent.ranAt.getTime()) / 3600_000)}h ago`);
      state.runs.push({ source: "companies_house", location, discovered: 0, new: 0, skipped: true });
      state.totalSkipped++;
      return;
    }

    const result = await discoverFromCompaniesHouse({ location, sicCodes, incorporatedBefore });
    state.totalDiscovered += result.businesses.length;
    state.totalRejectedFinancialStanding += result.rejectedFinancialStanding;
    state.totalRejectedProfileFetchFailed += result.rejectedProfileFetchFailed;
    state.totalRejectedDormant += result.rejectedDormant;
    state.totalRejectedInsolvency += result.rejectedInsolvency;
    state.totalRejectedOverdue += result.rejectedOverdue;
    state.totalRejectedAccountsCategory += result.rejectedAccountsCategory;
    state.totalRejectedNoAccountsCategory += result.rejectedNoAccountsCategory;
    state.totalRejectedStatusInactive += result.rejectedStatusInactive;
    state.totalRejectedHardExclude += result.rejectedHardExclude;
    state.totalRejectedPreScore += result.rejectedPreScore;
    state.totalRejectedNomineeAddress += result.rejectedNomineeAddress;
    state.totalFlaggedSubsidiary += result.flaggedSubsidiary;
    console.log(
      `    CH found ${result.businesses.length} qualifying ` +
      `(rejected: profile-fetch=${result.rejectedProfileFetchFailed}, ` +
      `dormant=${result.rejectedDormant}, insolvency=${result.rejectedInsolvency}, ` +
      `overdue=${result.rejectedOverdue}, accounts-cat=${result.rejectedAccountsCategory}, ` +
      `no-accounts-cat=${result.rejectedNoAccountsCategory}, status=${result.rejectedStatusInactive}, ` +
      `hard-exclude=${result.rejectedHardExclude}, pre-score=${result.rejectedPreScore}, ` +
      `nominee=${result.rejectedNomineeAddress}, subsidiary-flagged=${result.flaggedSubsidiary})`,
    );

    for (const biz of result.businesses) {
      if (state.totalNew >= TARGET_NEW) break;

      const dedup = await checkDuplicate({
        businessName: biz.businessName,
        city: biz.city,
        outwardPostcode: biz.outwardPostcode,
        companiesHouseNumber: biz.companiesHouseNumber,
      });
      if (dedup.isDuplicate) {
        scanDuplicates++;
        state.totalDuplicates++;
        continue;
      }

      const sig = biz.signals;
      const acc = biz.accounts;

      const factsBlock = sig
        ? buildCompanyFactsBlock({
            businessName: biz.businessName,
            companiesHouseNumber: biz.companiesHouseNumber,
            incorporatedOn: biz.incorporatedOn,
            accountsCategory: biz.accountsCategory,
            sicCodes: biz.sicCodes,
            signals: sig,
            accounts: acc,
            vatRegistered: null,
            vatNumber: null,
          })
        : null;

      const turnoverGrowthPct =
        acc?.turnover != null && acc?.priorTurnover != null && acc.priorTurnover > 0n
          ? (Number(acc.turnover) - Number(acc.priorTurnover)) / Number(acc.priorTurnover)
          : null;
      const employeeGrowthPct =
        acc?.employeeCount != null && acc?.priorEmployeeCount != null && acc.priorEmployeeCount > 0
          ? (acc.employeeCount - acc.priorEmployeeCount) / acc.priorEmployeeCount
          : null;

      const created = await prisma.lead.create({
        data: {
          businessName: biz.businessName,
          normalizedName: normalizeBusinessName(biz.businessName),
          city: biz.city,
          country: biz.country,
          address: biz.address,
          outwardPostcode: biz.outwardPostcode,
          companiesHouseNumber: biz.companiesHouseNumber,
          sicCodes: biz.sicCodes,
          accountsCategory: biz.accountsCategory,
          incorporatedOn: biz.incorporatedOn,
          companyStatus: biz.companyStatus,
          discoverySource: "companies_house",
          discoveryQuery: sicCodes.join(","),
          ownerName: biz.ownerName,
          // CH-derived signals
          accountsLastMadeUpTo: sig?.accountsLastMadeUpTo ?? null,
          accountsNextDue: sig?.accountsNextDue ?? null,
          confirmationNextDue: sig?.confirmationNextDue ?? null,
          directorCount: sig?.directorCount ?? null,
          earliestDirectorAppointedOn: sig?.earliestDirectorAppointedOn ?? null,
          latestDirectorAppointedOn: sig?.latestDirectorAppointedOn ?? null,
          activeChargesCount: sig?.activeChargesCount ?? null,
          recentChargeCreatedOn: sig?.recentChargeCreatedOn ?? null,
          registeredOfficeMovedOn: sig?.registeredOfficeMovedOn ?? null,
          pscCount: sig?.pscCount ?? null,
          // Latest filed financials
          latestTurnover: acc?.turnover ?? null,
          latestEmployeeCount: acc?.employeeCount ?? null,
          priorYearTurnover: acc?.priorTurnover ?? null,
          priorYearEmployeeCount: acc?.priorEmployeeCount ?? null,
          turnoverGrowthPct,
          employeeGrowthPct,
          latestAccountsMadeUpTo: acc?.madeUpTo ?? null,
          latestProfitLoss: acc?.profitLoss ?? null,
          // Composite pre-score
          chPreScore: sig?.preScore ?? null,
          chSignals: sig?.signals ?? [],
          companyFactsBlock: factsBlock,
          // Send-window
          nextOutreachWindow: biz.nextOutreachWindow,
          nextOutreachWindowReason: biz.nextOutreachWindowReason,
          // Tier-5 audit fields
          lastAccountsType: biz.lastAccountsType,
          nomineeAddress: biz.nomineeAddress,
          subsidiaryOfLeadId: biz.subsidiaryOfLeadId,
          corporatePscCount: biz.corporatePscCount,
          recentNameChangeCount: biz.recentNameChangeCount,
          // Subsidiaries that survive the policy land in `needs_review` so
          // an operator picks whether to pitch the parent or the entity.
          status: biz.subsidiaryOfLeadId ? "needs_review" : "new_lead",
          notes: biz.subsidiaryOfLeadId
            ? `Likely subsidiary of lead ${biz.subsidiaryOfLeadId} — same registered office and overlapping directors. Consider pitching the parent instead.`
            : null,
        },
      });

      // Director graph: link officers we already fetched during enrichment.
      // We re-fetch from cache (free hit) rather than threading the array
      // through return shapes; the cache TTL is 24h so this is essentially
      // a single additional in-process call.
      try {
        const officers = await getCompanyOfficers(biz.companiesHouseNumber);
        if (officers?.items) {
          await linkOfficersToLead(created.id, officers.items);
        }
      } catch { /* best-effort */ }

      scanNew++;
      state.totalNew++;
    }

    await prisma.discoveryRun.create({
      data: {
        source: "companies_house",
        query: sicCodes.join(","),
        region: location,
        leadsFound: scanNew,
        totalResults: result.businesses.length,
        durationMs: Date.now() - start,
      },
    }).catch(() => { /* best-effort */ });

    state.runs.push({ source: "companies_house", location, discovered: result.businesses.length, new: scanNew });
    if (scanNew === 0) {
      state.consecutiveZeroYieldScans++;
    } else {
      state.consecutiveZeroYieldScans = 0;
    }
    console.log(
      `    → ${scanNew} new, ${scanDuplicates} dupes (${Date.now() - start}ms) | ` +
      `running total ${state.totalNew}/${TARGET_NEW}` +
      (state.consecutiveZeroYieldScans > 0 ? ` | zero-yield streak: ${state.consecutiveZeroYieldScans}/${MAX_CONSECUTIVE_ZERO_YIELD}` : "")
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`    CH scan failed: ${msg}`);
    await prisma.errorLog.create({
      data: {
        scenarioName: "S0_Discovery", moduleName: "discovery-sweep",
        errorCode: "CH_SCAN_FAILED", errorMessage: msg.slice(0, 4000), killSwitchFired: false,
      },
    }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Google Places scan (fallback — sole traders / partnerships not on CH)
// ---------------------------------------------------------------------------

async function scanPlaces(
  query: string,
  region: ReturnType<typeof getNicheConfig>["discoveryRegions"][number],
  state: SweepState,
): Promise<void> {
  state.attempts++;
  const start = Date.now();
  const regionKey = `${region.lat},${region.lng},${region.radiusMeters}`;
  console.log(`  [Places] "${query}" in ${region.label}...`);

  let scanNew = 0, scanDuplicates = 0, scanInvalidSites = 0;

  try {
    const result = await discoverFromPlaces({
      query,
      locationBias: { lat: region.lat, lng: region.lng, radiusMeters: region.radiusMeters },
    });
    state.totalDiscovered += result.businesses.length;
    console.log(`    Places found ${result.businesses.length} businesses`);

    for (const biz of result.businesses) {
      if (state.totalNew >= TARGET_NEW) break;
      if (!biz.businessName?.trim()) continue;

      const dedup = await checkDuplicate({
        businessName: biz.businessName,
        website: biz.website,
        city: biz.city,
        phone: biz.phone,
        outwardPostcode: biz.outwardPostcode,
        address: biz.address,
        googlePlaceId: biz.googlePlaceId,
      });
      if (dedup.isDuplicate) {
        scanDuplicates++;
        state.totalDuplicates++;
        continue;
      }

      let website: string | null = biz.website;
      if (VALIDATE_WEBSITES && website) {
        const validation = await validateWebsite(website);
        if (!validation.valid) {
          scanInvalidSites++;
          state.totalInvalidWebsites++;
          website = null;
        }
      }

      await prisma.lead.create({
        data: {
          businessName: biz.businessName,
          normalizedName: normalizeBusinessName(biz.businessName),
          websiteDomain: extractDomain(website),
          websiteUrl: website,
          city: biz.city,
          country: biz.country,
          address: biz.address,
          outwardPostcode: biz.outwardPostcode,
          phone: biz.phone,
          phoneE164: normalizePhoneE164(biz.phone),
          googlePlaceId: biz.googlePlaceId,
          googleRating: biz.rating,
          status: "new_lead",
          discoverySource: "google_places",
          discoveryQuery: query,
        },
      });
      scanNew++;
      state.totalNew++;
    }

    await prisma.discoveryRun.create({
      data: {
        source: "google_places",
        query,
        region: regionKey,
        leadsFound: scanNew,
        totalResults: result.businesses.length,
        durationMs: Date.now() - start,
      },
    }).catch(() => { /* best-effort */ });

    state.runs.push({ source: "google_places", location: region.label, discovered: result.businesses.length, new: scanNew });
    console.log(`    → ${scanNew} new, ${scanDuplicates} dupes, ${scanInvalidSites} invalid (${Date.now() - start}ms) | running total ${state.totalNew}/${TARGET_NEW}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`    Places scan failed: ${msg}`);
    await prisma.errorLog.create({
      data: {
        scenarioName: "S0_Discovery", moduleName: "discovery-sweep",
        errorCode: "PLACES_SCAN_FAILED", errorMessage: msg.slice(0, 4000), killSwitchFired: false,
      },
    }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export async function runDiscoverySweep() {
  const config = getNicheConfig();
  const state: SweepState = {
    totalNew: 0, totalDiscovered: 0, totalDuplicates: 0,
    totalSkipped: 0, totalInvalidWebsites: 0,
    totalRejectedFinancialStanding: 0,
    totalRejectedProfileFetchFailed: 0,
    totalRejectedDormant: 0,
    totalRejectedInsolvency: 0,
    totalRejectedOverdue: 0,
    totalRejectedAccountsCategory: 0,
    totalRejectedNoAccountsCategory: 0,
    totalRejectedStatusInactive: 0,
    totalRejectedHardExclude: 0,
    totalRejectedPreScore: 0,
    totalRejectedNomineeAddress: 0,
    totalFlaggedSubsidiary: 0,
    consecutiveZeroYieldScans: 0,
    attempts: 0, runs: [], startTime: Date.now(),
  };

  const sicCodes = (process.env.COMPANIES_HOUSE_SIC_CODES ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const locations = (process.env.COMPANIES_HOUSE_LOCATIONS ?? "")
    .split(";").map((s) => s.trim()).filter(Boolean);
  const incorporatedBefore = process.env.COMPANIES_HOUSE_INCORPORATED_BEFORE ?? "2023-01-01";

  console.log(
    `Discovery sweep: target=${TARGET_NEW}, max attempts=${MAX_ATTEMPTS}, ` +
    `max runtime=${Math.round(MAX_RUNTIME_MS / 60_000)}min`
  );
  console.log(`  Primary: Companies House — ${locations.length} locations × ${sicCodes.length} SIC codes`);
  console.log(`  Fallback: Google Places — ${USE_PLACES_FALLBACK ? "ENABLED" : "DISABLED"}`);
  console.log(`  Website validation: ${VALIDATE_WEBSITES ? "ENABLED" : "DISABLED"}`);

  if (sicCodes.length === 0 || locations.length === 0) {
  console.warn("  Skipping CH phase — COMPANIES_HOUSE_SIC_CODES or COMPANIES_HOUSE_LOCATIONS unset");
} else {
  const shuffledLocations = shuffle(locations);
  console.log(`  CH plan: ${shuffledLocations.length} locations × ${sicCodes.length} SICs (batched), randomised location order`);

  phase1: for (const location of shuffledLocations) {
    await scanCompaniesHouse(location, shuffle(sicCodes), incorporatedBefore, state);
    if (shouldStop(state)) break phase1;
  }
}

  if (USE_PLACES_FALLBACK && !shouldStop(state)) {
  console.log(`Phase 2: ${state.totalNew}/${TARGET_NEW} — Places fallback`);
  const placesPairs = shuffle(
    config.discoveryQueries.flatMap((query) =>
      config.discoveryRegions.map((region) => ({ query, region }))
    )
  );
  phase2: for (const { query, region } of placesPairs) {
    await scanPlaces(query, region, state);
    if (shouldStop(state)) break phase2;
  }
}

  const stopReason = shouldStop(state) ?? "completed";
  const durationMin = Math.round((Date.now() - state.startTime) / 60_000);

  console.log(
    `Discovery sweep complete: ${state.totalNew} new, ` +
    `${state.totalDuplicates} duplicates, ${state.totalSkipped} skipped, ` +
    `${state.totalInvalidWebsites} invalid sites, ` +
    `${state.attempts} attempts, ${durationMin}min, stop=${stopReason}`
  );
  console.log(
    `  Rejection breakdown: ` +
    `profile-fetch=${state.totalRejectedProfileFetchFailed}, ` +
    `dormant=${state.totalRejectedDormant}, ` +
    `insolvency=${state.totalRejectedInsolvency}, ` +
    `overdue=${state.totalRejectedOverdue}, ` +
    `accounts-cat=${state.totalRejectedAccountsCategory}, ` +
    `no-accounts-cat=${state.totalRejectedNoAccountsCategory}, ` +
    `status=${state.totalRejectedStatusInactive}, ` +
    `hard-exclude=${state.totalRejectedHardExclude}, ` +
    `pre-score=${state.totalRejectedPreScore}, ` +
    `nominee=${state.totalRejectedNomineeAddress}`
  );

  return {
    new: state.totalNew,
    discovered: state.totalDiscovered,
    duplicates: state.totalDuplicates,
    skipped: state.totalSkipped,
    invalidWebsites: state.totalInvalidWebsites,
    rejectedFinancialStanding: state.totalRejectedFinancialStanding,
    rejectedPreScore: state.totalRejectedPreScore,
    rejectedNomineeAddress: state.totalRejectedNomineeAddress,
    flaggedSubsidiary: state.totalFlaggedSubsidiary,
    attempts: state.attempts,
    durationMs: Date.now() - state.startTime,
    stopReason,
    runs: state.runs,
  };
}

const isDirectExecution = process.argv[1]?.includes("discovery-sweep");
if (isDirectExecution) {
  runDiscoverySweep().then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
    .catch((err) => { console.error("Fatal:", err); process.exit(1); });
}
