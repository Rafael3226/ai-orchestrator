import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { BoardStore } from '../board/board.store.js';
import type { LoadedConfig } from '../config/config.loader.js';
import type { SqliteStore } from '../db/sqlite.store.js';
import type { RunId } from '../domain/ids.js';

import { ChatError, type ChatService, MAX_MESSAGE_CHARS } from './chat.service.js';
import type { ChatStreamEvent } from './chat.types.js';
import { StateProjector } from './state.projection.js';
import type { LogLine, OfficeEvent } from './state.types.js';

export interface ServerOptions {
  readonly host: string;
  readonly port: number;
  /** Built office client; served when present. */
  readonly webDist?: string;
  readonly log: (msg: string) => void;
  /** The BA chat. Absent means the chat routes are not mounted. */
  readonly chat?: ChatService;
}

const messageBody = z.object({ text: z.string().min(1).max(MAX_MESSAGE_CHARS) });

/**
 * The office binds to loopback, but a page on any site can still POST to
 * 127.0.0.1 from the user's browser. A browser always sends Origin on a
 * cross-origin POST, so: no Origin (curl, tests) is fine, a same-host Origin is
 * fine, and a loopback Origin is fine (the Vite dev server proxies from :5173).
 */
export function originAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (host && url.host === host) return true;
  return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
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

    if (this.opts.chat) this.chatRoutes(this.opts.chat);

    if (this.opts.webDist && existsSync(this.opts.webDist)) {
      // Wildcard serving resolves files at request time, so a `pnpm web:build` with new
      // asset hashes is picked up without restarting the daemon.
      void app.register(fastifyStatic, {
        root: resolve(this.opts.webDist),
        prefix: '/',
        wildcard: true,
      });
      app.setNotFoundHandler((req, reply) => {
        const path = req.url.split('?')[0] ?? '';
        if (path.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
        // A missing asset must 404, never fall back to index.html (browsers reject a
        // text/html response for a module script).
        if (path.startsWith('/assets/') || /\.[a-z0-9]+$/i.test(path)) {
          return reply.code(404).send({ error: 'not found' });
        }
        return reply.sendFile('index.html');
      });
    } else {
      app.get('/', async () => ({
        hint: 'office client not built — run `pnpm web:build`; API is under /api/',
      }));
    }
  }

  private chatRoutes(chat: ChatService): void {
    const app = this.app;
    const guard = async (req: FastifyRequest, reply: FastifyReply) => {
      if (!originAllowed(req.headers.origin, req.headers.host)) {
        return reply.code(403).send({ error: 'cross-origin request refused' });
      }
    };
    const fail = (reply: FastifyReply, e: unknown) => {
      if (e instanceof ChatError) return reply.code(e.status).send({ error: e.message });
      throw e;
    };

    app.post<{ Params: { id: string } }>(
      '/api/projects/:id/chat',
      { preHandler: guard },
      async (req, reply) => {
        try {
          return reply.code(201).send(chat.start(req.params.id));
        } catch (e) {
          return fail(reply, e);
        }
      },
    );

    app.get<{ Params: { sid: string } }>('/api/chat/:sid', async (req, reply) => {
      try {
        return chat.view(req.params.sid);
      } catch (e) {
        return fail(reply, e);
      }
    });

    // SSE over POST (the browser reads it with fetch). The stream is opened on
    // the first event, so a validation failure still gets a plain status code.
    app.post<{ Params: { sid: string } }>(
      '/api/chat/:sid/messages',
      { preHandler: guard },
      async (req, reply) => {
        const body = messageBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: z.prettifyError(body.error) });
        const abort = new AbortController();
        let open = false;
        const emit = (e: ChatStreamEvent) => {
          if (!open) {
            open = true;
            this.sseHeaders(reply);
            reply.raw.on('close', () => {
              if (!reply.raw.writableEnded) abort.abort();
            });
          }
          if (!reply.raw.destroyed) {
            reply.raw.write(`event: ${e.type}
data: ${JSON.stringify(e)}

`);
          }
        };
        try {
          await chat.send(req.params.sid, body.data.text, emit, abort.signal);
        } catch (e) {
          if (!open) return fail(reply, e);
          emit({ type: 'error', message: e instanceof Error ? e.message : String(e) });
        }
        reply.raw.end();
        return reply;
      },
    );

    app.post<{ Params: { sid: string } }>(
      '/api/chat/:sid/submit',
      { preHandler: guard },
      async (req, reply) => {
        try {
          const r = chat.submit(req.params.sid);
          return { ...r, session: chat.view(req.params.sid) };
        } catch (e) {
          return fail(reply, e);
        }
      },
    );
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
