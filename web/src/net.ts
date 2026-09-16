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
