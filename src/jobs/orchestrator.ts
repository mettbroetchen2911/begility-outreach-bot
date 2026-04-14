import { prisma } from "../utils/prisma.js";
import { AIService, ResearchResult } from "../services/ai.service.js";
import { EmailService } from "../services/email.service.js";
import { ChatService } from "../services/chat.service.js";
import { verifyEmail } from "../verification/email-verifier.js";
import { generateHmacUrls } from "../utils/hmac.js";
import { getNicheConfig } from "../config/niche.js";
import { extractDomain, normalizeBusinessName } from "../utils/dedup.js";
import { scrapeBusinessWebsite } from "../services/website-scraper.js";

const ai = new AIService();
const email = new EmailService();
const chat = new ChatService();

const BATCH_SIZE = parseInt(process.env.ORCHESTRATOR_BATCH_SIZE ?? "5", 10);

// ---------------------------------------------------------------------------
// Main orchestration function
// ---------------------------------------------------------------------------
export async function runOrchestrator(): Promise<{
  processed: number;
  results: Array<{ leadId: string; businessName: string; outcome: string }>;
}> {
  const config = getNicheConfig();
  const results: Array<{ leadId: string; businessName: string; outcome: string }> = [];

  // =========================================================================
  // STEP 0: Atomically claim leads using FOR UPDATE SKIP LOCKED
  // This prevents race conditions when two orchestrator runs overlap
  // =========================================================================
  const claimed = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE "Lead"
    SET "enrichmentLock" = true, "status" = 'enriching', "updatedAt" = NOW()
    WHERE id IN (
      SELECT id FROM "Lead"
      WHERE "status" = 'new_lead' AND "enrichmentLock" = false
      ORDER BY "createdAt" ASC
      LIMIT ${BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id
  `;

  if (claimed.length === 0) {
    console.log("Orchestrator: No new leads.");
    return { processed: 0, results };
  }

  // Fetch full lead data for claimed IDs
  const newLeads = await prisma.lead.findMany({
    where: { id: { in: claimed.map((c) => c.id) } },
  });

  console.log(`Orchestrator: Processing ${newLeads.length} leads.`);

  for (const lead of newLeads) {
    try {
      console.log(`\n── ${lead.businessName} (${lead.id}) ──`);

      // =====================================================================
      // STEP 1: Research — scrape website first, grounded search as fallback
      // Scraping is free. Grounded search costs $0.035 per call.
      // =====================================================================
      console.log("  [1/7] Research...");

      let research: ResearchResult;
      let researchSource: "scraped" | "grounded" | "merged";

      const websiteUrl = lead.websiteUrl || lead.website;

      if (websiteUrl) {
        // Try scraping the website first (FREE — no grounding cost)
        console.log(`    Scraping ${websiteUrl}...`);
        const scraped = await scrapeBusinessWebsite(websiteUrl, lead.businessName, lead.city ?? undefined);

        if (scraped && scraped.email && scraped.confidence !== "low") {
          // Scrape found what we need — skip grounded search entirely
          research = {
            owner_name: scraped.owner_name,
            website: scraped.website,
            email: scraped.email,
            phone: scraped.phone,
            instagram: scraped.instagram,
            location: scraped.location,
            description: scraped.description,
            search_confidence: scraped.confidence === "high" ? 85 : 60,
          };
          researchSource = "scraped";
          console.log(`    Scrape SUCCESS (${scraped.pages_scraped.length} pages) — skipping grounded search`);
        } else if (scraped && scraped.description) {
          // Partial scrape — got some info but missing email
          // Run grounded search but merge with scraped data
          console.log(`    Scrape partial (no email) — falling back to grounded search...`);
          const grounded = await ai.runResearch(lead.businessName, lead.city ?? undefined);

          // Merge: prefer scraped data for fields it found, grounded for the rest
          research = {
            owner_name: scraped.owner_name ?? grounded.owner_name,
            website: scraped.website ?? grounded.website,
            email: grounded.email, // grounded is better at finding emails
            phone: scraped.phone ?? grounded.phone,
            instagram: scraped.instagram ?? grounded.instagram,
            location: scraped.location ?? grounded.location,
            description: scraped.description ?? grounded.description,
            search_confidence: grounded.search_confidence,
          };
          researchSource = "merged";
          console.log(`    Merged scraped + grounded data`);
        } else {
          // Scrape failed completely — fall back to grounded search
          console.log(`    Scrape failed — falling back to grounded search...`);
          research = await ai.runResearch(lead.businessName, lead.city ?? undefined);
          researchSource = "grounded";
        }
      } else {
        // No website URL from discovery — grounded search is the only option
        console.log(`    No website URL — using grounded search...`);
        research = await ai.runResearch(lead.businessName, lead.city ?? undefined);
        researchSource = "grounded";
      }

      console.log(`  [1/7] Done (${researchSource}). Email: ${research.email ?? "NOT FOUND"}`);

      // ── Post-research dedup: check if the discovered website/email
      //    matches an EXISTING lead that entered via a different name ──
      const researchDomain = extractDomain(research.website);
      if (researchDomain) {
        const domainConflict = await prisma.lead.findFirst({
          where: {
            websiteDomain: researchDomain,
            id: { not: lead.id },
          },
          select: { id: true, businessName: true },
        });

        if (domainConflict) {
          console.log(`  [DEDUP] Website domain ${researchDomain} already exists on "${domainConflict.businessName}" — excluding`);
          await prisma.lead.update({
            where: { id: lead.id },
            data: {
              status: "exclude",
              enrichmentLock: false,
              notes: `Post-research dedup: domain ${researchDomain} matches lead "${domainConflict.businessName}" (${domainConflict.id})`,
            },
          });
          results.push({ leadId: lead.id, businessName: lead.businessName, outcome: "dedup_domain_conflict" });
          continue;
        }
      }

      // Also check if research found an email that's already on another lead
      if (research.email) {
        const emailConflict = await prisma.lead.findFirst({
          where: {
            email: research.email.toLowerCase(),
            id: { not: lead.id },
          },
          select: { id: true, businessName: true },
        });

        if (emailConflict) {
          console.log(`  [DEDUP] Email ${research.email} already exists on "${emailConflict.businessName}" — excluding`);
          await prisma.lead.update({
            where: { id: lead.id },
            data: {
              status: "exclude",
              enrichmentLock: false,
              notes: `Post-research dedup: email ${research.email} matches lead "${emailConflict.businessName}" (${emailConflict.id})`,
            },
          });
          results.push({ leadId: lead.id, businessName: lead.businessName, outcome: "dedup_email_conflict" });
          continue;
        }
      }

      // Persist research + update dedup fields
      const normName = normalizeBusinessName(lead.businessName);
      await prisma.lead.update({
        where: { id: lead.id },
        data: {
          geminiResearchJson: research as any,
          ownerName: research.owner_name,
          website: research.website,
          email: research.email,
          phone: research.phone,
          instagram: research.instagram,
          businessDescription: research.description,
          searchConfidence: research.search_confidence,
          // Dedup fields — update with research data
          normalizedName: normName || lead.normalizedName,
          websiteDomain: researchDomain ?? lead.websiteDomain,
        },
      });
      console.log(`  [1/7] Done. Email: ${research.email ?? "NOT FOUND"}`);

      // =====================================================================
      // STEP 2: No-Email Gate
      // =====================================================================
      if (!research.email) {
        console.log("  [STOP] No email found → needs_review");
        await prisma.lead.update({
          where: { id: lead.id },
          data: { status: "needs_review", enrichmentLock: false },
        });
        results.push({ leadId: lead.id, businessName: lead.businessName, outcome: "needs_review" });
        continue;
      }

      // =====================================================================
      // STEP 3: Email Verification Waterfall
      // =====================================================================
      console.log("  [2/7] Email verification...");
      await prisma.lead.update({
        where: { id: lead.id },
        data: { status: "verifying" },
      });

      const verification = await verifyEmail(research.email);

      await prisma.lead.update({
        where: { id: lead.id },
        data: {
          mxValid: verification.mxValid,
          smtpValid: verification.smtpValid,
          isCatchAll: verification.isCatchAll,
          verificationScore: verification.verificationScore,
          emailVerified: verification.verificationScore >= config.verificationThreshold,
          emailVerifiedAt: verification.verificationScore >= config.verificationThreshold ? new Date() : null,
        },
      });

      console.log(
        `  [2/7] Score: ${verification.verificationScore}/100 ` +
        `(MX:${verification.mxValid} SMTP:${verification.smtpValid} CatchAll:${verification.isCatchAll})`
      );

      if (verification.verificationScore < config.verificationThreshold) {
        console.log(`  [STOP] Verification score ${verification.verificationScore} < ${config.verificationThreshold} → failed`);
        await prisma.lead.update({
          where: { id: lead.id },
          data: { status: "verification_failed", enrichmentLock: false },
        });
        results.push({ leadId: lead.id, businessName: lead.businessName, outcome: "verification_failed" });
        continue;
      }

      // =====================================================================
      // STEP 4: Suppression Check
      // =====================================================================
      console.log("  [3/7] Suppression check...");
      const suppressed = await prisma.suppression.findUnique({
        where: { email: research.email.toLowerCase() },
      });

      if (suppressed) {
        console.log("  [STOP] Email is suppressed");
        await prisma.lead.update({
          where: { id: lead.id },
          data: { status: "suppressed", enrichmentLock: false },
        });
        results.push({ leadId: lead.id, businessName: lead.businessName, outcome: "suppressed" });
        continue;
      }

      // =====================================================================
      // STEP 5: Brand Fit Scoring
      // =====================================================================
      console.log("  [4/7] Brand fit scoring...");
      const scoring = await ai.scoreBrandFit(research);

      // Enforce tier thresholds from config (override AI recommendation if needed)
      let tier: "Tier1" | "Tier2" | "Exclude";
      if (scoring.brand_fit_score >= config.tier1Threshold) {
        tier = "Tier1";
      } else if (scoring.brand_fit_score >= config.tier2Threshold) {
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
      console.log(`  [4/7] Score: ${scoring.brand_fit_score}/100 → ${tier} (AI suggested: ${scoring.recommended_tier})`);

      // =====================================================================
      // STEP 6: Email Drafting
      // =====================================================================
      console.log("  [5/7] Drafting email...");
      const draft = await ai.draftEmail(lead.businessName, research, scoring.brand_fit_rationale);

      await prisma.lead.update({
        where: { id: lead.id },
        data: {
          draftSubject: draft.subject_line,
          draftBodyHtml: draft.email_body_html,
        },
      });

      // =====================================================================
      // STEP 7: Tier Routing
      // =====================================================================
      console.log("  [6/7] Routing...");

      if (tier === "Tier1") {
        const outlookDraft = await email.createDraft(research.email, draft.subject_line, draft.email_body_html);
        const { approveUrl, rejectUrl } = generateHmacUrls(lead.id);
        const fullLead = await prisma.lead.findUnique({ where: { id: lead.id } });
        let activityId: string | null = null;

        if (fullLead) {
          const cardResult = await chat.sendApprovalCard(fullLead, approveUrl, rejectUrl, outlookDraft.webLink);
          activityId = cardResult.activityId;
        }

        await prisma.lead.update({
          where: { id: lead.id },
          data: {
            status: "waiting_concierge",
            outlookDraftId: outlookDraft.messageId,
            draftCreatedAt: new Date(),
            teamsCardActivityId: activityId,
            enrichmentLock: false,
          },
        });
        results.push({ leadId: lead.id, businessName: lead.businessName, outcome: "tier1_approval_sent" });

      } else if (tier === "Tier2") {
        const outlookDraft = await email.createDraft(research.email, draft.subject_line, draft.email_body_html);

        await prisma.lead.update({
          where: { id: lead.id },
          data: {
            status: "draft_created",
            outlookDraftId: outlookDraft.messageId,
            draftCreatedAt: new Date(),
            enrichmentLock: false,
          },
        });
        results.push({ leadId: lead.id, businessName: lead.businessName, outcome: "tier2_draft_created" });

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
      console.error(`  FAIL ${lead.businessName}: ${message}`);

      try {
        await prisma.errorLog.create({
          data: {
            scenarioName: "S1_Orchestrator",
            moduleName: "orchestrator",
            errorCode: "ENRICHMENT_FAILED",
            errorMessage: message.slice(0, 4000),
            leadId: lead.id,
            killSwitchFired: false,
          },
        });
      } catch { console.error("  Failed to write ErrorLog"); }

      results.push({ leadId: lead.id, businessName: lead.businessName, outcome: `error: ${message.slice(0, 100)}` });
    } finally {
      // ALWAYS release the lock
      try {
        const current = await prisma.lead.findUnique({ where: { id: lead.id } });
        if (current?.enrichmentLock) {
          await prisma.lead.update({
            where: { id: lead.id },
            data: { enrichmentLock: false },
          });
        }
      } catch { console.error(`  Failed to release lock for ${lead.id}`); }
    }
  }

  console.log(`\nOrchestrator complete: ${results.length} leads processed.`);
  return { processed: results.length, results };
}

const isDirectExecution = process.argv[1]?.includes("orchestrator");
if (isDirectExecution) {
  runOrchestrator().then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(0); }).catch((err) => { console.error("Fatal:", err); process.exit(1); });
}
