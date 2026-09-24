import { describe, expect, it } from 'vitest';

import { ROLES } from '../config/config.schema.js';

import { ROLE_DELIVERY } from './delivery.policy.js';
import { checkWrite } from './path.guard.js';

describe('ROLE_DELIVERY', () => {
  it('covers every role', () => {
    expect(Object.keys(ROLE_DELIVERY).sort()).toEqual([...ROLES].sort());
  });

  it('gives DEV-FE exactly the same contract as DEV-BE', () => {
    // The claim behind Slice A: a second code-producing role costs a charter
    // and a route, not pipeline code. If these ever diverge, say so on purpose.
    expect(ROLE_DELIVERY['DEV-FE']).toEqual(ROLE_DELIVERY['DEV-BE']);
  });

  it('makes PM board-only: no git, no install, no verify, no commit', () => {
    expect(ROLE_DELIVERY.PM).toMatchObject({
      kind: 'board-only',
      diff: 'forbidden',
      verifyWith: null,
      install: false,
      requireCommit: false,
    });
  });

  it('lets QA finish clean with an empty diff', () => {
    // The single field that stops "found nothing to fix" being a failure.
    expect(ROLE_DELIVERY.QA.diff).toBe('optional');
    expect(ROLE_DELIVERY.QA.kind).toBe('pull-request');
  });

  it('requires a diff from every role that opens a pull request except QA', () => {
    for (const role of ROLES) {
      const d = ROLE_DELIVERY[role];
      if (d.kind !== 'pull-request' || role === 'QA') continue;
      expect(d.diff, role).toBe('required');
    }
  });

  it('confines only the roles that should be confined', () => {
    expect(ROLE_DELIVERY['DEV-BE'].writeGlobs).toEqual([]);
    expect(ROLE_DELIVERY['DEV-FE'].writeGlobs).toEqual([]);
    expect(ROLE_DELIVERY.QA.writeGlobs.length).toBeGreaterThan(0);
    expect(ROLE_DELIVERY.DEVOPS.writeGlobs.length).toBeGreaterThan(0);
  });

  it('never gives write globs to a role that must not write at all', () => {
    expect(ROLE_DELIVERY.PM.writeGlobs).toEqual([]);
    expect(ROLE_DELIVERY.PM.diff).toBe('forbidden');
  });
});

describe('the declared globs against the real guard', () => {
  const root = process.platform === 'win32' ? 'D:\\wt' : '/wt';
  const can = (role: 'QA' | 'DEVOPS', file: string): boolean =>
    checkWrite(root, file, ROLE_DELIVERY[role].writeGlobs).ok;

  it.each(['src/slugify.test.ts', 'tests/e2e/login.spec.ts', 'test/helpers.ts', 'e2e/smoke.ts'])(
    'lets QA write %s',
    (file) => expect(can('QA', file)).toBe(true),
  );

  it.each(['src/slugify.ts', 'package.json', '.github/workflows/ci.yml'])(
    'stops QA writing %s',
    (file) => expect(can('QA', file)).toBe(false),
  );

  it.each(['.github/workflows/ci.yml', 'Dockerfile', 'infra/main.tf', 'scripts/deploy.sh'])(
    'lets DEVOPS write %s',
    (file) => expect(can('DEVOPS', file)).toBe(true),
  );

  it.each(['src/server.ts', 'src/api/users.test.ts'])('stops DEVOPS writing %s', (file) =>
    expect(can('DEVOPS', file)).toBe(false),
  );
});
