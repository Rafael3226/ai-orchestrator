import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { checkBash, segments } from './bash.guard.js';

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
});
