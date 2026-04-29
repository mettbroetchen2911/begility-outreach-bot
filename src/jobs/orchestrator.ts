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

const leads = await prisma.lead.findMany({
  where: { status: "new_lead", enrichmentLock: false },
  orderBy: { createdAt: "asc" },
  take: batch,
});

if (leads.length === 0) {
  console.log("Orchestrator: no new leads to process.");
  return { processed: 0, results: [] };
}

console.log(`Orchestrator: processing ${leads.length} leads…`);

for (const lead of leads) {
    try {
      // Lock the lead
      await prisma.lead.update({
        where: { id: lead.id },
        data: { enrichmentLock: true, status: "enriching" },
      });

      console.log(`\n[${lead.businessName}]`);

      // =====================================================================
      // STEP 1-2: Research + Data Enrichment
      // =====================================================================
      console.log("  [1/7] Researching...");
      const research = await ai.runResearch(lead.businessName, lead.city ?? "");

      // Normalise contact signals before persistence so downstream dedup &
      // suppression queries see the same canonical form.
      const emailNormalized = normalizeEmail(research.email ?? lead.email);
      const phoneE164 = normalizePhoneE164(research.phone ?? lead.phone);

      await prisma.lead.update({
        where: { id: lead.id },
        data: {
          geminiResearchJson: research as any,
          ownerName: research.owner_name ?? lead.ownerName,
          email: emailNormalized,
          phone: research.phone ?? lead.phone,
          phoneE164,
          instagram: (research as any).instagram ?? lead.instagram,
          websiteUrl: research.website ?? lead.websiteUrl,
          businessDescription: research.description ?? lead.businessDescription,
        },
      });

      if (!emailNormalized) {
        console.log("  No email found — excluding.");
        await prisma.lead.update({
          where: { id: lead.id },
          data: { status: "exclude", enrichmentLock: false },
        });
        results.push({ leadId: lead.id, businessName: lead.businessName, outcome: "no_email" });
        continue;
      }

      // ── Post-research dedup ───────────────────────────────────────────
      // The lead row was created at discovery with only name/address. Now
      // that we have an email + phone + (maybe) website, run dedup again
      // — excluding this lead's own id — to catch the case where the same
      // business surfaced under two different names (e.g. trading name vs
      // registered name) and they only collide on contact details.
      const postResearchDedup = await checkDuplicate({
        businessName: lead.businessName,
        website: research.website ?? lead.websiteUrl,
        city: lead.city,
        phone: research.phone ?? lead.phone,
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

      // =====================================================================
      // STEP 4-5: Brand Fit Scoring
      // =====================================================================
      console.log("  [4/7] Scoring...");
      const scoring = await ai.scoreBrandFit(research);

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

      // =====================================================================
      // STEP 6: Email Drafting
      // =====================================================================
      console.log(" [5/7] Scraping + drafting email...");
// Apollo-grade scrape (cached per-domain for SCRAPE_CACHE_HOURS)
const scrape = lead.websiteUrl
? await scrapeBusinessWebsiteV2(lead.websiteUrl, lead.businessName, lead.city ?? undefined)
: null;
const draft = await draftOutreachEmail({
businessName: lead.businessName,
ownerName: research.owner_name,
firstName: research.owner_name?.split(/\s+/)[0] ?? null,
city: lead.city,
country: lead.country,
rationale: scoring.brand_fit_rationale,
sourcePage: scrape?.pages_scraped?.[0] ?? lead.websiteUrl ?? null,
sourceKind: scrape ? "website" : "google",
scrape,
researchJsonFallback: research,
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
        data: { enrichmentLock: false },
      }).catch(() => { /* swallow */ });
      results.push({ leadId: lead.id, businessName: lead.businessName, outcome: `error: ${message.slice(0, 100)}` });
    }
  }

  console.log(`\nOrchestrator complete: ${results.length} processed.`);
  return { processed: results.length, results };
}

const isDirectExecution = process.argv[1]?.includes("orchestrator");
if (isDirectExecution) {
  runOrchestrator().then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(0); }).catch((e) => { console.error(e); process.exit(1); });
}
