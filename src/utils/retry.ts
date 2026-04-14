// ============================================================================
// Lead Engine — Retry with Exponential Backoff
//
// Used by ai.service.ts, email.service.ts, chat.service.ts, calendar.service.ts
// Handles transient 429 (rate limit), 500, 502, 503, 504 from any provider.
// ============================================================================

export interface RetryOptions {
  maxAttempts?: number;    // default 3
  baseDelayMs?: number;    // default 1000
  maxDelayMs?: number;     // default 15000
  retryOn?: (error: unknown) => boolean; // custom retry predicate
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 15000,
  retryOn: isRetryable,
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  opts?: RetryOptions
): Promise<T> {
  const config = { ...DEFAULT_OPTIONS, ...opts };
  let lastError: unknown;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (attempt === config.maxAttempts || !config.retryOn(err)) {
        throw err;
      }

      const delay = Math.min(
        config.baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 500,
        config.maxDelayMs
      );

      console.warn(
        `[retry] ${label} attempt ${attempt}/${config.maxAttempts} failed, ` +
        `retrying in ${Math.round(delay)}ms: ${err instanceof Error ? err.message : String(err)}`
      );

      await sleep(delay);
    }
  }

  throw lastError;
}

function isRetryable(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();

    // HTTP status codes in error messages
    if (/\b(429|500|502|503|504)\b/.test(msg)) return true;

    // Network errors
    if (/\b(econnreset|econnrefused|etimedout|epipe|enotfound|socket hang up)\b/.test(msg)) return true;

    // Gemini-specific
    if (msg.includes("resource exhausted") || msg.includes("rate limit")) return true;

    // Graph API throttling
    if (msg.includes("throttled") || msg.includes("too many requests")) return true;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
