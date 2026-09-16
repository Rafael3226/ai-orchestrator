import type { BoardCredential } from '../../config/credentials.js';
import { BoardError } from '../board.source.js';

import { sharedTrelloLimiter, type TrelloRateLimiter } from './trello.rate-limiter.js';

const BASE = 'https://api.trello.com/1';
const MAX_ATTEMPTS = 4;

export type Query = Record<string, string | number | boolean | undefined>;

/**
 * Ported from trello-cli/src/trelloClient.js with the gaps fixed: HTTP status
 * is preserved in a typed BoardError (so 429 can back off), all four verbs,
 * timeouts, jittered retry on retryable errors, a shared per-token rate
 * limiter, and credentials as constructor args instead of process.env reads.
 * Auth stays in the query string (what every Trello endpoint accepts), and
 * every logged URL is redacted.
 */
export class TrelloHttp {
  constructor(
    private readonly cred: BoardCredential,
    private readonly limiter: TrelloRateLimiter = sharedTrelloLimiter,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get<T>(path: string, query: Query = {}): Promise<T> {
    return this.request<T>('GET', path, query);
  }
  post<T>(path: string, query: Query = {}): Promise<T> {
    return this.request<T>('POST', path, query);
  }
  put<T>(path: string, query: Query = {}): Promise<T> {
    return this.request<T>('PUT', path, query);
  }
  delete<T>(path: string, query: Query = {}): Promise<T> {
    return this.request<T>('DELETE', path, query);
  }

  private url(path: string, query: Query): string {
    const params = new URLSearchParams({ key: this.cred.apiKey, token: this.cred.token });
    for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, String(v));
    return `${BASE}${path}?${params.toString()}`;
  }

  private async request<T>(method: string, path: string, query: Query): Promise<T> {
    let lastErr: BoardError | null = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      await this.limiter.acquire(this.cred.ref);
      try {
        const res = await this.fetchImpl(this.url(path, query), {
          method,
          signal: AbortSignal.timeout(15_000),
          headers: { Accept: 'application/json' },
        });
        if (res.ok) {
          const text = await res.text();
          return (text ? JSON.parse(text) : null) as T;
        }
        const body = await res.text().catch(() => '');
        const err = classify(res.status, body, res.headers.get('retry-after'), `${method} ${path}`);
        if (err.kind === 'rate-limited')
          this.limiter.penalize(this.cred.ref, err.retryAfterMs ?? 2000);
        if (!err.retryable) throw err;
        lastErr = err;
      } catch (e) {
        if (e instanceof BoardError) {
          if (!e.retryable) throw e;
          lastErr = e;
        } else {
          lastErr = new BoardError(
            'network',
            `${method} ${path}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      const delay = lastErr?.retryAfterMs ?? Math.min(8000, 500 * 2 ** attempt) * Math.random();
      await new Promise((r) => setTimeout(r, delay));
    }
    throw lastErr ?? new BoardError('unavailable', `${method} ${path}: retries exhausted`);
  }
}

export function classify(
  status: number,
  body: string,
  retryAfter: string | null,
  what: string,
): BoardError {
  const msg = `${what} → ${status}${body ? `: ${redact(body).slice(0, 300)}` : ''}`;
  if (status === 401) return new BoardError('auth', msg, status);
  if (status === 403) return new BoardError('permission', msg, status);
  if (status === 404) return new BoardError('not-found', msg, status);
  if (status === 429) {
    const secs = retryAfter ? Number(retryAfter) : NaN;
    return new BoardError('rate-limited', msg, status, Number.isFinite(secs) ? secs * 1000 : 2000);
  }
  if (status >= 500) return new BoardError('unavailable', msg, status);
  return new BoardError('permission', msg, status);
}

export const redact = (s: string): string => s.replace(/(key|token)=[^&\s"']+/gi, '$1=***');
