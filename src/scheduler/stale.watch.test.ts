import { beforeEach, describe, expect, it } from 'vitest';

import { BoardStore } from '../board/board.store.js';
import { loadConfigFromString, type ProjectConfig } from '../config/config.loader.js';
import { SqliteStore } from '../db/sqlite.store.js';
import { newTaskId } from '../domain/ids.js';
import { FakeBoardSource } from '../testing/fake.board.source.js';

import { StaleWatch } from './stale.watch.js';

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
      columns: { refine: Refinement, ready: Ready, review: Review, blocked: Blocked, done: Done }
    agents:
      PM: { enabled: true }
      DEV: { enabled: true }
    routes:
      - { when: { column: Refinement }, agent: PM }
      - { when: { column: Ready }, agent: DEV }
    flow:
      closed: done
      humanColumn: blocked
      stale: { defaultHours: 48, columns: { review: 4 }, label: stale }
`;

const HOUR = 3600_000;
const quiet = { info: () => {}, warn: () => {} };

let project: ProjectConfig;
let store: SqliteStore;
let boardStore: BoardStore;
let board: FakeBoardSource;
let watch: StaleWatch;

beforeEach(() => {
  project = loadConfigFromString(yaml, 'x').project('demo');
  store = new SqliteStore(':memory:');
  boardStore = new BoardStore(store);
  board = new FakeBoardSource('b1', ['Refinement', 'Ready', 'Review', 'Blocked', 'Done']);
  watch = new StaleWatch(store, boardStore, quiet);
});

const ops = () => boardStore.dueOutbox(100).map((r) => [r.op, JSON.parse(r.payload_json)] as const);

describe('StaleWatch.check', () => {
  it('flags a card past its column threshold once, naming who it waits on', async () => {
    const c = board.addCard('7', 'Sized story', 'Ready');
    const t0 = Date.now();
    const topo = await board.describe();
    await watch.check(project, board, topo, t0); // first sighting records the position
    expect(await watch.check(project, board, topo, t0 + 47 * HOUR)).toBe(0);
    expect(await watch.check(project, board, topo, t0 + 49 * HOUR)).toBe(1);
    expect(ops()).toEqual([
      ['add-label', { label: 'stale' }],
      ['comment', expect.objectContaining({ body: expect.stringContaining('waiting on **DEV**') })],
    ]);
    // Once is enough.
    expect(await watch.check(project, board, topo, t0 + 60 * HOUR)).toBe(0);
    expect(watch.attention([project]).map((a) => [a.kind, a.cardId])).toEqual([
      ['stale-card', c.id],
    ]);
  });

  it('uses the per-column threshold and says when no agent owns the column', async () => {
    board.addCard('8', 'Waiting for a human reviewer', 'Review');
    const t0 = Date.now();
    const topo = await board.describe();
    await watch.check(project, board, topo, t0);
    expect(await watch.check(project, board, topo, t0 + 5 * HOUR)).toBe(1);
    expect(JSON.stringify(ops())).toContain('it needs a person');
  });

  it('ignores the closed column and cards with a task in flight', async () => {
    board.addCard('9', 'Shipped', 'Done');
    const busy = board.addCard('10', 'Being built', 'Ready');
    store.insertTask({
      id: newTaskId(),
      projectId: 'demo',
      role: 'DEV',
      cardId: busy.id,
      cardShortId: '10',
      cardUrl: '',
      title: 'Being built',
      spec: '',
      labels: [],
    });
    const t0 = Date.now();
    const topo = await board.describe();
    await watch.check(project, board, topo, t0);
    expect(await watch.check(project, board, topo, t0 + 100 * HOUR)).toBe(0);
  });

  it('clears the label when a flagged card moves on, and restarts the clock', async () => {
    const c = board.addCard('11', 'Stuck', 'Ready');
    const t0 = Date.now();
    const topo = await board.describe();
    await watch.check(project, board, topo, t0);
    await watch.check(project, board, topo, t0 + 49 * HOUR);
    board.humanMove(c.id, 'Blocked');
    await watch.check(project, board, topo, t0 + 50 * HOUR);
    expect(ops().at(-1)).toEqual(['remove-label', { label: 'stale' }]);
    expect(watch.attention([project])).toEqual([]);
  });
});

describe('StaleWatch.attention', () => {
  it('lists a task that ended needing a human until someone hands the card on', async () => {
    const c = board.addCard('12', 'Ambiguous', 'Blocked');
    const id = newTaskId();
    store.insertTask({
      id,
      projectId: 'demo',
      role: 'DEV',
      cardId: c.id,
      cardShortId: '12',
      cardUrl: 'https://fake/c/12',
      title: 'Ambiguous',
      spec: '',
      labels: [],
    });
    store.db
      .prepare("UPDATE tasks SET state = 'blocked', blocked_reason = ? WHERE id = ?")
      .run('missing-info: which currency?', id);
    await watch.check(project, board, await board.describe());

    const [item] = watch.attention([project]);
    expect(item).toMatchObject({ kind: 'needs-human', role: 'DEV', cardShortId: '12' });
    expect(item!.reason).toContain('which currency?');

    // A person answers and moves it back to DEV's column: no longer anyone's problem here.
    board.humanMove(c.id, 'Ready');
    await watch.check(project, board, await board.describe());
    expect(watch.attention([project])).toEqual([]);
  });

  it('surfaces a writeback the outbox gave up on', () => {
    boardStore.enqueue({
      projectId: 'demo',
      taskId: null,
      cardId: 'card-x',
      op: 'move',
      payload: { alias: 'ready' },
      idempotencyKey: 'k1',
    });
    const [row] = boardStore.dueOutbox(1);
    boardStore.settleOutbox(row!.id, 'dead', 'no workflow transition leads to "Ready"');
    expect(watch.attention([project])).toEqual([
      expect.objectContaining({
        kind: 'dead-writeback',
        reason: expect.stringContaining('move gave up'),
      }),
    ]);
  });
});
