/**
 * Trello: 300 req/10s per API key, 100 req/10s per token. The token bucket is
 * the binding one and it is per TOKEN, so limiters are keyed by credential
 * ref, not by board. Sized at 80% of the documented limits.
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

export class TrelloRateLimiter {
  private readonly buckets = new Map<string, { key: TokenBucket; token: TokenBucket }>();

  private get(ref: string) {
    let b = this.buckets.get(ref);
    if (!b) {
      b = { key: new TokenBucket(240, 24), token: new TokenBucket(80, 8) };
      this.buckets.set(ref, b);
    }
    return b;
  }

  async acquire(ref: string): Promise<void> {
    const b = this.get(ref);
    for (;;) {
      const wait = Math.max(b.key.waitMs(), b.token.waitMs());
      if (wait <= 0) break;
      await new Promise((r) => setTimeout(r, wait));
    }
    b.key.take();
    b.token.take();
  }

  penalize(ref: string, ms: number): void {
    const b = this.get(ref);
    b.key.drain(ms);
    b.token.drain(ms);
  }
}

export const sharedTrelloLimiter = new TrelloRateLimiter();
