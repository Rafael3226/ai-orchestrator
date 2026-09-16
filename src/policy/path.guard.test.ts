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
