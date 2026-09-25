import { beforeEach, describe, expect, it } from 'vitest';

import { BoardStore } from '../board/board.store.js';
import { BoardSync } from '../board/board.sync.js';
import { BoardWriter } from '../board/board.writer.js';
import { loadConfigFromString } from '../config/config.loader.js';
import { SqliteStore } from '../db/sqlite.store.js';
import { newTaskId, type TaskId } from '../domain/ids.js';
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
    agents:
      DEV: { enabled: true }
      DEVOPS: { enabled: false }
      QA:
        enabled: true
        # QA is routed on In Review, so its own success must not move the card
        # back there — the loader rejects that as a dispatch loop.
        writeback:
          onSuccess: { comment: report }
    routes:
      - when: { list: Ready for Dev, label: be }
        agent: DEV
      - when: { list: Ready for Dev, label: fe }
        agent: DEVOPS
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
    expect(r.dispatched.map((d) => d.role)).toEqual(['DEV']);
  });

  it('dispatches exactly once when a labeled card is moved into Ready for Dev', async () => {
    const c = board.addCard('42', 'Add pagination', 'Backlog', { labels: ['be'] });
    board.humanMove(c.id, 'Ready for Dev');
    const r = await sync.tick();
    expect(r.dispatched).toHaveLength(1);
    expect(r.dispatched[0]?.role).toBe('DEV');
    expect(store.listTasks({ state: 'queued' })).toHaveLength(1);
    // Nothing new → nothing dispatched.
    expect((await sync.tick()).dispatched).toHaveLength(0);
  });

  it('dispatches when the routed label is added to a card already in the column', async () => {
    const c = board.addCard('7', 'Frontend-less', 'Ready for Dev');
    expect((await sync.tick()).dispatched).toHaveLength(0);
    board.humanLabel(c.id, 'be');
    expect((await sync.tick()).dispatched.map((d) => d.role)).toEqual(['DEV']);
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
    expect(r.skipped.some((s) => /DEVOPS is disabled/.test(s.reason))).toBe(true);
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

  it('treats the bot account as a human outside the echo window (shared-account setup)', async () => {
    // The operator's own token is the "bot": their manual moves must still dispatch.
    board.humanId = board.botId;
    const c = board.addCard('20', 'Moved by the same account', 'Backlog', { labels: ['be'] });
    board.humanMove(c.id, 'Ready for Dev');
    const r = await sync.tick();
    expect(r.dispatched.map((d) => d.role)).toEqual(['DEV']);
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

/** Walk a freshly queued task to `review`, as the runner would. */
const finish = (id: TaskId): void => {
  for (const to of ['claimed', 'preparing', 'running', 'review'] as const) {
    store.transitionTask(id, store.getTask(id).state, to);
  }
};

describe('handoff: one role waking the next', () => {
  it('dispatches QA on our own move, where a plain poll would call it an echo', async () => {
    const c = board.addCard('20', 'Handoff me', 'Ready for Dev', { labels: ['be'] });
    const first = await sync.tick();
    expect(first.dispatched.map((d) => d.role)).toEqual(['DEV']);
    const task = store.listTasks()[0]!;
    // The runner lands the task before its writeback is ever enqueued, so the
    // one-active-task-per-card index is satisfied by the time we hand off.
    finish(task.id);

    const project = loadConfigFromString(yaml, 'x').project('demo');
    const handedOff: string[] = [];
    const writer = new BoardWriter(project, board, boardStore, sync.router, quiet, {
      onMoved: (cardId) => handedOff.push(cardId),
    });
    writer.enqueueStep(
      'onSuccess',
      project.agents['DEV'].writeback.onSuccess,
      task.id,
      c.id,
      'done report',
    );
    await writer.drain(await sync.getTopology());

    // The writer told us our move landed...
    expect(handedOff).toEqual([c.id]);
    // ...and the handoff dispatches QA for the same card, unattended.
    const dispatch = await sync.handoff(c.id);
    expect(dispatch?.role).toBe('QA');

    const roles = store.listTasks().map((t) => t.role);
    expect(roles.sort()).toEqual(['DEV', 'QA']);
  });

  it('is idempotent — a second handoff for the same card dispatches nothing', async () => {
    const c = board.addCard('21', 'Once only', 'Ready for Dev', { labels: ['be'] });
    await sync.tick();
    finish(store.listTasks()[0]!.id);
    const project = loadConfigFromString(yaml, 'x').project('demo');
    const writer = new BoardWriter(project, board, boardStore, sync.router, quiet);
    writer.enqueueStep(
      'onSuccess',
      project.agents['DEV'].writeback.onSuccess,
      store.listTasks()[0]!.id,
      c.id,
      'done',
    );
    await writer.drain(await sync.getTopology());

    expect((await sync.handoff(c.id))?.role).toBe('QA');
    expect(await sync.handoff(c.id)).toBeNull();
    expect(store.listTasks()).toHaveLength(2);
  });

  it('still drops the same move when it arrives through an ordinary poll', async () => {
    const c = board.addCard('22', 'No flag, no dispatch', 'Ready for Dev', { labels: ['be'] });
    await sync.tick();
    finish(store.listTasks()[0]!.id);
    const project = loadConfigFromString(yaml, 'x').project('demo');
    const writer = new BoardWriter(project, board, boardStore, sync.router, quiet);
    writer.enqueueStep(
      'onSuccess',
      project.agents['DEV'].writeback.onSuccess,
      store.listTasks()[0]!.id,
      c.id,
      'done',
    );
    await writer.drain(await sync.getTopology());

    // Without the handoff flag the echo guard still holds — this is the
    // behaviour the handoff deliberately, and only locally, bypasses.
    const r = await sync.tick();
    expect(r.dispatched).toHaveLength(0);
    expect(r.skipped.some((s) => s.reason === 'own writeback')).toBe(true);
  });

  it('does not hand off a card that lands in an unrouted column', async () => {
    const c = board.addCard('23', 'Nowhere', 'Ready for Dev', { labels: ['be'] });
    await sync.tick();
    finish(store.listTasks()[0]!.id);
    await board.moveCard(c.id, board.columnId('In Progress'));

    expect(await sync.handoff(c.id)).toBeNull();
  });
});

describe('circuit breaker scoping', () => {
  it('counts dispatches per role, so a multi-role chain on one card is allowed', () => {
    const c = board.addCard('30', 'Busy card', 'Ready for Dev', { labels: ['be'] });
    const taskId = store.insertTask({
      id: newTaskId(),
      projectId: 'demo',
      role: 'DEV',
      cardId: c.id,
      cardShortId: c.shortId,
      title: c.title,
      spec: '',
    }).id;
    for (let i = 0; i < 4; i++) {
      boardStore.insertLedger({
        dedupeKey: `k-${i}`,
        projectId: 'demo',
        cardId: c.id,
        role: 'DEV',
        routeId: 'demo/route-0',
        taskId,
      });
    }

    const hour = 60 * 60_000;
    expect(boardStore.recentDispatchCount('demo', c.id, hour, 'DEV')).toBe(4);
    // QA is unaffected by DEV burning through its budget.
    expect(boardStore.recentDispatchCount('demo', c.id, hour, 'QA')).toBe(0);
    // Unscoped still counts everything, for callers that want the total.
    expect(boardStore.recentDispatchCount('demo', c.id, hour)).toBe(4);
  });
});
