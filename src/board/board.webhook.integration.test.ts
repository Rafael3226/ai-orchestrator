import { beforeEach, describe, expect, it } from 'vitest';

import { loadConfigFromString } from '../config/config.loader.js';
import { SqliteStore } from '../db/sqlite.store.js';
import { FakeBoardSource } from '../testing/fake.board.source.js';

import { BoardStore } from './board.store.js';
import { BoardSync } from './board.sync.js';
import type { BoardEvent } from './board.types.js';
import { WebhookBufferedSource } from './board.webhook-buffer.js';
import { BoardWriter } from './board.writer.js';

const yaml = `
version: 1
projects:
  - id: demo
    name: Demo
    repo: { path: /repo, worktreeRoot: /wt, githubRepo: me/demo }
    board:
      provider: trello
      boardId: b1
      credentials: TRELLO_X
      botMemberId: bot
      poll: { reconcileEveryTicks: 50 }
      webhook: { enabled: true }
      columns: { ready: Ready for Dev, inProgress: In Progress, review: In Review }
    agents: { DEV-BE: { enabled: true } }
    routes:
      - when: { list: Ready for Dev, label: be }
        agent: DEV-BE
    writeback:
      onStart: { move: inProgress, assign: bot, comment: started }
`;

const quiet = { info: () => {}, warn: () => {} };

const ledgerRows = (cardId: string): number =>
  (
    store.db
      .prepare('SELECT COUNT(*) AS n FROM dispatch_ledger WHERE project_id = ? AND card_id = ?')
      .get('demo', cardId) as { n: number }
  ).n;

let store: SqliteStore;
let boardStore: BoardStore;
let board: FakeBoardSource;
let buffered: WebhookBufferedSource;
let sync: BoardSync;
let woken: number;

/**
 * The event the webhook would have delivered for a board mutation: the same
 * event the actions feed will also report on the next poll. Taking it from the
 * fake's own feed is the point — in production both paths run the identical
 * `mapAction`, so the eventIds collide exactly like this.
 */
const lastEvent = (): BoardEvent => {
  const e = board.events.at(-1);
  if (!e) throw new Error('no event to deliver');
  return e;
};

beforeEach(async () => {
  woken = 0;
  store = new SqliteStore(':memory:');
  boardStore = new BoardStore(store);
  board = new FakeBoardSource(
    'b1',
    ['Backlog', 'Ready for Dev', 'In Progress', 'In Review'],
    ['be'],
  );
  buffered = new WebhookBufferedSource(board, {
    maxBuffered: 500,
    onWake: () => {
      woken += 1;
    },
    log: quiet,
  });
  const project = loadConfigFromString(yaml, 'x').project('demo');
  sync = new BoardSync(project, buffered, store, boardStore, quiet);
  await sync.tick(); // cold start seeds the cursor
});

describe('webhook delivery through the buffer into BoardSync', () => {
  it('dispatches from a delivery, and the poll that later reports it is a no-op', async () => {
    const card = board.addCard('42', 'Add pagination', 'Backlog', { labels: ['be'] });
    board.humanMove(card.id, 'Ready for Dev');

    // The webhook beats the poller to it.
    buffered.push([lastEvent()], { wake: true });
    expect(woken).toBe(1);

    const first = await sync.tick();
    expect(first.dispatched).toHaveLength(1);
    expect(first.dispatched[0]?.role).toBe('DEV-BE');
    expect(ledgerRows(card.id)).toBe(1);

    // The poller now reports the very same action from the feed.
    const second = await sync.tick();
    expect(second.dispatched).toHaveLength(0);
    expect(ledgerRows(card.id)).toBe(1);
  });

  it('dispatches once when the same delivery arrives twice in one tick', async () => {
    const card = board.addCard('43', 'Twice', 'Backlog', { labels: ['be'] });
    board.humanMove(card.id, 'Ready for Dev');
    const event = lastEvent();

    buffered.push([event, event], { wake: true });

    const r = await sync.tick();
    expect(r.dispatched).toHaveLength(1);
  });

  it('still dispatches after a crash loses the buffer, because the cursor did not move', async () => {
    const card = board.addCard('44', 'Crash safety', 'Backlog', { labels: ['be'] });
    board.humanMove(card.id, 'Ready for Dev');

    // Delivered, then the process dies before the tick that would drain it.
    buffered.push([lastEvent()], { wake: true });
    const reborn = new WebhookBufferedSource(board, { maxBuffered: 500, log: quiet });
    const afterCrash = new BoardSync(
      loadConfigFromString(yaml, 'x').project('demo'),
      reborn,
      store,
      boardStore,
      quiet,
    );

    // This is why the buffer needs no table of its own.
    const r = await afterCrash.tick();
    expect(r.dispatched).toHaveLength(1);
    expect(r.dispatched[0]?.role).toBe('DEV-BE');
  });

  it('drops our own writeback echo without dispatching, at webhook latency', async () => {
    const card = board.addCard('45', 'Echo', 'Backlog', { labels: ['be'] });
    board.humanMove(card.id, 'Ready for Dev');
    buffered.push([lastEvent()], { wake: true });
    expect((await sync.tick()).dispatched).toHaveLength(1);

    // The run starts: writeback comments, assigns and moves the card to In Progress.
    const writer = new BoardWriter(
      loadConfigFromString(yaml, 'x').project('demo'),
      buffered,
      boardStore,
      sync.router,
      quiet,
    );
    const project = loadConfigFromString(yaml, 'x').project('demo');
    const task = store.listTasks()[0]!;
    writer.enqueueStep('onStart', project.writeback.onStart, task.id, card.id, 'started');
    await writer.drain(await sync.getTopology());

    // Each of those comes straight back as a delivery, within the echo window.
    const echoes = board.events.filter((e) => e.actorMemberId === 'bot');
    expect(echoes.length).toBeGreaterThan(0);
    buffered.push(echoes, { wake: false });
    expect(woken).toBe(1); // bot deliveries never wake the daemon

    const r = await sync.tick();
    expect(r.dispatched).toHaveLength(0);
    expect(r.skipped.some((s) => /own writeback/.test(s.reason))).toBe(true);
    expect(ledgerRows(card.id)).toBe(1);
  });

  it('forces a reconcile on the tick after the buffer overflows', async () => {
    // A card parked in a routed column, whose delivery we are about to lose.
    board.addCard('46', 'Dropped delivery', 'Ready for Dev', { labels: ['be'] });
    await sync.tick(); // sees the creation event; card.created in a routed column dispatches

    const small = new WebhookBufferedSource(board, { maxBuffered: 1, log: quiet });
    const tight = new BoardSync(
      loadConfigFromString(yaml, 'x').project('demo'),
      small,
      store,
      boardStore,
      quiet,
    );
    const lost = board.addCard('47', 'Lost', 'Ready for Dev', { labels: ['be'] });
    small.push([lastEvent(), lastEvent()], { wake: true }); // overflows, drops one

    const r = await tight.tick();

    expect(r.reconciled).toBe(true);
    expect(ledgerRows(lost.id)).toBeGreaterThan(0);
  });
});
