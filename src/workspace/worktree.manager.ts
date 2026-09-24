import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { ProjectConfig } from '../config/config.loader.js';
import type { Role } from '../config/config.schema.js';
import type { SqliteStore, WorkspaceRow } from '../db/sqlite.store.js';
import { newWorkspaceId, shortId, type TaskId, type WorkspaceId } from '../domain/ids.js';
import { HostExecutor, type WorkspaceExecutor } from '../exec/workspace.executor.js';
import { KeyedMutex } from '../process/async.mutex.js';

import { renderBranchName, withCollisionSuffix } from './branch.namer.js';
import { GitCli } from './git.cli.js';
import { copyIncludes } from './include.copier.js';

export interface WorkspaceHandle {
  readonly id: WorkspaceId;
  readonly projectId: string;
  readonly path: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly baseSha: string;
  /** Repo-relative paths copied from the include manifest — never to be staged. */
  readonly copiedIncludes: readonly string[];
  readonly prepareMs: number;
}

export interface AcquireInput {
  readonly project: ProjectConfig;
  readonly taskId: TaskId;
  readonly role: Role;
  readonly cardShortId: string;
  readonly cardTitle: string;
  /** Retry path: reuse a retained workspace instead of creating one. */
  readonly reuseWorkspaceId?: WorkspaceId;
  /** False for roles that never build or run anything (PM). Defaults to true. */
  readonly install?: boolean;
  /**
   * Force LF on checkout. Required under the docker driver: Git-for-Windows
   * defaults to core.autocrlf=true, and a Linux container then lints and tries
   * to `exec` CRLF shell scripts.
   */
  readonly lineEndings?: 'lf';
  /**
   * Builds the executor that runs `checks.install`. A factory, not an instance,
   * because a container executor needs the worktree path and id, and neither
   * exists until `acquire` has created them.
   */
  readonly executorFor?: (path: string, workspaceId: WorkspaceId) => WorkspaceExecutor;
  readonly log?: (msg: string) => void;
}

const REPO_BUSY_MARKERS = [
  'index.lock',
  'MERGE_HEAD',
  'REBASE_HEAD',
  'CHERRY_PICK_HEAD',
  'BISECT_LOG',
];

/**
 * Owns git worktrees for every project. We manage them ourselves rather than
 * via `claude --worktree`: we need legible branch names, branching from
 * `origin/<base>` instead of HEAD, a short path outside the repo (Windows
 * MAX_PATH), and a lifecycle our crash recovery can see.
 */
export class WorktreeManager {
  private readonly mutex = new KeyedMutex();
  private readonly git = new GitCli();

  constructor(
    private readonly store: SqliteStore,
    private readonly includePatterns: readonly string[] = [
      '.env',
      '.env.local',
      'apps/*/.env',
      'packages/*/.env',
    ],
  ) {}

  async acquire(input: AcquireInput): Promise<WorkspaceHandle> {
    const log = input.log ?? (() => {});
    const repo = resolve(input.project.repo.path);

    if (input.reuseWorkspaceId) {
      const row = this.store.getWorkspace(input.reuseWorkspaceId);
      if (row && row.state !== 'removed' && existsSync(row.path)) {
        this.store.setWorkspaceState(row.id, 'active');
        log(`reusing workspace ${row.path}`);
        return { ...toHandle(row), copiedIncludes: [] };
      }
      log('retained workspace missing — creating a fresh one');
    }

    return this.mutex.run(repo, async () => {
      const started = Date.now();
      await this.assertRepoHealthy(repo);

      const { remote, baseBranch } = input.project.repo;
      log(`fetch ${remote}/${baseBranch}`);
      await this.git.fetch(repo, remote, baseBranch);
      const baseSha = await this.git.revParse(repo, `${remote}/${baseBranch}`);

      const base = renderBranchName({
        template: input.project.repo.branchTemplate,
        role: input.role,
        cardShortId: input.cardShortId,
        cardTitle: input.cardTitle,
      });
      const taken = new Set<string>();
      for (const candidate of [base, ...Array.from({ length: 10 }, (_, i) => `${base}-${i + 2}`)]) {
        if (
          (await this.git.refExists(repo, `refs/heads/${candidate}`)) ||
          (await this.git.remoteBranchExists(repo, remote, candidate))
        ) {
          taken.add(candidate);
        } else break;
      }
      const branch = withCollisionSuffix(base, (c) => taken.has(c));

      const id = newWorkspaceId();
      const root = resolve(input.project.repo.worktreeRoot);
      mkdirSync(root, { recursive: true });
      const path = join(root, `${slugDir(input.cardShortId)}-${shortId(id)}`);

      // `-c` before the subcommand so the setting applies to this invocation
      // only — nothing in the target repo's config is modified.
      const eol =
        input.lineEndings === 'lf' ? ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf'] : [];

      log(`git worktree add ${path} (${branch} @ ${baseSha.slice(0, 8)})`);
      await this.git.run(repo, [
        ...eol,
        'worktree',
        'add',
        '--no-checkout',
        '-b',
        branch,
        path,
        baseSha,
      ]);
      try {
        await this.git.run(path, [...eol, 'checkout', '--quiet']);
      } catch (err) {
        await this.forceRemove(repo, path, branch);
        throw err;
      }

      const copiedIncludes = copyIncludes(repo, path, this.includePatterns, log);

      if (input.project.checks.install && input.install !== false) {
        log(`install: ${input.project.checks.install}`);
        const executor = input.executorFor?.(path, id) ?? new HostExecutor();
        const r = await executor.run(input.project.checks.install, {
          cwd: path,
          timeoutMs: 10 * 60_000,
          env: { CI: '1' },
        });
        if (r.exitCode !== 0) {
          await this.forceRemove(repo, path, branch);
          throw new Error(`dependency install failed (${r.exitCode}):\n${r.output.slice(-3000)}`);
        }
      }

      const prepareMs = Date.now() - started;
      this.store.insertWorkspace({
        id,
        project_id: input.project.id,
        task_id: input.taskId,
        path,
        branch,
        base_branch: baseBranch,
        base_sha: baseSha,
        state: 'active',
        prepare_ms: prepareMs,
      });
      log(`workspace ready in ${Math.round(prepareMs / 1000)}s`);
      return {
        id,
        projectId: input.project.id,
        path,
        branch,
        baseBranch,
        baseSha,
        copiedIncludes,
        prepareMs,
      };
    });
  }

  /** Keep for a retry or human inspection. */
  retain(id: WorkspaceId): void {
    this.store.setWorkspaceState(id, 'retained');
  }

  /** Remove the worktree; delete the branch only if it was never pushed. Never throws. */
  async release(
    project: ProjectConfig,
    id: WorkspaceId,
    log: (m: string) => void = () => {},
  ): Promise<void> {
    const row = this.store.getWorkspace(id);
    if (!row || row.state === 'removed') return;
    const repo = resolve(project.repo.path);
    try {
      await this.mutex.run(repo, async () => {
        const pushed = await this.git.refExists(
          repo,
          `refs/remotes/${project.repo.remote}/${row.branch}`,
        );
        await this.forceRemove(repo, row.path, pushed ? null : row.branch);
      });
      this.store.setWorkspaceState(id, 'removed');
      log(`removed workspace ${row.path}`);
    } catch (err) {
      this.store.setWorkspaceState(id, 'cleanup_pending');
      log(`cleanup deferred for ${row.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Startup/periodic: reconcile DB rows with `git worktree list` and retry deferred cleanups. */
  async gc(project: ProjectConfig, log: (m: string) => void = () => {}): Promise<void> {
    const repo = resolve(project.repo.path);
    const root = resolve(project.repo.worktreeRoot);
    const known = new Map(this.store.listWorkspaces(project.id).map((w) => [normalize(w.path), w]));

    for (const wt of await this.git.worktreeList(repo)) {
      const p = normalize(wt.path);
      if (p === normalize(repo) || !p.startsWith(normalize(root))) continue;
      const row = known.get(p);
      if (!row) {
        log(`gc: unknown worktree ${wt.path} under our root — removing`);
        await this.forceRemove(repo, wt.path, wt.branch);
      }
    }
    for (const row of known.values()) {
      if (row.state === 'cleanup_pending') await this.release(project, row.id, log);
      else if (row.state !== 'removed' && !existsSync(row.path)) {
        this.store.setWorkspaceState(row.id, 'removed');
        await this.git.tryRun(repo, ['worktree', 'prune']);
      }
    }
  }

  private async assertRepoHealthy(repo: string): Promise<void> {
    if (!(await this.git.isRepo(repo))) throw new Error(`${repo} is not a git repository`);
    const gitDir = (await this.git.run(repo, ['rev-parse', '--git-dir'])).trim();
    for (const marker of REPO_BUSY_MARKERS) {
      if (existsSync(resolve(repo, gitDir, marker))) {
        throw new Error(`${repo} is mid-operation (${marker} present) — finish or abort it first`);
      }
    }
  }

  private async forceRemove(
    repo: string,
    path: string,
    branchToDelete: string | null,
  ): Promise<void> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 6; attempt++) {
      const r = await this.git.tryRun(repo, ['worktree', 'remove', '--force', path]);
      if (r.exitCode === 0 || !existsSync(path)) {
        lastErr = undefined;
        break;
      }
      lastErr = new Error(r.output.trim() || `worktree remove exited ${r.exitCode}`);
      await new Promise((res) => setTimeout(res, 500 * 2 ** attempt));
    }
    if (existsSync(path)) {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch (err) {
        lastErr = err;
      }
    }
    await this.git.tryRun(repo, ['worktree', 'prune']);
    if (branchToDelete) await this.git.tryRun(repo, ['branch', '-D', branchToDelete]);
    if (lastErr && existsSync(path)) throw lastErr;
  }
}

function toHandle(row: WorkspaceRow): Omit<WorkspaceHandle, 'copiedIncludes'> {
  return {
    id: row.id,
    projectId: row.project_id,
    path: row.path,
    branch: row.branch,
    baseBranch: row.base_branch,
    baseSha: row.base_sha,
    prepareMs: row.prepare_ms ?? 0,
  };
}

const slugDir = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24) || 'task';
const normalize = (p: string): string => resolve(p).replace(/\\/g, '/').toLowerCase();
