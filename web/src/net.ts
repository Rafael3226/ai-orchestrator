import type { LogLine, StateSnapshot } from '@server/state.types';

export type ConnState = 'connecting' | 'live' | 'reconnecting';

/** Snapshot stream. Every event is a full replacement, so reconnects need no replay logic. */
export function openStateStream(
  onSnapshot: (s: StateSnapshot) => void,
  onConn: (c: ConnState) => void,
): () => void {
  let es: EventSource | null = null;
  let closed = false;
  const connect = () => {
    if (closed) return;
    onConn('connecting');
    es = new EventSource('/api/events');
    es.addEventListener('state.snapshot', (e) => {
      onConn('live');
      onSnapshot(JSON.parse((e as MessageEvent<string>).data) as StateSnapshot);
    });
    es.onerror = () => {
      onConn('reconnecting'); // EventSource retries by itself (retry: 3000)
    };
  };
  connect();
  return () => {
    closed = true;
    es?.close();
  };
}

export interface LogStreamHandlers {
  onTail(lines: LogLine[]): void;
  onLines(lines: LogLine[]): void;
  onTruncated(dropped: number): void;
  onEnd(): void;
}

export function openLogStream(runId: string, h: LogStreamHandlers): () => void {
  const es = new EventSource(`/api/runs/${encodeURIComponent(runId)}/log`);
  const parse = <T>(e: Event) => JSON.parse((e as MessageEvent<string>).data) as T;
  es.addEventListener('log.tail', (e) => h.onTail(parse<{ lines: LogLine[] }>(e).lines));
  es.addEventListener('log.lines', (e) => h.onLines(parse<{ lines: LogLine[] }>(e).lines));
  es.addEventListener('log.truncated', (e) => h.onTruncated(parse<{ dropped: number }>(e).dropped));
  es.addEventListener('log.end', () => {
    h.onEnd();
    es.close();
  });
  return () => es.close();
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** JSON call against the office API. A non-2xx answer throws with the server's own message. */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, init);
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, body.error ?? `${res.status} ${res.statusText}`);
  return body as T;
}

export const postJson = <T>(path: string, body?: unknown): Promise<T> =>
  api<T>(path, {
    method: 'POST',
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });

/**
 * SSE over POST: EventSource can only GET, so read the body as a stream and
 * split it into events ourselves. A non-stream answer is a validation error.
 */
export async function postStream<E>(
  path: string,
  body: unknown,
  onEvent: (e: E) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok || !res.headers.get('content-type')?.includes('text/event-stream')) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, err.error ?? `${res.status} ${res.statusText}`);
  }
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      const data = block
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6))
        .join('\n');
      if (data) onEvent(JSON.parse(data) as E);
    }
  }
}
