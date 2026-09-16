import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';

import type { BoardStore } from '../board/board.store.js';
import type { LoadedConfig } from '../config/config.loader.js';
import type { SqliteStore } from '../db/sqlite.store.js';
import type { RunId } from '../domain/ids.js';

import { StateProjector } from './state.projection.js';
import type { LogLine, OfficeEvent } from './state.types.js';

export interface ServerOptions {
  readonly host: string;
  readonly port: number;
  /** Built office client; served when present. */
  readonly webDist?: string;
  readonly log: (msg: string) => void;
}

const SNAPSHOT_TICK_MS = 1000;
const HEARTBEAT_MS = 15_000;
const LOG_FLUSH_MS = 150;
const LOG_INITIAL = 200;
const LOG_MAX_BACKLOG = 2000;

/**
 * Fastify + SSE. Every event carries a full replacement object — no deltas.
 * The snapshot stream re-projects once a second and only emits on change.
 */
export class OfficeServer {
  private readonly app: FastifyInstance;
  private readonly projector: StateProjector;
  private eventId = 0;
  private lastHash = '';
  private lastSnapshotJson = '';
  private readonly clients = new Set<FastifyReply>();
  private snapshotTimer: NodeJS.Timeout | null = null;

  constructor(
    loaded: LoadedConfig,
    store: SqliteStore,
    boardStore: BoardStore,
    private readonly opts: ServerOptions,
  ) {
    this.projector = new StateProjector(loaded, store, boardStore);
    this.app = Fastify({ logger: false });
    this.routes();
  }

  private routes(): void {
    const app = this.app;

    app.get('/api/healthz', async () => ({
      ok: true,
      clients: this.clients.size,
      eventId: this.eventId,
    }));

    app.get('/api/state', async () => this.currentSnapshot());

    app.get('/api/events', async (req, reply) => {
      this.sseHeaders(reply);
      this.clients.add(reply);
      // Full-replacement semantics: any reconnect just gets the current snapshot.
      const snap = this.currentSnapshot();
      write(reply, this.eventId, { type: 'state.snapshot', data: snap });
      const hb = setInterval(() => reply.raw.write(':hb\n\n'), HEARTBEAT_MS);
      req.raw.on('close', () => {
        clearInterval(hb);
        this.clients.delete(reply);
      });
      await new Promise(() => {}); // held open until the client disconnects
    });

    app.get<{ Params: { id: string } }>('/api/runs/:id', async (req, reply) => {
      const runId = req.params.id as RunId;
      try {
        const lines = this.projector.logLines(runId, 0, 5000);
        return { runId, live: this.projector.runIsLive(runId), lines };
      } catch (e) {
        return reply.code(404).send({ error: String(e) });
      }
    });

    app.get<{ Params: { id: string } }>('/api/runs/:id/log', async (req, reply) => {
      const runId = req.params.id as RunId;
      this.sseHeaders(reply);
      const all = this.projector.logLines(runId, 0, 100_000);
      let seq = all.at(-1)?.seq ?? 0;
      write(reply, seq, { type: 'log.tail', data: { runId, lines: all.slice(-LOG_INITIAL) } });

      let closed = false;
      req.raw.on('close', () => {
        closed = true;
      });
      const hb = setInterval(() => !closed && reply.raw.write(':hb\n\n'), HEARTBEAT_MS);
      // Coalesced follow: one event per flush, backlog truncated in the MIDDLE (keep the start of a failure).
      const tick = async () => {
        while (!closed) {
          await new Promise((r) => setTimeout(r, LOG_FLUSH_MS));
          if (closed) break;
          let lines: LogLine[] = this.projector.logLines(runId, seq, LOG_MAX_BACKLOG + 1);
          if (lines.length) {
            seq = lines.at(-1)!.seq;
            if (lines.length > LOG_MAX_BACKLOG) {
              const dropped = lines.length - 400;
              lines = [...lines.slice(0, 200), ...lines.slice(-200)];
              write(reply, seq, { type: 'log.truncated', data: { runId, dropped } });
            }
            if (reply.raw.writableLength > 8 * 1024 * 1024) break; // wedged client — let go
            write(reply, seq, { type: 'log.lines', data: { runId, lines } });
          } else if (!this.projector.runIsLive(runId)) {
            write(reply, seq, { type: 'log.end', data: { runId } });
            break;
          }
        }
        clearInterval(hb);
        if (!closed) reply.raw.end();
      };
      void tick();
      await new Promise(() => {});
    });

    if (this.opts.webDist && existsSync(this.opts.webDist)) {
      void app.register(fastifyStatic, {
        root: resolve(this.opts.webDist),
        prefix: '/',
        wildcard: false,
      });
      app.setNotFoundHandler((req, reply) => {
        if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
        return reply.sendFile('index.html');
      });
    } else {
      app.get('/', async () => ({
        hint: 'office client not built — run `pnpm web:build`; API is under /api/',
      }));
    }
  }

  private sseHeaders(reply: FastifyReply): void {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });
    reply.raw.write('retry: 3000\n\n');
  }

  private currentSnapshot() {
    return this.projector.snapshot(this.eventId);
  }

  private broadcastIfChanged(): void {
    const snap = this.projector.snapshot(this.eventId + 1);
    // Hash without the volatile fields so an idle office does not spam clients.
    const stable = JSON.stringify({
      ...snap,
      serverTime: undefined,
      eventId: undefined,
      agents: snap.agents.map((a) => ({ ...a, run: a.run ? { ...a.run, elapsedMs: 0 } : null })),
    });
    const hash = createHash('sha1').update(stable).digest('hex');
    if (hash === this.lastHash && this.clients.size) {
      // Still push the cheap elapsed-time tick every 5s so pills stay honest.
      if (this.eventId % 5 !== 0) {
        this.eventId++;
        return;
      }
    }
    this.lastHash = hash;
    this.eventId++;
    const payload = { type: 'state.snapshot' as const, data: { ...snap, eventId: this.eventId } };
    this.lastSnapshotJson = JSON.stringify(payload.data);
    for (const c of this.clients) write(c, this.eventId, payload);
  }

  async start(): Promise<string> {
    this.snapshotTimer = setInterval(() => {
      try {
        this.broadcastIfChanged();
      } catch (e) {
        this.opts.log(`snapshot failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }, SNAPSHOT_TICK_MS);
    const url = await this.app.listen({ host: this.opts.host, port: this.opts.port });
    this.opts.log(`office at ${url}`);
    return url;
  }

  async stop(): Promise<void> {
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    for (const c of this.clients) c.raw.end();
    await this.app.close();
  }

  get lastJson(): string {
    return this.lastSnapshotJson;
  }
}

function write(reply: FastifyReply, id: number, ev: OfficeEvent): void {
  if (reply.raw.destroyed) return;
  reply.raw.write(`id: ${id}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`);
}
