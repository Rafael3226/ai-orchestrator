import { RateLimiter } from '../http/rate.limiter.js';

/**
 * Trello: 300 req/10s per API key, 100 req/10s per token. The token bucket is
 * the binding one and it is per TOKEN, so limiters are keyed by credential
 * ref, not by board. Sized at 80% of the documented limits.
 */
export class TrelloRateLimiter extends RateLimiter {
  constructor() {
    super([
      { capacity: 240, refillPerSec: 24 },
      { capacity: 80, refillPerSec: 8 },
    ]);
  }
}

export const sharedTrelloLimiter = new TrelloRateLimiter();
