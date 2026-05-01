import { GoogleGenAI } from "@google/genai";
import { prisma } from "../utils/prisma.js";
import { getNicheConfig } from "../config/niche.js";
import { withRetry } from "../utils/retry.js";
import { getConfig } from "./runtime-config.service.js";
import {
  extractFromHtml,
  extractAndRankSubpages,
  extractSitemapUrls,
  htmlToText,
  normaliseInstagramHandle,
  toE164,
  type RawExtract,
} from "../utils/scraper-extractors.js";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error("GEMINI_API_KEY environment variable is required");
const client = new GoogleGenAI({ apiKey });

// UA rotation — site owners block any single UA aggressively. Rotate.
const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
];

export interface ScrapedDataV2 {
  owner_name: string | null;
  email: string | null;
  alternate_emails: string[];
  phone: string | null;
  phone_e164: string | null;
  instagram: string | null;
  linkedin: string | null;
  facebook: string | null;
  twitter: string | null;
  tiktok: string | null;
  youtube: string | null;
  description: string | null;
  positioning: string | null;
  clientele: string | null;
  services: string[];
  website: string;
  location: string | null;
  address: string | null;
  postcode: string | null;
  people: Array<{ name: string; role?: string; source: string }>;
  confidence: "high" | "medium" | "low";
  pages_scraped: string[];
  scrape_ms: number;
  extraction_trace: {
    deterministic_emails: number;
    deterministic_phones: number;
    json_ld_blocks: number;
    people_found: number;
    subpages_fetched: number;
    gemini_used: boolean;
    cache_hit: boolean;
  };
}

// ── Per-process in-memory cache (fronts the DB cache) ──
interface MemCacheEntry { data: ScrapedDataV2; expiresAt: number; }
const memCache = new Map<string, MemCacheEntry>();

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------
export async function scrapeBusinessWebsiteV2(
  websiteUrl: string,
  businessName: string,
  city?: string,
): Promise<ScrapedDataV2 | null> {
  const start = Date.now();

  let normalised = websiteUrl.trim();
  if (!normalised.startsWith("http")) normalised = `https://${normalised}`;

  let origin: string;
  try { origin = new URL(normalised).origin; }
  catch { return null; }

  const domain = new URL(origin).hostname.replace(/^www\./, "");

  // ── Cache check ──
  const cacheHit = await readCache(domain);
  if (cacheHit) {
    cacheHit.extraction_trace.cache_hit = true;
    return cacheHit;
  }

  // ── robots.txt gate ──
  const respectRobots = await getConfig<boolean>("SCRAPE_RESPECT_ROBOTS");
  if (respectRobots && !(await robotsAllowsFetch(origin))) {
    console.warn(`[Scraper] robots.txt disallows fetch of ${origin}`);
    return null;
  }

  const timeoutMs = await getConfig<number>("SCRAPE_TIMEOUT_MS");
  const maxSubpages = await getConfig<number>("SCRAPE_MAX_SUBPAGES");
  const maxHtmlChars = await getConfig<number>("SCRAPE_MAX_HTML_CHARS");

  // ── Fetch homepage ──
  const homepage = await fetchHtml(normalised, timeoutMs);
  if (!homepage) return null;

  const pagesScraped = [normalised];

  // ── Run extractors on homepage ──
  const homepageExtract = extractFromHtml(homepage, normalised);
  const extracts: RawExtract[] = [homepageExtract];
  const texts: string[] = [`--- HOMEPAGE: ${normalised} ---\n${htmlToText(homepage)}`];

  // ── Rank subpages from homepage, plus sitemap fallback ──
  let subpageUrls = extractAndRankSubpages(homepage, normalised);
  if (subpageUrls.length < 3) {
    const sitemapUrls = await fetchSitemapSubpages(origin, timeoutMs);
    for (const s of sitemapUrls) if (!subpageUrls.includes(s)) subpageUrls.push(s);
  }
  subpageUrls = subpageUrls.slice(0, maxSubpages);

  // ── Fetch subpages sequentially (politeness) ──
  for (const url of subpageUrls) {
    const html = await fetchHtml(url, timeoutMs);
    if (!html) continue;
    pagesScraped.push(url);
    extracts.push(extractFromHtml(html, url));
    texts.push(`--- PAGE: ${url} ---\n${htmlToText(html)}`);
  }

  // ── Merge deterministic findings ──
  const merged = mergeExtracts(extracts);

  // ── Gemini gap-fill (description + anything regex missed) ──
  const combined = texts.join("\n\n").slice(0, maxHtmlChars);
  const geminiFill = await geminiGapFill({
    businessName,
    city,
    combinedText: combined,
    deterministic: merged,
  });

  // ── Email validation: cross-check Gemini's pick against the regex
  // candidate set. Gemini's prompt instructs it to pick from emails_found,
  // so anything outside that set is a hallucination. A null pick is also
  // legitimate — it means every candidate was a placeholder / third-party
  // address and we should record no email rather than spam a bad one. ──
  const candidateSet = new Set(merged.emails.map((e) => e.toLowerCase()));
  const geminiPick = geminiFill.email ? geminiFill.email.toLowerCase() : null;
  let validatedEmail: string | null = null;
  if (geminiPick && candidateSet.has(geminiPick)) {
    validatedEmail = geminiPick;
    if (geminiPick !== merged.emails[0]) {
      console.log(`[ScraperV2] Gemini chose '${geminiPick}' over regex first-match '${merged.emails[0]}'`);
    }
  } else if (geminiPick) {
    console.warn(`[ScraperV2] Gemini suggested '${geminiPick}' which wasn't in regex candidates — rejecting (possible hallucination)`);
  } else if (merged.emails.length > 0) {
    console.log(`[ScraperV2] Gemini returned null email — all candidates (${merged.emails.join(", ")}) rejected as placeholders/third-party`);
  }

  // ── Final assembly — prefer deterministic over LLM for factual fields ──
  const final: ScrapedDataV2 = {
    owner_name: pickOwner(merged, geminiFill),
    email: validatedEmail,
    alternate_emails: merged.emails.filter((e) => e !== validatedEmail).slice(0, 4),
    phone: merged.phonesRaw[0] ?? geminiFill.phone ?? null,
    phone_e164: merged.phonesE164[0] ?? (geminiFill.phone ? toE164(geminiFill.phone, normalised) : null),
    instagram: normaliseInstagramHandle(merged.instagramHandles[0] ?? geminiFill.instagram),
    linkedin: merged.linkedinUrls[0] ?? null,
    facebook: merged.facebookUrls[0] ?? null,
    twitter: merged.twitterHandles[0] ?? null,
    tiktok: merged.tiktokHandles[0] ?? null,
    youtube: merged.youtubeUrls[0] ?? null,
    description: geminiFill.description ?? merged.metaDescription ?? null,
    positioning: geminiFill.positioning ?? null,
    clientele: geminiFill.clientele ?? null,
    services: geminiFill.services ?? [],
    website: normalised,
    location: geminiFill.location ?? (merged.ogTags["locality"] ?? null),
    address: merged.addressGuesses[0] ?? null,
    postcode: merged.addressGuesses.find((a) => /[A-Z]{1,2}\d/.test(a)) ?? null,
    people: merged.peopleGuesses.slice(0, 10),
    confidence: gradeConfidence(merged, geminiFill),
    pages_scraped: pagesScraped,
    scrape_ms: Date.now() - start,
    extraction_trace: {
      deterministic_emails: merged.emails.length,
      deterministic_phones: merged.phonesE164.length,
      json_ld_blocks: merged.jsonLd.length,
      people_found: merged.peopleGuesses.length,
      subpages_fetched: pagesScraped.length - 1,
      gemini_used: Boolean(geminiFill.description),
      cache_hit: false,
    },
  };

  await writeCache(domain, final);
  return final;
}

// ---------------------------------------------------------------------------
// Fetching — with UA rotation + blocker detection
// ---------------------------------------------------------------------------
async function fetchHtml(url: string, timeoutMs: number): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const ua = USER_AGENTS[(attempt + Math.floor(Math.random() * USER_AGENTS.length)) % USER_AGENTS.length];
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: "follow",
        headers: {
          "User-Agent": ua,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9",
          "Accept-Language": "en-GB,en;q=0.9",
          "Accept-Encoding": "gzip, deflate, br",
        },
      });
      clearTimeout(t);

      if (res.status === 429 || res.status === 503) {
        // Back off on rate limit / CF challenge — try once more with different UA
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      if (res.status === 403) {
        // Some sites 403 any non-interactive UA; retry with a fresh UA once
        if (attempt === 0) continue;
        return null;
      }
      if (!res.ok) return null;

      const html = await res.text();
      if (isBlockerPage(html)) {
        if (attempt === 0) continue;
        return null;
      }
      return html;
    } catch {
      continue;
    }
  }
  return null;
}

function isBlockerPage(html: string): boolean {
  if (!html) return true;
  if (html.length < 500) return true; // too small to be real
  const lower = html.toLowerCase();
  return (
    lower.includes("cf-error-details") ||
    lower.includes("cloudflare") && lower.includes("challenge") ||
    lower.includes("access denied") && lower.length < 3000 ||
    lower.includes("just a moment") && lower.length < 3000
  );
}

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------
async function robotsAllowsFetch(origin: string): Promise<boolean> {
  try {
    const res = await fetch(`${origin}/robots.txt`, {
      signal: AbortSignal.timeout(5000),
      headers: { "User-Agent": USER_AGENTS[0] },
    });
    if (!res.ok) return true; // no robots.txt → allowed
    const text = await res.text();
    // Very simple parser — honour Disallow: / under User-agent: *
    let inStar = false;
    for (const lineRaw of text.split(/\r?\n/)) {
      const line = lineRaw.trim();
      if (!line || line.startsWith("#")) continue;
      const [kRaw, vRaw] = line.split(":", 2);
      if (!vRaw) continue;
      const k = kRaw.trim().toLowerCase();
      const v = vRaw.trim();
      if (k === "user-agent") inStar = v === "*";
      else if (inStar && k === "disallow" && (v === "/" || v === "/*")) return false;
    }
    return true;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Sitemap fallback — when homepage links don't yield enough subpages
// ---------------------------------------------------------------------------
async function fetchSitemapSubpages(origin: string, timeoutMs: number): Promise<string[]> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${origin}/sitemap.xml`, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENTS[0] },
    });
    clearTimeout(t);
    if (!res.ok) return [];
    const xml = await res.text();
    const urls = extractSitemapUrls(xml);
    // Filter to things we care about
    return urls
      .filter((u) => /\b(contact|about|team|founder|owner|staff|people|leadership|services|what-we-do|meet|management|directors|careers|jobs|case-studies|clients)\b/i.test(u))
      .slice(0, 10);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Merge extracts — dedup across pages, keep first-seen ordering (homepage wins)
// ---------------------------------------------------------------------------
function mergeExtracts(extracts: RawExtract[]): RawExtract {
  const out: RawExtract = {
    emails: [], phonesE164: [], phonesRaw: [], instagramHandles: [],
    linkedinUrls: [], facebookUrls: [], twitterHandles: [], tiktokHandles: [],
    youtubeUrls: [], jsonLd: [], ogTags: {}, metaDescription: null,
    canonicalUrl: null, titleTag: null, addressGuesses: [], peopleGuesses: [],
  };

  for (const e of extracts) {
    out.emails.push(...e.emails);
    out.phonesE164.push(...e.phonesE164);
    out.phonesRaw.push(...e.phonesRaw);
    out.instagramHandles.push(...e.instagramHandles);
    out.linkedinUrls.push(...e.linkedinUrls);
    out.facebookUrls.push(...e.facebookUrls);
    out.twitterHandles.push(...e.twitterHandles);
    out.tiktokHandles.push(...e.tiktokHandles);
    out.youtubeUrls.push(...e.youtubeUrls);
    out.jsonLd.push(...e.jsonLd);
    out.addressGuesses.push(...e.addressGuesses);
    out.peopleGuesses.push(...e.peopleGuesses);
    if (!out.metaDescription && e.metaDescription) out.metaDescription = e.metaDescription;
    if (!out.canonicalUrl && e.canonicalUrl) out.canonicalUrl = e.canonicalUrl;
    if (!out.titleTag && e.titleTag) out.titleTag = e.titleTag;
    Object.assign(out.ogTags, e.ogTags);
  }

  out.emails = uniq(out.emails);
  out.phonesE164 = uniq(out.phonesE164);
  out.phonesRaw = uniq(out.phonesRaw);
  out.instagramHandles = uniq(out.instagramHandles);
  out.linkedinUrls = uniq(out.linkedinUrls);
  out.facebookUrls = uniq(out.facebookUrls);
  out.twitterHandles = uniq(out.twitterHandles);
  out.tiktokHandles = uniq(out.tiktokHandles);
  out.youtubeUrls = uniq(out.youtubeUrls);
  out.addressGuesses = uniq(out.addressGuesses);

  // Dedupe people by normalised name
  const seen = new Set<string>();
  out.peopleGuesses = out.peopleGuesses.filter((p) => {
    const k = p.name.toLowerCase().replace(/\s+/g, " ").trim();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return out;
}

// ---------------------------------------------------------------------------
// Gemini gap-fill — we hand it the deterministic findings so it enriches
// rather than fabricates.
// ---------------------------------------------------------------------------
interface GeminiFill {
  owner_name: string | null;
  email: string | null;
  email_evidence: string | null;
  phone: string | null;
  instagram: string | null;
  description: string | null;
  positioning: string | null;
  clientele: string | null;
  services: string[];
  location: string | null;
  confidence: "high" | "medium" | "low";
}

async function geminiGapFill(opts: {
  businessName: string;
  city?: string;
  combinedText: string;
  deterministic: RawExtract;
}): Promise<GeminiFill> {
  const config = getNicheConfig();

  const detSummary = {
    emails_found: opts.deterministic.emails,
    phones_found: opts.deterministic.phonesE164,
    instagram: opts.deterministic.instagramHandles,
    linkedin: opts.deterministic.linkedinUrls,
    people_heuristic: opts.deterministic.peopleGuesses,
    title: opts.deterministic.titleTag,
    og_description: opts.deterministic.ogTags["description"] ?? null,
    meta_description: opts.deterministic.metaDescription,
  };

  try {
    return await withRetry(async () => {
      const res = await client.models.generateContent({
        model: config.geminiModel,
        contents: [{
          role: "user",
          parts: [{
            text: `You are a business research analyst extracting data from a scraped website.

Business: "${opts.businessName}"${opts.city ? ` (${opts.city})` : ""}

DATA ALREADY EXTRACTED BY REGEX/JSON-LD:
${JSON.stringify(detSummary, null, 2)}

The 'emails_found' list is RAW REGEX OUTPUT — it includes any string that looks
like an email, which means it can contain template placeholders (sample@mail.com,
your@email.com, name@company.com), third-party tools (notifications@stripe.com,
support@shopify.com, hello@mailchimp.com), tracking pixels, and unrelated
addresses that happen to appear in the page source. Your job is to pick the
ONE address that is genuinely the business's own contact email — or return
null if none of them are.

SCRAPED WEBSITE CONTENT:
${opts.combinedText}

Return a single JSON object:

{
  "owner_name": "Full name of the owner/founder/head decision-maker. Cross-reference the 'people_heuristic' list — if one clearly looks like the owner (role includes Founder, Owner, CEO, Managing Director, Director, Partner), return that. Otherwise null.",

  "email": "Pick the single real business contact email from emails_found. RULES: (1) REJECT template placeholders — anything that looks like demo content (sample@, example@, your@, you@, name@, test@, demo@, email@, hello@example.*, @yourdomain.*, @mysite.*). These appear in newsletter signup forms, contact form previews, and unedited template text. (2) REJECT third-party service emails — anything from stripe, shopify, mailchimp, klaviyo, sentry, intercom, hubspot, wix, squarespace, godaddy, etc. (3) PREFER an email that appears in a 'Contact', 'Get in touch', 'About', 'Team', or footer context — those are the business's own. (4) PREFER personal addresses (first.last@ or firstname@) over generic info@/hello@/contact@/enquiries@ on the same domain — for B2B SME outreach a named decision-maker inbox is far higher value than a shared one. (5) ACCEPT free-mail addresses (gmail, hotmail, outlook, btinternet etc.) ONLY if the page text indicates this is the owner's business inbox — small UK SMEs legitimately use personal Hotmail/Gmail as their business contact, and these often appear in the footer next to a phone number and address. (6) If NONE of the candidates pass these tests, return null. A null email is correct when the only candidates are placeholders or third-party services.",

  "email_evidence": "Brief quote (max 100 chars) of the surrounding page text where the chosen email appears, e.g. 'Email: jdoe@acme.co.uk Phone: 0207 2894551'. null if email is null. This is so a human reviewer can audit the decision.",

  "phone": "Primary phone. null if none.",
  "instagram": "Primary Instagram handle (no @). null if none.",
  "description": "3-4 sentences: what the business does, who they serve, and how they operate. Ground this in the website content — mention concrete specifics (sectors, geographies, service lines).",
  "positioning": "1 sentence: how they position themselves commercially (e.g. boutique/high-volume, specialist/generalist, local/national, premium/value).",
  "clientele": "1 sentence: who their customers are — sector, size, geography, typical use case.",
  "services": ["array of concrete service lines, product categories, or capabilities offered"],
  "location": "City, country.",
  "confidence": "high | medium | low — based on how much verifiable detail you found. If you returned a non-null email and you can quote evidence for it, that's high confidence on contact data."
}

Return ONLY the JSON object.`,
          }],
        }],
        config: {
          systemInstruction: "You are a data extraction analyst. Never fabricate. Return valid JSON only.",
          temperature: 0.1,
          maxOutputTokens: 3072,
        },
      });

      const raw = (res.text ?? "").replace(/^```(?:json)?\n?/g, "").replace(/\n?```$/g, "").trim();
      const parsed = JSON.parse(raw) as Partial<GeminiFill>;
      return {
        owner_name: typeof parsed.owner_name === "string" ? parsed.owner_name : null,
        email: typeof parsed.email === "string" ? parsed.email : null,
        email_evidence: typeof parsed.email_evidence === "string" ? parsed.email_evidence : null,
        phone: typeof parsed.phone === "string" ? parsed.phone : null,
        instagram: typeof parsed.instagram === "string" ? parsed.instagram : null,
        description: typeof parsed.description === "string" ? parsed.description : null,
        positioning: typeof parsed.positioning === "string" ? parsed.positioning : null,
        clientele: typeof parsed.clientele === "string" ? parsed.clientele : null,
        services: Array.isArray(parsed.services) ? parsed.services.filter((s): s is string => typeof s === "string") : [],
        location: typeof parsed.location === "string" ? parsed.location : null,
        confidence: (parsed.confidence === "high" || parsed.confidence === "medium" || parsed.confidence === "low") ? parsed.confidence : "low",
      };
    }, `scrapeV2:${opts.businessName}`, { maxAttempts: 3, baseDelayMs: 2000 });
  } catch (err) {
    console.warn(`[ScraperV2] Gemini gap-fill failed, using extractors only: ${(err as Error).message}`);
    return {
      owner_name: null, email: null, email_evidence: null, phone: null, instagram: null,
      description: null, positioning: null, clientele: null, services: [],
      location: null, confidence: "low",
    };
  }
}

function pickOwner(merged: RawExtract, fill: GeminiFill): string | null {
  if (fill.owner_name) return fill.owner_name;
  // Prefer JSON-LD founder over heuristic
  const ld = merged.peopleGuesses.find((p) => p.source === "json-ld" && /founder|owner|ceo|director/i.test(p.role ?? ""));
  if (ld) return ld.name;
  const heur = merged.peopleGuesses.find((p) => /founder|owner/i.test(p.role ?? ""));
  return heur?.name ?? null;
}

function gradeConfidence(merged: RawExtract, fill: GeminiFill): "high" | "medium" | "low" {
  const hasOwner = Boolean(fill.owner_name || merged.peopleGuesses.length > 0);
  const hasEmail = merged.emails.length > 0;
  const hasDesc = Boolean(fill.description);
  const score = (hasOwner ? 1 : 0) + (hasEmail ? 1 : 0) + (hasDesc ? 1 : 0) + (merged.jsonLd.length > 0 ? 1 : 0);
  if (score >= 3) return "high";
  if (score >= 2) return "medium";
  return "low";
}

// ---------------------------------------------------------------------------
// Cache layer — in-memory + Neon
// ---------------------------------------------------------------------------
async function readCache(domain: string): Promise<ScrapedDataV2 | null> {
  const now = Date.now();
  const mem = memCache.get(domain);
  if (mem && mem.expiresAt > now) {
    console.log(`[ScraperV2] Cache HIT (mem) ${domain} → email=${mem.data.email ?? 'NULL'} confidence=${mem.data.confidence}`);
    return mem.data;
  }

  try {
    const row = await (prisma as any).scrapeCache?.findUnique?.({ where: { domain } });
    if (!row) return null;
    if (new Date(row.expiresAt).getTime() < now) return null;
    const data = row.payload as ScrapedDataV2;
    console.log(`[ScraperV2] Cache HIT (db) ${domain} → email=${data.email ?? 'NULL'} confidence=${data.confidence}`);
    memCache.set(domain, { data, expiresAt: new Date(row.expiresAt).getTime() });
    return data;
  } catch {
    return null;
  }
}

async function writeCache(domain: string, data: ScrapedDataV2): Promise<void> {
  const hours = await getConfig<number>("SCRAPE_CACHE_HOURS").catch(() => 168);
  if (hours <= 0) return;

  // Negative results get a much shorter TTL — a missed email shouldn't lock
  // a lead out for a week. Sites change, the scraper improves, and the
  // Gemini email picker is still maturing. Re-try sooner on misses.
  const isLowValue = !data.email && data.confidence === "low";
  const effectiveHours = isLowValue ? Math.min(hours, 24) : hours;

  const expiresAt = new Date(Date.now() + effectiveHours * 3600 * 1000);
  memCache.set(domain, { data, expiresAt: expiresAt.getTime() });
  try {
    await (prisma as any).scrapeCache.upsert({
      where: { domain },
      create: {
        domain, payload: data as any, expiresAt,
        pagesScraped: data.pages_scraped.length,
        confidence: data.confidence,
      },
      update: {
        payload: data as any, fetchedAt: new Date(), expiresAt,
        pagesScraped: data.pages_scraped.length,
        confidence: data.confidence,
      },
    });
  } catch (err) {
    // Table may not exist yet — just warn
    console.warn(`[ScraperV2] ScrapeCache write failed (run migration?): ${(err as Error).message}`);
  }
}

function uniq<T>(arr: T[]): T[] { return [...new Set(arr)]; }
