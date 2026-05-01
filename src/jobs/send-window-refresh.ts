import { prisma } from "../utils/prisma.js";
import { computeNextSendWindow } from "../utils/ch-signals.js";
import { logError } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Daily send-window refresh.
//
// Send-windows are computed once at discovery time, but they go stale:
//   - "new-director-honeymoon" expires after 90 days
//   - The next "post-year-end" window arrives every 12 months
//   - Anniversaries roll forward
//
// This job re-computes `nextOutreachWindow` for every still-pending
// `new_lead`, so the orchestrator's queue order stays sensible without
// requiring a re-run of the full CH discovery pipeline.
//
// Only touches leads in `new_lead` status (others have been actioned).
// Idempotent — running multiple times a day is harmless.
// ---------------------------------------------------------------------------

const BATCH_SIZE = parseInt(process.env.SEND_WINDOW_REFRESH_BATCH ?? "500", 10);

export async function runSendWindowRefresh(): Promise<{ checked: number; updated: number }> {
  const leads = await prisma.lead.findMany({
    where: {
      status: "new_lead",
      // Only leads with at least one CH-derived field — Places-only leads
      // don't have the inputs we need to compute a window.
      OR: [
        { incorporatedOn: { not: null } },
        { accountsLastMadeUpTo: { not: null } },
        { latestDirectorAppointedOn: { not: null } },
      ],
    },
    select: {
      id: true,
      incorporatedOn: true,
      accountsLastMadeUpTo: true,
      accountsNextDue: true,
      latestDirectorAppointedOn: true,
      nextOutreachWindow: true,
      nextOutreachWindowReason: true,
    },
    take: BATCH_SIZE,
    orderBy: { updatedAt: "asc" },
  });

  let updated = 0;

  for (const lead of leads) {
    try {
      const window = computeNextSendWindow({
        incorporatedOn: lead.incorporatedOn,
        accountsLastMadeUpTo: lead.accountsLastMadeUpTo,
        accountsNextDue: lead.accountsNextDue,
        latestDirectorAppointedOn: lead.latestDirectorAppointedOn,
      });

      const newAt = window?.at ?? null;
      const newReason = window?.reason ?? null;

      const sameAt =
        (lead.nextOutreachWindow?.getTime() ?? null) === (newAt?.getTime() ?? null);
      const sameReason = lead.nextOutreachWindowReason === newReason;
      if (sameAt && sameReason) continue;

      await prisma.lead.update({
        where: { id: lead.id },
        data: {
          nextOutreachWindow: newAt,
          nextOutreachWindowReason: newReason,
        },
      });
      updated++;
    } catch (err) {
      await logError({
        scenario: "S0_Discovery",
        module: "send-window-refresh",
        code: "WINDOW_REFRESH_FAILED",
        message: (err as Error).message.slice(0, 4000),
        leadId: lead.id,
      }).catch(() => {});
    }
  }

  console.log(`Send-window refresh: checked=${leads.length} updated=${updated}`);
  return { checked: leads.length, updated };
}

const isDirectExecution = process.argv[1]?.includes("send-window-refresh");
if (isDirectExecution) {
  runSendWindowRefresh()
    .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
