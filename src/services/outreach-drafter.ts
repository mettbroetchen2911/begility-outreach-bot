import {
  getNicheConfig,
  getEmailSignature,
  getBrandContextPrompt,
} from "../config/niche.js";
import { getConfig } from "./runtime-config.service.js";
import type { ScrapedDataV2 } from "./website-scraper-v2.js";
import { callClaudeSonnetJson } from "../utils/bedrock.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DraftContext {
  businessName: string;
  ownerName: string | null;
  firstName: string | null;
  city: string | null;
  country: string | null;
  /** Begility brand-fit rationale — specific, concrete analysis of this business. */
  rationale: string;
  /** One-sentence hypothesis of the single most likely operational pain. */
  primaryPainHypothesis?: string | null;
  /** Lane suggestion from scorer: Lead Systems / Workflow Automation / Operational Visibility / Mixed. */
  suggestedLane?: string | null;
  /** Sector if known (recruitment, estate agent, trades, etc.) — steers the pain angle. */
  sector?: string | null;
  /** Best-effort source page we found them on (homepage URL / linkedin handle). */
  sourcePage: string | null;
  sourceKind: "website" | "linkedin" | "google" | "unknown";
  /** v2 scrape payload — optional. When present, the prompt is richer. */
  scrape?: Partial<ScrapedDataV2> | null;
  /** Light-weight fallback when a v2 scrape isn't available. */
  researchJsonFallback?: unknown;
  /** Authoritative CH/HMRC facts block — turnover, headcount, director,
   * VAT, anniversaries. Grounds the email far better than scraped text. */
  companyFactsBlock?: string | null;
  /** If this lead was scheduled into a specific outreach window (e.g.
   * "post-year-end", "new-director-honeymoon", "10-year-anniversary"),
   * the drafter can lean into the timing as a credible warm hook. */
  sendWindowReason?: string | null;
}

export interface DraftResult {
  subject_line: string;
  email_body_html: string;
  word_count: number;
  was_retried: boolean;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function draftOutreachEmail(ctx: DraftContext): Promise<DraftResult> {
  const wordMin = await getConfig<number>("OUTREACH_WORD_MIN").catch(() => 110);
  const wordMax = await getConfig<number>("OUTREACH_WORD_MAX").catch(() => 160);
  const subjMax = await getConfig<number>("OUTREACH_SUBJECT_MAX_CHARS").catch(() => 55);
  const tone = await getConfig<string>("OUTREACH_TONE").catch(() => getNicheConfig().outreachTone);

  const warnings: string[] = [];

  // ── First attempt ──
  let { subject, bodyHtml } = await callClaude(ctx, { wordMin, wordMax, tone });
  let wc = countWords(bodyHtml);
  let retried = false;

  // ── Word-count enforcement: one retry with explicit feedback ──
  if (wc < wordMin - 10 || wc > wordMax + 15) {
    retried = true;
    warnings.push(`first draft was ${wc} words, retrying`);
    const direction =
      wc < wordMin - 10
        ? `too short — add one more specific concrete detail from their research and sharpen the pain sentence`
        : `too long — tighten to the band by cutting the weakest sentence`;
    const retry = await callClaude(ctx, {
      wordMin,
      wordMax,
      tone,
      retryDirection: direction,
    });
    subject = retry.subject;
    bodyHtml = retry.bodyHtml;
    wc = countWords(bodyHtml);
  }

  // ── Deterministic post-processing ──
  subject = postProcessSubject(subject, subjMax);
  bodyHtml = postProcessBody(bodyHtml, getNicheConfig().brandName, getSenderDomain());

  // Re-count after post-processing tweaks
  wc = countWords(bodyHtml);
  if (wc < wordMin - 15) warnings.push(`final word count ${wc} is below min ${wordMin}`);
  if (wc > wordMax + 20) warnings.push(`final word count ${wc} is above max ${wordMax}`);

  return {
    subject_line: subject,
    email_body_html: bodyHtml,
    word_count: wc,
    was_retried: retried,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Prompt construction — Claude Sonnet on Bedrock
// ---------------------------------------------------------------------------

async function callClaude(
  ctx: DraftContext,
  opts: { wordMin: number; wordMax: number; tone: string; retryDirection?: string }
): Promise<{ subject: string; bodyHtml: string }> {
  const config = getNicheConfig();
  const signature = getEmailSignature();
  const website = getSenderDomain();

  const greeting = buildGreeting(ctx);
  const sourceLine = buildSourceLine(ctx);
  const scrapeCtx = buildScrapeContext(ctx);
  const laneGuidance = buildLaneGuidance(ctx);
  const factsSection = ctx.companyFactsBlock
    ? `\nAUTHORITATIVE COMPANIES HOUSE / HMRC FACTS (these come from filings, not website inference — they are the source of truth and override anything in the research data that contradicts them. Do NOT print them as bullet points or quote them verbatim — use them to ground a single specific reference in the email):\n${ctx.companyFactsBlock}\n`
    : "";
  const windowGuidance = buildWindowGuidance(ctx.sendWindowReason);

  const retryNote = opts.retryDirection
    ? `\n\nPREVIOUS ATTEMPT FEEDBACK: ${opts.retryDirection}. Rewrite the body accordingly — same structure, same ${opts.wordMin}-${opts.wordMax} word band.`
    : "";

  const subjectMax = await getConfig<number>("OUTREACH_SUBJECT_MAX_CHARS").catch(() => 55);

  const systemPrompt =
    `You are ${config.senderName}, founder of ${config.brandName}. You write cold outbound emails yourself, in your own voice — ` +
    `dry, honest, founder-first, zero consultant jargon. You have run real businesses and can smell operational drag at thirty paces. ` +
    `Every email reads differently because every business is different. You would rather be quoted than polished. Return valid JSON only.`;

  const userPrompt = `Write a single cold outbound email from ${config.senderName} at ${config.brandName} to the senior decision-maker at ${ctx.businessName}.

${getBrandContextPrompt()}

OPENING REQUIREMENTS:
- Opening greeting MUST be exactly: "${greeting}"
- "How I found you" sentence MUST reference: ${sourceLine}
- Do NOT invent a different source — use the one above.

BUSINESS RESEARCH (from the website + Gemini search — may be incomplete):
${scrapeCtx}
${factsSection}
${windowGuidance}
BEGILITY FIT RATIONALE (our internal analysis of why this business was selected — use this to ground the "why them" sentence, but do NOT quote it verbatim):
${ctx.rationale}

PRIMARY PAIN HYPOTHESIS (our best guess at the single operational pain most likely hurting them — anchor the email on this, but frame it as an observation, not a diagnosis):
${ctx.primaryPainHypothesis ?? "—"}

LANE GUIDANCE:
${laneGuidance}

────────────────────────────────────────────────────────────
THE PERFECT BEGILITY OUTREACH EMAIL — STRUCTURE
────────────────────────────────────────────────────────────

This email has exactly FOUR short paragraphs. It is specific, short, and operator-to-operator. It does NOT pitch AI. It does NOT quote prices. It does NOT explain the whole of Begility. It does ONE thing well: name a specific operational pain we think they have, show we understand their business, and invite them to tell us what their biggest pain actually is.

PARA 1 — WARM OPENING + "WHY THEM" (1-2 sentences)
- Use the exact greeting above.
- One sentence acknowledging this is out of the blue (dry, not apologetic).
- Name ONE concrete thing from the research that caught your eye — their positioning, team size, a specific service line, a specific signal. Must feel like you actually looked, not like a mail-merge field. No generic compliments ("great website", "impressive team") — those are banned.

PARA 2 — THE OBSERVED PAIN (2-3 sentences — THE HEART OF THE EMAIL)
- Based on the primary_pain_hypothesis and research, describe the specific operational friction you'd expect to see in a business like theirs, framed as an observation from the outside. Examples of the texture (do not copy, adapt):
   * "For a recruitment firm with ~20 consultants, the bit that usually starts leaking first is candidate follow-up — CVs come in, someone means to get back to them by Friday, and by the time anyone looks, the candidate has gone somewhere that replied the same day."
   * "In trades businesses with a team behind the van, the bottleneck is almost always the office-to-field handoff — missed calls, quote delays, and reminders that depend on one person remembering to chase."
   * "Lettings businesses usually leak most money between enquiry and viewing — the lead lands, it sits in someone's inbox for a day, and by the time it's answered, the prospect has already booked with someone faster."
- It must be SPECIFIC to their sector / size / signals. Not "businesses like yours have admin issues" — that's useless.
- Do NOT claim certainty. Frame as "where firms like yours usually end up leaking time/leads/revenue" or "the bit that tends to go first". You have not been inside their business yet.
- Avoid the word "pain" itself — use "drag", "leak", "friction", "bottleneck", "the bit that tends to go first", etc.

PARA 3 — WHO WE ARE + THE ASK (2-3 sentences)
- The FIRST time ${config.brandName} is written in this paragraph, write it as: ${config.brandName} (${website}). Only once across the whole email. Never repeat the URL.
- One sentence on what we do — NOT as a pitch. E.g.: "We're a small UK outfit that helps founder-led businesses strip operational drag out of the back-office — AI and automation as the tool, tighter operations as the actual product." Adapt; do not copy.
- Critically — the ASK is a question, not a meeting. Invite them to tell us what THEIR single biggest operational drag is right now. Use one of these textures (adapt; do not copy):
   * "Worth a two-line reply — what's the one operational thing that, if it ran itself by the end of the quarter, would give you the most breathing room?"
   * "Rather than send over a generic overview: what's the bit of your day-to-day right now that's costing you the most time or the most revenue?"
   * "Happy to send over how we'd think about it — but first, what's the bit that's currently eating the most of your week?"
- The question must feel genuinely curious, not a thinly-disguised sales trap. We actually want to hear the answer.

PARA 4 — SIGN-OFF
- Single line: <p>${signature}</p>

────────────────────────────────────────────────────────────
HARD RULES
────────────────────────────────────────────────────────────
- Tone: ${opts.tone}
- ${opts.wordMin}-${opts.wordMax} words in the body (excluding greeting and sign-off).
- Subject line: ≤ ${subjectMax} chars, specific to THIS business — reference their sector, a specific signal, or the pain lens. Never "A quick question" or "Partnership opportunity" or anything generic.
- Write in plain English. No consulting voice. No buzzwords. No "leverage", "synergy", "unlock value", "digital transformation", "AI journey", "at scale", "best-in-class", "end-to-end", "holistic", "seamless".
- NO em-dashes (—), en-dashes (–), or curly quotes. Use commas, full stops, straight quotes.
- NO bullet points, NO headings, NO lists, NO tables. Paragraphs only.
- NO pricing. NO audit fees. NO "our diagnostic is…", NO "from £X", NO commercial terms whatsoever. Cold outbound never quotes prices.
- NO "free audit", "free consultation", "no obligation" language — that's what spam sounds like. We offer a conversation, nothing more.
- NO case-study name-drops, NO "we helped a FTSE firm", NO "clients like X" unless the research genuinely names someone — we don't lie.
- NO mention of the portfolio (Garlic Shop, allium., Skillity) unless it's directly relevant and concrete — don't name-dump.
- NO phrases that label the email as cold ("cold email", "cold outreach", "sorry for the interruption").
- NO "I hope this finds you well", NO "I came across your company", NO "just wanted to reach out".
- Do not promise outcomes or ROI numbers — you have not looked inside their business.
- Sign off with ONLY: ${signature} (one line, last paragraph).
- HTML body uses ONLY <p> tags — no styles, no divs, no lists, no inline formatting.${retryNote}

────────────────────────────────────────────────────────────

Return a single JSON object. No markdown, no preamble:

{
  "subject_line": "<max ${subjectMax} chars, specific to this business>",
  "email_body_html": "<HTML with <p> tags only, 4 paragraphs, ending with the signature>"
}`;

  const parsed = await callClaudeSonnetJson<{
    subject_line?: string;
    email_body_html?: string;
  }>({
    label: `outreach-draft:${ctx.businessName}`,
    systemPrompt,
    userPrompt,
    temperature: 0.8,
    maxTokens: 2048,
  });

  if (!parsed.subject_line || !parsed.email_body_html) {
    throw new Error("Claude returned JSON missing required fields");
  }
  return { subject: parsed.subject_line, bodyHtml: parsed.email_body_html };
}

// ---------------------------------------------------------------------------
// Greeting logic — null-safe, first-name preferred
// ---------------------------------------------------------------------------

function buildGreeting(ctx: DraftContext): string {
  const first = ctx.firstName ?? (ctx.ownerName ? ctx.ownerName.split(/\s+/)[0] : null);
  if (first && /^[A-Za-z'\-]{2,}$/.test(first)) {
    return `Hi ${first.charAt(0).toUpperCase()}${first.slice(1)},`;
  }
  return `Hi there,`;
}

// ---------------------------------------------------------------------------
// Source-line construction — grounded, not guessed
// ---------------------------------------------------------------------------

function buildSourceLine(ctx: DraftContext): string {
  if (ctx.sourceKind === "linkedin" && ctx.sourcePage) {
    return `you came across their LinkedIn while looking at ${ctx.city ? `${ctx.city}-based ` : "UK "}firms in their sector`;
  }
  if (ctx.sourceKind === "website" && ctx.sourcePage) {
    return `you were on their website while researching ${ctx.city ? `${ctx.city} ` : "UK "}businesses in their space`;
  }
  if (ctx.sourceKind === "google") {
    return `you found them on Google while mapping ${ctx.city ? `${ctx.city}-based ` : "UK "}firms in their sector`;
  }
  return `you came across them while researching${ctx.city ? ` ${ctx.city}-based` : " UK"} businesses in their sector`;
}

// ---------------------------------------------------------------------------
// Scrape context — richer when v2 payload is present
// ---------------------------------------------------------------------------

function buildScrapeContext(ctx: DraftContext): string {
  const s = ctx.scrape;
  if (!s) {
    return typeof ctx.researchJsonFallback === "string"
      ? ctx.researchJsonFallback
      : JSON.stringify(ctx.researchJsonFallback ?? {}, null, 2);
  }
  const lines: string[] = [];
  lines.push(`Name: ${ctx.businessName}`);
  if (s.location) lines.push(`Location: ${s.location}`);
  if (s.description) lines.push(`Description: ${s.description}`);
  if (s.positioning) lines.push(`Positioning: ${s.positioning}`);
  if (s.clientele) lines.push(`Clientele: ${s.clientele}`);
  if (s.services && s.services.length > 0)
    lines.push(`Services / lines of work: ${s.services.slice(0, 8).join(", ")}`);
  if ((s as any).employee_count_estimate) lines.push(`Team size: ${(s as any).employee_count_estimate}`);
  if ((s as any).tech_stack_signals && (s as any).tech_stack_signals.length)
    lines.push(`Tech / system signals: ${(s as any).tech_stack_signals.slice(0, 6).join("; ")}`);
  if ((s as any).operational_signals && (s as any).operational_signals.length)
    lines.push(`Operational signals: ${(s as any).operational_signals.slice(0, 6).join("; ")}`);
  if ((s as any).linkedin) lines.push(`LinkedIn: ${(s as any).linkedin}`);
  if (s.pages_scraped && s.pages_scraped.length > 0) {
    lines.push(`Pages looked at: ${s.pages_scraped.slice(0, 3).join(", ")}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Lane-specific guidance — steers the "observed pain" paragraph
// ---------------------------------------------------------------------------

function buildLaneGuidance(ctx: DraftContext): string {
  const lane = (ctx.suggestedLane ?? "").toLowerCase();
  if (lane.includes("lead")) {
    return [
      `Primary lane: LEAD SYSTEMS. Anchor the pain paragraph around lead capture, response speed, follow-up discipline, missed-call recovery, qualification, or booking friction.`,
      `Do not talk about automation in the abstract — talk about where leads fall out of the funnel in a business shaped like theirs.`,
    ].join("\n");
  }
  if (lane.includes("workflow")) {
    return [
      `Primary lane: WORKFLOW AUTOMATION. Anchor the pain paragraph around manual admin, handoffs between people or stages, approvals, reminders, status changes, or repetitive back-office tasks.`,
      `Be specific about WHICH handoff tends to break in their kind of business.`,
    ].join("\n");
  }
  if (lane.includes("visibility") || lane.includes("reporting")) {
    return [
      `Primary lane: OPERATIONAL VISIBILITY. Anchor the pain paragraph around weak pipeline or performance visibility, reporting that someone has to hand-build each week, or decisions being made on instinct rather than signal.`,
      `Name the kind of dashboard / report a founder in their sector usually wishes they had by Monday morning.`,
    ].join("\n");
  }
  if (lane.includes("mixed")) {
    return [
      `Primary lane: MIXED. Pick the single most concrete lane based on the research signals — do NOT list multiple lanes in the email.`,
      `If Lead Systems and Workflow Automation are both plausible, anchor on Lead Systems (it's more specific and easier to show understanding of).`,
    ].join("\n");
  }
  return `Lane: not specified — pick the most plausible lane from the research signals and anchor the pain paragraph there. Do not mention more than one lane in the email.`;
}

// ---------------------------------------------------------------------------
// Post-processing — enforce rules deterministically so the model cannot drift
// ---------------------------------------------------------------------------

function postProcessSubject(raw: string, maxChars: number): string {
  let s = normaliseCopy(raw);
  if (s.length > maxChars) {
    const cut = s.slice(0, maxChars);
    const lastSpace = cut.lastIndexOf(" ");
    s = lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut;
    s = s.replace(/[,\-–—:]\s*$/, "").trim();
  }
  return s;
}

function postProcessBody(raw: string, brandName: string, website: string): string {
  let html = normaliseCopy(raw);

  // 1. Strip any accidental occurrences of the website elsewhere, keeping
  //    only the FIRST post-brand mention.
  const brandRe = new RegExp(`\\b${escapeRegex(brandName)}\\b`, "gi");
  const firstBrandMatch = brandRe.exec(html);
  if (firstBrandMatch) {
    // Remove any existing "(begility.com)" ANYWHERE first.
    const siteRe = new RegExp(`\\s*\\(${escapeRegex(website)}\\)`, "gi");
    html = html.replace(siteRe, "");
    // Re-find brand (indexes shifted), then insert the bracketed site once after it.
    const after = html.search(brandRe);
    if (after !== -1) {
      const insertAt = after + brandName.length;
      html = `${html.slice(0, insertAt)} (${website})${html.slice(insertAt)}`;
    }
    brandRe.lastIndex = 0;
  }

  // 2. Guarantee wrapping in <p> tags if model returned plain text
  if (!/<p[\s>]/i.test(html)) {
    html = html
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => `<p>${p.replace(/\n/g, "<br/>")}</p>`)
      .join("\n");
  }

  return html;
}

function normaliseCopy(s: string): string {
  return s
    .replace(/\u2014/g, ",")  // em dash
    .replace(/\u2013/g, ",")  // en dash
    .replace(/\u2018|\u2019/g, "'")
    .replace(/\u201C|\u201D/g, '"')
    .replace(/\u2026/g, "...")
    .replace(/\s+\n/g, "\n")
    .trim();
}

function countWords(html: string): number {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getSenderDomain(): string {
  const raw = process.env.SENDER_EMAIL_DOMAIN ?? "";
  const cleaned = raw.replace(/^https?:\/\//i, "").replace(/\/$/, "").trim();
  return cleaned || "begility.com";
}

// ---------------------------------------------------------------------------
// Send-window guidance — when the orchestrator schedules outreach into a
// specific calendar window (post year-end, new-director honeymoon, 10-year
// anniversary, etc), nudge the drafter to lean on the timing as a credible
// warm hook. Subtle — never name "we waited until your year-end".
// ---------------------------------------------------------------------------

function buildWindowGuidance(reason: string | null | undefined): string {
  if (!reason) return "";
  switch (reason) {
    case "new-director-honeymoon":
      return "TIMING ANGLE: A new director was appointed in the last 90 days. New mandates are the most receptive moment to discuss operational change. The email may briefly note that fresh leadership is often the moment when operating habits get re-examined — but ONLY if it lands naturally. Never name this as a reason for emailing.\n";
    case "post-year-end":
      return "TIMING ANGLE: This business has just passed its financial year-end. Founders are typically deep in admin and looking at what last year actually cost. The email may briefly nod to that ('the period after year-end usually brings a clear-eyed look at where the time went') — only if it lands naturally.\n";
    case "pre-accounts-deadline":
      return "TIMING ANGLE: This business's accounts deadline is approaching. Same energy as post year-end — the founder is reviewing the year. Use lightly if at all.\n";
    case "5-year-anniversary":
    case "10-year-anniversary":
    case "15-year-anniversary":
    case "20-year-anniversary":
    case "25-year-anniversary":
    case "30-year-anniversary": {
      const years = reason.split("-")[0];
      return `TIMING ANGLE: This business is approaching ${years} years since incorporation. Anniversaries are a credible warm hook — a founder who has been running ${years} years will have heard every cold pitch in that time, and acknowledging the milestone (one short clause, no congratulations theatre) lands as humanity rather than a mail-merge.\n`;
    }
    default:
      return "";
  }
}
