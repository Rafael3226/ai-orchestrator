import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { type ProjectConfig, loadConfigFromString } from '../config/config.loader.js';
import { SqliteStore } from '../db/sqlite.store.js';
import { newTaskId, type TaskId } from '../domain/ids.js';

import { WorktreeManager } from './worktree.manager.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let base: string;
let repo: string;
let wtRoot: string;
let store: SqliteStore;
let taskId: TaskId;

const yaml = (repoPath: string, wt: string, install?: string) => `
version: 1
projects:
  - id: demo
    name: Demo
    repo: { path: ${JSON.stringify(repoPath)}, worktreeRoot: ${JSON.stringify(wt)}, githubRepo: me/demo }
    board: { provider: trello, boardId: b1, credentials: T, columns: {} }
    checks: { ${install ? `install: ${JSON.stringify(install)}` : ''} }
    agents: { DEV-BE: { enabled: true } }
    routes: [{ when: { list: Ready }, agent: DEV-BE }]
`;

const project = (install?: string): ProjectConfig =>
  loadConfigFromString(yaml(repo, wtRoot, install), 'x').project('demo');

const acquire = (
  mgr: WorktreeManager,
  over: Partial<{ cardShortId: string; cardTitle: string }> = {},
) =>
  mgr.acquire({
    project: project(),
    taskId,
    role: 'DEV-BE',
    cardShortId: '42',
    cardTitle: 'Add a thing',
    ...over,
  });

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'wt-mgr-'));
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
  taskId = store.insertTask({
    id: newTaskId(),
    projectId: 'demo',
    role: 'DEV-BE',
    cardId: 'c1',
    cardShortId: '42',
    title: 'Add a thing',
    spec: '',
  }).id;
});

describe('WorktreeManager.acquire', () => {
  it('branches from origin/<base> into a short path and records the workspace', async () => {
    const mgr = new WorktreeManager(store, []);
    const ws = await acquire(mgr);

    expect(existsSync(join(ws.path, 'README.md'))).toBe(true);
    expect(ws.path.startsWith(wtRoot)).toBe(true);
    // <card-slug>-<short workspace id>, so a human can tell worktrees apart on disk.
    expect(join(ws.path).slice(wtRoot.length + 1)).toMatch(/^42-[a-z0-9]+$/i);
    expect(ws.branch).toBe('ai/dev-be/42-add-a-thing');
    expect(ws.baseBranch).toBe('main');
    expect(ws.baseSha).toBe(git(repo, 'rev-parse', 'origin/main'));
    expect(git(ws.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(ws.branch);

    const row = store.getWorkspace(ws.id)!;
    expect(row.state).toBe('active');
    expect(row.path).toBe(ws.path);
    expect(row.branch).toBe(ws.branch);
  });

  it('suffixes the branch when the name is already taken', async () => {
    const mgr = new WorktreeManager(store, []);
    const first = await acquire(mgr);
    const second = await acquire(mgr);

    expect(first.branch).toBe('ai/dev-be/42-add-a-thing');
    expect(second.branch).toBe('ai/dev-be/42-add-a-thing-2');
    expect(second.path).not.toBe(first.path);
  });

  it('copies include patterns into the worktree and reports them', async () => {
    writeFileSync(join(repo, '.env'), 'SECRET=1\n');
    const mgr = new WorktreeManager(store, ['.env']);
    const ws = await acquire(mgr);

    expect(ws.copiedIncludes).toEqual(['.env']);
    expect(existsSync(join(ws.path, '.env'))).toBe(true);
  });

  it('reuses a retained workspace when asked, and falls back when it is gone', async () => {
    const mgr = new WorktreeManager(store, []);
    const first = await acquire(mgr);
    mgr.retain(first.id);

    const reused = await mgr.acquire({
      project: project(),
      taskId,
      role: 'DEV-BE',
      cardShortId: '42',
      cardTitle: 'Add a thing',
      reuseWorkspaceId: first.id,
    });
    expect(reused.path).toBe(first.path);
    expect(reused.branch).toBe(first.branch);
    expect(store.getWorkspace(first.id)!.state).toBe('active');

    // The retained directory disappearing must not strand the retry.
    rmSync(first.path, { recursive: true, force: true });
    const logs: string[] = [];
    const fresh = await mgr.acquire({
      project: project(),
      taskId,
      role: 'DEV-BE',
      cardShortId: '42',
      cardTitle: 'Add a thing',
      reuseWorkspaceId: first.id,
      log: (m) => logs.push(m),
    });
    expect(fresh.path).not.toBe(first.path);
    expect(logs.join('\n')).toContain('retained workspace missing');
  });

  it('refuses a path that is not a git repository', async () => {
    const notARepo = join(base, 'plain');
    mkdirSync(notARepo);
    const mgr = new WorktreeManager(store, []);
    await expect(
      mgr.acquire({
        project: loadConfigFromString(yaml(notARepo, wtRoot), 'x').project('demo'),
        taskId,
        role: 'DEV-BE',
        cardShortId: '1',
        cardTitle: 'x',
      }),
    ).rejects.toThrow(/not a git repository/);
  });

  it('refuses a repo left mid-operation', async () => {
    writeFileSync(join(repo, '.git', 'MERGE_HEAD'), 'deadbeef\n');
    const mgr = new WorktreeManager(store, []);
    await expect(acquire(mgr)).rejects.toThrow(/mid-operation \(MERGE_HEAD present\)/);
  });

  it('tears the worktree down when the install command fails', async () => {
    const mgr = new WorktreeManager(store, []);
    await expect(
      mgr.acquire({
        project: project('exit 3'),
        taskId,
        role: 'DEV-BE',
        cardShortId: '42',
        cardTitle: 'Add a thing',
      }),
    ).rejects.toThrow(/dependency install failed \(3\)/);

    // No half-built worktree and no orphan branch left behind.
    expect(store.listWorkspaces('demo')).toHaveLength(0);
    expect(git(repo, 'worktree', 'list')).not.toContain(wtRoot.replace(/\\/g, '/'));
    expect(git(repo, 'branch', '--list', 'ai/dev-be/42-add-a-thing')).toBe('');
  });
});

describe('WorktreeManager.release', () => {
  it('removes the worktree and deletes a branch that was never pushed', async () => {
    const mgr = new WorktreeManager(store, []);
    const ws = await acquire(mgr);

    await mgr.release(project(), ws.id);

    expect(existsSync(ws.path)).toBe(false);
    expect(store.getWorkspace(ws.id)!.state).toBe('removed');
    expect(git(repo, 'branch', '--list', ws.branch)).toBe('');
  });

  it('keeps the branch when it has been pushed', async () => {
    const mgr = new WorktreeManager(store, []);
    const ws = await acquire(mgr);
    writeFileSync(join(ws.path, 'new.txt'), 'x\n');
    git(ws.path, 'add', '-A');
    git(ws.path, 'commit', '-q', '-m', 'work');
    git(ws.path, 'push', '-q', 'origin', ws.branch);

    await mgr.release(project(), ws.id);

    expect(existsSync(ws.path)).toBe(false);
    expect(store.getWorkspace(ws.id)!.state).toBe('removed');
    expect(git(repo, 'branch', '--list', ws.branch)).toContain(ws.branch);
  });

  it('is a no-op for an unknown or already removed workspace', async () => {
    const mgr = new WorktreeManager(store, []);
    const ws = await acquire(mgr);
    await mgr.release(project(), ws.id);
    await expect(mgr.release(project(), ws.id)).resolves.toBeUndefined();
  });
});

describe('WorktreeManager.gc', () => {
  it('removes a worktree under our root that the database does not know about', async () => {
    const mgr = new WorktreeManager(store, []);
    mkdirSync(wtRoot, { recursive: true });
    const stray = join(wtRoot, 'stray-1');
    git(repo, 'worktree', 'add', '-b', 'stray', stray, 'origin/main');
    expect(existsSync(stray)).toBe(true);

    const logs: string[] = [];
    await mgr.gc(project(), (m) => logs.push(m));

    expect(existsSync(stray)).toBe(false);
    expect(logs.join('\n')).toContain('unknown worktree');
  });

  it('marks a row removed when its directory has vanished', async () => {
    const mgr = new WorktreeManager(store, []);
    const ws = await acquire(mgr);
    rmSync(ws.path, { recursive: true, force: true });

    await mgr.gc(project());

    expect(store.getWorkspace(ws.id)!.state).toBe('removed');
  });

  it('retries a deferred cleanup', async () => {
    const mgr = new WorktreeManager(store, []);
    const ws = await acquire(mgr);
    store.setWorkspaceState(ws.id, 'cleanup_pending');

    await mgr.gc(project());

    expect(store.getWorkspace(ws.id)!.state).toBe('removed');
    expect(existsSync(ws.path)).toBe(false);
  });

  it('leaves the main checkout and worktrees outside our root alone', async () => {
    const mgr = new WorktreeManager(store, []);
    const outside = join(base, 'elsewhere');
    git(repo, 'worktree', 'add', '-b', 'elsewhere', outside, 'origin/main');

    await mgr.gc(project());

    expect(existsSync(join(repo, 'README.md'))).toBe(true);
    expect(existsSync(outside)).toBe(true);
  });
});
