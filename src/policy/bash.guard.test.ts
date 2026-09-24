import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { checkBash, fromMsysPath, segments } from './bash.guard.js';

const root = mkdtempSync(join(tmpdir(), 'guard-'));

const allowed = [
  'pnpm install --frozen-lockfile',
  'pnpm turbo run test',
  'pnpm --filter @app/api test',
  'npx tsc --noEmit',
  'node scripts/build.js',
  'git status',
  'git diff --stat',
  'git log --oneline -5',
  'git add -A',
  'git stash list',
  'ls -la src',
  'cat package.json | head -20',
  'grep -rn "TODO" src && echo found',
  'rg foo src',
  'mkdir -p src/new && touch src/new/index.ts',
  'rm -rf dist',
  'cd src && ls',
  'CI=1 pnpm test',
  'sed -n 1,20p README.md',
  // Quoted separators are data, not pipes.
  'grep -E "health|Test Files|Tests" out.log',
  "grep -E 'FAIL |ERROR|not passed' full.log | head -20",
  'pnpm test > full.log 2>&1; echo exit=$?',
  'grep -n "a;b" x.ts',
];

const denied: [string, RegExp][] = [
  ['git push origin main', /push/],
  ['git commit -m "x"', /commits/],
  ['git checkout main', /commits/],
  ['git remote -v', /network git/],
  ['git fetch', /network git/],
  ['gh pr create', /GitHub CLI/],
  ['curl https://example.com', /network/],
  ['node -e "fetch(\'https://x\')"', /inline code/],
  ['npm publish', /registry/],
  ['npx -y some-package', /npx -y/],
  ['rm -rf /', /recursive delete/],
  ['rm -rf ~', /recursive delete/],
  ['rm -rf ..', /recursive delete/],
  ['rm -rf C:\\', /recursive delete/],
  ['echo $(whoami)', /substitution/],
  ['echo `id`', /substitution/],
  ['eval "ls"', /eval/],
  ['python -c "print(1)"', /not allowed: python/],
  ['docker ps', /infrastructure/],
  ['cd .. && ls', /cd outside/],
  ['ls; curl x', /network/],
  ['ls | ssh host', /network/],
  ['sudo ls', /privileged/],
];

describe('checkBash', () => {
  it.each(allowed)('allows: %s', (cmd) => {
    expect(checkBash(root, cmd)).toEqual({ ok: true });
  });

  it.each(denied)('denies: %s', (cmd, why) => {
    const r = checkBash(root, cmd);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(why);
  });

  it('checks every segment of a pipeline', () => {
    expect(checkBash(root, 'ls && wget x').ok).toBe(false);
    expect(checkBash(root, 'ls || python x').ok).toBe(false);
  });

  it('splits segments on ; && || | and newlines', () => {
    expect(segments('a; b && c || d | e\nf')).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('does not split inside quotes', () => {
    expect(segments('grep -E "a|b;c && d" f | wc -l')).toEqual(['grep -E "a|b;c && d" f', 'wc -l']);
    expect(segments("echo 'x || y' && ls")).toEqual(["echo 'x || y'", 'ls']);
    expect(segments('echo "esc \\" | still quoted" | cat')).toEqual([
      'echo "esc \\" | still quoted"',
      'cat',
    ]);
  });

  it('still catches a denied head hidden after a quoted string', () => {
    expect(checkBash(root, 'echo "a|b" | curl x').ok).toBe(false);
    expect(checkBash(root, 'echo "a|b"; python x').ok).toBe(false);
  });

  it('treats 2>&1 and a lone & as part of the segment', () => {
    expect(segments('pnpm test > f.log 2>&1 && ls')).toEqual(['pnpm test > f.log 2>&1', 'ls']);
  });

  it('converts Git Bash drive paths', () => {
    expect(fromMsysPath('/d/aow/x/2-abc')).toBe('D:\\aow\\x\\2-abc');
    expect(fromMsysPath('/c')).toBe('C:\\');
    expect(fromMsysPath('/dev/null')).toBe('/dev/null');
    expect(fromMsysPath('src/x')).toBe('src/x');
  });

  it.runIf(process.platform === 'win32')('allows cd into the worktree via an MSYS path', () => {
    const msys = '/' + root[0]!.toLowerCase() + root.slice(2).replace(/\\/g, '/');
    expect(checkBash(root, `cd ${msys} && ls`)).toEqual({ ok: true });
    expect(checkBash(root, `cd ${msys}/sub && ls`)).toEqual({ ok: true });
    expect(checkBash(root, 'cd /c/Windows && ls').ok).toBe(false);
  });
});

describe('checkBash in posix mode', () => {
  const work = '/work';

  it('allows a cd deeper into the container worktree', () => {
    expect(checkBash(work, 'cd /work/packages/api && pnpm test', 'posix').ok).toBe(true);
    expect(checkBash(work, 'cd packages/api', 'posix').ok).toBe(true);
  });

  it.each(['cd /', 'cd /etc', 'cd /gitcommon'])('denies %s', (cmd) =>
    expect(checkBash(work, cmd, 'posix').ok).toBe(false),
  );

  it('does not apply the MSYS drive-letter rewrite to container paths', () => {
    // The rewrite only fires on a single-letter first segment, so `/work` was
    // never at risk — but a mount like `/w/src` would be turned into `W:\src`
    // and then judged to be outside the root. In posix mode it is left alone.
    expect(fromMsysPath('/w/src')).toBe('W:\\src');
    expect(checkBash('/w', 'cd /w/src', 'posix').ok).toBe(true);
    expect(checkBash('/w', 'cd /x/src', 'posix').ok).toBe(false);
  });

  it('keeps every other rule unchanged', () => {
    expect(checkBash(work, 'git push origin main', 'posix').ok).toBe(false);
    expect(checkBash(work, 'curl https://example.com', 'posix').ok).toBe(false);
    expect(checkBash(work, 'git status', 'posix').ok).toBe(true);
  });
});
