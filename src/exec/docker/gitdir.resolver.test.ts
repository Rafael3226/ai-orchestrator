import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { resolveGitDir } from './gitdir.resolver.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let base: string;
let repo: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'gitdir-'));
  repo = join(base, 'repo');
  mkdirSync(repo);
  git(base, 'init', '-b', 'main', repo);
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'README.md'), '# demo\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
});

describe('resolveGitDir against a real git worktree', () => {
  it('maps the gitdir link to a container path under /gitcommon', () => {
    const wt = join(base, 'wt-1');
    git(repo, 'worktree', 'add', '-q', '-b', 'feature', wt);

    const m = resolveGitDir(wt, repo);

    expect(m).not.toBeNull();
    expect(m?.gitCommonHostDir).toBe(join(repo, '.git'));
    expect(m?.containerGitDir).toBe(`/gitcommon/worktrees/${m?.worktreeName ?? ''}`);
    // The mapping must name the directory git actually created.
    expect(readFileSync(join(wt, '.git'), 'utf8')).toContain(m!.worktreeName);
  });

  it('uses the worktree NAME, which can differ from the folder name', () => {
    // git dedupes: a second worktree whose basename collides gets a suffix.
    const a = join(base, 'a', 'shared');
    const b = join(base, 'b', 'shared');
    mkdirSync(join(base, 'a'));
    mkdirSync(join(base, 'b'));
    git(repo, 'worktree', 'add', '-q', '-b', 'f1', a);
    git(repo, 'worktree', 'add', '-q', '-b', 'f2', b);

    const ma = resolveGitDir(a, repo);
    const mb = resolveGitDir(b, repo);

    expect(ma?.worktreeName).not.toBe(mb?.worktreeName);
    for (const m of [ma, mb]) {
      expect(readFileSync(join(m === ma ? a : b, '.git'), 'utf8')).toContain(m!.worktreeName);
    }
  });

  it('returns null for a plain clone, whose .git is already a directory', () => {
    expect(resolveGitDir(repo, repo)).toBeNull();
  });

  it('returns null when there is no .git at all', () => {
    const empty = join(base, 'empty');
    mkdirSync(empty);
    expect(resolveGitDir(empty, repo)).toBeNull();
  });

  it('tolerates a gitdir line with trailing whitespace or a trailing slash', () => {
    const wt = join(base, 'wt-ws');
    mkdirSync(wt);
    writeFileSync(join(wt, '.git'), 'gitdir: /somewhere/.git/worktrees/odd-name/  \n');

    expect(resolveGitDir(wt, repo)?.containerGitDir).toBe('/gitcommon/worktrees/odd-name');
  });

  it('returns null for a .git file that is not a gitdir link', () => {
    const wt = join(base, 'wt-bad');
    mkdirSync(wt);
    writeFileSync(join(wt, '.git'), 'this is not a gitdir link\n');

    expect(resolveGitDir(wt, repo)).toBeNull();
  });

  it('honours a custom container mount point', () => {
    const wt = join(base, 'wt-2');
    git(repo, 'worktree', 'add', '-q', '-b', 'other', wt);

    expect(resolveGitDir(wt, repo, '/gc')?.containerGitDir).toMatch(/^\/gc\/worktrees\//);
  });
});
