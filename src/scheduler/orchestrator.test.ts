import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BoardStore } from '../board/board.store.js';
import { loadConfigFromString } from '../config/config.loader.js';
import { SqliteStore } from '../db/sqlite.store.js';
import type {
  ExecDriver,
  ExecEvent,
  ExecResult,
  ExecRunSpec,
  ExecSession,
} from '../exec/exec.driver.js';
import { FakeBoardSource } from '../testing/fake.board.source.js';
import { aSummary, ScriptedDriver } from '../testing/scripted.driver.js';

import { Orchestrator } from './orchestrator.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A driver that "works" instantly: no Claude, no cost. It never calls propose_summary, so the task lands in needs_human without publishing. */
class FakeDriver implements ExecDriver {
  readonly kind = 'local' as const;
  readonly paths = { mode: 'native' as const, toAgent: (p: string) => p };
  readonly specs: ExecRunSpec[] = [];
  async preflight(): Promise<void> {}
  async start(spec: ExecRunSpec): Promise<ExecSession> {
    this.specs.push(spec);
    writeFileSync(join(spec.cwd, 'AGENT_WAS_HERE.md'), spec.prompt.slice(0, 200));
    const events: ExecEvent[] = [
      {
        kind: 'init',
        sessionId: 'fake-session',
        model: spec.model,
        tools: [],
        mcp: [{ name: 'board', status: 'connected' }],
        claudeCodeVersion: 'fake',
      },
      { kind: 'assistant-text', text: 'done', messageId: 'm1' },
    ];
    const result: ExecResult = {
      outcome: 'success',
      sessionId: 'fake-session',
      finalText: 'done',
      numTurns: 1,
      durationMs: 5,
      cost: {
        totalCostUsd: 0.01,
        reportedCostUsd: 0.01,
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        perModel: {},
        estimated: false,
      },
      permissionDenials: [],
      errors: [],
    };
    return {
      runId: spec.runId,
      events: () =>
        (async function* () {
          for (const e of events) yield e;
        })(),
      result: async () => result,
      cancel: async () => {},
    };
  }
}

let base: string;
let repo: string;
let remote: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'orch-e2e-'));
  repo = join(base, 'repo');
  remote = join(base, 'remote.git');
  mkdirSync(repo);
  git(base, 'init', '--bare', remote);
  git(base, 'init', '-b', 'main', repo);
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'README.md'), '# demo\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
});

afterEach(() => {
  // Worktrees hold handles briefly on Windows; nothing here needs cleanup to pass.
});

const yaml = (repoPath: string, wt: string) => `
version: 1
defaults: { concurrency: { global: 2, perProject: 1 } }
projects:
  - id: demo
    name: Demo
    repo: { path: ${JSON.stringify(repoPath)}, worktreeRoot: ${JSON.stringify(wt)}, githubRepo: me/demo }
    board:
      provider: trello
      boardId: b1
      credentials: TRELLO_X
      botMemberId: bot
      poll: { intervalSeconds: 5, reconcileEveryTicks: 100, reconcileOnStart: false }
      columns: { ready: Ready for Dev, inProgress: In Progress, review: In Review, blocked: Blocked }
    agents: { DEV-BE: { enabled: true } }
    routes:
      - when: { list: Ready for Dev }
        agent: DEV-BE
    writeback:
      onStart:   { move: inProgress, assign: bot, comment: started }
      onSuccess: { move: review, comment: report }
      onFailure: { move: blocked, comment: report }
`;

const quiet = { info: () => {}, warn: () => {}, error: (m: string) => console.error(m) };

describe('Orchestrator end to end (fake board, fake driver, real git)', () => {
  it('card → queued → worktree on a real repo → run → writeback → outbox delivered', async () => {
    const store = new SqliteStore(':memory:');
    const boardStore = new BoardStore(store);
    const board = new FakeBoardSource('b1', [
      'Backlog',
      'Ready for Dev',
      'In Progress',
      'In Review',
      'Blocked',
    ]);
    const driver = new FakeDriver();
    const loaded = loadConfigFromString(yaml(repo, join(base, 'wt')), 'x');
    const orch = new Orchestrator(loaded, store, driver, quiet, () => board);

    process.env['TRELLO_X_API_KEY'] = 'k';
    process.env['TRELLO_X_TOKEN'] = 't';
    await orch.start();
    await orch.stop(); // we drive ticks by hand below

    // Access the private machinery through the public seams we have: sync/writer via a fresh runtime
    // is heavy; instead reproduce the daemon's tick order using the same classes.
    const { BoardSync } = await import('../board/board.sync.js');
    const { BoardWriter } = await import('../board/board.writer.js');
    const { WorktreeManager } = await import('../workspace/worktree.manager.js');
    const { executeTask } = await import('./task.runner.js');
    const project = loaded.project('demo');
    const sync = new BoardSync(project, board, store, boardStore, quiet);
    const writer = new BoardWriter(project, board, boardStore, sync.router, quiet);
    await sync.tick(); // cold start

    const card = board.addCard('42', 'Add a thing', 'Backlog', {
      description: 'Please add the thing.',
    });
    board.humanMove(card.id, 'Ready for Dev');
    const t = await sync.tick();
    expect(t.dispatched).toHaveLength(1);
    const task = store.listTasks({ state: 'queued' })[0]!;
    expect(task.spec).toBe('Please add the thing.');

    const claimed = store.transitionTask(task.id, 'queued', 'claimed');
    const r = await executeTask(
      {
        store,
        worktrees: new WorktreeManager(store, []),
        driver,
        log: () => {},
        sink: {
          onStart: (tk, c) =>
            writer.enqueueStep('onStart', project.writeback.onStart, tk.id, tk.card_id, c),
          onProgress: () => {},
          onFinish: (tk, verdict, c) => {
            boardStore.saveReport(tk.id, verdict, c);
            writer.enqueueStep(
              verdict === 'review' ? 'onSuccess' : 'onFailure',
              project.writeback[verdict === 'review' ? 'onSuccess' : 'onFailure'],
              tk.id,
              tk.card_id,
              c,
            );
          },
        },
      },
      project,
      claimed,
    );

    // No propose_summary from the fake agent → needs_human, nothing published.
    expect(r.verdict).toBe('needs_human');
    expect(store.getTask(task.id).state).toBe('needs_human');

    // The agent ran inside a real worktree branched from origin/main.
    const spec = driver.specs[0]!;
    expect(existsSync(join(spec.cwd, 'README.md'))).toBe(true);
    expect(existsSync(join(spec.cwd, 'AGENT_WAS_HERE.md'))).toBe(true);
    expect(git(spec.cwd, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('ai/dev-be/42-add-a-thing');
    expect(spec.prompt).toContain('Please add the thing.');
    expect(spec.systemPromptAppend).toContain('You are DEV-BE');

    // Writeback: onStart moved it to In Progress, onFailure moved it to Blocked, both commented.
    await writer.drain(await sync.getTopology());
    expect((await board.getCard(card.id)).columnId).toBe(board.columnId('Blocked'));
    expect(board.comments.get(card.id)?.length).toBe(2);
    expect(boardStore.getReport(task.id)?.verdict).toBe('needs_human');
    expect(boardStore.outboxCounts()).toEqual({ done: 5 });

    // And the echo of our own moves does not re-dispatch anything.
    const after = await sync.tick();
    expect(after.dispatched).toHaveLength(0);

    // Workspace is retained (not review) and listed.
    expect(store.listWorkspaces('demo')[0]?.state).toBe('retained');
    store.close();
  }, 60_000);
});

const chainYaml = (repoPath: string, wt: string) => `
version: 1
defaults: { concurrency: { global: 2, perProject: 1 } }
projects:
  - id: demo
    name: Demo
    repo: { path: ${JSON.stringify(repoPath)}, worktreeRoot: ${JSON.stringify(wt)}, githubRepo: me/demo }
    board:
      provider: trello
      boardId: b1
      credentials: TRELLO_X
      botMemberId: bot
      poll: { intervalSeconds: 5, reconcileEveryTicks: 100, reconcileOnStart: false }
      columns:
        ready: Ready for Dev
        inProgress: In Progress
        review: In Review
        done: Done
        blocked: Blocked
    agents:
      DEV-BE: { enabled: true }
      QA:
        enabled: true
        writeback:
          onSuccess: { move: done, comment: report, addLabel: qa-passed }
    routes:
      - when: { list: Ready for Dev, label: be }
        agent: DEV-BE
      - when: { list: In Review }
        agent: QA
    writeback:
      onStart:   { move: inProgress, assign: bot, comment: started }
      onSuccess: { move: review, comment: report }
      onFailure: { move: blocked, comment: report }
`;

describe('role handoff end to end', () => {
  it('DEV-BE finishing wakes QA on the same card, with no human touching the board', async () => {
    const store = new SqliteStore(':memory:');
    const boardStore = new BoardStore(store);
    const board = new FakeBoardSource(
      'b1',
      ['Backlog', 'Ready for Dev', 'In Progress', 'In Review', 'Done', 'Blocked'],
      ['be', 'qa-passed'],
    );

    // Attempt 1 is DEV-BE (writes code), attempt 2 is QA (reviews, changes nothing).
    const driver = new ScriptedDriver([
      {
        work: (cwd) => writeFileSync(join(cwd, 'thing.ts'), 'export const thing = 1;\n'),
        calls: [['propose_summary', aSummary()]],
      },
      {
        calls: [
          [
            'propose_summary',
            {
              title: 'Review of the thing',
              summary: 'Implementation matches the card. One nit.',
              testPlan: 'Ran the suite.',
              filesTouched: [],
              findings: [
                { severity: 'nit', title: 'Naming could be clearer', detail: 'thing is vague.' },
              ],
              commit: { type: 'test', subject: 'review the thing' },
            },
          ],
        ],
      },
    ]);

    const loaded = loadConfigFromString(chainYaml(repo, join(base, 'wt')), 'x');
    const project = loaded.project('demo');

    const { BoardSync } = await import('../board/board.sync.js');
    const { BoardWriter } = await import('../board/board.writer.js');
    const { WorktreeManager } = await import('../workspace/worktree.manager.js');
    const { executeTask } = await import('./task.runner.js');

    const sync = new BoardSync(project, board, store, boardStore, quiet);
    const moved: string[] = [];
    const writer = new BoardWriter(project, board, boardStore, sync.router, quiet, {
      onMoved: (cardId) => moved.push(cardId),
    });
    const worktrees = new WorktreeManager(store, []);

    const run = async (t: (typeof store.listTasks extends () => infer R ? R : never)[number]) => {
      const writeback = project.agents[t.role as 'DEV-BE' | 'QA'].writeback;
      const claimed = store.transitionTask(t.id, 'queued', 'claimed');
      return executeTask(
        {
          store,
          worktrees,
          driver,
          log: () => {},
          sink: {
            onStart: (tk, c) =>
              writer.enqueueStep('onStart', writeback.onStart, tk.id, tk.card_id, c),
            onProgress: () => {},
            onFinish: (tk, verdict, c) => {
              boardStore.saveReport(tk.id, verdict, c);
              const step = verdict === 'review' ? 'onSuccess' : 'onFailure';
              writer.enqueueStep(step, writeback[step], tk.id, tk.card_id, c);
            },
          },
        },
        project,
        claimed,
        { dryRun: true, keepWorkspace: true },
      );
    };

    await sync.tick(); // cold start
    const card = board.addCard('42', 'Add a thing', 'Backlog', {
      description: 'Please add the thing.',
      labels: ['be'],
    });
    board.humanMove(card.id, 'Ready for Dev');

    // 1. The human's move dispatches DEV-BE.
    expect((await sync.tick()).dispatched.map((d) => d.role)).toEqual(['DEV-BE']);
    const beTask = store.listTasks({ state: 'queued' })[0]!;
    expect((await run(beTask)).verdict).toBe('review');

    // 2. Draining the outbox performs OUR move to In Review and reports it.
    await writer.drain(await sync.getTopology());
    expect((await board.getCard(card.id)).columnId).toBe(board.columnId('In Review'));
    expect(moved).toContain(card.id);

    // 3. That move is our own echo — an ordinary poll refuses to act on it...
    const pollAfterMove = await sync.tick();
    expect(pollAfterMove.dispatched).toHaveLength(0);
    expect(pollAfterMove.skipped.some((s) => s.reason === 'own writeback')).toBe(true);

    // ...but the handoff dispatches QA, which is the whole point.
    const handed = await sync.handoff(card.id);
    expect(handed?.role).toBe('QA');

    // 4. QA runs, finds only a nit, and commits nothing.
    const qaTask = store.listTasks({ state: 'queued' })[0]!;
    expect(qaTask.role).toBe('QA');
    const qaResult = await run(qaTask);
    expect(qaResult.verdict).toBe('review');
    expect(qaResult.comment).toContain('## Findings');

    // 5. QA's own overlay moves the card to Done, not back to In Review.
    await writer.drain(await sync.getTopology());
    expect((await board.getCard(card.id)).columnId).toBe(board.columnId('Done'));
    expect((await board.getCard(card.id)).labelNames).toContain('qa-passed');

    // Two roles, two tasks, one card, one unattended chain.
    const tasks = store.listTasks();
    expect(tasks.map((t) => t.role).sort()).toEqual(['DEV-BE', 'QA']);
    expect(tasks.every((t) => t.state === 'review')).toBe(true);

    // And it settles: nothing dispatches again.
    expect((await sync.tick()).dispatched).toHaveLength(0);
    expect(await sync.handoff(card.id)).toBeNull();
    expect(boardStore.outboxCounts().done).toBeGreaterThan(0);

    store.close();
  }, 90_000);
});
