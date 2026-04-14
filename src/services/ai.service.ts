import { GoogleGenAI } from "@google/genai";
import {
  getNicheConfig,
  getBrandContextPrompt,
  getEmailSignature,
} from "../config/niche.js";
import { withRetry } from "../utils/retry.js";

// ---------------------------------------------------------------------------
// Model routing — Pro for quality-sensitive calls, Flash for the rest
// ---------------------------------------------------------------------------
const PRO_MODEL = process.env.GEMINI_PRO_MODEL ?? "gemini-2.5-pro";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResearchResult {
  owner_name: string | null;
  website: string | null;
  email: string | null;
  phone: string | null;
  instagram: string | null;
  location: string | null;
  description: string | null;
  // ── Automation-opportunity signals (Begility-specific research output) ──
  services_offered: string | null;       // What the business actually sells/delivers
  team_size_estimate: string | null;     // e.g. "5-15", "20-50", "unknown"
  automation_signals: string[];          // Specific observable manual/repetitive work — e.g. "manual quote generation from PDF briefs"
  tech_stack_hints: string | null;       // CRM/tools they reference, or absence thereof
  growth_signals: string | null;         // Hiring, recent press, expansion, funding — anything suggesting operational pressure
  search_confidence: number;
}

export interface ScoringResult {
  brand_fit_score: number;
  brand_fit_rationale: string;
  recommended_tier: "Tier1" | "Tier2" | "Exclude";
  confidence: "high" | "medium" | "low";
}

export interface EmailDraftResult {
  subject_line: string;
  email_body_html: string;
}

export interface AutomationIdea {
  process: string;       // The specific manual process
  approach: string;      // How Begility would automate it (one sentence)
  impact: string;        // Plain-English outcome for the business
}

export interface SentimentResult {
  sentiment: "positive" | "soft_no" | "hard_no" | "neutral";
  confidence: "high" | "medium" | "low";
  reasoning: string;
  suggested_action: "call" | "reply_email" | "send_goodbye" | "wait" | "manual_review";
}

export interface FollowUpResult {
  subject_line: string;
  email_body_html: string;
  reasoning: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class AIService {
  private client: GoogleGenAI;

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY environment variable is required");

    this.client = new GoogleGenAI({ apiKey });
  }

  /** Default model (Flash) from niche config */
  private get model(): string {
    return getNicheConfig().geminiModel;
  }

  // -------------------------------------------------------------------------
  // Shared helper — call Gemini with retry, extract JSON
  // -------------------------------------------------------------------------
  private async callGemini<T>(opts: {
    systemPrompt: string;
    userPrompt: string;
    temperature: number;
    maxTokens: number;
    enableSearch: boolean;
    label: string;
    thinkingBudget?: number;
    modelOverride?: string; // Use Pro for quality-sensitive calls
  }): Promise<T> {
    const tools = opts.enableSearch ? [{ googleSearch: {} }] : undefined;
    const modelToUse = opts.modelOverride ?? this.model;

    return withRetry(
      async () => {
        const response = await this.client.models.generateContent({
          model: modelToUse,
          contents: [{ role: "user", parts: [{ text: opts.userPrompt }] }],
          config: {
            systemInstruction: opts.systemPrompt,
            temperature: opts.temperature,
            maxOutputTokens: opts.maxTokens,
            tools,
          },
        });

        const rawText = response.text ?? "";
        const cleaned = rawText
          .replace(/^```(?:json)?\n?/g, "")
          .replace(/\n?```$/g, "")
          .trim();

        try {
          return JSON.parse(cleaned) as T;
        } catch (err) {
          throw new Error(
            `Gemini returned unparseable JSON for ${opts.label} (model: ${modelToUse}).\n` +
            `Raw (first 500): ${rawText.slice(0, 500)}\nError: ${err}`
          );
        }
      },
      opts.label,
      { maxAttempts: 3, baseDelayMs: 2000 }
    );
  }

  // -------------------------------------------------------------------------
  // 1. RESEARCH — Google Search ENABLED (Flash — high volume, structured extraction)
  //
  // For Begility we don't just extract contact info. We hunt for signals
  // about HOW the business runs: what manual/repetitive work is visible,
  // what tools they use, and what growth pressure they're under. These
  // signals feed directly into the scoring and email-draft steps so the
  // outbound email can propose SPECIFIC automation ideas, not generic
  // "we do AI consulting" pitches.
  // -------------------------------------------------------------------------
  async runResearch(businessName: string, city?: string): Promise<ResearchResult> {
    const config = getNicheConfig();
    const locationHint = city ? ` located in ${city}` : "";

    return this.callGemini<ResearchResult>({
      label: `research:${businessName}`,
      systemPrompt: "You are a B2B research analyst working for an AI automation consultancy. Your job is to surface concrete operational signals a consultant could use to propose automation. Never fabricate. Return valid JSON only. No preamble.",
      userPrompt: `Search Google for the business called '${businessName}'${locationHint}. The target profile we care about is: ${config.nicheTag}.

Dig into their website, LinkedIn, Google Business Profile, job postings, Companies House / state registry records, case studies, press mentions, and any publicly visible documentation of how they work. We are hunting for OPERATIONAL signals — the kinds of manual, repetitive, labour-intensive work an AI consultancy could help them automate.

Return a single JSON object with these exact keys:

{
  "owner_name": "Full name of founder, managing director, owner, or senior decision-maker (operations director / head of ops also acceptable). null if not found.",
  "website": "Full URL including https://. null if not found.",
  "email": "Best direct contact email for the decision-maker. Prefer a named personal address (firstname@...) over generic info@ / hello@ — but return the generic one if that's all you find. null if not found.",
  "phone": "Phone number. null if not found.",
  "instagram": "Instagram handle without @. null if not found.",
  "location": "City and country.",
  "description": "2-3 sentences: what this business actually does, who they serve, their positioning, and anything distinctive about how they deliver.",
  "services_offered": "1-2 sentences listing the concrete services/products they sell. Be specific — 'bookkeeping, year-end accounts, VAT returns for SMEs' beats 'accounting services'.",
  "team_size_estimate": "Rough headcount band as a string, e.g. '1-5', '5-15', '15-50', '50-200', '200+'. Use LinkedIn employee count, team page, or job postings to estimate. 'unknown' if no signal.",
  "automation_signals": [
    "An array of 2-5 SPECIFIC, observable indicators of manual or repetitive work happening inside this business.",
    "Each item should be a short phrase a human reviewer could verify. Examples of good signals:",
    "- 'Quotes generated manually from emailed client briefs (mentioned on services page)'",
    "- 'Job postings for data-entry admin and onboarding coordinator open >30 days'",
    "- 'Case study describes spreadsheet-based compliance reporting across 40+ clients'",
    "- 'Contact form says expect 48h response — suggests manual triage'",
    "- 'No customer portal visible; all intake appears to be email/phone'",
    "Return an empty array [] if genuinely no signals found — do NOT invent."
  ],
  "tech_stack_hints": "Any CRM, ERP, accounting, scheduling, or workflow tool they mention publicly (e.g. Xero, HubSpot, Salesforce, ServiceNow, a custom portal). Also note ABSENCE of tooling if that is visible. null if nothing found.",
  "growth_signals": "Evidence the business is under operational pressure and would benefit from automation — open roles, recent expansion, new office, press coverage, acquisition, funding, 'we're hiring' banners. null if none found.",
  "search_confidence": "Integer 0-100: confidence this is the correct business AND that the automation signals are real (not guessed)."
}

HARD RULES:
- Automation signals MUST be observable in public sources. If you cannot point to where you saw it, omit it.
- Do not list generic platitudes like "they could use AI" — only concrete manual processes.
- Do not invent job postings, team sizes, or tools.

Return ONLY the JSON object. No markdown. No preamble.`,
      temperature: 0.1,
      maxTokens: 6144,
      enableSearch: true,
      thinkingBudget: 4096,
      // Flash — this is structured extraction, doesn't need Pro reasoning
    });
  }

  // -------------------------------------------------------------------------
  // 2. BRAND FIT SCORING — Search DISABLED (PRO — reasoning quality matters)
  // -------------------------------------------------------------------------
  async scoreBrandFit(researchJson: unknown): Promise<ScoringResult> {
    const config = getNicheConfig();
    const researchStr = typeof researchJson === "string"
      ? researchJson
      : JSON.stringify(researchJson, null, 2);

    return this.callGemini<ScoringResult>({
      label: "scoring",
      systemPrompt: `You are an AI automation consultant evaluating whether a business is a realistic, high-value fit for a bespoke automation engagement. You score conservatively — you'd rather exclude a borderline lead than waste outreach on a business where the automation story is generic. Your rationales must be specific enough that a copywriter can turn them directly into a personalised cold email proposing concrete automation ideas. Return JSON only.`,
      userPrompt: `You are evaluating a business as a potential client for ${config.brandName}, an AI consultancy that builds bespoke automations, agents, and integrations for operations-heavy SMBs.

${getBrandContextPrompt()}

Business research data (contains operational signals we already extracted):
${researchStr}

Score this business 0-100 on how good a fit they are for a paid Begility engagement. Evaluate against these criteria:
${config.scoringCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}

In addition, weight these automation-fit dimensions heavily:
A. How many CONCRETE manual/repetitive processes are visible in the research (quoting, intake, data entry, scheduling, reporting, onboarding, compliance, invoicing, document handling)? More specific signals = higher score.
B. Is the business large enough to afford a 5-figure engagement but small enough that a founder/director can approve it without a procurement process? Sweet spot: roughly 10-200 staff.
C. Is there a named, reachable decision-maker (founder, MD, ops director, partner)?
D. Is there growth pressure (hiring, expansion, backlog) that makes automation a "relieve pain" sell rather than a "nice to have" sell?
E. Is the business model services/operations-led (good fit) rather than pure product/e-commerce (usually a worse fit for Begility's playbook)?

RATIONALE RULES:
- The rationale must be SPECIFIC to this business. Reference the actual services they offer, the specific manual processes you can see, and the evidence of operational pressure.
- Name at least TWO concrete processes that look automatable, drawn directly from the research's automation_signals and services_offered fields.
- Do NOT write generic consultancy-speak like "digital transformation opportunities" or "they could benefit from AI". Every sentence must cite something observable.
- Explain WHY a Begility engagement would land here — what specific pain would we be relieving?
- 4-5 sentences. Be direct, analytical, and concrete enough that a copywriter could write the email from this rationale alone.

Tier assignment:
- Tier1 (score >= ${config.tier1Threshold}): Strong fit — multiple visible automation opportunities, reachable decision-maker, clear operational pressure. Warrants high-touch outreach with human approval.
- Tier2 (score ${config.tier2Threshold}-${config.tier1Threshold - 1}): Partial fit — some signals present but weaker evidence. Worth approaching at lower priority.
- Exclude (score < ${config.tier2Threshold}): Weak fit — no visible manual work, wrong business model, unreachable, or too small/too large.

Confidence reflects how much verifiable information you found:
- high: clear services, named decision-maker, 3+ concrete automation signals, growth evidence
- medium: some signals but gaps (vague services, no owner name, limited operational detail)
- low: minimal info, scoring based on niche category alone

Return a single JSON object only:

{
  "brand_fit_score": <integer 0-100>,
  "brand_fit_rationale": "<4-5 sentences: specific analysis citing at least two concrete automatable processes and the operational pressure that makes this business a fit for ${config.brandName}>",
  "recommended_tier": "<Tier1 | Tier2 | Exclude>",
  "confidence": "<high | medium | low>"
}`,
      temperature: 0.2,
      maxTokens: 4096,
      enableSearch: false,
      thinkingBudget: 2048,
      modelOverride: PRO_MODEL, // Pro — rationale quality feeds directly into email draft
    });
  }

  // -------------------------------------------------------------------------
  // 3. EMAIL DRAFTING (PRO — this is the output your leads actually read)
  // -------------------------------------------------------------------------
  async draftEmail(
    businessName: string,
    researchJson: unknown,
    rationale: string
  ): Promise<EmailDraftResult> {
    const config = getNicheConfig();
    const signature = getEmailSignature();
    const researchStr = typeof researchJson === "string"
      ? researchJson
      : JSON.stringify(researchJson, null, 2);

    const brandDomain = config.senderEmailDomain || "begility.com";

    const result = await this.callGemini<EmailDraftResult>({
      label: `draft:${businessName}`,
      systemPrompt: `You are a senior copywriter writing cold outbound from an AI automation consultancy to operations-heavy SMBs. Your emails feel like a founder-to-founder note, not a mass sequence. You lead with one or two specific, observable things about the reader's business, then propose concrete automation ideas that directly relieve manual pain you've spotted in the research. You write like a technically credible operator, not a corporate consultant. You never use buzzwords like "digital transformation", "synergies", "leverage", "unlock value", or "cutting-edge". Every email reads differently. Return JSON only.`,
      userPrompt: `Write a single cold outreach email from ${config.senderName} at ${config.brandName} to the decision-maker at ${businessName}.

ABOUT ${config.brandName.toUpperCase()} — the real facts to draw from:
${config.brandDescription}
- We are not a body-shop or a generic "AI agency". We build bespoke automations, agents, and integrations that replace specific manual processes inside a business.
- We run a portfolio of our own fully-automated companies, so we speak from operator experience, not slideware.
- We deliver in three shapes: (1) a short consultancy engagement to map automation opportunities and quantify ROI, (2) a fixed-scope build where we ship a working automation into their stack, and (3) ongoing AI integration support as processes evolve.
- Typical first engagements focus on one or two high-pain processes — not a boil-the-ocean transformation.
- Website: ${brandDomain}

Research on ${businessName} (use EVERYTHING here — especially automation_signals, services_offered, tech_stack_hints, and growth_signals):
${researchStr}

Fit rationale (this was written by our analyst and explains the concrete automation angle for this specific business — the email should echo the same reasoning in a human voice):
${rationale}

WHAT THE EMAIL MUST DO (in this order):

**PARA 1 — SPECIFIC HOOK FROM THEIR WORLD**: Use their first name. One short warm line. Then demonstrate in ONE sentence that you've actually looked at them — reference a concrete, verifiable detail from the research (a service they offer, a role they're hiring for, a case study, a process they describe on their site). Do NOT use vague compliments ("great website", "impressive work"). Name the specific thing. If the research mentions an open job posting or a specific service page, reference that.

**PARA 2 — THE AUTOMATION IDEAS (this is the whole point)**: Propose ONE or TWO specific automations you'd build for THEM, drawn directly from the automation_signals in the research. For each idea, in plain English: name the manual process → say what an automation would do → say what it would unlock (time back, fewer errors, faster turnaround, no new hires needed). Make it feel like you've thought about their business for 20 minutes, not 20 seconds. Do NOT promise outcomes in percentages you can't back up. Examples of the right shape (do not copy verbatim, adapt to the actual research):
- "The way you currently triage client briefs by email is exactly the kind of thing we'd wrap in an agent — it would read each brief, pull the relevant scope from your service library, and draft the quote for a human to approve. You keep the judgement, lose the typing."
- "Your job posts for a compliance admin suggest the year-end pack work is still manual. We've built that exact pipeline for another accountancy — Xero and Companies House data in, draft pack out, partner reviews instead of assembles."
The FIRST time ${config.brandName} is mentioned in the email body, include the domain in brackets immediately after, like this: ${config.brandName} (${brandDomain}). Only do this once in the whole email.

**PARA 3 — LOW-FRICTION CALL TO ACTION**: Make it easy to say yes. Offer a 20-30 minute call where you'll walk them through how you'd actually build the ideas you just mentioned — no slides, no pitch deck, just a working sketch. Frame it as useful to them even if they never hire you. Keep the close warm, direct, and low-pressure.

VARIATION: Every email must read differently. Vary sentence openings, rhythm, and the specific automations you propose. Write as if this is the only email you're sending today.

HARD RULES:
- 130-180 words total. Tight, technical, human.
- The first mention of ${config.brandName} in the email body MUST be followed by (${brandDomain}) in brackets. Only once.
- Do NOT use em-dashes anywhere in the email. Use commas, full stops, or short sentences instead.
- Do NOT use these banned phrases: "digital transformation", "unlock", "synergies", "leverage", "cutting-edge", "revolutionary", "game-changing", "in today's fast-paced", "I hope this email finds you well", "I wanted to reach out", "just touching base".
- Do NOT offer free audits, free trials, or discounts.
- Do NOT list benefits as bullet points — keep it in flowing prose.
- Do NOT make up client names, numbers, or case studies. If you reference another client, keep it anonymous ("another accountancy of similar size", "a logistics firm we work with").
- The automation ideas MUST be grounded in the research. If the research has no clear automation signals, propose the most likely process for a business of their type and say "I'd want to confirm this on a call" — never fabricate a problem they don't have.
- Sign off with ONLY: ${signature} (the email footer already has title, brand, website)
- Tone: ${config.outreachTone}

Return a single JSON object:

{
  "subject_line": "<max 60 chars. Specific to this business and hints at the automation angle. Examples: 'Automating your quote flow, ${businessName}', 'Idea for your year-end pack process', 'Quick thought on ${businessName}'s intake'. Never use clickbait or FW:/RE: tricks.>",
  "email_body_html": "<HTML with <p> tags only, no styles. Final line: <p>${signature}</p>>"
}`,
      temperature: 0.8,
      maxTokens: 8192,
      enableSearch: false,
      thinkingBudget: 4096,
      modelOverride: PRO_MODEL, // Pro — this is what the lead actually reads
    });

    // Strip em-dashes that may slip through
    result.email_body_html = result.email_body_html.replace(/\u2014/g, ",").replace(/\u2013/g, ",");
    result.subject_line = result.subject_line.replace(/\u2014/g, ",").replace(/\u2013/g, ",");

    return result;
  }

  // -------------------------------------------------------------------------
  // 4. REPLY SENTIMENT ANALYSIS — Search DISABLED (Flash — classification task)
  // -------------------------------------------------------------------------
  async analyzeReplySentiment(
    replyBody: string,
    businessName?: string,
    originalSubject?: string
  ): Promise<SentimentResult> {
    const config = getNicheConfig();

    return this.callGemini<SentimentResult>({
      label: `sentiment:${businessName ?? "unknown"}`,
      systemPrompt: "You are a reply sentiment analyst for a B2B AI consultancy's outbound team. You classify replies conservatively — when in doubt, escalate to human review rather than closing a lead prematurely. Procurement questions, pricing pushback, and 'send me more info' are ALL positive signals, not objections. Return JSON only.",
      userPrompt: `Classify the sentiment of this reply to a cold outreach email from ${config.brandName}, an AI automation consultancy. The original email proposed specific automations for their business and asked for a call.

Business name: ${businessName ?? "Unknown"}
Original email subject: ${originalSubject ?? "Automation idea"}

Reply:
"${replyBody}"

CLASSIFICATION RULES — read carefully:

**positive** — The person shows interest, asks questions (including pricing, scope, timelines, case studies, references), wants to learn more, suggests a call, forwards to a colleague, or gives any signal they're open to continuing. "Send me more info", "what would this cost?", and "what other clients have you worked with?" are ALL positive. Even lukewarm curiosity counts as positive.

**soft_no** — The person declines BUT leaves the door open, gives timing objections ("not right now", "maybe after Q3", "we're in the middle of another project"), expresses uncertainty ("not sure this is for us"), raises addressable objections ("we already have an internal dev team", "we tried an AI project last year"), or is polite but non-committal. These leads are salvageable by a human — do NOT classify as hard_no.

**hard_no** — The person EXPLICITLY and UNAMBIGUOUSLY wants no further contact. Look for: "stop emailing me", "unsubscribe", "not interested do not contact again", "remove me from your list", hostile or angry tone, threats to report as spam. ONLY classify as hard_no if a reasonable person would read this reply and conclude the sender wants zero further communication.

**neutral** — Out-of-office auto-replies, forwarded to a colleague, irrelevant/confused replies, or replies where intent is genuinely unclear.

IMPORTANT: When in doubt between soft_no and hard_no, ALWAYS choose soft_no. A human reviewer can always close a lead — but an auto-closed lead is a missed opportunity.

Return a single JSON object only:

{
  "sentiment": "<positive | soft_no | hard_no | neutral>",
  "confidence": "<high | medium | low>",
  "reasoning": "<1-2 sentences: what specific words or signals in this reply led to this classification>",
  "suggested_action": "<call | reply_email | send_goodbye | wait | manual_review>"
}`,
      temperature: 0.1,
      maxTokens: 2048,
      enableSearch: false,
      thinkingBudget: 1024,
      // Flash — straightforward classification, doesn't need Pro
    });
  }

  // -------------------------------------------------------------------------
  // 5. FOLLOW-UP DRAFTING — Search DISABLED (Flash — shorter, simpler email)
  // -------------------------------------------------------------------------
  async draftFollowUp(opts: {
    businessName: string;
    daysSinceContact: number;
    originalSubject: string;
    originalBodyPlain: string;
    researchContext: { description?: string; instagram?: string; location?: string };
  }): Promise<FollowUpResult> {
    const config = getNicheConfig();
    const signature = getEmailSignature();

    return this.callGemini<FollowUpResult>({
      label: `follow-up:${opts.businessName}`,
      systemPrompt: `You are a senior outbound writer for ${config.brandName}, an AI automation consultancy. You write follow-ups that feel like a natural second touch from a real operator — never like a drip-sequence step 2. The first email proposed an automation idea; this one must land a DIFFERENT angle. Return JSON only.`,
      userPrompt: `Write a follow-up email to a business that hasn't replied to our initial automation outreach.

${getBrandContextPrompt()}

Business: ${opts.businessName}
Days since first email: ${opts.daysSinceContact}
Original subject: ${opts.originalSubject}

Original email (for context — do NOT repeat or paraphrase it):
${opts.originalBodyPlain.slice(0, 400)}

Business research context:
${JSON.stringify(opts.researchContext, null, 2)}

STRATEGY: The first email didn't land. Do not re-sell the same automation idea louder. Pick ONE of these angles and commit:
1. A DIFFERENT automatable process from the same business — if the first email hit their quoting flow, this one hits their reporting or onboarding.
2. A micro-asset offer — "happy to send a 1-page sketch of how we'd wire this up for you, zero strings" — lower-commitment than a call.
3. A relevant example — "we just finished something similar for [anonymous description of another client of similar shape]" — proof without a case-study PDF.
4. A timing-aware nudge — if they're visibly hiring for a role that automation would replace, call that out gently.

RULES:
- Do NOT repeat, summarise, or reference the first email's specific automation idea.
- One brief, natural acknowledgement that you reached out before (max 6 words, e.g. "Quick follow-up on my note,").
- Lead with the NEW angle in the first real sentence.
- Frame around THEIR world and their pain, not ${config.brandName}'s services.
- Close with a lower-friction ask than the original (e.g. "worth me sending a quick sketch?" instead of "worth a call?").
- Tone: ${config.outreachTone}
- 70-110 words. Shorter is better. Dense is fine.
- No em-dashes. No bullet points.
- Sign off with just: ${signature}
- Do NOT include title or brand in the sign-off — the email footer handles that.
- BANNED phrases: "just checking in", "circling back", "wanted to follow up", "bumping this", "any thoughts", "did you see my last email", "touching base", "gentle nudge".

Return a single JSON object only:

{
  "subject_line": "<subject referencing the original thread, e.g. 'Re: ${opts.originalSubject}' or a short new angle>",
  "email_body_html": "<HTML with <p> tags only>",
  "reasoning": "<1 sentence: what new angle this takes and why>"
}`,
      temperature: 0.8,
      maxTokens: 4096,
      enableSearch: false,
      thinkingBudget: 2048,
      // Flash — shorter email, simpler task
    });
  }

  // -------------------------------------------------------------------------
  // 6. GOODBYE DRAFT — for hard_no replies (Flash — short, formulaic)
  // -------------------------------------------------------------------------
  async draftGoodbye(opts: {
    businessName: string;
    ownerName: string | null;
    originalSubject: string;
    replyBody: string;
  }): Promise<EmailDraftResult> {
    const config = getNicheConfig();
    const signature = getEmailSignature();

    return this.callGemini<EmailDraftResult>({
      label: `goodbye:${opts.businessName}`,
      systemPrompt: `You are an outbound writer for ${config.brandName}, an AI consultancy. Write a graceful, brief close-out email to a business that declined our automation outreach. Return JSON only.`,
      userPrompt: `Write a short, warm close-out email to a business that has declined our cold outreach about AI automation services.

Brand: ${config.brandName}
Business: ${opts.businessName}
Owner name: ${opts.ownerName ?? "Unknown"}
Original subject: ${opts.originalSubject}

Their reply (for tone-matching only — do NOT quote or reference specifics):
"${opts.replyBody.slice(0, 300)}"

RULES:
- Thank them for replying
- Confirm they won't hear from us again
- Leave the door open with one sentence ("if anything changes…")
- Match their tone — if they were blunt, be concise. If polite, be warm.
- 40-60 words maximum
- Tone: ${config.outreachTone}
- Sign off with just: ${signature}
- Do NOT include title or brand in the sign-off — the email footer handles that.

Return a single JSON object only:

{
  "subject_line": "Re: ${opts.originalSubject}",
  "email_body_html": "<HTML with <p> tags only>"
}`,
      temperature: 0.5,
      maxTokens: 2048,
      enableSearch: false,
      thinkingBudget: 512,
      // Flash — 40-60 word formulaic email, doesn't need Pro
    });
  }
}
