import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfigFromString, type ProjectConfig } from '../config/config.loader.js';
import type { ExecResult } from '../exec/exec.driver.js';
import type { ProposedSummary } from '../mcp/board.schemas.js';
import { ROLE_DELIVERY, type DeliveryPolicy } from '../policy/delivery.policy.js';
import type { WorkspaceHandle } from '../workspace/worktree.manager.js';

import { PublishAbort, publish } from './post.run.pipeline.js';
import type { PrPublisher } from './pr.publisher.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let base: string;
let repo: string;
let project: ProjectConfig;
let workspace: WorkspaceHandle;

const yaml = (repoPath: string) => `
version: 1
projects:
  - id: demo
    name: Demo
    repo: { path: ${JSON.stringify(repoPath)}, worktreeRoot: /wt, githubRepo: me/demo }
    board: { provider: trello, boardId: b1, credentials: T, columns: {} }
    agents: { DEV-BE: { enabled: true }, QA: { enabled: true } }
    routes: [{ when: { list: Ready }, agent: DEV-BE }]
`;

const summary = (over: Partial<ProposedSummary> = {}): ProposedSummary =>
  ({
    title: 'Add the thing',
    summary: 'Adds the thing, with a test that covers the empty case.',
    testPlan: 'pnpm test',
    filesTouched: ['thing.ts'],
    commit: { type: 'feat', subject: 'add the thing' },
    ...over,
  }) as ProposedSummary;

const emptyExec = (): ExecResult => ({
  outcome: 'success',
  sessionId: 's',
  finalText: null,
  numTurns: 1,
  durationMs: 1,
  cost: {
    totalCostUsd: 0,
    reportedCostUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    perModel: {},
    estimated: false,
  },
  permissionDenials: [],
  errors: [],
});

/** `gh` is never invoked in the suite; the PR step is a seam. */
const fakePr = () => {
  const createDraft = vi.fn().mockResolvedValue('https://github.com/me/demo/pull/7');
  return { createDraft } as unknown as PrPublisher & { createDraft: ReturnType<typeof vi.fn> };
};

const run = (delivery: DeliveryPolicy, pr = fakePr()) =>
  publish(
    {
      project,
      workspace,
      runId: 'run-1',
      cardShortId: '42',
      cardUrl: 'https://fake/c/42',
      role: 'DEV-BE',
      attempt: 1,
      summary: summary(),
      decisions: [],
      verify: [],
      exec: emptyExec(),
      denials: [],
      log: () => {},
      delivery,
    },
    { pr },
  );

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'publish-'));
  repo = join(base, 'repo');
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
  git(repo, 'checkout', '-q', '-b', 'ai/dev-be/42-add-a-thing');

  project = loadConfigFromString(yaml(repo), 'x').project('demo');
  workspace = {
    id: 'ws-1' as WorkspaceHandle['id'],
    projectId: 'demo',
    path: repo,
    branch: 'ai/dev-be/42-add-a-thing',
    baseBranch: 'main',
    baseSha: git(repo, 'rev-parse', 'HEAD'),
    copiedIncludes: [],
    prepareMs: 1,
  };
});

describe('publish', () => {
  it('aborts on an empty diff when the role must produce one', async () => {
    await expect(run(ROLE_DELIVERY['DEV-BE'])).rejects.toBeInstanceOf(PublishAbort);
    await expect(run(ROLE_DELIVERY['DEV-BE'])).rejects.toMatchObject({
      code: 'nothing-to-commit',
    });
  }, 30_000);

  it('finishes board-only on an empty diff when the role may review without changing anything', async () => {
    const pr = fakePr();

    const out = await run(ROLE_DELIVERY.QA, pr);

    expect(out).toEqual({
      kind: 'board-only',
      diff: null,
      sha: null,
      prUrl: null,
      hooksBypassed: false,
    });
    expect(pr.createDraft).not.toHaveBeenCalled();
    // Nothing was committed: the branch still has only the initial commit.
    expect(git(repo, 'log', '--oneline').split('\n')).toHaveLength(1);
  }, 30_000);

  it('commits, pushes and opens a PR when that same role did produce a diff', async () => {
    writeFileSync(join(repo, 'thing.test.ts'), 'export const t = 1;\n');
    const pr = fakePr();

    const out = await run(ROLE_DELIVERY.QA, pr);

    expect(out.kind).toBe('pull-request');
    expect(out.prUrl).toBe('https://github.com/me/demo/pull/7');
    expect(out.diff?.files).toBe(1);
    expect(pr.createDraft).toHaveBeenCalledTimes(1);
    expect(git(repo, 'log', '--oneline').split('\n')).toHaveLength(2);
    expect(git(repo, 'log', '-1', '--pretty=%s')).toBe('feat: add the thing');
  }, 30_000);

  it('opens a PR as usual for a DEV role with a diff', async () => {
    writeFileSync(join(repo, 'thing.ts'), 'export const t = 1;\n');
    const pr = fakePr();

    const out = await run(ROLE_DELIVERY['DEV-BE'], pr);

    expect(out.kind).toBe('pull-request');
    expect(out.sha).toMatch(/^[0-9a-f]{7,}$/);
    expect(pr.createDraft).toHaveBeenCalledTimes(1);
  }, 30_000);
});
