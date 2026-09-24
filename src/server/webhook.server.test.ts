import { afterEach, describe, expect, it } from 'vitest';

import type { BoardEvent } from '../board/board.types.js';
import { SIGNATURE_HEADER, trelloSignature } from '../board/trello/trello.webhook.js';

import { WebhookServer, type DeliveryOutcome, type WebhookTarget } from './webhook.server.js';

const PREFIX = '/hooks/trello';
const SECRET_PATH = 's3cr3tpath';
const API_SECRET = 'trello-api-secret-0123456789abcdef';
const PROJECT = 'ai-auto-apply';
const BOARD_ID = 'board-abc123';
const BOT = 'bot-member-id';

function delivery(
  over: { action?: Record<string, unknown>; model?: unknown } = {},
): Record<string, unknown> {
  const { action, ...rest } = over;
  return {
    action: {
      id: `act-${Math.random().toString(36).slice(2)}`,
      idMemberCreator: 'human-member-id',
      type: 'updateCard',
      date: new Date().toISOString(),
      data: {
        card: { id: 'card-1', idShort: 42, name: 'Add a slugify utility' },
        listBefore: { id: 'list-backlog', name: 'Backlog' },
        listAfter: { id: 'list-ready', name: 'Ready for Dev' },
        board: { id: BOARD_ID },
      },
      ...action,
    },
    model: { id: BOARD_ID },
    ...rest,
  };
}

interface Harness {
  url: string;
  server: WebhookServer;
  pushed: { event: BoardEvent; wake: boolean }[];
  noted: DeliveryOutcome[];
  callbackURL: string;
  post(body: string, opts?: { signature?: string; project?: string }): Promise<Response>;
}

const open: WebhookServer[] = [];

async function start(targetOver: Partial<WebhookTarget> = {}): Promise<Harness> {
  const pushed: { event: BoardEvent; wake: boolean }[] = [];
  const noted: DeliveryOutcome[] = [];
  const server = new WebhookServer({
    host: '127.0.0.1',
    port: 0,
    pathPrefix: PREFIX,
    pathSecret: SECRET_PATH,
    log: () => {},
  });
  open.push(server);
  const url = await server.start();
  const callbackURL = `${url}${PREFIX}/${SECRET_PATH}/${PROJECT}`;

  server.register({
    projectId: PROJECT,
    boardId: BOARD_ID,
    botMemberId: BOT,
    callbackURL,
    apiSecret: API_SECRET,
    maxEventAgeMs: 600_000,
    push: (event, o) => pushed.push({ event, wake: o.wake }),
    note: (o) => noted.push(o),
    ...targetOver,
  });

  const post = (body: string, o: { signature?: string; project?: string } = {}) =>
    fetch(`${url}${PREFIX}/${SECRET_PATH}/${o.project ?? PROJECT}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [SIGNATURE_HEADER]: o.signature ?? trelloSignature(body, callbackURL, API_SECRET),
      },
      body,
    });

  return { url, server, pushed, noted, callbackURL, post };
}

afterEach(async () => {
  for (const s of open.splice(0)) await s.stop();
});

describe('WebhookServer registration handshake', () => {
  it('answers Trello’s verification HEAD with 200 and no signature', async () => {
    const { url } = await start();
    const res = await fetch(`${url}${PREFIX}/${SECRET_PATH}/${PROJECT}`, { method: 'HEAD' });
    expect(res.status).toBe(200);
  });

  it('404s a HEAD for an unknown project', async () => {
    const { url } = await start();
    const res = await fetch(`${url}${PREFIX}/${SECRET_PATH}/nope`, { method: 'HEAD' });
    expect(res.status).toBe(404);
  });

  it('404s a POST on the wrong path secret', async () => {
    const { url } = await start();
    const res = await fetch(`${url}${PREFIX}/wrong-secret/${PROJECT}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });
});

describe('WebhookServer delivery', () => {
  it('buffers a correctly signed card move and asks for a wake', async () => {
    const h = await start();
    const body = JSON.stringify(delivery());

    const res = await h.post(body);

    expect(res.status).toBe(200);
    expect(h.pushed).toHaveLength(1);
    expect(h.pushed[0]?.wake).toBe(true);
    expect(h.pushed[0]?.event).toMatchObject({
      kind: 'card.moved',
      cardId: 'card-1',
      toColumnId: 'list-ready',
    });
    expect(h.noted).toEqual(['delivered']);
  });

  it('buffers our own writeback without waking the daemon', async () => {
    const h = await start();
    const body = JSON.stringify(delivery({ action: { idMemberCreator: BOT } }));

    expect((await h.post(body)).status).toBe(200);

    expect(h.pushed).toHaveLength(1);
    expect(h.pushed[0]?.wake).toBe(false);
  });

  it('401s a body signed for a different callback URL, and buffers nothing', async () => {
    const h = await start();
    const body = JSON.stringify(delivery());
    const wrong = trelloSignature(body, 'https://someone-else.example.com/hook', API_SECRET);

    const res = await h.post(body, { signature: wrong });

    expect(res.status).toBe(401);
    expect(h.pushed).toHaveLength(0);
    expect(h.noted).toEqual(['rejected']);
  });

  it('401s a missing signature header', async () => {
    const h = await start();
    const res = await fetch(h.callbackURL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(delivery()),
    });
    expect(res.status).toBe(401);
    expect(h.pushed).toHaveLength(0);
  });

  it('404s an unknown project', async () => {
    const h = await start();
    const res = await h.post(JSON.stringify(delivery()), { project: 'other' });
    expect(res.status).toBe(404);
  });

  it('400s a delivery for a different board and buffers nothing', async () => {
    const h = await start();
    const body = JSON.stringify({ ...delivery(), model: { id: 'some-other-board' } });

    const res = await h.post(body);

    expect(res.status).toBe(400);
    expect(h.pushed).toHaveLength(0);
    expect(h.noted).toEqual(['rejected']);
  });

  it('accepts but drops an action older than the staleness window', async () => {
    const h = await start();
    const old = new Date(Date.now() - 3600_000).toISOString();
    const body = JSON.stringify(delivery({ action: { date: old } }));

    const res = await h.post(body);

    expect(res.status).toBe(200);
    expect(h.pushed).toHaveLength(0);
    expect(h.noted).toEqual(['stale']);
  });

  it('accepts and ignores a board-level action it does not route on', async () => {
    const h = await start();
    const body = JSON.stringify(delivery({ action: { type: 'updateBoard' } }));

    const res = await h.post(body);

    expect(res.status).toBe(200);
    expect(h.pushed).toHaveLength(0);
    expect(h.noted).toEqual(['delivered']);
  });

  it('413s a body over the limit', async () => {
    const h = await start();
    const body = JSON.stringify({ ...delivery(), padding: 'x'.repeat(128 * 1024) });

    const res = await h.post(body);

    expect(res.status).toBe(413);
    expect(h.pushed).toHaveLength(0);
  });

  it('verifies a body whose exact bytes would not survive re-serialization', async () => {
    const h = await start();
    // Non-alphabetical keys, escaped unicode, and padding whitespace: signing a
    // JSON.stringify(req.body) round-trip instead of the raw bytes fails here.
    const body =
      '{ "model":{"id":"' +
      BOARD_ID +
      '"},\n  "action":{"type":"updateCard","id":"act-raw","date":"' +
      new Date().toISOString() +
      '","idMemberCreator":"human-member-id","data":{"card":{"id":"card-\\u00e9","name":"caf\\u00e9"},' +
      '"listBefore":{"id":"list-backlog","name":"Backlog"},"listAfter":{"id":"list-ready","name":"Ready for Dev"}}} }';

    const res = await h.post(body);

    expect(res.status).toBe(200);
    expect(h.pushed[0]?.event.cardId).toBe('card-é');
  });

  it('400s a correctly signed body that is not JSON at all, without crashing', async () => {
    const h = await start();
    // The signature is over the raw bytes and so still verifies; it is the
    // payload that is unrecognizable, which is a 400 rather than a 401.
    const res = await h.post('this is not json');
    expect(res.status).toBe(400);
    expect(h.pushed).toHaveLength(0);
  });

  it('sheds load under a burst and stays healthy afterwards', async () => {
    const h = await start();
    const body = JSON.stringify(delivery());

    const results = await Promise.all(Array.from({ length: 200 }, () => h.post(body)));
    const codes = results.map((r) => r.status);

    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
    expect(codes.every((c) => c === 200 || c === 429)).toBe(true);

    const health = (await (await fetch(`${h.url}${PREFIX}/healthz`)).json()) as {
      ok: boolean;
      targets: string[];
    };
    expect(health).toMatchObject({ ok: true, targets: [PROJECT] });
  });
});
