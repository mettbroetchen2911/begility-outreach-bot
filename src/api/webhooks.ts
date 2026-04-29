import { Router, Request, Response } from "express";
import { prisma } from "../utils/prisma.js";
import {
  checkDuplicate,
  normalizeBusinessName,
  extractDomain,
  normalizePhoneE164,
  extractOutwardPostcode,
  normalizeEmail,
} from "../utils/dedup.js";

const router = Router();

interface LeadInput {
  businessName: string;
  city?: string;
  website?: string;
  phone?: string;
  email?: string;
  address?: string;
  companiesHouseNumber?: string;
}

// ---------------------------------------------------------------------------
// POST /leads — Manual lead ingestion
// ---------------------------------------------------------------------------
router.post("/leads", async (req: Request, res: Response) => {
  try {
    const body = req.body as {
      businessName?: string;
      city?: string;
      website?: string;
      phone?: string;
      email?: string;
      address?: string;
      companiesHouseNumber?: string;
      leads?: LeadInput[];
    };

    const inputs: LeadInput[] = body.leads
      ? body.leads
      : body.businessName
        ? [{
            businessName: body.businessName,
            city: body.city,
            website: body.website,
            phone: body.phone,
            email: body.email,
            address: body.address,
            companiesHouseNumber: body.companiesHouseNumber,
          }]
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

      const businessName = input.businessName.trim();

      const dedup = await checkDuplicate({
        businessName,
        website: input.website,
        city: input.city?.trim(),
        phone: input.phone,
        email: input.email,
        address: input.address,
        companiesHouseNumber: input.companiesHouseNumber,
      });

      if (dedup.isDuplicate) {
        skipped.push({
          businessName,
          reason: `duplicate (${dedup.matchType}, sim=${dedup.similarity?.toFixed(2) ?? "1.00"})`,
          matchedWith: dedup.matchedBusinessName ?? undefined,
        });
        continue;
      }

      const normName = normalizeBusinessName(businessName);
      const domain = extractDomain(input.website);
      const phoneE164 = normalizePhoneE164(input.phone);
      const outward = input.address ? extractOutwardPostcode(input.address) : null;
      const emailNorm = normalizeEmail(input.email);
      const chNumber = input.companiesHouseNumber?.replace(/\s/g, "").toUpperCase() || null;

      const lead = await prisma.lead.create({
        data: {
          businessName,
          normalizedName: normName,
          websiteDomain: domain,
          city: input.city?.trim() || null,
          address: input.address?.trim() || null,
          outwardPostcode: outward,
          websiteUrl: input.website?.trim() || null,
          phone: input.phone?.trim() || null,
          phoneE164,
          email: emailNorm,
          companiesHouseNumber: chNumber,
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
