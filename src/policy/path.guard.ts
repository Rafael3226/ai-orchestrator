import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, posix, resolve, sep } from 'node:path';

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

/**
 * Which filesystem dialect the paths in front of us are written in.
 *
 * `posix` is for a containerized agent: the hook runs on the Windows host but
 * is handed container paths like `/work/src/x.ts`. Resolving those natively
 * would silently anchor them to the current drive. In posix mode we also skip
 * symlink resolution — we cannot follow the container's links from out here.
 * Accepted limitation: a symlink planted inside the mount pointing out of it is
 * not caught host-side; `--cap-drop ALL` and the mount set contain that.
 */
export type PathMode = 'native' | 'posix';

export function isInside(root: string, candidate: string, mode: PathMode = 'native'): boolean {
  if (mode === 'posix') {
    const r = posix.resolve(root);
    const c = posix.resolve(candidate);
    return c === r || c.startsWith(r.endsWith('/') ? r : `${r}/`);
  }
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

/**
 * Minimal glob → RegExp for repo-relative allowlists: `**` (any depth), `*`
 * (one segment) and `?`. Deliberately not a dependency — these patterns are
 * written by us, in `delivery.policy.ts`, and never by a user.
 */
function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` also matches zero directories, so `docs/qa/**` covers `docs/qa`.
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`, 'i');
}

const cache = new Map<string, RegExp>();
const matcher = (glob: string): RegExp => {
  let re = cache.get(glob);
  if (!re) cache.set(glob, (re = globToRegExp(glob)));
  return re;
};

/**
 * `allowGlobs` narrows a role to part of the tree (QA to tests, DEVOPS to CI
 * and infra). Empty means the whole worktree, which is every DEV role.
 */
export function checkWrite(
  root: string,
  filePath: string,
  allowGlobs: readonly string[] = [],
  mode: PathMode = 'native',
): GuardResult {
  if (!filePath) return { ok: false, reason: 'missing file path' };
  const abs = toAbsolute(root, filePath, mode);
  if (!isInside(root, abs, mode)) return { ok: false, reason: `write outside worktree: ${abs}` };
  const rel = abs.slice((mode === 'posix' ? posix.resolve(root) : realpathNearest(root)).length);
  for (const { re, why } of FORBIDDEN_WRITE) {
    if (re.test(rel)) return { ok: false, reason: `protected path (${why}): ${rel}` };
  }
  if (allowGlobs.length) {
    const relPosix = rel.replace(/^[\\/]+/, '').replace(/\\/g, '/');
    if (!allowGlobs.some((g) => matcher(g).test(relPosix))) {
      return {
        ok: false,
        reason: `path not writable by this role: ${relPosix} (allowed: ${allowGlobs.join(', ')})`,
      };
    }
  }
  return { ok: true };
}

export function checkRead(
  root: string,
  filePath: string,
  additionalRoots: readonly string[] = [],
  mode: PathMode = 'native',
): GuardResult {
  if (!filePath) return { ok: false, reason: 'missing file path' };
  const abs = toAbsolute(root, filePath, mode);
  if (isInside(root, abs, mode) || additionalRoots.some((r) => isInside(r, abs, mode)))
    return { ok: true };
  return { ok: false, reason: `read outside worktree: ${abs}` };
}

function toAbsolute(root: string, filePath: string, mode: PathMode): string {
  if (mode === 'posix') {
    return posix.isAbsolute(filePath) ? posix.normalize(filePath) : posix.resolve(root, filePath);
  }
  return isAbsolute(filePath) ? filePath : resolve(root, filePath);
}
