/**
 * A scripted `fetch` for provider clients. Routes are matched in order by
 * method and a URL substring (or regex); each call is recorded so a test can
 * assert on what was sent.
 */
export interface StubCall {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

export interface StubRoute {
  readonly method?: string;
  readonly match: string | RegExp;
  /** A JSON body (status 200), or a full response. Called per request when a function. */
  readonly reply:
    | unknown
    | ((
        call: StubCall,
      ) => unknown | { status: number; body?: unknown; headers?: Record<string, string> });
  /** Serve this route once, then fall through to later routes. */
  readonly once?: boolean;
}

export function stubFetch(routes: StubRoute[]): { fetch: typeof fetch; calls: StubCall[] } {
  const calls: StubCall[] = [];
  const used = new Set<StubRoute>();
  const impl = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    let body: unknown = init.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        // leave as text
      }
    }
    const call: StubCall = { method, url, headers, body };
    calls.push(call);
    const route = routes.find(
      (r) =>
        !(r.once && used.has(r)) &&
        (r.method ?? 'GET').toUpperCase() === method &&
        (typeof r.match === 'string' ? url.includes(r.match) : r.match.test(url)),
    );
    if (!route) return new Response(`no stub for ${method} ${url}`, { status: 404 });
    used.add(route);
    const out =
      typeof route.reply === 'function'
        ? (route.reply as (c: StubCall) => unknown)(call)
        : route.reply;
    if (
      out &&
      typeof out === 'object' &&
      'status' in out &&
      typeof (out as { status: unknown }).status === 'number'
    ) {
      const r = out as { status: number; body?: unknown; headers?: Record<string, string> };
      const text =
        r.body === undefined ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
      return new Response(r.status === 204 ? null : text, {
        status: r.status,
        headers: r.headers ?? {},
      });
    }
    return new Response(JSON.stringify(out ?? null), { status: 200 });
  };
  return { fetch: impl as typeof fetch, calls };
}
