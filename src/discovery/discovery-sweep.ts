import { prisma } from "../utils/prisma.js";
import { getNicheConfig } from "../config/niche.js";
import { discoverBusinesses, DiscoveredBusiness } from "./gemini-discovery.js";
import { checkDuplicate, normalizeBusinessName, extractDomain } from "../utils/dedup.js";
import { validateWebsite } from "../utils/website-validator.js";

const MAX_NEW = parseInt(process.env.MAX_NEW_LEADS_PER_SWEEP ?? "50", 10);

// Minimum hours between scanning the same query+region pair
const SCAN_COOLDOWN_HOURS = parseInt(process.env.SCAN_COOLDOWN_HOURS ?? "48", 10);

// Skip website validation entirely if disabled (saves time in dev/testing)
const VALIDATE_WEBSITES = (process.env.VALIDATE_WEBSITES ?? "true").toLowerCase() === "true";

export async function runDiscoverySweep(): Promise<{
  totalScans: number;
  totalDiscovered: number;
  totalNew: number;
  totalDuplicates: number;
  totalSkipped: number;
  totalInvalidWebsites: number;
  runs: Array<{ query: string; region: string; discovered: number; new: number; skipped?: boolean }>;
}> {
  const config = getNicheConfig();
  const runs: Array<{ query: string; region: string; discovered: number; new: number; skipped?: boolean }> = [];
  let totalNew = 0;
  let totalDiscovered = 0;
  let totalSkipped = 0;
  let totalInvalidWebsites = 0;
  let totalDuplicates = 0;
  let hitCap = false;

  console.log(`Discovery sweep: ${config.discoveryQueries.length} queries × ${config.discoveryRegions.length} regions`);
  console.log(`  Fuzzy dedup: ENABLED | Website validation: ${VALIDATE_WEBSITES ? "ENABLED" : "DISABLED"}`);

  for (const query of config.discoveryQueries) {
    if (hitCap) break;

    for (const region of config.discoveryRegions) {
      if (hitCap) break;

      const regionKey = `${region.lat},${region.lng},${region.radiusMeters}`;

      // ── Rotation check: skip if we scanned this pair recently ──
      const cooldownCutoff = new Date(Date.now() - SCAN_COOLDOWN_HOURS * 60 * 60 * 1000);
      const recentRun = await prisma.discoveryRun.findFirst({
        where: {
          query,
          region: regionKey,
          ranAt: { gte: cooldownCutoff },
        },
        orderBy: { ranAt: "desc" },
      });

      if (recentRun) {
        console.log(`  Skipping "${query}" in ${region.label} — scanned ${Math.round((Date.now() - recentRun.ranAt.getTime()) / 3600000)}h ago`);
        runs.push({ query, region: region.label, discovered: 0, new: 0, skipped: true });
        totalSkipped++;
        continue;
      }

      const start = Date.now();
      let scanNew = 0;
      let scanDuplicates = 0;
      let scanInvalidSites = 0;
      let businesses: DiscoveredBusiness[] = [];

      try {
        console.log(`  Scanning: "${query}" in ${region.label}...`);
        const result = await discoverBusinesses(query, region);
        businesses = result.businesses;
        totalDiscovered += businesses.length;
        console.log(`    Gemini found ${businesses.length} businesses`);

        for (const biz of businesses) {
          if (totalNew >= MAX_NEW) { hitCap = true; break; }
          if (!biz.businessName?.trim()) continue;

          // ── Fuzzy dedup check ──
          const dedup = await checkDuplicate({
            businessName: biz.businessName.trim(),
            website: biz.website,
            city: biz.city,
          });

          if (dedup.isDuplicate) {
            console.log(`    DEDUP: "${biz.businessName}" matches "${dedup.matchedBusinessName}" (${dedup.matchType}, sim=${dedup.similarity?.toFixed(2) ?? "1.00"})`);
            scanDuplicates++;
            totalDuplicates++;
            continue;
          }

          // ── Website validation ──
          if (VALIDATE_WEBSITES && biz.website) {
            const validation = await validateWebsite(biz.website);
            if (!validation.valid) {
              console.log(`    INVALID SITE: "${biz.businessName}" — ${validation.reason} (${validation.responseTimeMs}ms)`);
              scanInvalidSites++;
              totalInvalidWebsites++;
              // Still create the lead but without the website — the orchestrator
              // research step will try to find the real one
              biz.website = null;
            }
          }

          // ── Create lead with dedup fields ──
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
          totalNew++;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`    Scan failed: ${message}`);
        try {
          await prisma.errorLog.create({
            data: {
              scenarioName: "S0_Discovery",
              moduleName: "discovery-sweep",
              errorCode: "SCAN_FAILED",
              errorMessage: message.slice(0, 4000),
              killSwitchFired: false,
            },
          });
        } catch { /* swallow */ }
      }

      // Record audit trail
      try {
        await prisma.discoveryRun.create({
          data: {
            source: "google_maps",
            query,
            region: regionKey,
            leadsFound: scanNew,
            totalResults: businesses.length,
            durationMs: Date.now() - start,
          },
        });
      } catch { console.error("    Failed to record DiscoveryRun"); }

      runs.push({ query, region: region.label, discovered: businesses.length, new: scanNew });
      console.log(`    → ${scanNew} new, ${scanDuplicates} dupes, ${scanInvalidSites} invalid sites (${Date.now() - start}ms)`);
    }
  }

  console.log(`\nDiscovery complete: ${totalDiscovered} found, ${totalNew} new, ${totalDuplicates} duplicates, ${totalInvalidWebsites} invalid sites, ${totalSkipped} skipped (cooldown)`);
  return { totalScans: runs.length, totalDiscovered, totalNew, totalDuplicates, totalSkipped, totalInvalidWebsites, runs };
}

const isDirectExecution = process.argv[1]?.includes("discovery-sweep");
if (isDirectExecution) {
  runDiscoverySweep().then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(0); }).catch((err) => { console.error("Fatal:", err); process.exit(1); });
}
