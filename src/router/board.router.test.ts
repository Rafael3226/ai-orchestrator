import { beforeEach, describe, expect, it } from 'vitest';

import { BoardStore } from '../board/board.store.js';
import { BoardSync } from '../board/board.sync.js';
import { BoardWriter } from '../board/board.writer.js';
import { loadConfigFromString } from '../config/config.loader.js';
import { SqliteStore } from '../db/sqlite.store.js';
import { FakeBoardSource } from '../testing/fake.board.source.js';

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
      poll: { reconcileEveryTicks: 3 }
      columns: { ready: Ready for Dev, inProgress: In Progress, review: In Review, blocked: Blocked }
    agents: { DEV-BE: { enabled: true }, QA: { enabled: true }, DEV-FE: { enabled: false } }
    routes:
      - when: { list: Ready for Dev, label: be }
        agent: DEV-BE
      - when: { list: Ready for Dev, label: fe }
        agent: DEV-FE
      - when: { list: In Review }
        agent: QA
    writeback:
      onStart:   { move: inProgress, assign: bot, comment: started }
      onSuccess: { move: review, comment: report }
`;

const quiet = { info: () => {}, warn: () => {} };

let store: SqliteStore;
let boardStore: BoardStore;
let board: FakeBoardSource;
let sync: BoardSync;

beforeEach(async () => {
  store = new SqliteStore(':memory:');
  boardStore = new BoardStore(store);
  board = new FakeBoardSource(
    'b1',
    ['Backlog', 'Ready for Dev', 'In Progress', 'In Review', 'Blocked'],
    ['be', 'fe'],
  );
  const project = loadConfigFromString(yaml, 'x').project('demo');
  sync = new BoardSync(project, board, store, boardStore, quiet);
  await sync.tick(); // cold start seeds the cursor and emits nothing
});

describe('BoardSync + BoardRouter with a fake board', () => {
  it('cold start replays no history', async () => {
    board.addCard('1', 'Old work', 'Ready for Dev', { labels: ['be'] });
    const fresh = new BoardSync(
      loadConfigFromString(yaml, 'x').project('demo'),
      board,
      new SqliteStore(':memory:'),
      new BoardStore(new SqliteStore(':memory:')),
      quiet,
    );
    // A brand-new store with no cursor: reconcile picks up the parked card exactly once.
    const r = await fresh.tick();
    expect(r.dispatched.map((d) => d.role)).toEqual(['DEV-BE']);
  });

  it('dispatches exactly once when a labeled card is moved into Ready for Dev', async () => {
    const c = board.addCard('42', 'Add pagination', 'Backlog', { labels: ['be'] });
    board.humanMove(c.id, 'Ready for Dev');
    const r = await sync.tick();
    expect(r.dispatched).toHaveLength(1);
    expect(r.dispatched[0]?.role).toBe('DEV-BE');
    expect(store.listTasks({ state: 'queued' })).toHaveLength(1);
    // Nothing new → nothing dispatched.
    expect((await sync.tick()).dispatched).toHaveLength(0);
  });

  it('dispatches when the routed label is added to a card already in the column', async () => {
    const c = board.addCard('7', 'Frontend-less', 'Ready for Dev');
    expect((await sync.tick()).dispatched).toHaveLength(0);
    board.humanLabel(c.id, 'be');
    expect((await sync.tick()).dispatched.map((d) => d.role)).toEqual(['DEV-BE']);
  });

  it('never dispatches on description edits or comments', async () => {
    const c = board.addCard('8', 'Edited', 'Ready for Dev', { labels: ['be'] });
    await sync.tick();
    board.humanEdit(c.id, 'new description');
    await board.comment(c.id, 'hello');
    const r = await sync.tick();
    expect(r.dispatched).toHaveLength(0);
    expect(r.skipped.some((s) => /never dispatches/.test(s.reason))).toBe(true);
  });

  it('skips a matched route whose agent is disabled', async () => {
    board.addCard('9', 'UI thing', 'Ready for Dev', { labels: ['fe'] });
    const r = await sync.tick();
    expect(r.dispatched).toHaveLength(0);
    expect(r.skipped.some((s) => /DEV-FE is disabled/.test(s.reason))).toBe(true);
  });

  it('re-dispatches when a card leaves the column and comes back (arrivalSeq)', async () => {
    const c = board.addCard('10', 'Rework', 'Ready for Dev', { labels: ['be'] });
    await sync.tick();
    const t1 = store.listTasks()[0]!;
    store.transitionTask(t1.id, 'queued', 'cancelled'); // free the one-active-task slot
    board.humanMove(c.id, 'Backlog');
    await sync.tick();
    board.humanMove(c.id, 'Ready for Dev');
    const r = await sync.tick();
    expect(r.dispatched).toHaveLength(1);
    expect(store.listTasks()).toHaveLength(2);
  });

  it('ignores the echo of its own writeback (loop guard) and does not dispatch QA on its own move', async () => {
    const c = board.addCard('11', 'Loop bait', 'Ready for Dev', { labels: ['be'] });
    const r1 = await sync.tick();
    const task = store.getTask(
      r1.dispatched[0]!.dedupeKey ? store.listTasks()[0]!.id : store.listTasks()[0]!.id,
    );

    const project = loadConfigFromString(yaml, 'x').project('demo');
    const writer = new BoardWriter(project, board, boardStore, sync.router, quiet);
    writer.enqueueStep('onSuccess', project.writeback.onSuccess, task.id, c.id, 'done report');
    await writer.drain(await sync.getTopology());

    expect((await board.getCard(c.id)).columnId).toBe(board.columnId('In Review'));
    // The bot's move into "In Review" must NOT fire the QA route.
    const r2 = await sync.tick();
    expect(r2.dispatched).toHaveLength(0);
    expect(r2.skipped.some((s) => s.reason === 'own writeback')).toBe(true);
    // But a human moving a different card there does.
    const d = board.addCard('12', 'Human review', 'In Review');
    void d;
    expect((await sync.tick()).dispatched.map((x) => x.role)).toEqual(['QA']);
  });

  it('writeback comment is idempotent on redelivery', async () => {
    const c = board.addCard('13', 'Twice', 'Ready for Dev', { labels: ['be'] });
    await sync.tick();
    const task = store.listTasks()[0]!;
    const project = loadConfigFromString(yaml, 'x').project('demo');
    const writer = new BoardWriter(project, board, boardStore, sync.router, quiet);
    writer.enqueueStep('onStart', project.writeback.onStart, task.id, c.id, 'started');
    writer.enqueueStep('onStart', project.writeback.onStart, task.id, c.id, 'started'); // duplicate enqueue
    await writer.drain(await sync.getTopology());
    await writer.drain(await sync.getTopology());
    expect(board.comments.get(c.id)).toHaveLength(1);
    expect(boardStore.outboxCounts()).toEqual({ done: 3 });
  });
});
