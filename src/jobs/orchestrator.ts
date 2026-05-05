import { prisma } from "../utils/prisma.js";
import { EmailService } from "../services/email.service.js";
import { BotService } from "../services/bot.service.js";
import { AIService } from "../services/ai.service.js";
import { getNicheConfig } from "../config/niche.js";
import { logError } from "../utils/logger.js";
import { verifyEmail } from "../verification/email-verifier.js";
import { checkDuplicate, normalizeEmail, normalizePhoneE164 } from "../utils/dedup.js";
import { scrapeBusinessWebsiteV2 } from "../services/website-scraper-v2.js";
import { draftOutreachEmail } from "../services/outreach-drafter.js";
import { getConfig } from "../services/runtime-config.service.js";
import { countSendsToday } from "../services/send-recorder.js";
import { extractVrnFromText, checkVatNumber } from "../utils/vat-check.js";
import { buildCompanyFactsBlock, type ChSignalSummary } from "../utils/ch-signals.js";
import type { ParsedAccounts } from "../utils/ixbrl-parser.js";

const STALE_LOCK_MINUTES = parseInt(process.env.ENRICHMENT_LOCK_TTL_MIN ?? "30", 10);
const PER_LEAD_TIMEOUT_MS = parseInt(process.env.ORCHESTRATOR_PER_LEAD_TIMEOUT_MS ?? "180000", 10);

const email = new EmailService();
const bot = new BotService();
const ai = new AIService();

export async function runOrchestrator() {
const config = getNicheConfig();
const results = [];
const batch = await getConfig<number>("ORCHESTRATOR_BATCH_SIZE");
const tier1Threshold = await getConfig<number>("TIER1_THRESHOLD");
const tier2Threshold = await getConfig<number>("TIER2_THRESHOLD");
const verificationThreshold = await getConfig<number>("VERIFICATION_THRESHOLD");
const dailyCap = await getConfig<number>("DAILY_SEND_CAP");

if (dailyCap > 0) {
  const sentToday =
    (await countSendsToday("outreach")) +
    (await countSendsToday("follow_up")) +
    (await countSendsToday("goodbye"));
  if (sentToday >= dailyCap) {
    console.log(`Orchestrator: daily cap reached (${sentToday}/${dailyCap}) — skipping this run.`);
    return { processed: 0, results: [], skipped: "daily_cap" };
  }
}

// ── Stale-lock recovery — release locks left behind by crashed runs ──
const staleCutoff = new Date(Date.now() - STALE_LOCK_MINUTES * 60_000);

// 1. Release stale locks
const released = await prisma.lead.updateMany({
  where: {
    enrichmentLock: true,
    OR: [
      { enrichmentLockedAt: { lt: staleCutoff } },
      { enrichmentLockedAt: null },
    ],
  },
  data: { enrichmentLock: false, enrichmentLockedAt: null },
});
if (released.count > 0) {
  console.log(`Orchestrator: released ${released.count} stale enrichment lock(s).`);
}
const recovered = await prisma.lead.updateMany({
  where: {
    status: { in: ["enriching", "verifying"] },
    enrichmentLock: false,
    updatedAt: { lt: staleCutoff },
  },
  data: { status: "new_lead" },
});
if (recovered.count > 0) {
  console.log(`Orchestrator: recovered ${recovered.count} orphaned lead(s) → new_lead.`);
}

const now = new Date();
const leads = await prisma.lead.findMany({
  where: {
    status: "new_lead",
    enrichmentLock: false,
    // Send-window gate: process if no window or window has opened.
    OR: [
      { nextOutreachWindow: null },
      { nextOutreachWindow: { lte: now } },
    ],
  },
  // Tier 3 ranking: highest CH pre-score first, then oldest discovery date.
  // Leads with no pre-score sort last (treated as 0).
  orderBy: [
    { chPreScore: { sort: "desc", nulls: "last" } },
    { createdAt: "asc" },
  ],
  take: batch,
});

if (leads.length === 0) {
  console.log("Orchestrator: no new leads to process.");
  return { processed: 0, results: [] };
}

console.log(`Orchestrator: processing ${leads.length} leads…`);

for (const lead of leads) {
    try {
      const acquired = await prisma.lead.updateMany({
        where: {
          id: lead.id,
          status: "new_lead",
          enrichmentLock: false,
        },
        data: {
          enrichmentLock: true,
          enrichmentLockedAt: new Date(),
          status: "enriching",
        },
      });
      if (acquired.count === 0) {
        console.log(`\n[${lead.businessName}] skipped — already locked by another runner.`);
        results.push({ leadId: lead.id, businessName: lead.businessName, outcome: "skipped_locked" });
        continue;
      }

console.log(`\n[${lead.businessName}]${lead.chPreScore != null ? ` chPreScore=${lead.chPreScore}` : ""}`);
      
console.log("  [1/8] Researching...");
const research = await withLeadTimeout(
  ai.runResearch(lead.businessName, lead.city ?? "", lead.websiteUrl ?? undefined),
  PER_LEAD_TIMEOUT_MS,
  `research:${lead.businessName}`,
);

const authoritativeOwner = lead.ownerName;

const resolvedWebsite = research.website ?? lead.websiteUrl ?? null;

let scrape: Awaited<ReturnType<typeof scrapeBusinessWebsiteV2>> | null = null;
let scrapeOutcome: "ok" | "empty" | "failed" | "skipped" = "skipped";

if (resolvedWebsite) {
  console.log("  [2/8] Scraping website...");
  try {
    scrape = await withLeadTimeout(
      scrapeBusinessWebsiteV2(resolvedWebsite, lead.businessName, lead.city ?? undefined),
      PER_LEAD_TIMEOUT_MS,
      `scrape:${lead.businessName}`,
    );
    scrapeOutcome = scrape?.email ? "ok" : "empty";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  Scrape failed: ${msg.slice(0, 120)} — continuing without scrape.`);
    scrapeOutcome = "failed";
  }
}

const mergedEmail =
  scrape?.email ?? research.email ?? lead.email ?? null;
const mergedPhone =
  scrape?.phone ?? research.phone ?? lead.phone ?? null;
const mergedPhoneE164 =
  scrape?.phone_e164 ?? normalizePhoneE164(mergedPhone);
const mergedOwner =
  authoritativeOwner ?? scrape?.owner_name ?? research.owner_name ?? lead.ownerName;
const mergedDescription =
  scrape?.description ?? research.description ?? lead.businessDescription;

const emailNormalized = normalizeEmail(mergedEmail);
const phoneE164 = normalizePhoneE164(mergedPhone);

await prisma.lead.update({
  where: { id: lead.id },
  data: {
    geminiResearchJson: research as any,
    ownerName: mergedOwner,
    email: emailNormalized,
    phone: mergedPhone,
    phoneE164: mergedPhoneE164,
    instagram: scrape?.instagram ?? (research as any).instagram ?? lead.instagram,
    linkedin: scrape?.linkedin ?? research.linkedin ?? lead.linkedin,
    websiteUrl: resolvedWebsite,
    businessDescription: mergedDescription,
  },
});

const SCRAPE_MAX_ATTEMPTS = 3;

if (!emailNormalized) {
  let outcome: string;
  let nextStatus: "exclude" | "new_lead";
  let nextScrapeAttempts = lead.scrapeAttempts ?? 0;

  if (!resolvedWebsite) {
    outcome = "no_email_no_website";
    nextStatus = "exclude";
  } else if (scrapeOutcome === "failed") {
    nextScrapeAttempts += 1;
    if (nextScrapeAttempts >= SCRAPE_MAX_ATTEMPTS) {
      outcome = "no_email_scrape_failed_max_retries";
      nextStatus = "exclude";
    } else {
      outcome = "no_email_scrape_failed";
      nextStatus = "new_lead";
    }
  } else {
    outcome = "no_email_scrape_empty";
    nextStatus = "exclude";
  }

  console.log(`  No email after research+scrape → ${outcome} (status=${nextStatus}, attempts=${nextScrapeAttempts}).`);
  await prisma.lead.update({
    where: { id: lead.id },
    data: {
      status: nextStatus,
      enrichmentLock: false,
      scrapeAttempts: nextScrapeAttempts,
    },
  });
  results.push({ leadId: lead.id, businessName: lead.businessName, outcome });
  continue;
}
      
  const postResearchDedup = await checkDuplicate({
    businessName: lead.businessName,
    website: resolvedWebsite,
    city: lead.city,
    phone: mergedPhone,
    email: emailNormalized,
    address: lead.address,
    outwardPostcode: lead.outwardPostcode,
    companiesHouseNumber: lead.companiesHouseNumber,
    excludeLeadId: lead.id,
  });
      if (postResearchDedup.isDuplicate) {
        console.log(
          `  Duplicate of "${postResearchDedup.matchedBusinessName}" ` +
          `via ${postResearchDedup.matchType} — excluding.`
        );
        await prisma.lead.update({
          where: { id: lead.id },
          data: {
            status: "exclude",
            enrichmentLock: false,
            notes: `Duplicate of lead ${postResearchDedup.matchedLeadId} ` +
              `(${postResearchDedup.matchType}, sim=${postResearchDedup.similarity?.toFixed(2) ?? "1.00"})`,
          },
        });
        results.push({
          leadId: lead.id,
          businessName: lead.businessName,
          outcome: `duplicate_${postResearchDedup.matchType}`,
        });
        continue;
      }

      // =====================================================================
      // STEP 3: Email Verification
      // =====================================================================
      console.log("  [2/7] Verifying email...");
      await prisma.lead.update({ where: { id: lead.id }, data: { status: "verifying" } });

      const verification = await verifyEmail(emailNormalized);
      const threshold = verificationThreshold;

      await prisma.lead.update({
        where: { id: lead.id },
        data: {
          emailVerified: verification.verificationScore >= threshold,
          emailVerifiedAt: new Date(),
          mxValid: verification.mxValid,
          smtpValid: verification.smtpValid,
          isCatchAll: verification.isCatchAll,
          verificationScore: verification.verificationScore,
        },
      });

      if (verification.verificationScore < threshold) {
        console.log(`  Verification score ${verification.verificationScore} < ${threshold} — failing.`);
        await prisma.lead.update({
          where: { id: lead.id },
          data: { status: "verification_failed", enrichmentLock: false },
        });
        results.push({ leadId: lead.id, businessName: lead.businessName, outcome: "verification_failed" });
        continue;
      }
      console.log(`  [3/7] Verified: ${verification.verificationScore}/100`);

console.log("  [4/8] Scoring...");
const scoringLead = await prisma.lead.findUnique({ where: { id: lead.id } });
const scoringFacts = scoringLead?.companyFactsBlock
  ?? (scoringLead ? buildCompanyFactsBlockFromLead(scoringLead) : null);
const scoringInput = {
  ...research,
  owner_name: mergedOwner ?? research.owner_name,
  description: mergedDescription ?? research.description,
  website: resolvedWebsite ?? research.website,
  scraped_services: scrape?.services ?? null,
  scraped_positioning: scrape?.positioning ?? null,
  scraped_clientele: scrape?.clientele ?? null,
  scraped_location: scrape?.location ?? null,
  scraped_address: scrape?.address ?? null,
  scraped_people: scrape?.people ?? null,
  scrape_confidence: scrape?.confidence ?? null,
};

const scoring = await ai.scoreBrandFit(scoringInput, scoringFacts);

      // Enforce tier thresholds from config
      let tier: "Tier1" | "Tier2" | "Exclude";
      if (scoring.brand_fit_score >= tier1Threshold) {
tier = "Tier1";
} else if (scoring.brand_fit_score >= tier2Threshold) {
tier = "Tier2";
} else {
        tier = "Exclude";
      }

      await prisma.lead.update({
        where: { id: lead.id },
        data: {
          brandFitScore: scoring.brand_fit_score,
          brandFitRationale: scoring.brand_fit_rationale,
          tier,
        },
      });
      console.log(`  Score: ${scoring.brand_fit_score}/100 → ${tier} (AI suggested: ${scoring.recommended_tier})`);

      console.log("  [6/8] Drafting email...");

let vatNumber = lead.vatNumber;
let vatRegistered = lead.vatRegistered;
let vatEffectiveFrom = lead.vatEffectiveFrom;
if (!vatNumber && scrape) {
  const corpus = [
    scrape.description,
    scrape.address,
    scrape.location,
    ...(scrape.services ?? []),
  ].filter(Boolean).join(" \n ");
  vatNumber = extractVrnFromText(corpus);
}
if (vatNumber && lead.vatCheckedAt == null) {
  const result = await checkVatNumber(vatNumber);
  vatRegistered = result.registered;
  vatEffectiveFrom = result.effectiveFrom;
  await prisma.lead.update({
    where: { id: lead.id },
    data: {
      vatNumber: result.vrn,
      vatRegistered: result.registered,
      vatEffectiveFrom: result.effectiveFrom,
      vatCheckedAt: new Date(),
    },
  });
}

// Re-render the CH facts block now that we have the freshest VAT, owner,
// and (potentially) financials. Persist to Lead.companyFactsBlock so the
// approval card and any downstream consumer (follow-up drafter, reply
// drafter) reads the same string the outreach drafter saw.
const refreshed = await prisma.lead.findUnique({ where: { id: lead.id } });
const companyFactsBlock = refreshed ? buildCompanyFactsBlockFromLead(refreshed) : null;
if (companyFactsBlock && companyFactsBlock !== lead.companyFactsBlock) {
  await prisma.lead.update({
    where: { id: lead.id },
    data: { companyFactsBlock },
  });
}

const draft = await draftOutreachEmail({
businessName: lead.businessName,
ownerName: authoritativeOwner ?? research.owner_name,
firstName: (authoritativeOwner ?? research.owner_name)?.split(/\s+/)[0] ?? null,
city: lead.city,
country: lead.country,
rationale: scoring.brand_fit_rationale,
primaryPainHypothesis: scoring.primary_pain_hypothesis,
suggestedLane: scoring.suggested_lane,
sourcePage: scrape?.pages_scraped?.[0] ?? lead.websiteUrl ?? null,
sourceKind: scrape ? "website" : "google",
scrape,
researchJsonFallback: research,
companyFactsBlock,
sendWindowReason: lead.nextOutreachWindowReason,
});
await prisma.lead.update({
      where: { id: lead.id },
      data: {
        draftSubject: draft.subject_line,
        draftBodyHtml: draft.email_body_html,
      },
    });

    if (draft.warnings.length > 0) {
      console.log(` [draft] warnings: ${draft.warnings.join(", ")} (wc=${draft.word_count})`);
    }

      // =====================================================================
      // STEP 7: Tier Routing — BOTH TIERS NOW GET APPROVAL CARDS
      // =====================================================================
      console.log("  [6/7] Routing...");

      if (tier === "Tier1") {
        // Create Outlook draft
        const outlookDraft = await email.createDraft(emailNormalized, draft.subject_line, draft.email_body_html);

        // Send editable approval card via bot
        const fullLead = await prisma.lead.findUnique({ where: { id: lead.id } });
        let activityId: string | null = null;

        if (fullLead) {
          const cardResult = await bot.sendApprovalCard(fullLead);
          activityId = cardResult.activityId;
        }

        await prisma.lead.update({
          where: { id: lead.id },
          data: {
            status: "waiting_concierge",
            outlookDraftId: outlookDraft.messageId,
            conversationId: outlookDraft.conversationId,
            draftCreatedAt: new Date(),
            teamsCardActivityId: activityId,
            enrichmentLock: false,
          },
        });
        results.push({ leadId: lead.id, businessName: lead.businessName, outcome: "tier1_approval_sent" });

      } else if (tier === "Tier2") {
        // ── NEW: Tier 2 now also gets an approval card in Teams ──
        const outlookDraft = await email.createDraft(emailNormalized, draft.subject_line, draft.email_body_html);

        const fullLead = await prisma.lead.findUnique({ where: { id: lead.id } });
        let activityId: string | null = null;

        if (fullLead) {
          const cardResult = await bot.sendTier2ApprovalCard(fullLead);
          activityId = cardResult.activityId;
        }

        await prisma.lead.update({
          where: { id: lead.id },
          data: {
            status: "waiting_concierge",  // ← was "draft_created", now goes through approval
            outlookDraftId: outlookDraft.messageId,
            conversationId: outlookDraft.conversationId,
            draftCreatedAt: new Date(),
            teamsCardActivityId: activityId,
            enrichmentLock: false,
          },
        });
        results.push({ leadId: lead.id, businessName: lead.businessName, outcome: "tier2_approval_sent" });

      } else {
        await prisma.lead.update({
          where: { id: lead.id },
          data: { status: "exclude", enrichmentLock: false },
        });
        results.push({ leadId: lead.id, businessName: lead.businessName, outcome: "excluded" });
      }

      console.log(`  [7/7] Done: ${results[results.length - 1].outcome}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  ERROR: ${message}`);
      await logError({
        scenario: "S2_Orchestrator",
        module: "orchestrate",
        code: "ORCHESTRATE_FAILED",
        message,
        leadId: lead.id,
      });
      await prisma.lead.update({
        where: { id: lead.id },
        data: {
          enrichmentLock: false,
          enrichmentLockedAt: null,
          status: "new_lead",
        },
      }).catch(() => { /* swallow */ });
      results.push({ leadId: lead.id, businessName: lead.businessName, outcome: `error: ${message.slice(0, 100)}` });
    }
  }

  const outcomeCounts = results.reduce<Record<string, number>>((acc, r) => {
  acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
  return acc;
}, {});

console.log(`\nOrchestrator complete: ${results.length} processed.`);
console.log("Outcomes:");
for (const [outcome, count] of Object.entries(outcomeCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${outcome.padEnd(32)} ${count}`);
}

return { processed: results.length, results, outcomeCounts };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withLeadTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Per-lead timeout after ${ms}ms (${label})`)), ms);
    }),
  ]).finally(() => clearTimeout(timer!));
}

function buildCompanyFactsBlockFromLead(lead: {
  businessName: string;
  companiesHouseNumber: string | null;
  incorporatedOn: Date | null;
  accountsCategory: string | null;
  sicCodes: string[];
  ownerName: string | null;
  earliestDirectorAppointedOn: Date | null;
  latestDirectorAppointedOn: Date | null;
  directorCount: number | null;
  activeChargesCount: number | null;
  accountsNextDue: Date | null;
  latestTurnover: bigint | null;
  priorYearTurnover: bigint | null;
  latestEmployeeCount: number | null;
  priorYearEmployeeCount: number | null;
  latestAccountsMadeUpTo: Date | null;
  vatRegistered: boolean | null;
  vatNumber: string | null;
  chSignals: string[];
}): string | null {
  const lines: string[] = [];
  lines.push(`Company: ${lead.businessName}${lead.companiesHouseNumber ? ` (CRN ${lead.companiesHouseNumber})` : ""}`);
  if (lead.incorporatedOn) {
    const years = Math.floor((Date.now() - lead.incorporatedOn.getTime()) / (365.25 * 24 * 3600_000));
    lines.push(`Founded: ${lead.incorporatedOn.toISOString().slice(0, 10)} (${years} years).`);
  }
  if (lead.accountsCategory) lines.push(`Accounts category: ${lead.accountsCategory}.`);
  if (lead.sicCodes.length > 0) lines.push(`SIC codes: ${lead.sicCodes.join(", ")}.`);
  if (lead.ownerName) {
    const since = lead.earliestDirectorAppointedOn
      ? `, in role since ${lead.earliestDirectorAppointedOn.toISOString().slice(0, 10)}`
      : "";
    lines.push(`Primary director: ${lead.ownerName}${since}.`);
  }
  if (lead.directorCount != null) lines.push(`Active directors: ${lead.directorCount}.`);
  if (lead.chSignals.includes("new_director_recent") && lead.latestDirectorAppointedOn) {
    lines.push(`Most recent appointment: ${lead.latestDirectorAppointedOn.toISOString().slice(0, 10)} — in mandate-honeymoon window.`);
  }
  if (lead.latestTurnover != null) {
    let line = `Turnover (latest filed): £${formatGbp(Number(lead.latestTurnover))}`;
    if (lead.priorYearTurnover != null && lead.priorYearTurnover > 0n) {
      const growth = (Number(lead.latestTurnover) - Number(lead.priorYearTurnover)) / Number(lead.priorYearTurnover);
      line += `, ${(growth * 100).toFixed(0)}% YoY (prior £${formatGbp(Number(lead.priorYearTurnover))})`;
    }
    lines.push(line + ".");
  }
  if (lead.latestEmployeeCount != null) {
    let line = `Average employees: ${lead.latestEmployeeCount}`;
    if (lead.priorYearEmployeeCount != null) {
      line += ` (prior year ${lead.priorYearEmployeeCount})`;
    }
    lines.push(line + ".");
  }
  if (lead.latestAccountsMadeUpTo) {
    lines.push(`Accounts made up to: ${lead.latestAccountsMadeUpTo.toISOString().slice(0, 10)}.`);
  }
  if (lead.accountsNextDue) {
    lines.push(`Next accounts due: ${lead.accountsNextDue.toISOString().slice(0, 10)}.`);
  }
  if (lead.activeChargesCount && lead.activeChargesCount > 0) {
    lines.push(`Outstanding charges: ${lead.activeChargesCount}.`);
  } else if (lead.activeChargesCount === 0) {
    lines.push(`No outstanding charges.`);
  }
  if (lead.vatRegistered === true) {
    lines.push(`VAT-registered${lead.vatNumber ? ` (GB${lead.vatNumber})` : ""}.`);
  } else if (lead.vatRegistered === false) {
    lines.push(`Not VAT-registered.`);
  }
  if (lead.chSignals.length > 0) {
    lines.push(`CH signals: ${lead.chSignals.join(", ")}.`);
  }
  return lines.length > 1 ? lines.join("\n") : null;
}

function formatGbp(n: number): string {
  if (!isFinite(n)) return "?";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}m`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(Math.round(n));
}

const isDirectExecution = process.argv[1]?.includes("orchestrator");
if (isDirectExecution) {
  runOrchestrator().then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(0); }).catch((e) => { console.error(e); process.exit(1); });
}
