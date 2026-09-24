import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { checkRead, checkWrite, isInside } from './path.guard.js';

const base = mkdtempSync(join(tmpdir(), 'pathguard-'));
const root = join(base, 'wt');
const outside = join(base, 'outside');
mkdirSync(root, { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(join(outside, 'secret.txt'), 'x');

describe('checkWrite', () => {
  it('allows a relative path inside the worktree', () => {
    expect(checkWrite(root, 'src/index.ts')).toEqual({ ok: true });
  });
  it('allows an absolute path inside the worktree', () => {
    expect(checkWrite(root, join(root, 'a', 'b.ts'))).toEqual({ ok: true });
  });
  it('denies traversal out of the worktree', () => {
    const r = checkWrite(root, '../outside/secret.txt');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/outside worktree/);
  });
  it('denies an absolute path elsewhere', () => {
    expect(checkWrite(root, join(outside, 'x')).ok).toBe(false);
  });
  it.each([
    '.git/config',
    '.env',
    '.env.local',
    'apps/api/.env',
    '.claude/settings.json',
    '.mcp.json',
    'node_modules/x/index.js',
    '.husky/pre-commit',
  ])('denies protected path %s', (p) => {
    const r = checkWrite(root, p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/protected/);
  });
  it('allows files that merely contain "env" in their name', () => {
    expect(checkWrite(root, 'src/environment.ts')).toEqual({ ok: true });
    expect(checkWrite(root, 'src/config/env.ts')).toEqual({ ok: true });
  });
  it('denies an empty path', () => {
    expect(checkWrite(root, '').ok).toBe(false);
  });
});

describe('checkRead', () => {
  it('allows reads inside and in additional roots only', () => {
    expect(checkRead(root, 'package.json')).toEqual({ ok: true });
    expect(checkRead(root, join(outside, 'secret.txt')).ok).toBe(false);
    expect(checkRead(root, join(outside, 'secret.txt'), [outside])).toEqual({ ok: true });
  });
});

describe('isInside with symlinks', () => {
  it('follows a symlink that escapes the root', () => {
    const link = join(root, 'escape');
    try {
      symlinkSync(outside, link, 'junction');
    } catch {
      return; // no symlink privilege on this machine — skip
    }
    expect(isInside(root, join(link, 'secret.txt'))).toBe(false);
    expect(checkWrite(root, 'escape/secret.txt').ok).toBe(false);
  });
});

describe('checkWrite with a role write allowlist', () => {
  const qa = ['**/*.test.*', 'test/**', 'tests/**'];
  const ops = ['.github/**', 'Dockerfile*', 'infra/**', '*.config.*'];

  it('is unrestricted when the allowlist is empty', () => {
    expect(checkWrite(root, 'src/anything.ts', []).ok).toBe(true);
  });

  it.each(['src/a.test.ts', 'src/deep/b.test.tsx', 'test/x.ts', 'tests/nested/y.ts'])(
    'allows %s under the QA globs',
    (p) => expect(checkWrite(root, p, qa).ok).toBe(true),
  );

  it.each(['src/a.ts', 'README.md', 'testing/x.ts'])('denies %s under the QA globs', (p) =>
    expect(checkWrite(root, p, qa).ok).toBe(false),
  );

  it('names the offending path and the allowed globs when it denies', () => {
    const r = checkWrite(root, 'src/a.ts', qa);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('src/a.ts');
      expect(r.reason).toContain('**/*.test.*');
    }
  });

  it.each([
    '.github/workflows/ci.yml',
    'Dockerfile',
    'Dockerfile.dev',
    'infra/main.tf',
    'vite.config.ts',
  ])('allows %s under the DEVOPS globs', (p) => expect(checkWrite(root, p, ops).ok).toBe(true));

  it('normalizes Windows separators before matching', () => {
    expect(checkWrite(root, join(root, 'test', 'x.ts'), qa).ok).toBe(true);
    expect(checkWrite(root, join(root, '.github', 'workflows', 'ci.yml'), ops).ok).toBe(true);
  });

  it('still refuses a protected path that the globs would otherwise allow', () => {
    // `.github/**` must not become a way to write .git or an env file.
    expect(checkWrite(root, '.env', ['**']).ok).toBe(false);
    expect(checkWrite(root, '.git/config', ['**']).ok).toBe(false);
  });
});

describe('posix mode (a containerized agent judged from a Windows host)', () => {
  const work = '/work';

  it('allows writes inside the container worktree', () => {
    expect(checkWrite(work, '/work/src/x.ts', [], 'posix').ok).toBe(true);
    expect(checkWrite(work, 'src/x.ts', [], 'posix').ok).toBe(true);
  });

  it.each(['/etc/passwd', '/gitcommon/config', '/work/../etc/shadow', '/'])(
    'denies a write to %s',
    (p) => expect(checkWrite(work, p, [], 'posix').ok).toBe(false),
  );

  it('still protects .git and env files inside the mount', () => {
    expect(checkWrite(work, '/work/.git/config', [], 'posix').ok).toBe(false);
    expect(checkWrite(work, '/work/.env', [], 'posix').ok).toBe(false);
    expect(checkWrite(work, '/work/node_modules/x/index.js', [], 'posix').ok).toBe(false);
  });

  it('applies role write globs against container paths', () => {
    const qa = ['**/*.test.*', 'test/**'];
    expect(checkWrite(work, '/work/src/a.test.ts', qa, 'posix').ok).toBe(true);
    expect(checkWrite(work, '/work/src/a.ts', qa, 'posix').ok).toBe(false);
  });

  it('reads are confined the same way, with additional roots honoured', () => {
    expect(checkRead(work, '/work/README.md', [], 'posix').ok).toBe(true);
    expect(checkRead(work, '/etc/passwd', [], 'posix').ok).toBe(false);
    expect(checkRead(work, '/gitcommon/HEAD', ['/gitcommon'], 'posix').ok).toBe(true);
  });

  it('does not anchor container paths to the host drive', () => {
    // The bug this mode exists to prevent: on win32, resolve('/work/x') yields
    // `<cwd drive>:\work\x`, so containment would hold only by coincidence.
    expect(isInside('/work', '/work/src', 'posix')).toBe(true);
    expect(isInside('/work', '/workspace', 'posix')).toBe(false);
  });
});
