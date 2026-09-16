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

import { Orchestrator } from './orchestrator.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A driver that "works" instantly: no Claude, no cost. It never calls propose_summary, so the task lands in needs_human without publishing. */
class FakeDriver implements ExecDriver {
  readonly kind = 'local' as const;
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
