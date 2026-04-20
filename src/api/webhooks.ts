import { Router, Request, Response } from "express";
import { prisma } from "../utils/prisma.js";
import { checkDuplicate, normalizeBusinessName, extractDomain } from "../utils/dedup.js";

const router = Router();

// ---------------------------------------------------------------------------
// POST /leads — Manual lead ingestion
// ---------------------------------------------------------------------------
router.post("/leads", async (req: Request, res: Response) => {
  try {
    const body = req.body as {
      businessName?: string;
      city?: string;
      website?: string;
      leads?: Array<{ businessName: string; city?: string; website?: string }>;
    };

    const inputs = body.leads
      ? body.leads
      : body.businessName
        ? [{ businessName: body.businessName, city: body.city, website: body.website }]
        : [];

    if (inputs.length === 0) {
      res.status(400).json({ error: "Provide businessName or leads[]" });
      return;
    }

    const created: Array<{ id: string; businessName: string }> = [];
    const skipped: Array<{ businessName: string; reason: string; matchedWith?: string }> = [];

    for (const input of inputs) {
      if (!input.businessName?.trim()) {
        skipped.push({ businessName: input.businessName ?? "", reason: "empty name" });
        continue;
      }

      // Fuzzy dedup check
      const dedup = await checkDuplicate({
        businessName: input.businessName.trim(),
        website: input.website,
        city: input.city?.trim(),
      });

      if (dedup.isDuplicate) {
        skipped.push({
          businessName: input.businessName,
          reason: `duplicate (${dedup.matchType}, sim=${dedup.similarity?.toFixed(2) ?? "1.00"})`,
          matchedWith: dedup.matchedBusinessName ?? undefined,
        });
        continue;
      }

      const normName = normalizeBusinessName(input.businessName.trim());
      const domain = extractDomain(input.website);

      const lead = await prisma.lead.create({
        data: {
          businessName: input.businessName.trim(),
          normalizedName: normName,
          websiteDomain: domain,
          city: input.city?.trim() || null,
          websiteUrl: input.website?.trim() || null,
          status: "new_lead",
          discoverySource: "manual",
        },
      });
      created.push({ id: lead.id, businessName: lead.businessName });
    }

    res.status(201).json({
      created: created.length, skipped: skipped.length, leads: created,
      ...(skipped.length > 0 && { skippedDetails: skipped }),
    });
  } catch (err) {
    res.status(500).json({ error: "Ingestion failed", detail: String(err) });
  }
});

export default router;
