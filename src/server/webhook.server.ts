import Fastify, { type FastifyInstance } from 'fastify';

import type { BoardEvent } from '../board/board.types.js';
import { redact } from '../board/trello/trello.http.js';
import {
  mapWebhookPayload,
  parseTrelloWebhook,
  SIGNATURE_HEADER,
  verifyTrelloSignature,
} from '../board/trello/trello.webhook.js';

export type DeliveryOutcome = 'delivered' | 'rejected' | 'stale';

export interface WebhookTarget {
  readonly projectId: string;
  readonly boardId: string;
  /** Deliveries this member caused are buffered but never wake the daemon. */
  readonly botMemberId: string | null;
  /** The exact string registered with Trello — the HMAC covers it. */
  readonly callbackURL: string;
  readonly apiSecret: string;
  readonly maxEventAgeMs: number;
  push(event: BoardEvent, opts: { wake: boolean }): void;
  /** Durable counters, so `orchestrator status` in another process sees liveness. */
  note?(outcome: DeliveryOutcome): void;
}

export interface WebhookServerOptions {
  readonly host: string;
  readonly port: number;
  /** Everything before the per-project segment, e.g. `/hooks/trello`. */
  readonly pathPrefix: string;
  /** Unguessable path segment shared by every project on this daemon. */
  readonly pathSecret: string;
  readonly log: (msg: string) => void;
}

const BODY_LIMIT_BYTES = 64 * 1024;
const RATE_BURST = 80;
const RATE_PER_SECOND = 40;

/**
 * The one endpoint that must be reachable from the public internet, and so
 * deliberately NOT part of OfficeServer:
 *
 * - `start --no-server` disables the office; it must never disable dispatch.
 * - The office binds loopback and sets `Access-Control-Allow-Origin: *` over a
 *   firehose of run logs. Two ports means you expose exactly one of them.
 * - The office's not-found handler falls back to index.html for extensionless
 *   paths, so a typo'd callback would answer Trello's verification HEAD with
 *   `200 text/html` and silently register against a dead route. Here a wrong
 *   path 404s, loudly.
 * - Signature checking needs the raw body bytes, which means a custom content
 *   type parser that has no business changing how `/api/*` is parsed.
 */
export class WebhookServer {
  private readonly app: FastifyInstance;
  private readonly targets = new Map<string, WebhookTarget>();
  private tokens = RATE_BURST;
  private lastRefill = Date.now();

  constructor(private readonly opts: WebhookServerOptions) {
    this.app = Fastify({ logger: false, bodyLimit: BODY_LIMIT_BYTES });
    // Keep the bytes exactly as received: re-serializing req.body would change
    // key order, unicode escaping and number formatting, and break every HMAC.
    this.app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
      try {
        done(null, { raw: body as string, json: JSON.parse(body as string) as unknown });
      } catch {
        // Keep the raw bytes: a body that fails to parse must still fail the
        // signature check rather than looking like a malformed-JSON 400.
        done(null, { raw: body as string, json: null });
      }
    });
    this.routes();
  }

  register(target: WebhookTarget): void {
    this.targets.set(target.projectId, target);
  }

  private route(): string {
    return `${this.opts.pathPrefix}/${this.opts.pathSecret}/:projectId`;
  }

  private routes(): void {
    const app = this.app;

    // Trello verifies a callbackURL with a HEAD before accepting a registration,
    // and Fastify only derives HEAD for GET routes — never for POST. Without
    // this, `POST /1/webhooks` fails with an unhelpful "callbackURL" error.
    app.head<{ Params: { projectId: string } }>(this.route(), async (req, reply) => {
      if (!this.targets.has(req.params.projectId)) return reply.code(404).send();
      return reply.code(200).send();
    });

    app.post<{ Params: { projectId: string } }>(this.route(), async (req, reply) => {
      if (!this.allow()) return reply.code(429).send({ error: 'slow down' });

      const target = this.targets.get(req.params.projectId);
      if (!target) return reply.code(404).send({ error: 'unknown project' });

      const body = req.body as { raw: string; json: unknown } | undefined;
      const header = req.headers[SIGNATURE_HEADER];
      const signature = Array.isArray(header) ? header[0] : header;
      if (
        !body ||
        !verifyTrelloSignature(body.raw, target.callbackURL, target.apiSecret, signature)
      ) {
        // 401, not a swallowed 200: a webhook we persistently reject is
        // something the operator should see, not something to hide.
        target.note?.('rejected');
        this.opts.log(`${target.projectId}: webhook delivery rejected — bad signature`);
        return reply.code(401).send({ error: 'bad signature' });
      }

      const parsed = parseTrelloWebhook(body.json);
      if (!parsed) {
        target.note?.('rejected');
        return reply.code(400).send({ error: 'unrecognized payload' });
      }

      const claimed = parsed.modelId ?? boardIdOf(parsed.action.data);
      if (claimed && claimed !== target.boardId) {
        target.note?.('rejected');
        this.opts.log(
          `${target.projectId}: webhook delivery for board ${claimed}, expected ${target.boardId}`,
        );
        return reply.code(400).send({ error: 'board mismatch' });
      }

      const age = Date.now() - Date.parse(parsed.action.date);
      if (Number.isFinite(age) && age > target.maxEventAgeMs) {
        // A genuine replay is already inert (same eventId → markEventSeen), so
        // this only makes a captured-payload flood cheap to refuse.
        target.note?.('stale');
        return reply.code(200).send();
      }

      const event = mapWebhookPayload(body.json, target.boardId);
      if (event) {
        // Our own writeback comes straight back as a delivery. It still has to
        // reach the router — the only thing allowed to call an event an echo —
        // but a run in flight must not storm the daemon with its own ticks.
        const ours = target.botMemberId !== null && event.actorMemberId === target.botMemberId;
        target.push(event, { wake: !ours });
        target.note?.('delivered');
        this.opts.log(
          `${target.projectId}: webhook ${parsed.action.type} on card ${event.cardId}` +
            (ours ? ' (own writeback — buffered, not woken)' : ''),
        );
      } else {
        // A board-level action we do not route on. Accepted and ignored.
        target.note?.('delivered');
      }
      return reply.code(200).send();
    });

    app.get(`${this.opts.pathPrefix}/healthz`, async () => ({
      ok: true,
      targets: [...this.targets.keys()],
    }));
  }

  /** Global token bucket. Outbound limiting is a separate concern entirely. */
  private allow(): boolean {
    const now = Date.now();
    this.tokens = Math.min(
      RATE_BURST,
      this.tokens + ((now - this.lastRefill) / 1000) * RATE_PER_SECOND,
    );
    this.lastRefill = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  async start(): Promise<string> {
    const url = await this.app.listen({ host: this.opts.host, port: this.opts.port });
    this.opts.log(`webhooks at ${redact(url)}${this.opts.pathPrefix}`);
    if (this.opts.host === '0.0.0.0') {
      this.opts.log(
        'webhook server is bound to 0.0.0.0 — it is directly exposed; put a TLS terminator or tunnel in front',
      );
    }
    return url;
  }

  async stop(): Promise<void> {
    await this.app.close();
  }
}

function boardIdOf(data: unknown): string | null {
  const board = (data as { board?: { id?: unknown } } | null)?.board;
  return typeof board?.id === 'string' ? board.id : null;
}
