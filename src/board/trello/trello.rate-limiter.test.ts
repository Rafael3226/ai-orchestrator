import { describe, expect, it } from 'vitest';

import { TrelloRateLimiter } from './trello.rate-limiter.js';

describe('TrelloRateLimiter', () => {
  it('lets a burst through up to the token bucket and then waits', async () => {
    const l = new TrelloRateLimiter();
    const t0 = Date.now();
    for (let i = 0; i < 80; i++) await l.acquire('REF');
    expect(Date.now() - t0).toBeLessThan(200);
    const t1 = Date.now();
    await l.acquire('REF'); // 81st needs ~1/8 s of refill
    expect(Date.now() - t1).toBeGreaterThanOrEqual(90);
  });

  it('keys buckets by credential ref', async () => {
    const l = new TrelloRateLimiter();
    for (let i = 0; i < 80; i++) await l.acquire('A');
    const t = Date.now();
    await l.acquire('B');
    expect(Date.now() - t).toBeLessThan(50);
  });

  it('penalize drains the bucket for the given window', async () => {
    const l = new TrelloRateLimiter();
    l.penalize('REF', 300);
    const t = Date.now();
    await l.acquire('REF');
    expect(Date.now() - t).toBeGreaterThanOrEqual(250);
  });
});
