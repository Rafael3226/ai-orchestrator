import { describe, expect, it } from 'vitest';

import { loadConfigFromString } from '../config/config.loader.js';
import { ROLES } from '../config/config.schema.js';

import { buildSystemAppend } from './system.append.js';

const yaml = `
version: 1
projects:
  - id: demo
    name: Demo
    repo: { path: /repo, worktreeRoot: /wt, githubRepo: me/demo }
    checks:
      install: pnpm install
      test: pnpm test
      infra: pnpm run ci:validate
    board: { provider: trello, boardId: b1, credentials: TRELLO_X, columns: { ready: Ready } }
    agents: { DEV: { enabled: true } }
    routes: [{ when: { list: Ready }, agent: DEV }]
`;

const project = loadConfigFromString(yaml, 'x').project('demo');
const append = (role: (typeof ROLES)[number]) => buildSystemAppend(project, role);

describe('buildSystemAppend', () => {
  it('is byte-identical across calls, so the prompt cache hits', () => {
    // Delivery is a pure function of the role, which is what keeps this true.
    for (const role of ROLES) expect(append(role)).toBe(append(role));
  });

  it('tells a board-only role that the summary is the deliverable', () => {
    const pm = append('PM');
    expect(pm).toContain('no commit, no branch and no pull request');
    expect(pm).toContain('posted to the work item verbatim');
    expect(pm).toContain('Do not create, edit or delete files');
  });

  it('never asks a board-only role to verify or commit', () => {
    const pm = append('PM');
    expect(pm).not.toContain('Run the verification command');
    expect(pm).not.toContain('Verification command');
    expect(pm).not.toContain('commitlint');
    expect(pm).not.toContain('Dependencies are installed');
    expect(pm).not.toContain('The existing test suite passes');
  });

  it('tells QA that an empty diff is a success', () => {
    const qa = append('QA');
    expect(qa).toContain('An empty diff is a valid, successful');
    expect(qa).toContain('findings');
  });

  it('lists the literal write globs for a confined role', () => {
    const devops = append('DEVOPS');
    expect(devops).toContain('You may write ONLY these paths');
    expect(devops).toContain('.github/**');
    expect(append('QA')).toContain('**/*.test.*');
  });

  it('leaves DEV without a write allowlist', () => {
    expect(append('DEV')).not.toContain('You may write ONLY these paths');
  });

  it('keeps the DEV contract: commit message, verify, no push', () => {
    const be = append('DEV');
    expect(be).toContain('You MUST NOT commit, push, or open a pull request');
    expect(be).toContain('pnpm test');
    expect(be).toContain('commitlint');
  });

  it('gives DEVOPS its own verification command when the project declares one', () => {
    expect(append('DEVOPS')).toContain('pnpm run ci:validate');
    expect(append('DEV')).toContain('pnpm test');
  });

  it('numbers the board protocol contiguously whether or not there is a verify step', () => {
    for (const role of ROLES) {
      const steps = [...append(role).matchAll(/^(\d)\. /gm)].map((m) => Number(m[1]));
      expect(steps, role).toEqual(steps.map((_, i) => i + 1));
    }
  });

  it('opens every role with its own charter', () => {
    for (const role of ROLES) expect(append(role).startsWith(`You are ${role}`)).toBe(true);
  });
});
