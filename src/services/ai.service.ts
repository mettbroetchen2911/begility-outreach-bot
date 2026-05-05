import { GoogleGenAI } from "@google/genai";
import {
  getNicheConfig,
  getBrandContextPrompt,
  getEmailSignature,
} from "../config/niche.js";
import { withRetry } from "../utils/retry.js";
import { callClaudeSonnetJson } from "../utils/bedrock.js";

// ---------------------------------------------------------------------------
// Model routing
//   - Pro / quality-sensitive calls (brand-fit scoring) → Claude Sonnet on AWS Bedrock
//   - Flash / high-volume calls (research, sentiment, follow-up, goodbye)
//     → Gemini 2.5 Flash
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResearchResult {
  owner_name: string | null;
  website: string | null;
  email: string | null;
  phone: string | null;
  linkedin: string | null;
  location: string | null;
  description: string | null;
  employee_count_estimate: string | null;
  tech_stack_signals: string[] | null;
  operational_signals: string[] | null;
  search_confidence: number;
}

export interface ScoringResult {
  brand_fit_score: number;
  brand_fit_rationale: string;
  recommended_tier: "Tier1" | "Tier2" | "Exclude";
  confidence: "high" | "medium" | "low";
  primary_pain_hypothesis: string;
  suggested_lane: "Lead Systems" | "Workflow Automation" | "Operational Visibility" | "Mixed";
}

export interface EmailDraftResult {
  subject_line: string;
  email_body_html: string;
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

  /** Default Flash model from niche config */
  private get model(): string {
    return getNicheConfig().geminiModel;
  }

  // -------------------------------------------------------------------------
  // Shared helper — call Gemini Flash with retry, extract JSON
  // -------------------------------------------------------------------------
  private async callGemini<T>(opts: {
    systemPrompt: string;
    userPrompt: string;
    temperature: number;
    maxTokens: number;
    enableSearch: boolean;
    label: string;
    thinkingBudget?: number;
  }): Promise<T> {
    const tools = opts.enableSearch ? [{ googleSearch: {} }] : undefined;

    return withRetry(
      async () => {
        const response = await this.client.models.generateContent({
          model: this.model,
          contents: [{ role: "user", parts: [{ text: opts.userPrompt }] }],
          config: {
            systemInstruction: opts.systemPrompt,
            temperature: opts.temperature,
            maxOutputTokens: opts.maxTokens,
            tools,
            ...(opts.thinkingBudget != null && {
              thinkingConfig: { thinkingBudget: opts.thinkingBudget },
            }),
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
            `Gemini Flash returned unparseable JSON for ${opts.label}.\n` +
              `Raw (first 500): ${rawText.slice(0, 500)}\nError: ${err}`
          );
        }
      },
      opts.label,
      { maxAttempts: 5, baseDelayMs: 5000 }
    );
  }

  // -------------------------------------------------------------------------
  // 1. RESEARCH — Google Search ENABLED (Flash — high-volume structured extraction)
  //
  // For Begility, we care about operational signals: team size, tech stack
  // hints (CRM / booking / scheduling / case-management software references),
  // and observable process pain (manual booking, phone-only contact, no
  // online booking, no live chat, outdated site, missing CRM, etc.).
  // -------------------------------------------------------------------------
  async runResearch(businessName: string, city?: string): Promise<ResearchResult> {
    const config = getNicheConfig();
    const locationHint = city ? ` located in ${city}` : "";

    return this.callGemini<ResearchResult>({
      label: `research:${businessName}`,
      systemPrompt:
        "You are a B2B operations researcher working for an AI consultancy that only sells to businesses with visible operational drag. You search the web and return valid JSON only — no preamble, no markdown.",
      userPrompt: `Search Google for the ${config.nicheTag} called '${businessName}'${locationHint}.

Return a single JSON object with these exact keys:

{
  "owner_name": "Founder, MD, operations director, or senior decision-maker. null if not found.",
  "website": "Full URL including https://. null if not found.",
  "email": "Best direct contact email for the decision-maker. Prefer named personal addresses over generic info@/hello@. null if not found.",
  "phone": "Main business phone. null if not found.",
  "linkedin": "Company LinkedIn URL or handle. null if not found.",
  "location": "City and country.",
  "description": "2-3 sentences: what this business does, who they serve, and how they position themselves.",
  "employee_count_estimate": "Rough team size if you can tell (e.g. '10-20 staff', 'boutique 5-person firm', '50+ across three offices'). null if not inferable.",
  "tech_stack_signals": ["Short list of observable software / systems references — e.g. 'uses Bullhorn CRM', 'booking via Setmore', 'Xero badge in footer', 'WhatsApp-only contact', 'phone-only booking'. Empty array if nothing observable."],
  "operational_signals": ["Short list of observable operational friction or sophistication signals — e.g. 'no online booking', 'contact form only', 'team page shows 30+ staff but only one shared inbox', 'three office locations', 'blog last updated 2022'. Empty array if nothing observable."],
  "search_confidence": 0-100 integer confidence this is the correct business
}

Return ONLY the JSON object. No markdown. No preamble.`,
      temperature: 0.1,
      maxTokens: 4096,
      enableSearch: false,
      thinkingBudget: 2048,
    });
  }

  // -------------------------------------------------------------------------
  // 2. BRAND FIT SCORING — Claude Sonnet on Bedrock
  //
  // This is the most reasoning-heavy call in the pipeline: the rationale it
  // produces is injected directly into the outreach draft prompt, so rationale
  // quality determines email quality. Runs on Sonnet.
  // -------------------------------------------------------------------------
  async scoreBrandFit(researchJson: unknown, companyFactsBlock?: string | null): Promise<ScoringResult> {
    const config = getNicheConfig();
    const researchStr =
      typeof researchJson === "string"
        ? researchJson
        : JSON.stringify(researchJson, null, 2);

    const factsSection = companyFactsBlock
      ? `\n\nAUTHORITATIVE COMPANIES HOUSE / HMRC FACTS (these are the source of truth — they come from filings, not website inference. Override anything in the research data that contradicts them):
${companyFactsBlock}\n`
      : "";

    return callClaudeSonnetJson<ScoringResult>({
      label: "scoring",
      systemPrompt:
        `You are a senior operations analyst at ${config.brandName}, an AI consultancy that sells operational change — not AI theatre. ` +
        `You have spent a decade inside real UK SMEs and can spot operational drag from surface signals. ` +
        `Your rationales must be specific enough to inform a personalised cold email — generic assessments are useless. Return JSON only.`,
      userPrompt: `You are evaluating a UK SME as a potential client for ${config.brandName}.

${getBrandContextPrompt()}
${factsSection}
BUSINESS RESEARCH DATA (from web search — may be incomplete or out-of-date):
${researchStr}

TASK: Score this business 0-100 on fit as a Begility client. Fit means:
(a) they are a UK founder-led / owner-managed business in our size band,
(b) there is visible evidence of operational drag (manual admin, missed leads, weak follow-up, booking friction, poor handoffs, patchy systems),
(c) they appear cashflow-capable of buying a real fix — not a low-budget bootstrapped microbusiness,
(d) the pain is in one of our three lanes: Lead Systems, Workflow Automation, or Operational Visibility.

SCORING CRITERIA:
${config.scoringCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}

RATIONALE RULES — READ CAREFULLY:
- The rationale must be SPECIFIC to this business. Reference what you actually found in the research: their sector, size signals, tech_stack_signals, operational_signals, positioning.
- Explain WHY the fit exists or doesn't. Not "they look like a decent SME" but "their team page lists 18 consultants but the contact page has a single generic info@ inbox — classic handoff and lead-capture pain for a recruitment firm this size."
- The rationale will be passed verbatim into the outreach draft prompt, so it must contain enough concrete detail for a copywriter to name the pain specifically without guessing.
- 4-5 sentences. Direct, analytical, zero fluff.
- DO NOT mention prices, audit fees, discovery calls, or commercial terms in the rationale — those live in the draft, not the analysis.

ALSO RETURN:
- primary_pain_hypothesis: one sentence naming the single most likely operational pain, grounded in the signals (e.g. "Lead capture is manual and almost certainly leaking — no online booking, phone-only contact, and a team clearly too large to triage everything through one shared inbox.").
- suggested_lane: pick ONE — Lead Systems, Workflow Automation, Operational Visibility, or Mixed if more than one lane is equally strong.

TIER ASSIGNMENT:
- Tier1 (score >= ${config.tier1Threshold}): Strong fit on multiple criteria, visible operational pain, right sector/size — high-touch outreach with human approval.
- Tier2 (score ${config.tier2Threshold}-${config.tier1Threshold - 1}): Partial fit — worth approaching but lower priority. Signals present but thinner.
- Exclude (score < ${config.tier2Threshold}): Wrong size, wrong geography, no visible pain, agency / competitor, regulated edge case without clear boundary, or too small to buy a real fix.

CONFIDENCE:
- high: website + LinkedIn + clear positioning + named decision-maker + multiple operational signals
- medium: partial coverage — some gaps on decision-maker or signals
- low: minimal info, largely inferred from name / sector alone

Return a single JSON object only:

{
  "brand_fit_score": <integer 0-100>,
  "brand_fit_rationale": "<4-5 sentences: specific analysis referencing concrete research details>",
  "recommended_tier": "<Tier1 | Tier2 | Exclude>",
  "confidence": "<high | medium | low>",
  "primary_pain_hypothesis": "<one sentence naming the most likely operational pain>",
  "suggested_lane": "<Lead Systems | Workflow Automation | Operational Visibility | Mixed>"
}`,
      temperature: 0.2,
      maxTokens: 2048,
    });
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
      systemPrompt:
        "You are a reply sentiment analyst for a B2B consultancy sales team. You classify replies conservatively — when in doubt, escalate to human review rather than closing a lead prematurely. Return JSON only.",
      userPrompt: `Classify the sentiment of this reply to a cold outreach email from ${config.brandName}, an AI consultancy selling operational change to UK SMEs.

Business name: ${businessName ?? "Unknown"}
Original email subject: ${originalSubject ?? "Operational drag"}

Reply:
"${replyBody}"

CLASSIFICATION RULES — read carefully:

**positive** — Any signal the person is open to continuing: interest, questions, asking for a call or more info, naming a pain of their own, asking for a time, or even lukewarm curiosity. Treat "what would this look like?" / "happy to chat" / "send me something" as positive.

**soft_no** — Declines BUT leaves the door open: timing objections ("not right now", "maybe Q3", "we're heads-down"), uncertainty ("not sure this is for us"), addressable objections ("we already have someone looking at this", "we built something internally"), polite but non-committal replies. These are salvageable by a human — do NOT classify as hard_no.

**hard_no** — EXPLICIT and UNAMBIGUOUS request for no further contact. Look for: "stop emailing me", "unsubscribe", "remove me from your list", "do not contact again", hostile / angry tone, threats to report as spam, GDPR / data-deletion demands. ONLY classify as hard_no if a reasonable person would conclude the sender wants zero further communication.

**neutral** — Out-of-office auto-replies, forwarded to a colleague, irrelevant / confused replies, or genuinely unclear intent.

IMPORTANT: When in doubt between soft_no and hard_no, ALWAYS choose soft_no. A human reviewer can always close a lead — an auto-closed lead is a missed opportunity.

Return a single JSON object only:

{
  "sentiment": "<positive | soft_no | hard_no | neutral>",
  "confidence": "<high | medium | low>",
  "reasoning": "<1-2 sentences: specific words or signals that led to this classification>",
  "suggested_action": "<call | reply_email | send_goodbye | wait | manual_review>"
}`,
      temperature: 0.1,
      maxTokens: 2048,
      enableSearch: false,
      thinkingBudget: 1024,
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
    researchContext: {
      description?: string;
      linkedin?: string;
      location?: string;
      operational_signals?: string[];
      primary_pain_hypothesis?: string;
      suggested_lane?: string;
    };
    companyFactsBlock?: string | null;
  }): Promise<FollowUpResult> {
    const config = getNicheConfig();
    const signature = getEmailSignature();

    return this.callGemini<FollowUpResult>({
      label: `follow-up:${opts.businessName}`,
      systemPrompt: `You are a senior copywriter for ${config.brandName}, an AI consultancy. You write follow-ups that feel like a natural second touch from a real operator — never like an automated sequence. Return JSON only.`,
      userPrompt: `Write a follow-up email to a UK SME that hasn't replied to our first note.

${getBrandContextPrompt()}

Business: ${opts.businessName}
Days since first email: ${opts.daysSinceContact}
Original subject: ${opts.originalSubject}

Original email (for context — do NOT repeat or paraphrase it):
${opts.originalBodyPlain.slice(0, 400)}

Business research context:
${JSON.stringify(opts.researchContext, null, 2)}
${opts.companyFactsBlock ? `\nAUTHORITATIVE COMPANIES HOUSE / HMRC FACTS (override anything in the research that contradicts these — they're filing-derived, not website inference):\n${opts.companyFactsBlock}\n` : ""}

STRATEGY: The first email didn't land. This follow-up must take a DIFFERENT angle. Study the research context and switch lens: if the first note led with lead leakage, try admin / handoffs; if it led with process, try visibility / reporting; if it was broad, get specific on one observable signal. Another option: lower the commitment — instead of a discovery call, offer to send a short worked example or a one-pager of what we built for a similar business.

RULES:
- Do NOT repeat, summarise, or reference the original email's content directly
- One brief, natural acknowledgement of the first note (max 6 words, e.g. "Following up on my last note —")
- Lead with the NEW angle immediately
- Frame around their operational world, not ours
- Name ONE concrete pain or signal from the research context — specific, not generic
- Close with an even lower-friction ask than the original (a quick reply, a 15-minute call, or "happy to just send you the one-pager we use internally")
- Tone: ${config.outreachTone}
- 60-90 words. Shorter is better.
- NO pricing, NO audit fees, NO commercial terms. We never quote prices in cold outbound.
- Sign off with just: ${signature}
- Do NOT include title or brand in the sign-off — the email footer handles that.
- BANNED phrases: "just checking in", "circling back", "wanted to follow up", "bumping this", "any thoughts", "leverage", "synergy", "digital transformation", "AI journey"

Return a single JSON object only:

{
  "subject_line": "<subject referencing the original thread>",
  "email_body_html": "<HTML with <p> tags only>",
  "reasoning": "<1 sentence: the new angle this takes>"
}`,
      temperature: 0.8,
      maxTokens: 4096,
      enableSearch: false,
      thinkingBudget: 2048,
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
      systemPrompt: `You are a copywriter for ${config.brandName}. Write a graceful, brief close-out email. Return JSON only.`,
      userPrompt: `Write a short, warm close-out email to a UK SME that has asked not to be contacted further.

Brand: ${config.brandName}
Business: ${opts.businessName}
Owner / contact name: ${opts.ownerName ?? "Unknown"}
Original subject: ${opts.originalSubject}

Their reply (for tone-matching only — do NOT quote or reference specifics):
"${opts.replyBody.slice(0, 300)}"

RULES:
- Thank them for replying and being direct
- Confirm they won't hear from us again
- Leave one line open ("if anything changes, you know where to find us")
- Match their tone — if blunt, be concise. If polite, be warm.
- 40-60 words maximum
- Tone: ${config.outreachTone}
- NO apologies, NO grovelling, NO justification of the original outreach
- NO pricing, NO audit fees, NO commercial terms
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
    });
  }

  // -------------------------------------------------------------------------
  // 7. REPLY RESPONSE DRAFT — for positive / soft_no replies (Sonnet —
  //     quality matters because a response can win or lose the deal)
  //
  //     Crafts a personalised reply grounded in (a) the full Begility
  //     context, (b) what we know about their business, and (c) what they
  //     actually said. Invites them to name their single biggest operational
  //     pain so we can tailor a discovery call around it.
  // -------------------------------------------------------------------------
  async draftReplyResponse(opts: {
    businessName: string;
    ownerName: string | null;
    originalSubject: string;
    originalBodyPlain: string;
    replyBody: string;
    sentiment: "positive" | "soft_no" | "neutral";
    researchContext: unknown;
    brandFitRationale: string | null;
    primaryPainHypothesis: string | null;
    companyFactsBlock?: string | null;
  }): Promise<FollowUpResult> {
    const config = getNicheConfig();
    const signature = getEmailSignature();

    return callClaudeSonnetJson<FollowUpResult>({
      label: `reply-response:${opts.businessName}`,
      systemPrompt:
        `You are ${config.senderName}, founder of ${config.brandName}. You reply to cold-outbound responses personally, in your own voice. ` +
        `Dry, honest, founder-first, zero consultant jargon. You write short, specific, useful replies that move the conversation toward a discovery call by asking about THEIR pain, not pushing ours. Return JSON only.`,
      userPrompt: `Write a personal reply to a UK SME that responded to our cold outbound.

${getBrandContextPrompt()}

CONTEXT FOR THIS REPLY:

Business: ${opts.businessName}
Contact: ${opts.ownerName ?? "Unknown"}
Original subject: ${opts.originalSubject}
Sentiment of their reply: ${opts.sentiment}

Our original outreach (do NOT quote or repeat it):
${opts.originalBodyPlain.slice(0, 500)}

Their reply (read carefully — every word matters):
"""
${opts.replyBody.slice(0, 1500)}
"""

What we already know about their business (from research + scoring):
${typeof opts.researchContext === "string" ? opts.researchContext : JSON.stringify(opts.researchContext, null, 2)}
${opts.companyFactsBlock ? `\nAUTHORITATIVE COMPANIES HOUSE / HMRC FACTS (override the research above when they conflict — these are filing-derived):\n${opts.companyFactsBlock}\n` : ""}
Our internal fit rationale (for grounding only — do not quote):
${opts.brandFitRationale ?? "—"}

Our best guess at their primary operational pain:
${opts.primaryPainHypothesis ?? "—"}

WHAT A GOOD REPLY LOOKS LIKE (study this carefully — this is the target):

1. ACKNOWLEDGE WHAT THEY SAID. Thank them for the reply. If they raised a specific concern, objection, or question, name it back in your own words in one short sentence so they know you actually read it. Do not paraphrase verbatim, do not flatter.

2. DEMONSTRATE UNDERSTANDING OF THEIR BUSINESS. In one sentence, show you get what they actually do and the operational shape of it. Reference something concrete from research (their sector, size, positioning, or one specific signal) — not a generic compliment.

3. REFRAME AROUND THEIR PAIN, NOT OUR PITCH. Do NOT launch into what Begility sells. Instead, invite them to name the single biggest operational pain they're wrestling with right now. Phrase it like a real operator, e.g.:
   - "Before I send over anything tailored, it'd help to hear — what's the one thing that, if it ran itself tomorrow, would give you the most breathing room?"
   - "I'd rather not send a generic overview. What's the bit of the day-to-day that's currently costing you the most time or revenue?"
   - "If it's useful, happy to share how we'd think about it — but what's the specific bottleneck you're seeing most often right now?"
   Pick ONE variant, adapted to their tone and what they said. Never use the exact wording above.

4. LOW-FRICTION NEXT STEP. Offer either (a) a 20-30 minute call to walk through their answer, or (b) a reply by email if they'd rather keep it written. Their choice.

5. CLOSE. Sign off cleanly.

HARD RULES:
- Tone: ${config.outreachTone}. Operator-to-operator. No consulting voice.
- 110-160 words. Specific beats short.
- NO pricing, NO audit fees, NO "our diagnostic is £X", NO commercial terms whatsoever. We never quote prices in email.
- NO bullet points. NO headings. Plain paragraphs.
- NO em-dashes (—), en-dashes (–), or curly quotes. Use commas, full stops, straight quotes.
- NO generic compliments ("great site", "impressive team"). Only concrete specifics from research.
- NO phrases: "I hope this finds you well", "circling back", "just wanted to", "leverage", "synergy", "digital transformation", "AI journey", "unlock value", "at scale"
- If they asked a specific factual question (e.g. "do you work with firms outside London?"), ANSWER it directly in one sentence before pivoting to the pain question.
- If sentiment is soft_no, acknowledge the objection specifically, do not argue with it, and lower the ask (one email exchange, not a call).
- HTML body uses ONLY <p> tags — no styles, no divs, no lists.
- Last paragraph is the sign-off: <p>${signature}</p>

Return a single JSON object only:

{
  "subject_line": "Re: ${opts.originalSubject}",
  "email_body_html": "<HTML <p> tags only>",
  "reasoning": "<1 sentence: the specific angle this reply takes and why>"
}`,
      temperature: 0.75,
      maxTokens: 2048,
    });
  }
}
