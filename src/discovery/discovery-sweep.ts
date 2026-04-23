import { prisma } from "../utils/prisma.js";
import { getNicheConfig } from "../config/niche.js";
import { discoverBusinesses, DiscoveredBusiness } from "./gemini-discovery.js";
import { checkDuplicate, normalizeBusinessName, extractDomain } from "../utils/dedup.js";
import { validateWebsite } from "../utils/website-validator.js";

const TARGET_NEW = parseInt(process.env.MAX_NEW_LEADS_PER_SWEEP ?? "50", 10);
const MAX_ATTEMPTS = parseInt(process.env.MAX_DISCOVERY_ATTEMPTS ?? "30", 10);
const MAX_RUNTIME_MS = parseInt(process.env.DISCOVERY_MAX_RUNTIME_MS ?? "1500000", 10); // 25 min
const SCAN_COOLDOWN_HOURS = parseInt(process.env.SCAN_COOLDOWN_HOURS ?? "48", 10);
const VALIDATE_WEBSITES = (process.env.VALIDATE_WEBSITES ?? "true").toLowerCase() === "true";

type StopReason = "target_hit" | "attempts_exhausted" | "timeout" | "no_progress";

interface SweepState {
  totalNew: number; totalDiscovered: number; totalDuplicates: number;
  totalSkipped: number; totalInvalidWebsites: number; attempts: number;
  runs: Array<{ query: string; region: string; discovered: number; new: number; phase: number; skipped?: boolean }>;
  startTime: number;
}

function shouldStop(s: SweepState): StopReason | null {
  if (s.totalNew >= TARGET_NEW) return "target_hit";
  if (s.attempts >= MAX_ATTEMPTS) return "attempts_exhausted";
  if (Date.now() - s.startTime >= MAX_RUNTIME_MS) return "timeout";
  return null;
}

/**
 * Single query × region scan. Reads and writes `state` in place.
 */
async function scanQueryRegion(
  query: string,
  region: Awaited<ReturnType<typeof getNicheConfig>>["discoveryRegions"][number],
  state: SweepState,
  phase: number,
): Promise<void> {
  const regionKey = `${region.lat},${region.lng},${region.radiusMeters}`;
  const start = Date.now();
  state.attempts++;

  let scanNew = 0, scanDuplicates = 0, scanInvalidSites = 0;
  let businesses: DiscoveredBusiness[] = [];

  try {
    console.log(`  [phase ${phase}] Scanning: "${query}" in ${region.label}...`);
    const result = await discoverBusinesses(query, region);
    businesses = result.businesses;
    state.totalDiscovered += businesses.length;
    console.log(`    Gemini found ${businesses.length} businesses`);

    for (const biz of businesses) {
      if (state.totalNew >= TARGET_NEW) break;
      if (!biz.businessName?.trim()) continue;

      const dedup = await checkDuplicate({
        businessName: biz.businessName.trim(),
        website: biz.website,
        city: biz.city,
      });
      if (dedup.isDuplicate) {
        console.log(`    DEDUP: "${biz.businessName}" matches "${dedup.matchedBusinessName}" (${dedup.matchType})`);
        scanDuplicates++;
        state.totalDuplicates++;
        continue;
      }

      if (VALIDATE_WEBSITES && biz.website) {
        const validation = await validateWebsite(biz.website);
        if (!validation.valid) {
          console.log(`    INVALID SITE: "${biz.businessName}" — ${validation.reason}`);
          scanInvalidSites++;
          state.totalInvalidWebsites++;
          biz.website = null;
        }
      }

      const normName = normalizeBusinessName(biz.businessName.trim());
      const domain = extractDomain(biz.website);
      await prisma.lead.create({
        data: {
          businessName: biz.businessName.trim(),
          normalizedName: normName,
          websiteDomain: domain,
          city: biz.city,
          country: biz.country,
          websiteUrl: biz.website,
          businessDescription: biz.description,
          ownerName: biz.ownerName,
          status: "new_lead",
          discoverySource: "google_maps",
          discoveryQuery: query,
        },
      });
      scanNew++;
      state.totalNew++;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`    Scan failed: ${msg}`);
    await prisma.errorLog.create({
      data: {
        scenarioName: "S0_Discovery", moduleName: "discovery-sweep",
        errorCode: "SCAN_FAILED", errorMessage: msg.slice(0, 4000), killSwitchFired: false,
      },
    }).catch(() => {});
  }

  await prisma.discoveryRun.create({
    data: {
      source: "google_maps", query, region: regionKey,
      leadsFound: scanNew, totalResults: businesses.length,
      durationMs: Date.now() - start,
    },
  }).catch(() => { console.error("    Failed to record DiscoveryRun"); });

  state.runs.push({ query, region: region.label, discovered: businesses.length, new: scanNew, phase });
  console.log(`    → ${scanNew} new, ${scanDuplicates} dupes, ${scanInvalidSites} invalid (${Date.now() - start}ms) | running total ${state.totalNew}/${TARGET_NEW}`);
}

export async function runDiscoverySweep() {
  const config = getNicheConfig();
  const state: SweepState = {
    totalNew: 0, totalDiscovered: 0, totalDuplicates: 0,
    totalSkipped: 0, totalInvalidWebsites: 0, attempts: 0,
    runs: [], startTime: Date.now(),
  };

  console.log(
    `Discovery sweep: target=${TARGET_NEW}, max attempts=${MAX_ATTEMPTS}, ` +
    `max runtime=${Math.round(MAX_RUNTIME_MS / 60000)}min, ` +
    `queries=${config.discoveryQueries.length}, regions=${config.discoveryRegions.length}`
  );
  console.log(`  Fuzzy dedup: ENABLED | Website validation: ${VALIDATE_WEBSITES ? "ENABLED" : "DISABLED"}`);

  // ── Phase 1: normal pass, respecting cooldown ──
  phase1: for (const query of config.discoveryQueries) {
    for (const region of config.discoveryRegions) {
      const cooldownCutoff = new Date(Date.now() - SCAN_COOLDOWN_HOURS * 3600000);
      const regionKey = `${region.lat},${region.lng},${region.radiusMeters}`;
      const recent = await prisma.discoveryRun.findFirst({
        where: { query, region: regionKey, ranAt: { gte: cooldownCutoff } },
        orderBy: { ranAt: "desc" },
      });
      if (recent) {
        console.log(`  [phase 1] Skipping "${query}" in ${region.label} — scanned ${Math.round((Date.now() - recent.ranAt.getTime()) / 3600000)}h ago`);
        state.runs.push({ query, region: region.label, discovered: 0, new: 0, phase: 1, skipped: true });
        state.totalSkipped++;
        continue;
      }
      await scanQueryRegion(query, region, state, 1);
      if (shouldStop(state)) break phase1;
    }
  }

  // ── Phase 2: bypass cooldown on pairs we haven't hit yet this run ──
  if (!shouldStop(state)) {
    console.log(`Phase 2: ${state.totalNew}/${TARGET_NEW} — bypassing cooldown for missed pairs`);
    phase2: for (const query of config.discoveryQueries) {
      for (const region of config.discoveryRegions) {
        const alreadyScanned = state.runs.some(r =>
          r.phase === 1 && r.query === query && r.region === region.label && !r.skipped
        );
        if (alreadyScanned) continue;
        await scanQueryRegion(query, region, state, 2);
        if (shouldStop(state)) break phase2;
      }
    }
  }

  // ── Phase 3: re-run — Gemini returns different businesses on repeat calls ──
  let iter = 0;
  while (!shouldStop(state)) {
    iter++;
    console.log(`Phase 3 (iter ${iter}): ${state.totalNew}/${TARGET_NEW}`);
    const before = state.totalNew;
    phase3: for (const query of config.discoveryQueries) {
      for (const region of config.discoveryRegions) {
        await scanQueryRegion(query, region, state, 3);
        if (shouldStop(state)) break phase3;
      }
    }
    if (state.totalNew === before) {
      console.log(`Phase 3 iter ${iter} found nothing new — stopping`);
      break;
    }
  }

  const stopReason = shouldStop(state) ?? "no_progress";
  const runtimeS = Math.round((Date.now() - state.startTime) / 1000);
  console.log(
    `Discovery complete: ${state.totalNew}/${TARGET_NEW} new, ` +
    `${state.totalDuplicates} dupes, ${state.totalInvalidWebsites} invalid, ` +
    `${state.attempts} attempts, ${runtimeS}s. Reason: ${stopReason}`
  );

  return {
    totalScans: state.runs.length,
    totalDiscovered: state.totalDiscovered,
    totalNew: state.totalNew,
    totalDuplicates: state.totalDuplicates,
    totalSkipped: state.totalSkipped,
    totalInvalidWebsites: state.totalInvalidWebsites,
    attempts: state.attempts,
    stopReason,
    runtimeS,
    runs: state.runs,
  };
}

const isDirectExecution = process.argv[1]?.includes("discovery-sweep");
if (isDirectExecution) {
  runDiscoverySweep().then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
    .catch((err) => { console.error("Fatal:", err); process.exit(1); });
}
