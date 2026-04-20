import { prisma } from "../utils/prisma.js";
import { getNicheConfig } from "../config/niche.js";
import { logError } from "../utils/logger.js";

// ── Whitelist of editable keys ─────────────────────────────────────────────

export type ConfigType = "string" | "int" | "float" | "bool" | "json";

interface KeyDef {
  type: ConfigType;
  description: string;
  /** Optional validator. Throws on invalid input with a human-readable message. */
  validate?: (parsed: unknown) => void;
  /** Default getter — called when the key is absent in DB. */
  default: () => unknown;
}

export const CONFIG_KEYS: Record<string, KeyDef> = {
  // ── Scoring thresholds ──
  TIER1_THRESHOLD: {
    type: "int",
    description: "Brand fit score >= this becomes Tier1 (default: from env / 70)",
    validate: (v) => { if (typeof v !== "number" || v < 0 || v > 100) throw new Error("Must be 0-100"); },
    default: () => getNicheConfig().tier1Threshold,
  },
  TIER2_THRESHOLD: {
    type: "int",
    description: "Brand fit score >= this becomes Tier2 (default: from env / 50)",
    validate: (v) => { if (typeof v !== "number" || v < 0 || v > 100) throw new Error("Must be 0-100"); },
    default: () => getNicheConfig().tier2Threshold,
  },
  VERIFICATION_THRESHOLD: {
    type: "int",
    description: "Email verification score minimum to send (0-100)",
    validate: (v) => { if (typeof v !== "number" || v < 0 || v > 100) throw new Error("Must be 0-100"); },
    default: () => getNicheConfig().verificationThreshold,
  },

  // ── Scraper ──
  SCRAPE_TIMEOUT_MS: {
    type: "int",
    description: "Per-page fetch timeout in ms (default 12000)",
    validate: (v) => { if (typeof v !== "number" || v < 1000 || v > 60000) throw new Error("Must be 1000-60000"); },
    default: () => parseInt(process.env.SCRAPE_TIMEOUT_MS ?? "12000", 10),
  },
  SCRAPE_MAX_SUBPAGES: {
    type: "int",
    description: "Max subpages to fetch beyond homepage (default 5)",
    validate: (v) => { if (typeof v !== "number" || v < 0 || v > 15) throw new Error("Must be 0-15"); },
    default: () => 5,
  },
  SCRAPE_MAX_HTML_CHARS: {
    type: "int",
    description: "Hard cap on combined HTML chars sent to Gemini",
    validate: (v) => { if (typeof v !== "number" || v < 2000 || v > 200000) throw new Error("Must be 2000-200000"); },
    default: () => parseInt(process.env.MAX_SCRAPE_HTML_CHARS ?? "40000", 10),
  },
  SCRAPE_CACHE_HOURS: {
    type: "int",
    description: "How long to reuse a scraped domain (hours)",
    validate: (v) => { if (typeof v !== "number" || v < 0 || v > 720) throw new Error("Must be 0-720"); },
    default: () => 168, // 1 week
  },
  SCRAPE_RESPECT_ROBOTS: {
    type: "bool",
    description: "Honour robots.txt directives (default true)",
    default: () => true,
  },

  // ── Outreach ──
  OUTREACH_WORD_MIN: {
    type: "int",
    description: "Minimum word count for outreach email body",
    validate: (v) => { if (typeof v !== "number" || v < 40 || v > 400) throw new Error("Must be 40-400"); },
    default: () => 100,
  },
  OUTREACH_WORD_MAX: {
    type: "int",
    description: "Maximum word count for outreach email body",
    validate: (v) => { if (typeof v !== "number" || v < 60 || v > 500) throw new Error("Must be 60-500"); },
    default: () => 140,
  },
  OUTREACH_SUBJECT_MAX_CHARS: {
    type: "int",
    description: "Subject line truncation cap",
    validate: (v) => { if (typeof v !== "number" || v < 20 || v > 120) throw new Error("Must be 20-120"); },
    default: () => 50,
  },
  OUTREACH_TONE: {
    type: "string",
    description: "Tone descriptor passed into draft prompt",
    default: () => getNicheConfig().outreachTone,
  },

  // ── Orchestrator ──
  ORCHESTRATOR_BATCH_SIZE: {
    type: "int",
    description: "Leads processed per orchestrator run",
    validate: (v) => { if (typeof v !== "number" || v < 1 || v > 50) throw new Error("Must be 1-50"); },
    default: () => parseInt(process.env.ORCHESTRATOR_BATCH_SIZE ?? "5", 10),
  },
  DAILY_SEND_CAP: {
    type: "int",
    description: "Hard cap on outbound emails per UTC day (0 = unlimited)",
    validate: (v) => { if (typeof v !== "number" || v < 0 || v > 5000) throw new Error("Must be 0-5000"); },
    default: () => 0,
  },

  // ── Follow-up ──
  FOLLOWUP_DAYS_AFTER: {
    type: "int",
    description: "Days after lastContactedAt before queueing a follow-up",
    validate: (v) => { if (typeof v !== "number" || v < 1 || v > 60) throw new Error("Must be 1-60"); },
    default: () => 5,
  },
};

// ── Cache layer ────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 30_000; // 30s — Teams edits land within half a minute

interface CacheEntry { value: unknown; loadedAt: number; }
const cache = new Map<string, CacheEntry>();

export function invalidateConfigCache(key?: string): void {
  if (key) cache.delete(key);
  else cache.clear();
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function getConfig<T = unknown>(key: string): Promise<T> {
  const def = CONFIG_KEYS[key];
  if (!def) throw new Error(`Unknown config key: ${key}`);

  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.loadedAt < CACHE_TTL_MS) return hit.value as T;

  let resolved: unknown;
  try {
    const row = await (prisma as any).runtimeConfig?.findUnique?.({ where: { key } });
    if (row) {
      resolved = parseStored(row.value, row.valueType as ConfigType);
    } else {
      resolved = def.default();
    }
  } catch (err) {
    // Table missing or DB hiccup → fall through to default; do not throw.
    console.warn(`[RuntimeConfig] Failed to load ${key}, using default:`, err);
    resolved = def.default();
  }

  cache.set(key, { value: resolved, loadedAt: now });
  return resolved as T;
}

/** Synchronous variant for hot paths — uses last-cached value or default. Never hits DB. */
export function getConfigSync<T = unknown>(key: string): T {
  const def = CONFIG_KEYS[key];
  if (!def) throw new Error(`Unknown config key: ${key}`);
  const hit = cache.get(key);
  if (hit) return hit.value as T;
  return def.default() as T;
}

export async function setConfig(key: string, rawValue: string, updatedBy: string): Promise<{ previous: unknown; current: unknown }> {
  const def = CONFIG_KEYS[key];
  if (!def) throw new Error(`Unknown config key: ${key}. Use !config list to see editable keys.`);

  const parsed = parseInput(rawValue, def.type);
  if (def.validate) def.validate(parsed);

  const previous = await getConfig(key);

  await (prisma as any).runtimeConfig.upsert({
    where: { key },
    create: {
      key,
      value: serialiseStored(parsed, def.type),
      valueType: def.type,
      description: def.description,
      updatedBy,
    },
    update: {
      value: serialiseStored(parsed, def.type),
      valueType: def.type,
      updatedBy,
    },
  });

  invalidateConfigCache(key);

  await logError({
    scenario: "CONFIG_CHANGE",
    module: "runtime-config",
    code: "CONFIG_SET",
    message: `${updatedBy} set ${key} = ${rawValue} (was: ${JSON.stringify(previous)})`,
  }).catch(() => { /* swallow */ });

  return { previous, current: parsed };
}

export async function resetConfig(key: string, updatedBy: string): Promise<unknown> {
  const def = CONFIG_KEYS[key];
  if (!def) throw new Error(`Unknown config key: ${key}`);

  await (prisma as any).runtimeConfig.deleteMany({ where: { key } }).catch(() => {});
  invalidateConfigCache(key);

  await logError({
    scenario: "CONFIG_CHANGE",
    module: "runtime-config",
    code: "CONFIG_RESET",
    message: `${updatedBy} reset ${key} to default`,
  }).catch(() => { /* swallow */ });

  return def.default();
}

export async function listConfig(): Promise<Array<{ key: string; current: unknown; default: unknown; type: ConfigType; description: string; isOverride: boolean; updatedBy?: string; updatedAt?: Date }>> {
  const rows = (await (prisma as any).runtimeConfig.findMany().catch(() => [])) as Array<{ key: string; value: string; valueType: ConfigType; updatedBy: string | null; updatedAt: Date }>;
  const overrides = new Map(rows.map((r) => [r.key, r]));

  const out: Array<{ key: string; current: unknown; default: unknown; type: ConfigType; description: string; isOverride: boolean; updatedBy?: string; updatedAt?: Date }> = [];

  for (const [key, def] of Object.entries(CONFIG_KEYS)) {
    const dbRow = overrides.get(key);
    const dflt = def.default();
    const current = dbRow ? parseStored(dbRow.value, dbRow.valueType) : dflt;
    out.push({
      key,
      current,
      default: dflt,
      type: def.type,
      description: def.description,
      isOverride: Boolean(dbRow),
      updatedBy: dbRow?.updatedBy ?? undefined,
      updatedAt: dbRow?.updatedAt,
    });
  }

  return out.sort((a, b) => a.key.localeCompare(b.key));
}

// ── Type marshalling ───────────────────────────────────────────────────────

function parseInput(raw: string, type: ConfigType): unknown {
  const trimmed = raw.trim();
  switch (type) {
    case "string": return trimmed;
    case "int": {
      const n = parseInt(trimmed, 10);
      if (Number.isNaN(n)) throw new Error(`Expected integer, got "${raw}"`);
      return n;
    }
    case "float": {
      const n = parseFloat(trimmed);
      if (Number.isNaN(n)) throw new Error(`Expected number, got "${raw}"`);
      return n;
    }
    case "bool": {
      const lower = trimmed.toLowerCase();
      if (["true", "1", "yes", "on"].includes(lower)) return true;
      if (["false", "0", "no", "off"].includes(lower)) return false;
      throw new Error(`Expected boolean, got "${raw}"`);
    }
    case "json": {
      try { return JSON.parse(trimmed); }
      catch (e) { throw new Error(`Invalid JSON: ${(e as Error).message}`); }
    }
  }
}

function parseStored(raw: string, type: ConfigType): unknown {
  switch (type) {
    case "string": return raw;
    case "int": return parseInt(raw, 10);
    case "float": return parseFloat(raw);
    case "bool": return raw === "true";
    case "json": return JSON.parse(raw);
  }
}

function serialiseStored(value: unknown, type: ConfigType): string {
  if (type === "json") return JSON.stringify(value);
  if (type === "bool") return String(Boolean(value));
  return String(value);
}
