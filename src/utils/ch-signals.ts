import {
  type CompanyProfile,
  type OfficersResponse,
  type FilingHistoryResponse,
  type FilingHistoryItem,
  type ChargesResponse,
  type PscResponse,
  type CompanyOfficer,
} from "./companies-house.js";
import { type ParsedAccounts } from "./ixbrl-parser.js";
import { countCorporatePSCs, countRecentNameChanges } from "./lead-quality.js";

// ---------------------------------------------------------------------------
// CH-signal extraction & composite pre-scoring.
//
// Why this exists: scrape + Gemini are by far the most expensive steps in
// the pipeline. If a Companies House profile already tells us a lead is too
// big / too small / too new / clearly stressed in a way we don't sell to,
// we should know that BEFORE spending tokens on it. The composite score
// here is computed from CH-only data and gates whether a lead progresses.
// ---------------------------------------------------------------------------

export interface ChSnapshot {
  profile: CompanyProfile;
  officers: OfficersResponse | null;
  filings: FilingHistoryResponse | null;
  charges: ChargesResponse | null;
  psc: PscResponse | null;
  accounts: ParsedAccounts | null;
}

export interface ChSignalSummary {
  // Director / leadership
  directorCount: number | null;
  earliestDirectorAppointedOn: Date | null;
  latestDirectorAppointedOn: Date | null;
  primaryDirectorName: string | null;
  primaryDirectorRole: string | null;

  // PSC
  pscCount: number | null;

  // Filings activity
  registeredOfficeMovedOn: Date | null;
  recentChargeCreatedOn: Date | null;
  activeChargesCount: number | null;

  // Accounts timing
  accountsLastMadeUpTo: Date | null;
  accountsNextDue: Date | null;
  confirmationNextDue: Date | null;

  // Composite output
  signals: string[];
  preScore: number;     // 0-100
  preScoreReasons: string[];
  /** Hard exclude — set if we should not pursue this company at all. */
  hardExclude: boolean;
  hardExcludeReason: string | null;
}

const NEW_DIRECTOR_DAYS = 90;
const RECENT_FILING_DAYS = 365;
const RECENT_OFFICE_MOVE_DAYS = 365;

// SIC codes Begility deliberately doesn't sell to (financial regulators,
// extra-territorial, holding-companies-only). Add to via env if desired.
const HARD_EXCLUDE_SIC_PREFIXES = (process.env.CH_HARD_EXCLUDE_SIC_PREFIXES ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export function summariseCh(snap: ChSnapshot): ChSignalSummary {
  const { profile, officers, filings, charges, psc, accounts } = snap;
  const now = Date.now();
  const signals: string[] = [];
  const reasons: string[] = [];
  let score = 50; // baseline — moves up/down from here

  // ── Hard excludes ─────────────────────────────────────────────────────
  if (
    profile.has_been_liquidated ||
    profile.has_insolvency_history ||
    profile.company_status !== "active"
  ) {
    return {
      ...emptySummary(),
      hardExclude: true,
      hardExcludeReason: profile.has_been_liquidated
        ? "liquidated"
        : profile.has_insolvency_history
          ? "insolvency-history"
          : `status=${profile.company_status}`,
    };
  }

  if (HARD_EXCLUDE_SIC_PREFIXES.length > 0 && profile.sic_codes) {
    const blocked = profile.sic_codes.find((c) =>
      HARD_EXCLUDE_SIC_PREFIXES.some((p) => c.startsWith(p)),
    );
    if (blocked) {
      return {
        ...emptySummary(),
        hardExclude: true,
        hardExcludeReason: `sic-blocked=${blocked}`,
      };
    }
  }

  // ── Officer signals ───────────────────────────────────────────────────
  const activeOfficers = (officers?.items ?? []).filter(
    (o) => !o.resigned_on && (o.officer_role === "director" || o.officer_role === "llp-member"),
  );
  const directorCount = activeOfficers.length || null;

  const apptDates = activeOfficers
    .map((o) => (o.appointed_on ? safeDate(o.appointed_on) : null))
    .filter((d): d is Date => d !== null);
  const earliest = apptDates.length ? new Date(Math.min(...apptDates.map((d) => d.getTime()))) : null;
  const latest = apptDates.length ? new Date(Math.max(...apptDates.map((d) => d.getTime()))) : null;

  const primary = pickPrimaryDirector(activeOfficers);

  if (latest && now - latest.getTime() <= NEW_DIRECTOR_DAYS * 24 * 3600_000) {
    signals.push("new_director_recent");
    score += 12;
    reasons.push(`+12 new director appointed ${daysAgo(latest)}d ago`);
  }
  if (directorCount !== null) {
    if (directorCount >= 1 && directorCount <= 3) {
      signals.push("founder_led");
      score += 8;
      reasons.push(`+8 ${directorCount}-director company (founder-led)`);
    } else if (directorCount >= 7) {
      signals.push("board_run");
      score -= 12;
      reasons.push(`-12 ${directorCount}-director company (board-run, weak ICP fit)`);
    }
  }

  // ── Filing signals ────────────────────────────────────────────────────
  const recentFilings = (filings?.items ?? []).filter(
    (f) => f.date && now - safeDate(f.date)!.getTime() <= RECENT_FILING_DAYS * 24 * 3600_000,
  );
  const officeMoveFiling = recentFilings.find(
    (f) =>
      (f.category === "address" || /change.*registered.*office/i.test(f.description ?? "")) &&
      f.date,
  );
  const officeMovedOn = officeMoveFiling?.date ? safeDate(officeMoveFiling.date) : null;
  if (officeMovedOn && now - officeMovedOn.getTime() <= RECENT_OFFICE_MOVE_DAYS * 24 * 3600_000) {
    signals.push("registered_office_moved_recently");
    score += 5;
    reasons.push("+5 moved registered office in last 12m (likely scaling)");
  }

  const capitalRaise = recentFilings.find(
    (f) => f.category === "capital" || /allotment|increase.*capital|share.*allotment/i.test(f.description ?? ""),
  );
  if (capitalRaise) {
    signals.push("recent_capital_event");
    score += 8;
    reasons.push("+8 recent capital allotment / share event");
  }

  // ── Charges (debt / lender exposure) ──────────────────────────────────
  const activeCharges = (charges?.items ?? []).filter(
    (c) => c.status === "outstanding" || c.status === "part-satisfied",
  );
  const recentCharge = activeCharges
    .map((c) => (c.created_on ? safeDate(c.created_on) : null))
    .filter((d): d is Date => d !== null)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  if (recentCharge && now - recentCharge.getTime() <= 90 * 24 * 3600_000) {
    signals.push("recent_charge_created");
    score += 4;
    reasons.push("+4 charge created in last 90d (often debt-funded growth)");
  }

  // ── PSC ───────────────────────────────────────────────────────────────
  const pscCount = psc?.active_count ?? null;
  const pscBreakdown = countCorporatePSCs(psc);
  if (pscBreakdown.active > 0 && pscBreakdown.active >= pscBreakdown.activeIndividuals) {
    // Dominant corporate / legal-person PSC = parent-controlled entity.
    // Decision-maker often isn't on the entity's own director list.
    signals.push("corporate_psc_dominant");
    score -= 12;
    reasons.push(`-12 dominant corporate PSC (${pscBreakdown.active} corporate vs ${pscBreakdown.activeIndividuals} individual) — likely subsidiary`);
  } else if (pscBreakdown.active > 0) {
    signals.push("corporate_psc_present");
  }

  // ── Name-change churn ─────────────────────────────────────────────────
  const recentNameChanges = countRecentNameChanges(filings);
  if (recentNameChanges >= 2) {
    signals.push("frequent_name_changes");
    score -= 8;
    reasons.push(`-8 ${recentNameChanges} name changes in last 5 years (rebrand churn / shell pattern)`);
  }

  // ── Late filings / stress (already excluded from CH discovery, but
  // handles cases where this is called for a re-enrichment) ────────────
  if (profile.accounts?.overdue) {
    signals.push("accounts_overdue");
    score -= 25;
    reasons.push("-25 accounts overdue");
  }
  if (profile.confirmation_statement?.overdue) {
    signals.push("confirmation_statement_overdue");
    score -= 10;
    reasons.push("-10 confirmation statement overdue");
  }

  // ── Financials (when we successfully parsed iXBRL) ────────────────────
  if (accounts && accounts.hasFinancials) {
    if (accounts.turnover != null) {
      const t = Number(accounts.turnover);
      if (t >= 1_000_000 && t <= 20_000_000) {
        signals.push("turnover_in_icp_band");
        score += 15;
        reasons.push(`+15 turnover £${formatGbp(t)} (in £1m-£20m ICP band)`);
      } else if (t > 20_000_000) {
        signals.push("turnover_above_icp");
        score -= 8;
        reasons.push(`-8 turnover £${formatGbp(t)} (above ICP — too big)`);
      } else if (t > 0 && t < 250_000) {
        signals.push("turnover_below_icp");
        score -= 15;
        reasons.push(`-15 turnover £${formatGbp(t)} (sub-£250k — too small to buy a real fix)`);
      }
    }
    if (accounts.employeeCount != null) {
      if (accounts.employeeCount >= 10 && accounts.employeeCount <= 100) {
        signals.push("headcount_in_icp_band");
        score += 8;
        reasons.push(`+8 ${accounts.employeeCount} employees (in 10-100 ICP band)`);
      } else if (accounts.employeeCount > 200) {
        signals.push("headcount_above_icp");
        score -= 8;
        reasons.push(`-8 ${accounts.employeeCount} employees (above ICP)`);
      } else if (accounts.employeeCount > 0 && accounts.employeeCount < 5) {
        signals.push("headcount_below_icp");
        score -= 10;
        reasons.push(`-10 ${accounts.employeeCount} employees (sub-5, too small)`);
      }
    }
    if (accounts.turnover != null && accounts.priorTurnover != null && accounts.priorTurnover > 0n) {
      const growth = (Number(accounts.turnover) - Number(accounts.priorTurnover)) / Number(accounts.priorTurnover);
      if (growth >= 0.1) {
        signals.push("growing_yoy");
        score += 10;
        reasons.push(`+10 ${(growth * 100).toFixed(0)}% YoY turnover growth`);
      } else if (growth <= -0.15) {
        signals.push("contracting_yoy");
        score -= 5;
        reasons.push(`-5 ${(growth * 100).toFixed(0)}% YoY turnover (contracting)`);
      }
    }
  } else {
    signals.push("no_parseable_accounts");
    // No score change — neutral.
  }

  // Clamp
  score = Math.max(0, Math.min(100, score));

  return {
    directorCount,
    earliestDirectorAppointedOn: earliest,
    latestDirectorAppointedOn: latest,
    primaryDirectorName: primary?.name ?? null,
    primaryDirectorRole: primary?.officer_role ?? null,
    pscCount,
    registeredOfficeMovedOn: officeMovedOn,
    recentChargeCreatedOn: recentCharge ?? null,
    activeChargesCount: activeCharges.length || null,
    accountsLastMadeUpTo: profile.accounts?.last_accounts?.made_up_to
      ? safeDate(profile.accounts.last_accounts.made_up_to)
      : null,
    accountsNextDue: profile.accounts?.next_due ? safeDate(profile.accounts.next_due) : null,
    confirmationNextDue: profile.confirmation_statement?.next_due
      ? safeDate(profile.confirmation_statement.next_due)
      : null,
    signals,
    preScore: score,
    preScoreReasons: reasons,
    hardExclude: false,
    hardExcludeReason: null,
  };
}

// ---------------------------------------------------------------------------
// Pick a "primary" director — the founder / longest-serving active director
// who looks like the decision-maker. Heuristic: earliest appointment date,
// breaking ties on role (director > llp-member > secretary).
// ---------------------------------------------------------------------------

function pickPrimaryDirector(active: CompanyOfficer[]): CompanyOfficer | null {
  if (active.length === 0) return null;
  const ranked = [...active].sort((a, b) => {
    const dA = a.appointed_on ? new Date(a.appointed_on).getTime() : Number.MAX_SAFE_INTEGER;
    const dB = b.appointed_on ? new Date(b.appointed_on).getTime() : Number.MAX_SAFE_INTEGER;
    if (dA !== dB) return dA - dB;
    return roleScore(b.officer_role) - roleScore(a.officer_role);
  });
  return ranked[0];
}

function roleScore(role: string | undefined): number {
  if (!role) return 0;
  if (role === "director") return 3;
  if (role === "llp-member") return 2;
  if (role === "secretary") return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Send-window computation.
//
// Returns the next moment we should consider this lead worth contacting.
// Returning null means "send-anytime" (default behaviour). The orchestrator
// queue filters by `nextOutreachWindow IS NULL OR <= NOW()`.
//
// Windows we consider (earliest of):
//   1. New director appointed in last 90 days → contact in next 14 days
//      (mandate-honeymoon window)
//   2. Year-end + 4-6 weeks → founder is buried in admin, high receptivity
//   3. Accounts due date - 4-6 weeks → same energy
//   4. Incorporation 5/10/15/20 year anniversary +/- 2 weeks
//
// If all candidate windows are in the past, return null (send any time).
// ---------------------------------------------------------------------------

export interface SendWindow {
  at: Date;
  reason: string;
}

const POST_YE_OFFSET_DAYS = 35;
const PRE_DEADLINE_OFFSET_DAYS = 35;

export function computeNextSendWindow(opts: {
  incorporatedOn: Date | null;
  accountsLastMadeUpTo: Date | null;
  accountsNextDue: Date | null;
  latestDirectorAppointedOn: Date | null;
  now?: Date;
}): SendWindow | null {
  const now = opts.now ?? new Date();
  const candidates: SendWindow[] = [];

  // 1. New director honeymoon
  if (opts.latestDirectorAppointedOn) {
    const ageDays = (now.getTime() - opts.latestDirectorAppointedOn.getTime()) / (24 * 3600_000);
    if (ageDays >= 0 && ageDays <= 90) {
      candidates.push({ at: now, reason: "new-director-honeymoon" });
    }
  }

  // 2. Year-end + ~5 weeks (next year)
  if (opts.accountsLastMadeUpTo) {
    const yeMonth = opts.accountsLastMadeUpTo.getUTCMonth();
    const yeDay = opts.accountsLastMadeUpTo.getUTCDate();
    let next = new Date(Date.UTC(now.getUTCFullYear(), yeMonth, yeDay));
    if (next <= now) next = new Date(Date.UTC(now.getUTCFullYear() + 1, yeMonth, yeDay));
    next = new Date(next.getTime() + POST_YE_OFFSET_DAYS * 24 * 3600_000);
    candidates.push({ at: next, reason: "post-year-end" });
  }

  // 3. Accounts deadline - ~5 weeks
  if (opts.accountsNextDue) {
    const pre = new Date(opts.accountsNextDue.getTime() - PRE_DEADLINE_OFFSET_DAYS * 24 * 3600_000);
    if (pre > now) candidates.push({ at: pre, reason: "pre-accounts-deadline" });
  }

  // 4. Incorporation 5/10/15/20-year anniversary
  if (opts.incorporatedOn) {
    const inc = opts.incorporatedOn;
    const yearsOld = (now.getTime() - inc.getTime()) / (365.25 * 24 * 3600_000);
    const milestones = [5, 10, 15, 20, 25, 30];
    for (const m of milestones) {
      if (yearsOld < m) {
        const at = new Date(Date.UTC(inc.getUTCFullYear() + m, inc.getUTCMonth(), inc.getUTCDate()));
        // Open the window 2 weeks before the anniversary
        const at2w = new Date(at.getTime() - 14 * 24 * 3600_000);
        candidates.push({ at: at2w, reason: `${m}-year-anniversary` });
        break;
      }
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.at.getTime() - b.at.getTime());
  return candidates[0];
}

// ---------------------------------------------------------------------------
// Build the "company facts block" — a plain-text dossier the drafter and
// scorer use to ground their copy. Authoritative, no Gemini guessing.
// ---------------------------------------------------------------------------

export function buildCompanyFactsBlock(opts: {
  businessName: string;
  companiesHouseNumber: string | null;
  incorporatedOn: Date | null;
  accountsCategory: string | null;
  sicCodes: string[];
  signals: ChSignalSummary;
  accounts: ParsedAccounts | null;
  vatRegistered: boolean | null;
  vatNumber: string | null;
}): string {
  const lines: string[] = [];
  lines.push(`Company: ${opts.businessName}${opts.companiesHouseNumber ? ` (CRN ${opts.companiesHouseNumber})` : ""}`);
  if (opts.incorporatedOn) {
    const years = Math.floor((Date.now() - opts.incorporatedOn.getTime()) / (365.25 * 24 * 3600_000));
    lines.push(`Founded: ${opts.incorporatedOn.toISOString().slice(0, 10)} (${years} years).`);
  }
  if (opts.accountsCategory) lines.push(`Accounts category: ${opts.accountsCategory}.`);
  if (opts.sicCodes.length > 0) lines.push(`SIC codes: ${opts.sicCodes.join(", ")}.`);

  if (opts.signals.primaryDirectorName) {
    const since = opts.signals.earliestDirectorAppointedOn
      ? `, in role since ${opts.signals.earliestDirectorAppointedOn.toISOString().slice(0, 10)}`
      : "";
    lines.push(`Primary director: ${opts.signals.primaryDirectorName} (${opts.signals.primaryDirectorRole ?? "director"})${since}.`);
  }
  if (opts.signals.directorCount != null) lines.push(`Active directors: ${opts.signals.directorCount}.`);
  if (opts.signals.signals.includes("new_director_recent") && opts.signals.latestDirectorAppointedOn) {
    lines.push(`Most recent appointment: ${opts.signals.latestDirectorAppointedOn.toISOString().slice(0, 10)} — in mandate-honeymoon window.`);
  }

  if (opts.accounts?.hasFinancials) {
    if (opts.accounts.turnover != null) {
      const cur = `£${formatGbp(Number(opts.accounts.turnover))}`;
      let line = `Turnover (latest filed): ${cur}`;
      if (opts.accounts.priorTurnover != null && opts.accounts.priorTurnover > 0n) {
        const growth = (Number(opts.accounts.turnover) - Number(opts.accounts.priorTurnover)) / Number(opts.accounts.priorTurnover);
        line += `, ${(growth * 100).toFixed(0)}% YoY (prior £${formatGbp(Number(opts.accounts.priorTurnover))})`;
      }
      lines.push(line + ".");
    }
    if (opts.accounts.employeeCount != null) {
      let line = `Average employees: ${opts.accounts.employeeCount}`;
      if (opts.accounts.priorEmployeeCount != null) {
        line += ` (prior year ${opts.accounts.priorEmployeeCount})`;
      }
      lines.push(line + ".");
    }
    if (opts.accounts.madeUpTo) {
      lines.push(`Accounts made up to: ${opts.accounts.madeUpTo.toISOString().slice(0, 10)}.`);
    }
  }

  if (opts.signals.accountsNextDue) {
    lines.push(`Next accounts due: ${opts.signals.accountsNextDue.toISOString().slice(0, 10)}.`);
  }
  if (opts.signals.activeChargesCount && opts.signals.activeChargesCount > 0) {
    lines.push(`Outstanding charges: ${opts.signals.activeChargesCount}.`);
  } else if (opts.signals.activeChargesCount === 0) {
    lines.push(`No outstanding charges.`);
  }

  if (opts.vatRegistered === true) {
    lines.push(`VAT-registered${opts.vatNumber ? ` (GB${opts.vatNumber})` : ""}.`);
  } else if (opts.vatRegistered === false) {
    lines.push(`Not VAT-registered.`);
  }

  if (opts.signals.signals.length > 0) {
    lines.push(`CH signals: ${opts.signals.signals.join(", ")}.`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeDate(iso: string): Date | null {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

function daysAgo(d: Date): number {
  return Math.floor((Date.now() - d.getTime()) / (24 * 3600_000));
}

function formatGbp(n: number): string {
  if (!isFinite(n)) return "?";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}m`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(Math.round(n));
}

function emptySummary(): ChSignalSummary {
  return {
    directorCount: null,
    earliestDirectorAppointedOn: null,
    latestDirectorAppointedOn: null,
    primaryDirectorName: null,
    primaryDirectorRole: null,
    pscCount: null,
    registeredOfficeMovedOn: null,
    recentChargeCreatedOn: null,
    activeChargesCount: null,
    accountsLastMadeUpTo: null,
    accountsNextDue: null,
    confirmationNextDue: null,
    signals: [],
    preScore: 0,
    preScoreReasons: [],
    hardExclude: false,
    hardExcludeReason: null,
  };
}
