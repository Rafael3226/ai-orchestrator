import { readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

export interface GitDirMapping {
  /** Host path of the PARENT repo's `.git`, bind-mounted read-write. */
  readonly gitCommonHostDir: string;
  /** Value for GIT_DIR inside the container. */
  readonly containerGitDir: string;
  /** The worktree's name under `.git/worktrees`, which is not always the folder name. */
  readonly worktreeName: string;
}

/**
 * A `git worktree` has a `.git` FILE, not a directory, containing
 * `gitdir: D:/repo/.git/worktrees/<name>`. Bind-mounting only the worktree
 * therefore hands the container a dangling Windows path and every git command
 * fails.
 *
 * We never rewrite that file — the host publisher reads it moments later to
 * stage, commit and push. Instead the parent `.git` is mounted at
 * `/gitcommon` and git is pinned by environment:
 *
 *   GIT_DIR=/gitcommon/worktrees/<name>   GIT_WORK_TREE=/work
 *
 * GIT_DIR short-circuits discovery so the `.git` file is never read, and
 * `<gitdir>/commondir` is the relative `../..`, which resolves to `/gitcommon`.
 * (`<gitdir>/gitdir` still holds a stale host path, but only `git worktree
 * list/prune` reads it, and bash.guard denies those.)
 *
 * Returns null for a plain clone, where `.git` is already a directory and
 * nothing extra needs mounting.
 */
export function resolveGitDir(
  worktreePath: string,
  repoPath: string,
  containerGitCommon = '/gitcommon',
): GitDirMapping | null {
  const dotGit = join(worktreePath, '.git');
  let stat;
  try {
    stat = statSync(dotGit);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return null;

  const text = readFileSync(dotGit, 'utf8');
  const match = /^\s*gitdir:\s*(.+?)\s*$/m.exec(text);
  if (!match?.[1]) return null;

  // The folder name and the worktree name diverge once branch.namer dedupes.
  const worktreeName = basename(match[1].replace(/[\\/]+$/, ''));
  if (!worktreeName) return null;

  return {
    gitCommonHostDir: join(repoPath, '.git'),
    containerGitDir: `${containerGitCommon}/worktrees/${worktreeName}`,
    worktreeName,
  };
}
