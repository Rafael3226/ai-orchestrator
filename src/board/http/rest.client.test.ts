import { describe, expect, it } from 'vitest';

import { stubFetch } from '../../testing/fetch.stub.js';
import { BoardError } from '../board.source.js';

import { RateLimiter } from './rate.limiter.js';
import { basicAuth, redact, RestClient } from './rest.client.js';

const client = (
  fetchImpl: typeof fetch,
  extra: Partial<ConstructorParameters<typeof RestClient>[0]> = {},
) =>
  new RestClient({
    baseUrl: 'https://api.example.com',
    ref: 'REF',
    limiter: new RateLimiter([{ capacity: 100, refillPerSec: 100 }]),
    fetchImpl,
    ...extra,
  });

describe('RestClient', () => {
  it('sends JSON bodies with auth headers and the query string', async () => {
    const { fetch, calls } = stubFetch([{ method: 'POST', match: '/things', reply: { ok: 1 } }]);
    const out = await client(fetch, { headers: { Authorization: 'Basic abc' } }).post('/things', {
      query: { a: 1, skip: undefined },
      body: { name: 'x' },
    });
    expect(out).toEqual({ ok: 1 });
    expect(calls[0]?.url).toBe('https://api.example.com/things?a=1');
    expect(calls[0]?.headers['authorization']).toBe('Basic abc');
    expect(calls[0]?.headers['content-type']).toBe('application/json');
    expect(calls[0]?.body).toEqual({ name: 'x' });
  });

  it('puts query auth first and accepts absolute URLs', async () => {
    const { fetch, calls } = stubFetch([{ match: 'other.example.com', reply: {} }]);
    await client(fetch, { authQuery: { key: 'k' } }).get('https://other.example.com/x?y=1');
    expect(calls[0]?.url).toBe('https://other.example.com/x?y=1&key=k');
  });

  it('treats a 203 sign-in page as an auth failure, without retrying', async () => {
    const { fetch, calls } = stubFetch([{ match: '/x', reply: { status: 203, body: '<html>' } }]);
    await expect(client(fetch).get('/x')).rejects.toMatchObject({ kind: 'auth', status: 203 });
    expect(calls).toHaveLength(1);
  });

  it('retries a 429 after Retry-After, then succeeds', async () => {
    const { fetch, calls } = stubFetch([
      { match: '/x', once: true, reply: { status: 429, headers: { 'retry-after': '0' } } },
      { match: '/x', reply: { done: true } },
    ]);
    await expect(client(fetch).get('/x')).resolves.toEqual({ done: true });
    expect(calls).toHaveLength(2);
  });

  it('does not retry a 400, and keeps the provider message', async () => {
    const { fetch, calls } = stubFetch([
      { method: 'PATCH', match: '/x', reply: { status: 400, body: { message: 'bad state' } } },
    ]);
    const err = await client(fetch)
      .patch('/x', { body: [] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BoardError);
    expect((err as BoardError).message).toMatch(/bad state/);
    expect(calls).toHaveLength(1);
  });

  it('reports an unparseable success body as a parse error', async () => {
    const { fetch } = stubFetch([{ match: '/x', reply: { status: 200, body: 'not json' } }]);
    await expect(client(fetch).get('/x')).rejects.toMatchObject({ kind: 'parse' });
  });
});

describe('redact', () => {
  it('masks query credentials and auth headers', () => {
    expect(redact('GET /x?key=abc&token=def')).toBe('GET /x?key=***&token=***');
    expect(redact('Authorization: Basic dXNlcjpwYXNz')).toBe('Authorization: Basic ***');
  });
});

describe('basicAuth', () => {
  it('encodes an empty user for Azure DevOps PATs', () => {
    expect(basicAuth('', 'pat')).toBe(`Basic ${Buffer.from(':pat').toString('base64')}`);
  });
});
