export interface RawExtract {
  emails: string[];
  phonesE164: string[];
  phonesRaw: string[];
  instagramHandles: string[];
  linkedinUrls: string[];
  facebookUrls: string[];
  twitterHandles: string[];
  tiktokHandles: string[];
  youtubeUrls: string[];
  jsonLd: any[];
  ogTags: Record<string, string>;
  metaDescription: string | null;
  canonicalUrl: string | null;
  titleTag: string | null;
  addressGuesses: string[];
  peopleGuesses: Array<{ name: string; role?: string; source: string }>;
}

const GENERIC_EMAIL_PREFIXES = new Set([
  "info", "contact", "hello", "hi", "enquiries", "enquiry", "admin",
  "support", "help", "sales", "marketing", "press", "bookings", "reception",
  "noreply", "no-reply", "donotreply",
]);

const SOCIAL_BLOCKLIST = new Set([
  "share", "sharer", "intent", "home", "explore", "login", "signup", "about",
  "tv", "reel", "reels", "tag", "tags", "search",
]);

// ---------------------------------------------------------------------------
// Main extractor — takes raw HTML
// ---------------------------------------------------------------------------
export function extractFromHtml(html: string, baseUrl: string): RawExtract {
  const out: RawExtract = {
    emails: [],
    phonesE164: [],
    phonesRaw: [],
    instagramHandles: [],
    linkedinUrls: [],
    facebookUrls: [],
    twitterHandles: [],
    tiktokHandles: [],
    youtubeUrls: [],
    jsonLd: [],
    ogTags: {},
    metaDescription: null,
    canonicalUrl: null,
    titleTag: null,
    addressGuesses: [],
    peopleGuesses: [],
  };

  // ── Emails (mailto + inline) ──
  // Filter only obvious image-extension false positives at the regex layer.
  // Content-based filtering (placeholders, third-party services, template
  // text) is delegated to the Gemini email picker — it sees the surrounding
  // context and is far better at it than a hardcoded substring blacklist.
  const emailRe = /(?:mailto:)?([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/gi;
  const emailHits = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = emailRe.exec(html)) !== null) {
    const addr = m[1].toLowerCase();
    if (!addr.includes("@")) continue;
    if (addr.endsWith(".png") || addr.endsWith(".jpg") || addr.endsWith(".webp") || addr.endsWith(".gif") || addr.endsWith(".svg")) continue;
    emailHits.add(addr);
  }
  out.emails = rankEmails([...emailHits]);

  // ── Phones (tel: and common patterns) ──
  const telRe = /tel:([+\d][\d\s().-]{6,})/gi;
  const phoneSet = new Set<string>();
  while ((m = telRe.exec(html)) !== null) {
    const raw = m[1].trim();
    phoneSet.add(raw);
    const e164 = toE164(raw, baseUrl);
    if (e164) out.phonesE164.push(e164);
  }
  out.phonesRaw = [...phoneSet];
  out.phonesE164 = uniq(out.phonesE164);

  // ── Social handles ──
  out.instagramHandles = extractInstagram(html);
  out.linkedinUrls = extractLinkedIn(html);
  out.facebookUrls = extractFacebook(html);
  out.twitterHandles = extractTwitter(html);
  out.tiktokHandles = extractTikTok(html);
  out.youtubeUrls = extractYouTube(html);

  // ── JSON-LD blocks ──
  const ldRe = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  while ((m = ldRe.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(m[1].trim());
      if (Array.isArray(parsed)) out.jsonLd.push(...parsed);
      else out.jsonLd.push(parsed);
    } catch { /* non-JSON-LD — skip */ }
  }

  // Walk JSON-LD for richer fields
  for (const block of out.jsonLd) {
    collectFromJsonLd(block, out);
  }

  // ── OG tags + meta description + canonical ──
  const ogRe = /<meta\s+[^>]*property=["']og:([^"']+)["'][^>]*content=["']([^"']+)["'][^>]*>/gi;
  while ((m = ogRe.exec(html)) !== null) {
    out.ogTags[m[1].toLowerCase()] = m[2];
  }
  const ogReRev = /<meta\s+[^>]*content=["']([^"']+)["'][^>]*property=["']og:([^"']+)["'][^>]*>/gi;
  while ((m = ogReRev.exec(html)) !== null) {
    if (!out.ogTags[m[2].toLowerCase()]) out.ogTags[m[2].toLowerCase()] = m[1];
  }

  const descRe = /<meta\s+[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i;
  const descMatch = descRe.exec(html);
  if (descMatch) out.metaDescription = decodeEntities(descMatch[1]);

  const canonRe = /<link\s+[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i;
  const canonMatch = canonRe.exec(html);
  if (canonMatch) out.canonicalUrl = canonMatch[1];

  const titleRe = /<title[^>]*>([\s\S]*?)<\/title>/i;
  const titleMatch = titleRe.exec(html);
  if (titleMatch) out.titleTag = decodeEntities(titleMatch[1].trim());

  // ── Address guesses — postcodes, structured addresses ──
  out.addressGuesses = extractAddressGuesses(html);

  // ── People guesses — "Founder", "Owner", "MD", "Director" captions near names ──
  out.peopleGuesses.push(...extractPeopleHeuristics(html));

  return out;
}

// ---------------------------------------------------------------------------
// Email ranking — personal addresses beat generic info@
// ---------------------------------------------------------------------------
function rankEmails(emails: string[]): string[] {
  return emails.sort((a, b) => score(b) - score(a));
  function score(e: string): number {
    const local = e.split("@")[0];
    if (GENERIC_EMAIL_PREFIXES.has(local)) return 0;
    // first.last@ is the gold standard
    if (/^[a-z]+\.[a-z]+$/.test(local)) return 100;
    // first@ / flast@ — probably personal
    if (local.length <= 12 && /^[a-z]+$/.test(local)) return 70;
    return 40;
  }
}

// ---------------------------------------------------------------------------
// Social extractors
// ---------------------------------------------------------------------------
function extractInstagram(html: string): string[] {
  const re = /instagram\.com\/([A-Za-z0-9_.]+)(?:\/|["'?#])/gi;
  const hits = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const h = m[1].toLowerCase();
    if (SOCIAL_BLOCKLIST.has(h)) continue;
    if (h.startsWith("p") && h.length === 1) continue;
    hits.add(h);
  }
  return [...hits];
}

function extractLinkedIn(html: string): string[] {
  const re = /linkedin\.com\/(?:company|in|school)\/([A-Za-z0-9\-_%]+)/gi;
  const hits = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    hits.add(m[0].replace(/[?#].*$/, ""));
  }
  return [...hits];
}

function extractFacebook(html: string): string[] {
  const re = /facebook\.com\/([A-Za-z0-9.\-_]+)(?:\/|["'?#])/gi;
  const hits = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const h = m[1].toLowerCase();
    if (SOCIAL_BLOCKLIST.has(h)) continue;
    hits.add(m[0].replace(/["'?#].*$/, ""));
  }
  return [...hits];
}

function extractTwitter(html: string): string[] {
  const re = /(?:twitter|x)\.com\/([A-Za-z0-9_]+)(?:\/|["'?#])/gi;
  const hits = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const h = m[1].toLowerCase();
    if (SOCIAL_BLOCKLIST.has(h)) continue;
    hits.add(h);
  }
  return [...hits];
}

function extractTikTok(html: string): string[] {
  const re = /tiktok\.com\/@([A-Za-z0-9_.]+)/gi;
  const hits = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) hits.add(m[1].toLowerCase());
  return [...hits];
}

function extractYouTube(html: string): string[] {
  const re = /youtube\.com\/(?:@|c\/|channel\/|user\/)([A-Za-z0-9_\-]+)/gi;
  const hits = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) hits.add(m[0].replace(/[?#].*$/, ""));
  return [...hits];
}

// ---------------------------------------------------------------------------
// JSON-LD walker — picks up LocalBusiness, Organization, Person
// ---------------------------------------------------------------------------
function collectFromJsonLd(node: any, out: RawExtract): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { node.forEach((n) => collectFromJsonLd(n, out)); return; }

  const t = node["@type"];
  const types = Array.isArray(t) ? t : t ? [t] : [];

  if (types.some((x: string) => /Organization|LocalBusiness|ProfessionalService|RealEstateAgent|Dentist|HomeAndConstructionBusiness|AutomotiveBusiness|Store|Corporation/i.test(x))) {
    if (typeof node.email === "string") out.emails.push(node.email.toLowerCase());
    if (typeof node.telephone === "string") {
      out.phonesRaw.push(node.telephone);
      const e164 = toE164(node.telephone, "");
      if (e164) out.phonesE164.push(e164);
    }
    if (node.address) {
      const a = node.address;
      if (typeof a === "string") out.addressGuesses.push(a);
      else if (a.streetAddress) {
        out.addressGuesses.push([a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode, a.addressCountry].filter(Boolean).join(", "));
      }
    }
    if (Array.isArray(node.sameAs)) {
      for (const url of node.sameAs as string[]) {
        if (/instagram\.com\/[^/]+/i.test(url)) {
          const h = url.match(/instagram\.com\/([^/?#]+)/i)?.[1];
          if (h) out.instagramHandles.push(h.toLowerCase());
        }
        if (/linkedin\.com\//i.test(url)) out.linkedinUrls.push(url);
        if (/facebook\.com\//i.test(url)) out.facebookUrls.push(url);
      }
    }
    if (node.founder) {
      const founders = Array.isArray(node.founder) ? node.founder : [node.founder];
      for (const f of founders) {
        if (typeof f === "string") out.peopleGuesses.push({ name: f, role: "Founder", source: "json-ld" });
        else if (f?.name) out.peopleGuesses.push({ name: f.name, role: "Founder", source: "json-ld" });
      }
    }
    if (node.employee) {
      const emps = Array.isArray(node.employee) ? node.employee : [node.employee];
      for (const e of emps) {
        if (e?.name) out.peopleGuesses.push({ name: e.name, role: e.jobTitle ?? "Employee", source: "json-ld" });
      }
    }
  }

  if (types.some((x: string) => /^Person$/i.test(x))) {
    if (node.name) out.peopleGuesses.push({ name: node.name, role: node.jobTitle, source: "json-ld" });
  }

  for (const k of Object.keys(node)) {
    if (typeof node[k] === "object") collectFromJsonLd(node[k], out);
  }
}

// ---------------------------------------------------------------------------
// Address heuristics — UK postcodes + "Street/Road/Lane" lines
// ---------------------------------------------------------------------------
function extractAddressGuesses(html: string): string[] {
  const hits = new Set<string>();
  const ukPostcode = /\b[A-Z]{1,2}[0-9][A-Z0-9]? ?[0-9][A-Z]{2}\b/g;
  let m: RegExpExecArray | null;
  while ((m = ukPostcode.exec(html)) !== null) hits.add(m[0]);
  return [...hits].slice(0, 5);
}

// ---------------------------------------------------------------------------
// People heuristics — look for "Founder", "Owner", "Director", "MD" adjacent
// to proper-cased names within visible text spans.
// ---------------------------------------------------------------------------
function extractPeopleHeuristics(html: string): Array<{ name: string; role?: string; source: string }> {
  const roles = [
    "Founder", "Co-Founder", "Co Founder", "Owner", "Director",
    "Managing Director", "MD", "CEO", "COO", "Chief Operating Officer",
    "Operations Director", "Head of Operations", "Operations Manager",
    "Commercial Director", "Sales Director", "Head of Sales",
    "Principal", "Partner", "Senior Partner", "Managing Partner",
    "Practice Manager", "Practice Principal",
  ];
  const out: Array<{ name: string; role?: string; source: string }> = [];
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

  for (const role of roles) {
    // Pattern A: "Jane Doe, Founder"
    const reA = new RegExp(`([A-Z][a-zA-Z'\\-]+(?:\\s+[A-Z][a-zA-Z'\\-]+){1,2})\\s*[,\\-–—|:]+\\s*${role}`, "g");
    let m: RegExpExecArray | null;
    while ((m = reA.exec(text)) !== null) out.push({ name: m[1], role, source: "heuristic" });
    // Pattern B: "Founder Jane Doe"
    const reB = new RegExp(`${role}[,\\s:\\-–—|]+([A-Z][a-zA-Z'\\-]+(?:\\s+[A-Z][a-zA-Z'\\-]+){1,2})`, "g");
    while ((m = reB.exec(text)) !== null) out.push({ name: m[1], role, source: "heuristic" });
  }

  // dedupe by name
  const seen = new Set<string>();
  return out.filter((p) => { const k = p.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 8);
}

// ---------------------------------------------------------------------------
// Phone normalization — very defensive, falls back to raw
// ---------------------------------------------------------------------------
export function toE164(raw: string, baseUrl: string): string | null {
  const digits = raw.replace(/[^\d+]/g, "");
  if (!digits) return null;
  if (digits.startsWith("+") && digits.length >= 8 && digits.length <= 16) return digits;

  // Infer country from domain TLD
  let cc = "";
  try {
    const host = new URL(baseUrl.startsWith("http") ? baseUrl : `https://${baseUrl}`).hostname;
    if (host.endsWith(".uk") || host.endsWith(".co.uk")) cc = "+44";
    else if (host.endsWith(".com") || host.endsWith(".io") || host.endsWith(".net") || host.endsWith(".us")) cc = "";
    else if (host.endsWith(".ca")) cc = "+1";
    else if (host.endsWith(".au")) cc = "+61";
    else if (host.endsWith(".ie")) cc = "+353";
  } catch { /* ignore */ }

  // UK leading 0 → +44
  if (cc === "+44" && digits.startsWith("0") && digits.length >= 10 && digits.length <= 11) {
    return `+44${digits.slice(1)}`;
  }
  // Bare 10-digit US
  if (cc === "" && /^\d{10}$/.test(digits)) return `+1${digits}`;

  return null;
}

// ---------------------------------------------------------------------------
// Handle normalizer — accepts @foo, foo, instagram.com/foo → foo
// ---------------------------------------------------------------------------
export function normaliseInstagramHandle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let v = raw.trim();
  v = v.replace(/^@/, "");
  v = v.replace(/^https?:\/\/(?:www\.)?instagram\.com\//i, "");
  v = v.replace(/\/$/, "").split(/[/?#]/)[0];
  if (!v || SOCIAL_BLOCKLIST.has(v.toLowerCase())) return null;
  if (!/^[A-Za-z0-9_.]{1,30}$/.test(v)) return null;
  return v.toLowerCase();
}

// ---------------------------------------------------------------------------
// Subpage prioritisation — Apollo-grade contact-first ordering
// ---------------------------------------------------------------------------
const SUBPAGE_PRIORITIES: Array<{ pattern: RegExp; weight: number }> = [
  { pattern: /\/contact(?:-us)?\/?$/i, weight: 100 },
  { pattern: /\/contact/i, weight: 90 },
  { pattern: /\/get-in-touch/i, weight: 85 },
  { pattern: /\/about(?:-us)?\/?$/i, weight: 80 },
  { pattern: /\/about/i, weight: 70 },
  { pattern: /\/our-story/i, weight: 65 },
  { pattern: /\/team\/?$/i, weight: 75 },
  { pattern: /\/our-team/i, weight: 75 },
  { pattern: /\/meet-(?:the-)?team/i, weight: 75 },
  { pattern: /\/staff/i, weight: 70 },
  { pattern: /\/people/i, weight: 60 },
  { pattern: /\/directors?/i, weight: 75 },
  { pattern: /\/management/i, weight: 70 },
  { pattern: /\/partners/i, weight: 70 },
  { pattern: /\/founder/i, weight: 85 },
  { pattern: /\/owner/i, weight: 80 },
  { pattern: /\/leadership/i, weight: 70 },
  { pattern: /\/press/i, weight: 40 },
  { pattern: /\/partnerships?/i, weight: 45 },
];

export function extractAndRankSubpages(html: string, baseUrl: string): string[] {
  const hrefRe = /href=["']([^"']+)["']/gi;
  const candidates = new Map<string, number>();
  let base: URL;
  try { base = new URL(baseUrl.startsWith("http") ? baseUrl : `https://${baseUrl}`); }
  catch { return []; }

  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(html)) !== null) {
    let href = m[1];
    if (href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("javascript:")) continue;

    let abs: string;
    try {
      abs = new URL(href, base).toString();
    } catch { continue; }

    const u = new URL(abs);
    if (u.hostname !== base.hostname) continue; // same-origin only
    if (/\.(pdf|jpg|jpeg|png|webp|gif|svg|mp4|mp3|zip|css|js)(\?|$)/i.test(u.pathname)) continue;

    const clean = `${u.origin}${u.pathname.replace(/\/$/, "")}`;
    if (clean === `${base.origin}${base.pathname.replace(/\/$/, "")}`) continue; // skip homepage

    let best = 0;
    for (const { pattern, weight } of SUBPAGE_PRIORITIES) {
      if (pattern.test(u.pathname)) best = Math.max(best, weight);
    }
    if (best === 0) continue;

    const prior = candidates.get(clean) ?? 0;
    if (best > prior) candidates.set(clean, best);
  }

  return [...candidates.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([url]) => url);
}

// ---------------------------------------------------------------------------
// Sitemap parsing — used as fallback when homepage link extraction is weak
// ---------------------------------------------------------------------------
export function extractSitemapUrls(xml: string): string[] {
  const out: string[] = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1].trim());
  return out;
}

// ---------------------------------------------------------------------------
// HTML → clean text (smarter than the current stripToText)
// ---------------------------------------------------------------------------
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    // Keep alt text — often names team members under photos
    .replace(/<img[^>]*alt=["']([^"']+)["'][^>]*>/gi, " [IMG: $1] ")
    // Keep href
    .replace(/<a\s[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, "$2 [$1]")
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&[a-z]+;/gi, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

function uniq<T>(arr: T[]): T[] { return [...new Set(arr)]; }
