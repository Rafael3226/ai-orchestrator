import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { loadConfigFromString } from './config.loader.js';

const example = readFileSync(resolve('orchestrator.example.yaml'), 'utf8');

const minimal = (overrides = '') => `
version: 1
projects:
  - id: demo
    name: Demo
    repo: { path: /repo, worktreeRoot: /wt, githubRepo: me/demo }
    board:
      provider: trello
      boardId: b1
      credentials: TRELLO_X
      botMemberId: m1
      columns: { ready: Ready, review: Review }
    agents: { DEV-BE: { enabled: true } }
    routes:
      - when: { list: Ready }
        agent: DEV-BE
${overrides}
`;

describe('loadConfigFromString', () => {
  it('loads the shipped example and resolves agent defaults', () => {
    const loaded = loadConfigFromString(example, 'orchestrator.example.yaml');
    const p = loaded.project('ai-auto-apply');
    expect(p.agents['DEV-BE'].enabled).toBe(true);
    expect(p.agents['DEV-BE'].model).toBe('opus');
    expect(p.agents['DEV-BE'].budget.maxUsd).toBe(6);
    expect(p.agents.QA.enabled).toBe(false);
    expect(p.agents.PM.model).toBe('haiku');
    expect(loaded.credentialRefs.get('TRELLO_MAIN')).toEqual(['ai-auto-apply']);
    expect(Object.isFrozen(loaded.config.projects)).toBe(true);
  });

  it('folds the `list` alias into `column` and assigns route ids', () => {
    const loaded = loadConfigFromString(minimal(), 'x.yaml');
    const [r] = loaded.project('demo').routes;
    expect(r?.when.column).toBe('Ready');
    expect(r?.id).toBe('demo/route-0');
  });

  it('rejects a typo’d key instead of silently ignoring it', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = minimal().replace('routes:', 'route:');
    expect(() => loadConfigFromString(bad, 'x.yaml')).toThrow(/Invalid config/);
  });

  it('rejects a writeback move to an undeclared column alias', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = minimal(`    writeback:
      onSuccess: { move: shipped }`);
    expect(() => loadConfigFromString(bad, 'x.yaml')).toThrow(/Invalid config/);
  });

  it('rejects card moves without a botMemberId (loop guard)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = minimal(`    writeback:
      onSuccess: { move: review }`).replace('      botMemberId: m1\n', '');
    expect(() => loadConfigFromString(bad, 'x.yaml')).toThrow(/Invalid config/);
  });

  it('rejects two projects on one board', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const dup = minimal().replace(
      'projects:',
      `projects:
  - id: other
    name: Other
    repo: { path: /r, worktreeRoot: /w, githubRepo: me/o }
    board: { provider: trello, boardId: b1, credentials: TRELLO_X }
    routes: [{ when: { list: A }, agent: QA }]`,
    );
    expect(() => loadConfigFromString(dup, 'x.yaml')).toThrow(/Invalid config/);
  });

  it('warns when a route targets a disabled agent', () => {
    const loaded = loadConfigFromString(
      minimal(`      - when: { list: Review }
        agent: QA`),
      'x.yaml',
    );
    expect(loaded.diagnostics.map((d) => d.code)).toContain('route-to-disabled-agent');
  });

  it('warns when an unconditional route shadows a later one on the same column', () => {
    const loaded = loadConfigFromString(
      minimal(`      - when: { list: Ready, label: be }
        agent: DEV-BE`),
      'x.yaml',
    );
    expect(loaded.diagnostics.map((d) => d.code)).toContain('route-shadowed');
  });

  it('applies priority as a stable reorder over file order', () => {
    const loaded = loadConfigFromString(
      minimal(`      - when: { list: Ready, label: be }
        agent: DEV-BE
        priority: 10`),
      'x.yaml',
    );
    expect(loaded.project('demo').routes.map((r) => r.index)).toEqual([1, 0]);
  });
});
