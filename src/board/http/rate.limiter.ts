/**
 * Token buckets keyed by credential ref. Every provider throttles per identity
 * (Trello per token, Azure DevOps per user, Jira per account), so limiters are
 * keyed by ref, not by board.
 */
class TokenBucket {
  private tokens: number;
  private last = Date.now();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
  ) {
    this.tokens = capacity;
  }

  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(
      this.capacity,
      this.tokens + ((now - this.last) / 1000) * this.refillPerSec,
    );
    this.last = now;
  }

  /** ms to wait before one token is available (0 = now). */
  waitMs(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    return Math.ceil(((1 - this.tokens) / this.refillPerSec) * 1000);
  }

  take(): void {
    this.refill();
    this.tokens = Math.max(0, this.tokens - 1);
  }

  /** Drain everything for `ms` — used after a 429 so every caller backs off together. */
  drain(ms: number): void {
    this.tokens = -((ms / 1000) * this.refillPerSec);
    this.last = Date.now();
  }
}

export interface BucketSpec {
  readonly capacity: number;
  readonly refillPerSec: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, TokenBucket[]>();

  constructor(private readonly specs: readonly BucketSpec[]) {}

  private get(ref: string): TokenBucket[] {
    let b = this.buckets.get(ref);
    if (!b) {
      b = this.specs.map((s) => new TokenBucket(s.capacity, s.refillPerSec));
      this.buckets.set(ref, b);
    }
    return b;
  }

  async acquire(ref: string): Promise<void> {
    const buckets = this.get(ref);
    for (;;) {
      const wait = Math.max(0, ...buckets.map((b) => b.waitMs()));
      if (wait <= 0) break;
      await new Promise((r) => setTimeout(r, wait));
    }
    for (const b of buckets) b.take();
  }

  penalize(ref: string, ms: number): void {
    for (const b of this.get(ref)) b.drain(ms);
  }
}
