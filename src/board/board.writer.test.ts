import { beforeEach, describe, expect, it } from 'vitest';

import { loadConfigFromString, type ProjectConfig } from '../config/config.loader.js';
import { SqliteStore } from '../db/sqlite.store.js';
import { newTaskId } from '../domain/ids.js';
import { BoardRouter } from '../router/board.router.js';
import { FakeBoardSource, type FakeBoardOptions } from '../testing/fake.board.source.js';

import { BoardStore } from './board.store.js';
import { BoardWriter, LOOP_LABEL } from './board.writer.js';

const yaml = `
version: 1
projects:
  - id: demo
    name: Demo
    repo: { path: /repo, worktreeRoot: /wt, githubRepo: me/demo }
    board:
      provider: jira
      site: acme
      projectKey: DEMO
      credentials: JIRA_X
      botMemberId: bot
      columns:
        requirements: Requirements
        refinement: Refinement
        ready: Ready for Dev
        review: In Review
        blocked: Blocked
        done: Done
    agents:
      BA: { enabled: true }
      PM: { enabled: true }
      DEV: { enabled: true }
      QA: { enabled: true, writeback: { onSuccess: { move: done } } }
    routes:
      - when: { column: Requirements }
        agent: BA
      - when: { column: Refinement }
        agent: PM
      - when: { column: Ready for Dev, label: be }
        agent: DEV
      - when: { column: In Review }
        agent: QA
    flow:
      humanColumn: blocked
      closed: done
      maxBounces: 2
      newItems: { story: PM, bug: DEV }
    writeback:
      onSuccess: { move: review, comment: report }
`;

const COLUMNS = ['Requirements', 'Refinement', 'Ready for Dev', 'In Review', 'Blocked', 'Done'];
const quiet = { info: () => {}, warn: () => {} };

let project: ProjectConfig;
let boardStore: BoardStore;
let board: FakeBoardSource;
let writer: BoardWriter;
let moved: string[];

function setup(opts: FakeBoardOptions = {}): void {
  project = loadConfigFromString(yaml, 'x').project('demo');
  boardStore = new BoardStore(new SqliteStore(':memory:'));
  board = new FakeBoardSource('acme/DEMO', COLUMNS, [], [], {
    provider: 'jira',
    freeformLabels: true,
    ...opts,
  });
  moved = [];
  writer = new BoardWriter(
    project,
    board,
    boardStore,
    new BoardRouter(project, boardStore),
    quiet,
    {
      onMoved: (id) => moved.push(id),
    },
  );
}

const drain = async (): Promise<void> => {
  // A create-card op can enqueue a follow-up hand-to; drain until quiet.
  for (let i = 0; i < 5; i++) if ((await writer.drain(await board.describe())) === 0) return;
};

beforeEach(() => setup());

describe('BoardWriter — flow ops', () => {
  it('derives each role home column from its routes', () => {
    expect(project.flow.homes.DEV).toEqual({ column: 'Ready for Dev', label: 'be' });
    expect(project.flow.homes.QA).toEqual({ column: 'In Review', label: null });
    expect(project.flow.homes.DEVOPS).toBeNull();
  });

  it('hands a card to a role: its home column plus the route label, then wakes the router', async () => {
    const card = board.addCard('1', 'Bug found', 'In Review');
    writer.enqueueStep('onFailure', { ...step(), handTo: 'DEV' }, newTaskId(), card.id, null);
    await drain();
    const now = await board.getCard(card.id);
    expect(now.columnId).toBe(board.columnId('Ready for Dev'));
    expect(now.labelNames).toContain('be');
    expect(moved).toEqual([card.id]);
  });

  it('hands a card to a human', async () => {
    const card = board.addCard('2', 'Stuck', 'Refinement');
    writer.enqueueStep('onBlocked', { ...step(), handTo: 'human' }, newTaskId(), card.id, null);
    await drain();
    expect((await board.getCard(card.id)).columnId).toBe(board.columnId('Blocked'));
  });

  it('diverts to a human with the loop label once a role has had the card maxBounces times', async () => {
    const card = board.addCard('3', 'Ping-pong', 'In Review');
    for (let i = 0; i < 2; i++) {
      boardStore.insertLedger({
        dedupeKey: `k${i}`,
        projectId: 'demo',
        cardId: card.id,
        role: 'DEV',
        routeId: 'demo/route-2',
        taskId: newTaskId(),
      });
    }
    writer.enqueueStep('onFailure', { ...step(), handTo: 'DEV' }, newTaskId(), card.id, null);
    await drain();
    const now = await board.getCard(card.id);
    expect(now.columnId).toBe(board.columnId('Blocked'));
    expect(now.labelNames).toContain(LOOP_LABEL);
  });

  it('creates a sub-task under the current card and leaves it there', async () => {
    const card = board.addCard('4', 'Story', 'Ready for Dev');
    writer.enqueueActions(newTaskId(), card.id, [
      {
        kind: 'create',
        item: {
          type: 'subtask',
          title: 'QA: how to test',
          description: 'Open the page',
          acceptanceCriteria: ['It loads'],
          parent: 'current',
        },
      },
    ]);
    await drain();
    const kids = await board.listChildren(card.id);
    expect(kids.map((k) => k.title)).toEqual(['QA: how to test']);
    expect(kids[0]?.description).toContain('- [ ] It loads');
    expect(moved).toEqual([]);
  });

  it('routes a created bug to DEV via flow.newItems and wakes the router for it', async () => {
    const card = board.addCard('5', 'Story', 'In Review');
    const created: string[] = [];
    writer = new BoardWriter(
      project,
      board,
      boardStore,
      new BoardRouter(project, boardStore),
      quiet,
      { onMoved: (id) => moved.push(id), onCreated: (_row, c) => created.push(c.id) },
    );
    writer.enqueueActions(newTaskId(), card.id, [
      { kind: 'create', item: { type: 'bug', title: 'Totals are wrong', description: 'x' } },
    ]);
    await drain();
    expect(created).toHaveLength(1);
    const bug = await board.getCard(created[0]!);
    expect(bug.columnId).toBe(board.columnId('Ready for Dev'));
    expect(bug.labelNames).toContain('be');
    expect(moved).toEqual([bug.id]);
  });

  it('degrades a sub-task to a comment on the parent when the board has no sub-tasks', async () => {
    setup({ canCreateSubtask: false });
    const card = board.addCard('6', 'Story', 'Ready for Dev');
    writer.enqueueActions(newTaskId(), card.id, [
      {
        kind: 'create',
        item: { type: 'subtask', title: 'QA plan', description: 'steps', parent: 'current' },
      },
    ]);
    await drain();
    expect(board.created.size).toBe(0);
    expect(board.comments.get(card.id)?.[0]?.text).toContain('### Sub-task: QA plan');
  });

  it('sets planning fields, and skips them when the board cannot store any', async () => {
    const card = board.addCard('7', 'Story', 'Refinement');
    writer.enqueueActions(newTaskId(), card.id, [
      { kind: 'set-fields', fields: { storyPoints: 5, priority: 'high' }, rationale: 'r' },
    ]);
    await drain();
    expect(board.fields.get(card.id)).toEqual({ storyPoints: 5, priority: 'high' });

    setup({ canSetFields: false });
    const other = board.addCard('8', 'Story', 'Refinement');
    writer.enqueueActions(newTaskId(), other.id, [
      { kind: 'set-fields', fields: { storyPoints: 3 }, rationale: 'r' },
    ]);
    await drain();
    expect(board.fields.get(other.id)).toBeUndefined();
    expect(boardStore.outboxCounts()['skipped']).toBe(1);
  });
});

function step() {
  return {
    comment: 'none' as const,
    assign: 'none' as const,
    required: false,
  };
}
