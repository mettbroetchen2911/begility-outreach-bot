import { prisma } from "../utils/prisma.js";
import { ChatService } from "../services/chat.service.js";

const chatSvc = new ChatService();
const THRESHOLD = parseFloat(process.env.BOUNCE_RATE_THRESHOLD ?? "5");

export async function runBounceMonitor(): Promise<{
  bounceRate: number;
  killSwitchFired: boolean;
}> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  const recentErrors = await prisma.errorLog.findMany({
    where: { timestamp: { gte: oneHourAgo } },
  });

  const bounceCount = recentErrors.filter(
    (e) => e.errorCode.includes("550") || e.errorCode.includes("551") || e.errorCode.toLowerCase().includes("bounce")
  ).length;

  const sentCount = await prisma.lead.count({
    where: { lastContactedAt: { gte: oneHourAgo } },
  });

  const bounceRate = sentCount > 0 ? (bounceCount / sentCount) * 100 : 0;
  console.log(`Bounce monitor: ${bounceCount}/${sentCount} = ${bounceRate.toFixed(1)}%`);

  if (bounceRate <= THRESHOLD) {
    return { bounceRate, killSwitchFired: false };
  }

  console.warn(`Bounce rate ${bounceRate.toFixed(1)}% > ${THRESHOLD}% — KILL SWITCH`);

  let confirmed = false;
  try {
    await prisma.errorLog.create({
      data: {
        scenarioName: "S8_Kill_Switch",
        moduleName: "bounce-monitor",
        errorCode: "KILL_SWITCH_ACTIVE",
        errorMessage: `Bounce rate ${bounceRate.toFixed(1)}% exceeded ${THRESHOLD}% threshold. Follow-up sweep disabled.`,
        killSwitchFired: true,
      },
    });
    confirmed = true;
  } catch { console.error("Failed to write kill-switch flag"); }

  try {
    await chatSvc.sendErrorAlert({
      scenarioName: "S8_Bounce_Monitor",
      errorCode: "KILL_SWITCH_FIRED",
      errorMessage: `Bounce rate ${bounceRate.toFixed(1)}% exceeded ${THRESHOLD}%`,
      killSwitchFired: true,
      bounceRate,
      s5Confirmed: confirmed,
    });
  } catch (e) { console.error("DevOps alert failed:", e); }

  return { bounceRate, killSwitchFired: true };
}

export async function isKillSwitchActive(): Promise<boolean> {
  const recent = await prisma.errorLog.findFirst({
    where: {
      scenarioName: "S8_Kill_Switch",
      errorCode: "KILL_SWITCH_ACTIVE",
      killSwitchFired: true,
      timestamp: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    },
    orderBy: { timestamp: "desc" },
  });
  return recent !== null;
}

const isDirectExecution = process.argv[1]?.includes("bounce-monitor");
if (isDirectExecution) {
  runBounceMonitor().then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(0); }).catch((e) => { console.error(e); process.exit(1); });
}
