import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { type ProjectConfig, loadConfigFromString } from '../config/config.loader.js';
import { SqliteStore, type TaskRow } from '../db/sqlite.store.js';
import { newTaskId } from '../domain/ids.js';
import { aSummary, ScriptedDriver } from '../testing/scripted.driver.js';
import { WorktreeManager } from '../workspace/worktree.manager.js';

import {
  executeTask,
  type TaskRunnerDeps,
  type TaskSink,
  validateCommitWithRepo,
} from './task.runner.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let base: string;
let repo: string;
let wtRoot: string;
let store: SqliteStore;

interface ProjectOpts {
  readonly test?: string;
  readonly install?: string;
  readonly repoPath?: string;
}

const yaml = (repoPath: string, wt: string, o: ProjectOpts) => `
version: 1
projects:
  - id: demo
    name: Demo
    repo: { path: ${JSON.stringify(repoPath)}, worktreeRoot: ${JSON.stringify(wt)}, githubRepo: me/demo }
    board: { provider: trello, boardId: b1, credentials: T, columns: {} }
    checks: { ${[
      o.test ? `test: ${JSON.stringify(o.test)}` : null,
      o.install ? `install: ${JSON.stringify(o.install)}` : null,
    ]
      .filter(Boolean)
      .join(', ')} }
    agents:
      DEV-BE: { enabled: true, budget: { maxUsd: 1, maxTurns: 5 } }
      QA: { enabled: true, budget: { maxUsd: 1, maxTurns: 5 } }
      PM: { enabled: true, budget: { maxUsd: 1, maxTurns: 5 } }
      DEVOPS: { enabled: true, budget: { maxUsd: 1, maxTurns: 5 } }
    routes: [{ when: { list: Ready }, agent: DEV-BE }]
`;

const project = (test?: string, repoPath = repo): ProjectConfig =>
  loadConfigFromString(yaml(repoPath, wtRoot, { ...(test ? { test } : {}) }), 'x').project('demo');

const projectWith = (o: ProjectOpts): ProjectConfig =>
  loadConfigFromString(yaml(o.repoPath ?? repo, wtRoot, o), 'x').project('demo');

/** Records what the board would have been told, in order. */
class RecordingSink implements TaskSink {
  readonly started: string[] = [];
  readonly progress: string[] = [];
  readonly finished: { verdict: string; comment: string }[] = [];
  onStart(_t: TaskRow, comment: string): void {
    this.started.push(comment);
  }
  onProgress(_t: TaskRow, _r: string, p: { message: string }): void {
    this.progress.push(p.message);
  }
  onFinish(_t: TaskRow, verdict: string, comment: string): void {
    this.finished.push({ verdict, comment });
  }
}

function claimedTask(maxAttempts = 2, role = 'DEV-BE'): TaskRow {
  const t = store.insertTask({
    id: newTaskId(),
    projectId: 'demo',
    role,
    cardId: 'c1',
    cardShortId: '42',
    title: 'Add a thing',
    spec: 'Please add the thing.',
    maxAttempts,
  });
  return store.transitionTask(t.id, 'queued', 'claimed');
}

const deps = (driver: ScriptedDriver, sink: TaskSink): TaskRunnerDeps => ({
  store,
  worktrees: new WorktreeManager(store, []),
  driver,
  sink,
  log: () => {},
});

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'runner-'));
  repo = join(base, 'repo');
  wtRoot = join(base, 'wt');
  const remote = join(base, 'remote.git');
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
  store = new SqliteStore(':memory:');
});

describe('executeTask verdicts', () => {
  it('reaches review on a passing verify, and dry run stops before the PR', async () => {
    const driver = new ScriptedDriver([
      {
        work: (cwd) => writeFileSync(join(cwd, 'thing.ts'), 'export const thing = 1;\n'),
        calls: [
          ['report_progress', { phase: 'implementing', message: 'writing the thing' }],
          ['record_decision', { title: 'Kept it pure', rationale: 'No I/O means no mocks.' }],
          ['propose_summary', aSummary()],
        ],
      },
    ]);
    const sink = new RecordingSink();
    const task = claimedTask();

    const r = await executeTask(deps(driver, sink), project('git --version'), task, {
      dryRun: true,
    });

    expect(r.verdict).toBe('review');
    expect(r.prUrl).toBeNull();
    expect(store.getTask(task.id).state).toBe('review');
    expect(sink.started[0]).toContain('picked up this card (attempt 1)');
    expect(sink.progress).toEqual(['writing the thing']);
    expect(sink.finished).toHaveLength(1);
    expect(sink.finished[0]!.verdict).toBe('review');
    expect(sink.finished[0]!.comment).toContain('✅ **DEV-BE** — review (attempt 1)');
    expect(sink.finished[0]!.comment).toContain('Adds the thing, with a test');
    expect(sink.finished[0]!.comment).toContain('ai/dev-be/42-add-a-thing');

    const run = store.listRunsForTask(task.id)[0]!;
    expect(run.outcome).toBe('success');
    expect(run.verify_exit_code).toBe(0);
    expect(JSON.parse(run.summary_json!).title).toBe('Add the thing that was asked for');
    expect(JSON.parse(run.decisions_json!)).toHaveLength(1);
    // dryRun keeps the workspace for inspection rather than releasing it.
    expect(store.listWorkspaces('demo')[0]!.state).toBe('retained');
  }, 60_000);

  it('skips verification entirely when the project configures no test command', async () => {
    const driver = new ScriptedDriver([
      {
        work: (cwd) => writeFileSync(join(cwd, 'thing.ts'), 'export const thing = 1;\n'),
        calls: [['propose_summary', aSummary()]],
      },
    ]);
    const task = claimedTask();

    const r = await executeTask(deps(driver, new RecordingSink()), project(), task, {
      dryRun: true,
    });

    expect(r.verdict).toBe('review');
    expect(store.listRunsForTask(task.id)[0]!.verify_exit_code).toBeNull();
  }, 60_000);

  it('lands in blocked when the agent reports it, without publishing', async () => {
    const driver = new ScriptedDriver([
      {
        calls: [
          [
            'report_blocked',
            {
              reason: 'The spec does not say which column the index belongs on.',
              category: 'ambiguous-requirements',
              needs: ['the target column'],
            },
          ],
        ],
      },
    ]);
    const sink = new RecordingSink();
    const task = claimedTask();

    const r = await executeTask(deps(driver, sink), project('git --version'), task);

    expect(r.verdict).toBe('blocked');
    expect(r.reason).toContain('ambiguous-requirements');
    expect(r.prUrl).toBeNull();
    const row = store.getTask(task.id);
    expect(row.state).toBe('blocked');
    expect(row.blocked_reason).toContain('ambiguous-requirements');
    // Blocked short-circuits before verify.
    expect(store.listRunsForTask(task.id)[0]!.verify_exit_code).toBeNull();
    expect(sink.finished[0]!.verdict).toBe('blocked');
  }, 60_000);

  it('lands in needs_human when the agent never proposes a summary', async () => {
    const driver = new ScriptedDriver([{ calls: [] }]);
    const task = claimedTask();

    const r = await executeTask(deps(driver, new RecordingSink()), project('git --version'), task);

    expect(r.verdict).toBe('needs_human');
    expect(r.reason).toContain('without calling propose_summary');
    expect(store.getTask(task.id).state).toBe('needs_human');
  }, 60_000);

  it('fails when the agent run itself ends badly, reporting the driver errors', async () => {
    const driver = new ScriptedDriver([
      { outcome: 'error_max_turns', errors: ['turn limit reached'] },
    ]);
    const task = claimedTask();

    const r = await executeTask(deps(driver, new RecordingSink()), project('git --version'), task);

    expect(r.verdict).toBe('failed');
    expect(r.reason).toContain('error_max_turns');
    expect(r.reason).toContain('turn limit reached');
    expect(store.getTask(task.id).last_error).toContain('error_max_turns');
  }, 60_000);

  it('retries once in the same session, then gives up to a human', async () => {
    const driver = new ScriptedDriver([
      {
        work: (cwd) => writeFileSync(join(cwd, 'thing.ts'), 'export const thing = 1;\n'),
        calls: [['propose_summary', aSummary()]],
      },
    ]);
    const task = claimedTask(2);

    const r = await executeTask(deps(driver, new RecordingSink()), project('exit 7'), task, {
      dryRun: true,
    });

    expect(r.verdict).toBe('needs_human');
    expect(r.reason).toBe('verification failed twice');
    expect(driver.specs).toHaveLength(2);
    // The second attempt resumes the first session and is told what failed.
    expect(driver.specs[0]!.resume).toBeUndefined();
    expect(driver.specs[1]!.resume?.sessionId).toBe('session-1');
    expect(driver.specs[1]!.prompt).toContain('exit 7');

    const runs = store.listRunsForTask(task.id);
    expect(runs).toHaveLength(2);
    expect(runs.every((x) => x.verify_exit_code === 7)).toBe(true);
    expect(store.getTask(task.id).attempts).toBe(2);
  }, 90_000);

  it('stops at a single attempt when max_attempts is 1', async () => {
    const driver = new ScriptedDriver([
      {
        work: (cwd) => writeFileSync(join(cwd, 'thing.ts'), 'export const thing = 1;\n'),
        calls: [['propose_summary', aSummary()]],
      },
    ]);
    const task = claimedTask(1);

    const r = await executeTask(deps(driver, new RecordingSink()), project('exit 7'), task, {
      dryRun: true,
    });

    expect(r.verdict).toBe('needs_human');
    expect(driver.specs).toHaveLength(1);
  }, 60_000);

  it('fails before starting when the worktree cannot be created', async () => {
    const driver = new ScriptedDriver([{}]);
    const sink = new RecordingSink();
    const task = claimedTask();
    const notARepo = join(base, 'plain');
    mkdirSync(notARepo);

    const r = await executeTask(deps(driver, sink), project(undefined, notARepo), task);

    expect(r.verdict).toBe('failed');
    expect(r.reason).toContain('not a git repository');
    expect(store.getTask(task.id).state).toBe('failed');
    expect(driver.specs).toHaveLength(0);
    expect(sink.finished[0]!.comment).toContain('failed before starting');
  }, 60_000);

  it('fails with nothing-to-commit when the agent proposed a summary but changed nothing', async () => {
    const driver = new ScriptedDriver([{ calls: [['propose_summary', aSummary()]] }]);
    const task = claimedTask();

    // Not a dry run: publish runs for real and aborts at the staging step.
    const r = await executeTask(deps(driver, new RecordingSink()), project(), task);

    expect(r.verdict).toBe('failed');
    expect(r.reason).toContain('nothing-to-commit');
    expect(r.prUrl).toBeNull();
    expect(store.getTask(task.id).state).toBe('failed');
  }, 60_000);

  it('passes the card, the branch and the role policy through to the driver', async () => {
    const driver = new ScriptedDriver([{}]);
    const task = claimedTask();

    await executeTask(deps(driver, new RecordingSink()), project('git --version'), task);

    const spec = driver.specs[0]!;
    expect(spec.prompt).toContain('Please add the thing.');
    expect(spec.systemPromptAppend).toContain('You are DEV-BE');
    expect(spec.cwd.startsWith(wtRoot)).toBe(true);
    expect(spec.maxTurns).toBe(5);
    expect(spec.maxBudgetUsd).toBe(1);
    expect(Object.keys(spec.mcpServers)).toContain('board');
    expect(spec.hooks.PreToolUse?.length).toBeGreaterThan(0);
  }, 60_000);
});

describe('validateCommitWithRepo', () => {
  const summary = (commit: Record<string, unknown>) =>
    aSummary({ commit }) as unknown as Parameters<typeof validateCommitWithRepo>[1];

  it('accepts a well-formed conventional commit when the repo has no commitlint', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'nolint-'));
    expect(
      await validateCommitWithRepo(cwd, summary({ type: 'feat', subject: 'add the thing' })),
    ).toEqual([]);
  });

  it('rejects an uppercase subject, a trailing period and an over-long header', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'nolint-'));
    expect(
      await validateCommitWithRepo(cwd, summary({ type: 'feat', subject: 'Add the thing' })),
    ).toEqual(['subject must not start with an uppercase letter']);
    expect(
      await validateCommitWithRepo(cwd, summary({ type: 'feat', subject: 'add the thing.' })),
    ).toEqual(['subject must not end with a period']);

    const long = await validateCommitWithRepo(
      cwd,
      summary({ type: 'feat', scope: 'x', subject: 'a'.repeat(120) }),
    );
    expect(long[0]).toMatch(/header is \d+ chars \(max 100\)/);
  });
});

describe('delivery policy: roles that do not end in a pull request', () => {
  it('runs PM with no install, no verify, no branch diff and no commit', async () => {
    // `exit 1` for both hooks is the proof: if either ran, the run would fail.
    const driver = new ScriptedDriver([
      {
        calls: [
          ['report_progress', { phase: 'planning', message: 'refining the spec' }],
          [
            'propose_summary',
            {
              title: 'Specification: withdraw an application',
              summary:
                'An applicant can withdraw a submitted application.\nWithdrawal is reversible for 24 hours.\nThe employer sees the withdrawal in their inbox.\nAudit keeps the original submission.',
              testPlan: 'Covered by the acceptance criteria below.',
              filesTouched: [],
              acceptanceCriteria: [
                'A submitted application shows a Withdraw action',
                'Withdrawing moves it to the Withdrawn state',
              ],
              // Deliberately no `commit` — PM has nothing to commit.
            },
          ],
        ],
      },
    ]);
    const sink = new RecordingSink();
    const task = claimedTask(2, 'PM');

    const r = await executeTask(
      deps(driver, sink),
      projectWith({ install: 'exit 1', test: 'exit 1' }),
      task,
      { keepWorkspace: true },
    );

    expect(r.verdict).toBe('review');
    expect(r.prUrl).toBeNull();
    expect(store.getTask(task.id).state).toBe('review');

    // No verify ran at all.
    expect(store.listRunsForTask(task.id)[0]!.verify_exit_code).toBeNull();

    // Nothing was committed to the worktree branch.
    const ws = store.listWorkspaces('demo')[0]!;
    expect(git(ws.path, 'log', '--oneline').split('\n')).toHaveLength(1);

    // The comment carries the spec itself, not a branch/diff teaser.
    const comment = sink.finished[0]!.comment;
    expect(comment).toContain('Audit keeps the original submission.');
    expect(comment).toContain('## Acceptance criteria');
    expect(comment).toContain('- [ ] A submitted application shows a Withdraw action');
    expect(comment).not.toContain('Branch:');
    expect(comment).not.toContain('Changes:');

    // PM may not write anything, at the tool level.
    const spec = driver.specs[0]!;
    expect(spec.allowedTools).not.toContain('Write');
    expect(spec.allowedTools).not.toContain('Edit');
    expect(spec.allowedTools).not.toContain('Bash');
  }, 60_000);

  it('lets QA finish clean with findings and no diff', async () => {
    const driver = new ScriptedDriver([
      {
        // No `work`: QA reviewed the branch and changed nothing.
        calls: [
          [
            'propose_summary',
            {
              title: 'Review of the slugify branch',
              summary: 'The implementation matches the card. Two issues worth fixing first.',
              testPlan: 'Ran the existing suite; it passes.',
              filesTouched: [],
              findings: [
                {
                  severity: 'major',
                  title: 'Empty input is not handled',
                  detail: 'slugify("") returns undefined rather than an empty string.',
                  location: 'src/slugify.ts:12',
                },
                {
                  severity: 'nit',
                  title: 'Redundant comment',
                  detail: 'The comment on line 4 restates the function name.',
                },
              ],
              commit: { type: 'test', subject: 'review the slugify branch' },
            },
          ],
        ],
      },
    ]);
    const sink = new RecordingSink();
    const task = claimedTask(2, 'QA');

    const r = await executeTask(deps(driver, sink), project('git --version'), task, {
      keepWorkspace: true,
    });

    // This is the case that used to land in `failed` with nothing-to-commit.
    expect(r.verdict).toBe('review');
    expect(r.prUrl).toBeNull();
    expect(store.getTask(task.id).state).toBe('review');

    const ws = store.listWorkspaces('demo')[0]!;
    expect(git(ws.path, 'log', '--oneline').split('\n')).toHaveLength(1);

    const comment = sink.finished[0]!.comment;
    expect(comment).toContain('## Findings');
    expect(comment).toContain('**major**');
    expect(comment).toContain('Empty input is not handled');
    expect(comment).toContain('src/slugify.ts:12');
  }, 60_000);

  it('still fails a DEV role that produces no diff', async () => {
    // The `optional` escape hatch must not leak to roles that must produce code.
    const driver = new ScriptedDriver([{ calls: [['propose_summary', aSummary()]] }]);
    const task = claimedTask(1, 'DEV-BE');

    const r = await executeTask(deps(driver, new RecordingSink()), project(), task, {
      keepWorkspace: true,
    });

    expect(r.verdict).toBe('failed');
    expect(r.reason).toContain('nothing-to-commit');
  }, 60_000);

  it('rejects a summary with no commit from a role that must commit', async () => {
    const noCommit = aSummary();
    delete (noCommit as Record<string, unknown>).commit;
    const driver = new ScriptedDriver([
      {
        work: (cwd) => writeFileSync(join(cwd, 'thing.ts'), 'export const thing = 1;\n'),
        calls: [['propose_summary', noCommit]],
      },
    ]);
    const task = claimedTask(1, 'DEV-BE');

    const r = await executeTask(deps(driver, new RecordingSink()), project(), task, {
      keepWorkspace: true,
    });

    // The summary was refused, so the run ends without one.
    expect(r.verdict).toBe('needs_human');
    expect(store.listRunsForTask(task.id)[0]!.summary_json).toBeNull();
  }, 60_000);
});

describe('container driver path mapping', () => {
  it('gives the agent container paths, not host paths, in the guard and the prompt', async () => {
    // The bug this prevents: the prompt telling a containerized agent to work in
    // D:\aow\..., and the guard resolving /work/... against the current drive.
    const driver = new ScriptedDriver([{ calls: [['propose_summary', aSummary()]] }], {
      kind: 'docker',
      paths: { mode: 'posix', toAgent: () => '/work' },
    });
    const task = claimedTask(1, 'DEV-BE');

    await executeTask(deps(driver, new RecordingSink()), project(), task, {
      dryRun: true,
      keepWorkspace: true,
    });

    const spec = driver.specs[0]!;
    // The worktree the driver is told to mount is still the real host path...
    expect(spec.cwd).toContain(wtRoot);
    expect(spec.repoPath).toBe(repo);
    expect(spec.workspaceId).toBe(store.listWorkspaces('demo')[0]!.id);
    // ...but everything the AGENT reads speaks container paths.
    expect(spec.prompt).toContain('/work');
    expect(spec.prompt).not.toContain(wtRoot);

    // And the run is recorded against the docker driver.
    expect(store.listRunsForTask(task.id)[0]!.driver).toBe('docker');
  }, 60_000);

  it('keeps host paths for the local driver', async () => {
    const driver = new ScriptedDriver([{ calls: [['propose_summary', aSummary()]] }]);
    const task = claimedTask(1, 'DEV-BE');

    await executeTask(deps(driver, new RecordingSink()), project(), task, {
      dryRun: true,
      keepWorkspace: true,
    });

    const spec = driver.specs[0]!;
    expect(spec.prompt).toContain(spec.cwd);
    expect(store.listRunsForTask(task.id)[0]!.driver).toBe('local');
  }, 60_000);
});
