// ---------------------------------------------------------------------------
// Lean iXBRL accounts parser.
//
// Companies House filed accounts (since 2011 for Ltd companies) are submitted
// as iXBRL — XHTML with embedded XBRL-tagged numbers. We parse the structure
// just enough to pull the figures relevant to outreach personalisation:
//
//   - Turnover (current + prior year, for YoY growth)
//   - Average employee count (current + prior)
//   - Profit / loss (current + prior)
//
// We deliberately do NOT pull a full balance sheet — that's beyond what we
// need for "name a credible operational pain in a cold email."
//
// Tags can be in several namespaces depending on the taxonomy version:
//   - uk-gaap (FRS 102, older filings)
//   - uk-bus  (the business taxonomy, used for Turnover, Employees)
//   - uk-direp / uk-aurep (director/auditor reports)
//   - core    (FRS 105 micro-entity)
//
// We match by the unprefixed local name to be taxonomy-agnostic.
// ---------------------------------------------------------------------------

export interface ParsedAccounts {
  madeUpTo: Date | null;
  turnover: bigint | null;
  employeeCount: number | null;
  profitLoss: bigint | null;
  priorTurnover: bigint | null;
  priorEmployeeCount: number | null;
  priorProfitLoss: bigint | null;
  /** True if we successfully extracted at least one of turnover/employees. */
  hasFinancials: boolean;
  /** Concise reason this returned no usable data, e.g. "no-ixbrl-tags". */
  reason?: string;
}

const EMPTY: ParsedAccounts = {
  madeUpTo: null,
  turnover: null,
  employeeCount: null,
  profitLoss: null,
  priorTurnover: null,
  priorEmployeeCount: null,
  priorProfitLoss: null,
  hasFinancials: false,
};

// Local tag names we care about. We accept any of these in the `name`
// attribute regardless of namespace prefix.
const TURNOVER_NAMES = new Set([
  "Turnover",
  "TurnoverRevenue",
  "TurnoverGrossOperatingRevenue",
  "Revenue",
]);

const EMPLOYEES_NAMES = new Set([
  "AverageNumberEmployeesDuringPeriod",
  "AverageNumberEmployees",
  "AverageNumberOfEmployees",
  "EmployeesTotal",
]);

const PROFIT_NAMES = new Set([
  "ProfitLoss",
  "ProfitLossOnOrdinaryActivitiesBeforeTax",
  "ProfitLossBeforeTax",
  "ProfitLossAfterTax",
  "OperatingProfitLoss",
]);

interface IxFact {
  localName: string;
  value: number | null;
  contextRef: string | null;
  scale: number;          // scaled exponent (xbrli `scale` attr — multiplier 10^scale)
  unit: string | null;
}

interface IxContext {
  id: string;
  /** Period end date, parsed from the xbrli:context. */
  endDate: Date | null;
  /** Period start date if it's a duration; instant date is captured here too. */
  startDate: Date | null;
}

export function parseIxbrlAccounts(html: string): ParsedAccounts {
  if (!html || html.length < 1000) return { ...EMPTY, reason: "empty-document" };

  const facts = extractFacts(html);
  if (facts.length === 0) return { ...EMPTY, reason: "no-ixbrl-tags" };

  const contexts = extractContexts(html);
  if (contexts.size === 0) {
    // Some FRS 105 micro-entity filings have non-standard contexts. We can
    // still try to take the first numeric occurrence of each tag.
    return naiveExtract(facts);
  }

  // Find the latest period end date — that's "current year".
  // The next-latest end ~12 months earlier is "prior year".
  const datedContexts: Array<{ id: string; endDate: Date }> = [];
  for (const c of contexts.values()) {
    if (c.endDate) datedContexts.push({ id: c.id, endDate: c.endDate });
  }
  if (datedContexts.length === 0) return naiveExtract(facts);

  datedContexts.sort((a, b) => b.endDate.getTime() - a.endDate.getTime());
  const currentEnd = datedContexts[0].endDate;
  const priorTarget = new Date(currentEnd.getTime() - 365 * 24 * 3600_000);

  // Bucket by which year a context belongs to.
  const currentCtxIds = new Set(
    datedContexts
      .filter((c) => withinDays(c.endDate, currentEnd, 90))
      .map((c) => c.id),
  );
  const priorCtxIds = new Set(
    datedContexts
      .filter((c) => withinDays(c.endDate, priorTarget, 180) && !currentCtxIds.has(c.id))
      .map((c) => c.id),
  );

  return {
    madeUpTo: currentEnd,
    turnover: findFigure(facts, TURNOVER_NAMES, currentCtxIds),
    employeeCount: findInt(facts, EMPLOYEES_NAMES, currentCtxIds),
    profitLoss: findFigure(facts, PROFIT_NAMES, currentCtxIds),
    priorTurnover: findFigure(facts, TURNOVER_NAMES, priorCtxIds),
    priorEmployeeCount: findInt(facts, EMPLOYEES_NAMES, priorCtxIds),
    priorProfitLoss: findFigure(facts, PROFIT_NAMES, priorCtxIds),
    hasFinancials:
      findFigure(facts, TURNOVER_NAMES, currentCtxIds) !== null ||
      findInt(facts, EMPLOYEES_NAMES, currentCtxIds) !== null,
  };
}

// ---------------------------------------------------------------------------
// Fact extraction — both ix:nonFraction (numeric) and ix:nonNumeric (we
// ignore for this parser). We use a regex pass rather than a full XML parser
// because (a) iXBRL is HTML, often messy in practice, and (b) we only need
// a handful of tags. cheerio would also work but it's not currently a dep.
// ---------------------------------------------------------------------------

const NON_FRACTION_RE = /<ix:nonFraction\b([^>]*)>([\s\S]*?)<\/ix:nonFraction>/gi;
const ATTR_RE = /(\w+(?::\w+)?)\s*=\s*"([^"]*)"/g;

function extractFacts(html: string): IxFact[] {
  const out: IxFact[] = [];
  let m: RegExpExecArray | null;
  while ((m = NON_FRACTION_RE.exec(html)) !== null) {
    const attrs = parseAttrs(m[1]);
    const inner = stripTags(m[2]).trim();
    const name = attrs["name"] ?? "";
    const localName = name.includes(":") ? name.split(":").pop()! : name;
    if (!localName) continue;

    const numericValue = parseSignedNumber(inner);
    const scale = parseInt(attrs["scale"] ?? "0", 10) || 0;
    const sign = attrs["sign"] === "-" ? -1 : 1;
    const value = numericValue == null ? null : sign * numericValue * Math.pow(10, scale);

    out.push({
      localName,
      value,
      contextRef: attrs["contextRef"] ?? null,
      scale,
      unit: attrs["unitRef"] ?? null,
    });
  }
  return out;
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  let m: RegExpExecArray | null;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(s)) !== null) out[m[1]] = m[2];
  return out;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

function parseSignedNumber(s: string): number | null {
  if (!s) return null;
  // Brackets denote negative in UK accounts: "(1,234)" → -1234
  const neg = /^\(.+\)$/.test(s.trim());
  const cleaned = s.replace(/[(),£$\s]/g, "");
  if (!cleaned) return null;
  const n = parseFloat(cleaned);
  if (!isFinite(n)) return null;
  return neg ? -n : n;
}

// ---------------------------------------------------------------------------
// Context extraction — pulls xbrli:context blocks and their period endDate.
// ---------------------------------------------------------------------------

const CONTEXT_RE = /<xbrli:context\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/xbrli:context>/gi;
const END_DATE_RE = /<xbrli:endDate>([^<]+)<\/xbrli:endDate>/i;
const START_DATE_RE = /<xbrli:startDate>([^<]+)<\/xbrli:startDate>/i;
const INSTANT_RE = /<xbrli:instant>([^<]+)<\/xbrli:instant>/i;

function extractContexts(html: string): Map<string, IxContext> {
  const out = new Map<string, IxContext>();
  let m: RegExpExecArray | null;
  while ((m = CONTEXT_RE.exec(html)) !== null) {
    const id = m[1];
    const inner = m[2];
    const endMatch = inner.match(END_DATE_RE);
    const instantMatch = inner.match(INSTANT_RE);
    const startMatch = inner.match(START_DATE_RE);
    const endStr = endMatch?.[1] ?? instantMatch?.[1] ?? null;
    const startStr = startMatch?.[1] ?? instantMatch?.[1] ?? null;
    out.set(id, {
      id,
      endDate: endStr ? safeDate(endStr) : null,
      startDate: startStr ? safeDate(startStr) : null,
    });
  }
  return out;
}

function safeDate(iso: string): Date | null {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

function withinDays(a: Date, b: Date, days: number): boolean {
  return Math.abs(a.getTime() - b.getTime()) <= days * 24 * 3600_000;
}

// ---------------------------------------------------------------------------
// Selection helpers
// ---------------------------------------------------------------------------

function findFigure(facts: IxFact[], names: Set<string>, contexts: Set<string>): bigint | null {
  const useContexts = contexts.size > 0;
  for (const f of facts) {
    if (!names.has(f.localName)) continue;
    if (f.value == null) continue;
    if (useContexts && f.contextRef && !contexts.has(f.contextRef)) continue;
    // Round to integer GBP — turnover figures don't need fractional pence.
    return BigInt(Math.round(f.value));
  }
  return null;
}

function findInt(facts: IxFact[], names: Set<string>, contexts: Set<string>): number | null {
  const useContexts = contexts.size > 0;
  for (const f of facts) {
    if (!names.has(f.localName)) continue;
    if (f.value == null) continue;
    if (useContexts && f.contextRef && !contexts.has(f.contextRef)) continue;
    const n = Math.round(f.value);
    if (!isFinite(n) || n < 0) continue;
    return n;
  }
  return null;
}

// Fallback when contexts don't parse — return the first sensible value found.
function naiveExtract(facts: IxFact[]): ParsedAccounts {
  const turnover = findFigure(facts, TURNOVER_NAMES, new Set());
  const employees = findInt(facts, EMPLOYEES_NAMES, new Set());
  const profit = findFigure(facts, PROFIT_NAMES, new Set());
  // Without contexts we can't distinguish current/prior — only emit current.
  return {
    madeUpTo: null,
    turnover,
    employeeCount: employees,
    profitLoss: profit,
    priorTurnover: null,
    priorEmployeeCount: null,
    priorProfitLoss: null,
    hasFinancials: turnover !== null || employees !== null,
    reason: !turnover && !employees ? "no-matching-tags" : undefined,
  };
}
