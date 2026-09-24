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
    expect(loaded.credentialRefs.get('TRELLO_MAIN')).toEqual({
      kind: 'trello',
      projects: ['ai-auto-apply'],
    });
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

  it('defaults board.webhook to off when the key is absent', () => {
    // `board` is a strictObject, so every pre-webhook config and fixture omits
    // this key entirely — it has to keep loading.
    const w = loadConfigFromString(minimal(), 'x.yaml').project('demo').board.webhook;
    expect(w).toMatchObject({
      enabled: false,
      manageRegistration: true,
      deleteOnShutdown: false,
      maxBufferedEvents: 500,
      maxEventAgeSeconds: 600,
    });
  });

  /** A project whose board block carries extra keys, built as real YAML. */
  const LOCATION: Record<string, string> = {
    trello: 'boardId: b1',
    jira: 'site: acme\n      projectKey: PROJ',
    'azure-devops': 'organization: contoso\n      project: Web',
  };
  const withBoard = (extra: string, provider = 'trello') =>
    `
version: 1
projects:
  - id: demo
    name: Demo
    repo: { path: /repo, worktreeRoot: /wt, githubRepo: me/demo }
    board:
      provider: ${provider}
      ${LOCATION[provider]}
      credentials: TRELLO_X
      botMemberId: m1
      columns: { ready: Ready, review: Review }
${extra}
    agents: { DEV-BE: { enabled: true } }
    routes:
      - when: { list: Ready }
        agent: DEV-BE
`;

  it('rejects webhooks on a provider that does not implement them', () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((m: unknown) => void errors.push(String(m)));
    expect(() =>
      loadConfigFromString(withBoard('      webhook: { enabled: true }', 'jira'), 'x.yaml'),
    ).toThrow(/Invalid config/);
    expect(errors.join(' ')).toMatch(/only implemented for trello/);
  });

  it('warns, without failing, when webhooks are on and polling is still aggressive', () => {
    const loaded = loadConfigFromString(
      withBoard(`      poll: { intervalSeconds: 15 }
      webhook: { enabled: true }`),
      'x.yaml',
    );
    expect(loaded.diagnostics.map((d) => d.code)).toContain('webhook-redundant-polling');
    expect(loaded.project('demo').board.webhook.enabled).toBe(true);
  });

  it('does not warn about polling at the recommended webhook profile', () => {
    const loaded = loadConfigFromString(
      withBoard(`      poll: { intervalSeconds: 120, reconcileEveryTicks: 5 }
      webhook: { enabled: true }`),
      'x.yaml',
    );
    expect(loaded.diagnostics.map((d) => d.code)).not.toContain('webhook-redundant-polling');
  });

  it('defaults exec to the local driver', () => {
    const p = loadConfigFromString(minimal(), 'x.yaml').project('demo');
    expect(p.agents['DEV-BE'].exec.driver).toBe('local');
    expect(p.agents['DEV-BE'].exec.docker.image).toBe('ai-orchestrator/agent:latest');
  });

  it('merges exec across defaults, project and role, narrowest last', () => {
    const yaml = `
version: 1
defaults:
  exec:
    driver: local
    docker: { image: base:1, memoryMb: 2048, cpus: 1 }
projects:
  - id: demo
    name: Demo
    repo: { path: /repo, worktreeRoot: /wt, githubRepo: me/demo }
    board: { provider: trello, boardId: b1, credentials: TRELLO_X, columns: { ready: Ready } }
    exec:
      driver: docker
      docker: { memoryMb: 8192 }
    agents:
      DEV-BE: { enabled: true }
      DEV-FE: { enabled: true, docker: { image: fe:2 } }
    routes: [{ when: { list: Ready }, agent: DEV-BE }]
`;
    const p = loadConfigFromString(yaml, 'x.yaml').project('demo');

    // Project overrides the default driver...
    expect(p.agents['DEV-BE'].exec.driver).toBe('docker');
    // ...project memory wins over the default...
    expect(p.agents['DEV-BE'].exec.docker.memoryMb).toBe(8192);
    // ...the default image survives where nothing overrode it...
    expect(p.agents['DEV-BE'].exec.docker.image).toBe('base:1');
    // ...and the role's image is narrower still, without erasing its siblings.
    expect(p.agents['DEV-FE'].exec.docker).toMatchObject({
      image: 'fe:2',
      memoryMb: 8192,
      cpus: 1,
    });
  });

  it('rejects an unknown key inside the docker block', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = minimal(`    exec: { driver: docker, docker: { memoryMB: 4096 } }`);
    expect(() => loadConfigFromString(bad, 'x.yaml')).toThrow(/Invalid config/);
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

  describe('providers', () => {
    const project = (board: string, repo = 'githubRepo: me/demo', extra = '') => `
version: 1
projects:
  - id: demo
    name: Demo
    repo: { path: /repo, worktreeRoot: /wt, ${repo} }
    board:
${board}
      botMemberId: m1
      columns: { ready: Ready, review: In Review }
    agents: { DEV-BE: { enabled: true } }
    routes:
      - when: { column: Ready }
        agent: DEV-BE
${extra}
`;
    const ado = `      provider: azure-devops
      organization: contoso
      project: Web Shop
      credentials: ADO_MAIN`;
    const jira = `      provider: jira
      site: Acme
      projectKey: SHOP
      credentials: JIRA_MAIN`;

    it('loads an Azure DevOps board with its defaults and derives a board key', () => {
      const p = loadConfigFromString(project(ado), 'x.yaml').project('demo');
      expect(p.board.provider).toBe('azure-devops');
      if (p.board.provider !== 'azure-devops') return;
      expect(p.board.workItemTypes).toEqual(['User Story', 'Bug', 'Task']);
      expect(p.board.boardId).toBe('contoso/Web Shop');
    });

    it('loads a Jira board and normalizes the site', () => {
      const p = loadConfigFromString(project(jira), 'x.yaml').project('demo');
      if (p.board.provider !== 'jira') throw new Error('expected jira');
      expect(p.board.site).toBe('acme.atlassian.net');
      expect(p.board.boardId).toBe('acme.atlassian.net/SHOP');
    });

    it('rejects provider fields on the wrong provider', () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const bad = project(`${jira}
      organization: contoso`);
      expect(() => loadConfigFromString(bad, 'x.yaml')).toThrow(/Invalid config/);
    });

    it('turns the githubRepo shorthand into a github host', () => {
      const p = loadConfigFromString(project(ado), 'x.yaml').project('demo');
      expect(p.repo.host).toEqual({ provider: 'github', githubRepo: 'me/demo' });
    });

    it('accepts an Azure Repos host and counts its credential ref', () => {
      const loaded = loadConfigFromString(
        project(
          ado,
          'host: { provider: azure-devops, organization: contoso, project: Web Shop, repository: shop, credentials: ADO_MAIN }',
        ),
        'x.yaml',
      );
      expect(loaded.project('demo').repo.host.provider).toBe('azure-devops');
      // One PAT for the board and the repo: one ref, one project.
      expect(loaded.credentialRefs.get('ADO_MAIN')).toEqual({
        kind: 'azure-devops',
        projects: ['demo'],
      });
    });

    it('rejects a repo with neither host nor githubRepo, or both', () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(() => loadConfigFromString(project(ado, 'branchTemplate: x'), 'x.yaml')).toThrow(
        /Invalid config/,
      );
      expect(() =>
        loadConfigFromString(
          project(ado, 'githubRepo: me/demo, host: { provider: github, githubRepo: me/demo }'),
          'x.yaml',
        ),
      ).toThrow(/Invalid config/);
    });

    it('rejects one credential ref used by two providers', () => {
      const errors: string[] = [];
      vi.spyOn(console, 'error').mockImplementation((m: unknown) => void errors.push(String(m)));
      const bad = project(
        jira.replace('JIRA_MAIN', 'SHARED'),
        'host: { provider: azure-devops, organization: contoso, project: Web, repository: shop, credentials: SHARED }',
      );
      expect(() => loadConfigFromString(bad, 'x.yaml')).toThrow(/Invalid config/);
      expect(errors.join(' ')).toMatch(/already a jira credential/);
    });

    it('rejects label names the provider cannot store', () => {
      const errors: string[] = [];
      vi.spyOn(console, 'error').mockImplementation((m: unknown) => void errors.push(String(m)));
      const bad = project(
        jira,
        undefined,
        '    writeback:\n      onFailure: { addLabel: needs human }',
      );
      expect(() => loadConfigFromString(bad, 'x.yaml')).toThrow(/Invalid config/);
      expect(errors.join(' ')).toMatch(/Jira labels cannot contain spaces/);
    });
  });
});
