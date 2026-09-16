import { cpSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { isInside } from '../policy/path.guard.js';

const HARD_REFUSE = [/(^|[\\/])node_modules([\\/]|$)/i, /(^|[\\/])\.git([\\/]|$)/i];

/**
 * Copy gitignored files (`.env` and friends) from the main checkout into a new
 * worktree — the same job as Claude Code's `.worktreeinclude`, and reading
 * that file when the target repo has one.
 *
 * Returns the repo-relative paths copied so the secret scanner can hard-deny
 * them from ever being staged.
 */
export function copyIncludes(
  repoPath: string,
  worktreePath: string,
  configuredPatterns: readonly string[],
  log: (msg: string) => void = () => {},
): string[] {
  const patterns = [...configuredPatterns, ...readWorktreeInclude(repoPath)];
  const copied: string[] = [];

  for (const pattern of patterns) {
    let matched = 0;
    for (const abs of expand(repoPath, pattern)) {
      const rel = relative(repoPath, abs);
      if (HARD_REFUSE.some((re) => re.test(rel)) || !isInside(repoPath, abs)) {
        log(`include: refusing ${rel}`);
        continue;
      }
      if (!existsSync(abs) || !statSync(abs).isFile()) continue;
      const dest = join(worktreePath, rel);
      cpSync(abs, dest, { preserveTimestamps: true, force: true, recursive: false });
      copied.push(rel);
      matched++;
    }
    if (matched === 0) log(`include: pattern "${pattern}" matched nothing`);
  }
  return copied;
}

function readWorktreeInclude(repoPath: string): string[] {
  const file = join(repoPath, '.worktreeinclude');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

/**
 * Minimal glob: supports literal paths and a single `*` directory segment
 * (`apps/*\/.env`). That covers every real include file we have seen; a full
 * glob library is not worth the dependency here.
 */
function expand(root: string, pattern: string): string[] {
  const parts = pattern.replace(/\\/g, '/').split('/');
  let current = [root];
  for (const part of parts) {
    const next: string[] = [];
    for (const dir of current) {
      if (part === '*') {
        if (!existsSync(dir)) continue;
        for (const entry of readDirSafe(dir)) next.push(join(dir, entry));
      } else {
        next.push(resolve(dir, part));
      }
    }
    current = next;
  }
  return current.filter((p) => dirname(p) !== p);
}

function readDirSafe(dir: string): string[] {
  try {
    return statSync(dir).isDirectory() ? readdirSync(dir) : [];
  } catch {
    return [];
  }
}
