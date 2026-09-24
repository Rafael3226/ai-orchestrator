import { BoardError } from '../board.source.js';

import type { RateLimiter } from './rate.limiter.js';

const MAX_ATTEMPTS = 4;
const TIMEOUT_MS = 15_000;

export type Query = Record<string, string | number | boolean | undefined>;

export interface RestRequest {
  readonly query?: Query;
  /** Serialized as JSON unless it is already a string. */
  readonly body?: unknown;
  readonly contentType?: string;
}

export interface RestClientOptions {
  readonly baseUrl: string;
  /** Credential ref: the rate-limiter key. */
  readonly ref: string;
  readonly limiter: RateLimiter;
  /** Auth that travels in headers (Azure DevOps, Jira). */
  readonly headers?: Readonly<Record<string, string>>;
  /** Auth that travels in the query string (Trello). */
  readonly authQuery?: Readonly<Record<string, string>>;
  readonly fetchImpl?: typeof fetch;
}

/**
 * The retrying JSON client every board provider shares. HTTP status is kept in
 * a typed BoardError so a 429 can back off. It adds timeouts, jittered retry on
 * retryable errors and a per-ref rate limiter, and redacts every logged URL.
 */
export class RestClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: RestClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get<T>(path: string, req: RestRequest = {}): Promise<T> {
    return this.request<T>('GET', path, req);
  }
  post<T>(path: string, req: RestRequest = {}): Promise<T> {
    return this.request<T>('POST', path, req);
  }
  put<T>(path: string, req: RestRequest = {}): Promise<T> {
    return this.request<T>('PUT', path, req);
  }
  patch<T>(path: string, req: RestRequest = {}): Promise<T> {
    return this.request<T>('PATCH', path, req);
  }
  delete<T>(path: string, req: RestRequest = {}): Promise<T> {
    return this.request<T>('DELETE', path, req);
  }

  private url(path: string, query: Query): string {
    const params = new URLSearchParams(this.opts.authQuery ?? {});
    for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, String(v));
    const qs = params.toString();
    const url = /^https?:\/\//.test(path) ? path : `${this.opts.baseUrl}${path}`;
    return qs ? `${url}${url.includes('?') ? '&' : '?'}${qs}` : url;
  }

  async request<T>(method: string, path: string, req: RestRequest = {}): Promise<T> {
    const { ref, limiter } = this.opts;
    const what = `${method} ${redact(path)}`;
    const headers: Record<string, string> = { Accept: 'application/json', ...this.opts.headers };
    let body: string | undefined;
    if (req.body !== undefined) {
      body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      headers['Content-Type'] = req.contentType ?? 'application/json';
    }

    let lastErr: BoardError | null = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      await limiter.acquire(ref);
      try {
        const res = await this.fetchImpl(this.url(path, req.query ?? {}), {
          method,
          signal: AbortSignal.timeout(TIMEOUT_MS),
          headers,
          ...(body !== undefined ? { body } : {}),
        });
        // Azure DevOps answers a bad or expired PAT with 203 and an HTML
        // sign-in page instead of a 401.
        if (res.status === 203) {
          throw new BoardError('auth', `${what} → 203: credentials rejected (sign-in page)`, 203);
        }
        if (res.ok) {
          const text = await res.text();
          return (text ? JSON.parse(text) : null) as T;
        }
        const text = await res.text().catch(() => '');
        const err = classify(res.status, text, res.headers.get('retry-after'), what);
        if (err.kind === 'rate-limited') limiter.penalize(ref, err.retryAfterMs ?? 2000);
        if (!err.retryable) throw err;
        lastErr = err;
      } catch (e) {
        if (e instanceof BoardError) {
          if (!e.retryable) throw e;
          lastErr = e;
        } else if (e instanceof SyntaxError) {
          throw new BoardError('parse', `${what}: ${e.message}`);
        } else {
          lastErr = new BoardError(
            'network',
            `${what}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      const delay = lastErr?.retryAfterMs ?? Math.min(8000, 500 * 2 ** attempt) * Math.random();
      await new Promise((r) => setTimeout(r, delay));
    }
    throw lastErr ?? new BoardError('unavailable', `${what}: retries exhausted`);
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

export const redact = (s: string): string =>
  s
    .replace(/(key|token)=[^&\s"']+/gi, '$1=***')
    .replace(/\b(Basic|Bearer)\s+[A-Za-z0-9+/=._-]+/g, '$1 ***');

export const basicAuth = (user: string, secret: string): string =>
  `Basic ${Buffer.from(`${user}:${secret}`).toString('base64')}`;
