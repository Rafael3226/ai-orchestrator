import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';

/**
 * Pure path confinement helpers. No orchestrator imports on purpose — the
 * Docker driver will need to run these from a tiny CLI shim inside the
 * container.
 */

/** Canonicalize through symlinks/junctions using the nearest EXISTING ancestor. */
export function realpathNearest(p: string): string {
  let cur = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(cur);
      return tail.length ? resolve(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return resolve(p);
      tail.push(cur.slice(parent.length).replace(/^[\\/]/, ''));
      cur = parent;
    }
  }
}

const norm = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);

export function isInside(root: string, candidate: string): boolean {
  const r = norm(realpathNearest(root));
  const c = norm(realpathNearest(candidate));
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep);
}

/** Paths that may be read but never written, even inside the worktree. */
const FORBIDDEN_WRITE = [
  { re: /(^|[\\/])\.git([\\/]|$)/i, why: 'git metadata' },
  { re: /(^|[\\/])\.claude[\\/]settings(\.local)?\.json$/i, why: 'Claude Code settings' },
  { re: /(^|[\\/])\.mcp\.json$/i, why: 'MCP config' },
  { re: /(^|[\\/])\.env(\.[\w.-]+)?$/i, why: 'environment file' },
  { re: /(^|[\\/])node_modules([\\/]|$)/i, why: 'dependencies' },
  { re: /(^|[\\/])\.husky([\\/]|$)/i, why: 'git hooks' },
];

export type GuardResult = { ok: true } | { ok: false; reason: string };

export function checkWrite(root: string, filePath: string): GuardResult {
  if (!filePath) return { ok: false, reason: 'missing file path' };
  const abs = isAbsolute(filePath) ? filePath : resolve(root, filePath);
  if (!isInside(root, abs)) return { ok: false, reason: `write outside worktree: ${abs}` };
  const rel = abs.slice(realpathNearest(root).length);
  for (const { re, why } of FORBIDDEN_WRITE) {
    if (re.test(rel)) return { ok: false, reason: `protected path (${why}): ${rel}` };
  }
  return { ok: true };
}

export function checkRead(
  root: string,
  filePath: string,
  additionalRoots: readonly string[] = [],
): GuardResult {
  if (!filePath) return { ok: false, reason: 'missing file path' };
  const abs = isAbsolute(filePath) ? filePath : resolve(root, filePath);
  if (isInside(root, abs) || additionalRoots.some((r) => isInside(r, abs))) return { ok: true };
  return { ok: false, reason: `read outside worktree: ${abs}` };
}
