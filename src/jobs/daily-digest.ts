import { prisma } from "../utils/prisma.js";
import { ChatService } from "../services/chat.service.js";

const chatSvc = new ChatService();

export async function runDailyDigest(): Promise<{ sent: boolean }> {
  const warmReplies = await prisma.lead.findMany({
    where: { status: "interested" },
    orderBy: { lastReplyAt: "desc" },
    take: 5,
  });

  const pendingApprovals = await prisma.lead.findMany({
    where: { status: "waiting_concierge" },
    orderBy: { brandFitScore: "desc" },
    take: 5,
  });

  // NEW: Fetch Tier 2 drafts
  const tier2Drafts = await prisma.lead.findMany({
    where: { status: "draft_created", tier: "Tier2" },
    orderBy: { brandFitScore: "desc" },
    take: 5,
  });

  const followUpQueue = await prisma.followUpQueue.findMany({
    where: { status: "pending" },
    orderBy: { queuedAt: "asc" },
    take: 5,
  });

  const topLeads = await prisma.lead.findMany({
    where: { status: { in: ["outreach_sent", "draft_created"] } },
    orderBy: { brandFitScore: "desc" },
    take: 5,
  });

  await chatSvc.sendDailyDigest({
    warmReplies: warmReplies.map((l) => ({ businessName: l.businessName, ownerName: l.ownerName, score: l.brandFitScore })),
    pendingApprovals: pendingApprovals.map((l) => ({ businessName: l.businessName, score: l.brandFitScore })),
    tier2Drafts: tier2Drafts.map((l) => ({ businessName: l.businessName, score: l.brandFitScore })),
    followUpQueue: followUpQueue.map((f) => ({ businessName: f.businessName, draftPreview: f.draftPreview })),
    topLeads: topLeads.map((l) => ({ businessName: l.businessName, score: l.brandFitScore, status: l.status })),
  });

  console.log("Daily digest sent.");
  return { sent: true };
}

const isDirectExecution = process.argv[1]?.includes("daily-digest");
if (isDirectExecution) {
  runDailyDigest().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
