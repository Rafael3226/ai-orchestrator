import type { TrelloCredential } from '../../config/credentials.js';
import { type Query, RestClient } from '../http/rest.client.js';

import { sharedTrelloLimiter, type TrelloRateLimiter } from './trello.rate-limiter.js';

export { classify, redact, type Query } from '../http/rest.client.js';

const BASE = 'https://api.trello.com/1';

/**
 * Trello over the shared RestClient. Auth stays in the query string, which
 * every Trello endpoint accepts, and so does every parameter: Trello takes no
 * JSON bodies.
 */
export class TrelloHttp {
  private readonly client: RestClient;

  constructor(
    cred: TrelloCredential,
    limiter: TrelloRateLimiter = sharedTrelloLimiter,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.client = new RestClient({
      baseUrl: BASE,
      ref: cred.ref,
      limiter,
      authQuery: { key: cred.apiKey, token: cred.token },
      fetchImpl,
    });
  }

  get<T>(path: string, query: Query = {}): Promise<T> {
    return this.client.get<T>(path, { query });
  }
  post<T>(path: string, query: Query = {}): Promise<T> {
    return this.client.post<T>(path, { query });
  }
  put<T>(path: string, query: Query = {}): Promise<T> {
    return this.client.put<T>(path, { query });
  }
  delete<T>(path: string, query: Query = {}): Promise<T> {
    return this.client.delete<T>(path, { query });
  }
}
