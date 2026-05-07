export class CircuitBreaker {
  private failures: number[] = [];
  private openUntil = 0;

  constructor(
    private readonly label: string,
    private readonly threshold = 5,
    private readonly windowMs = 5 * 60_000,
    private readonly cooldownMs = 10 * 60_000,
  ) {}

  isOpen(): boolean {
    if (Date.now() < this.openUntil) return true;
    if (this.openUntil > 0 && Date.now() >= this.openUntil) {
      console.log(`[circuit:${this.label}] cooldown elapsed, half-open`);
      this.openUntil = 0;
      this.failures = [];
    }
    return false;
  }

  recordFailure(): void {
    const now = Date.now();
    this.failures = this.failures.filter((t) => now - t < this.windowMs);
    this.failures.push(now);
    if (this.failures.length >= this.threshold) {
      this.openUntil = now + this.cooldownMs;
      console.error(
        `[circuit:${this.label}] OPEN — ${this.failures.length} failures in ${this.windowMs / 1000}s, ` +
        `cooling down for ${this.cooldownMs / 60_000}min`,
      );
    }
  }

  recordSuccess(): void {
    this.failures = [];
  }
}

export const geminiBreaker = new CircuitBreaker("gemini", 5, 5 * 60_000, 10 * 60_000);
export const claudeBreaker = new CircuitBreaker("claude", 5, 5 * 60_000, 10 * 60_000);
