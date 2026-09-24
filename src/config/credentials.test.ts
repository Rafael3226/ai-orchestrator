import { describe, expect, it, vi } from 'vitest';

import { credentialOf, resolveBoardCredentials } from './credentials.js';

describe('resolveBoardCredentials', () => {
  it('resolves <REF>_API_KEY and <REF>_TOKEN per ref', () => {
    const refs = new Map([['TRELLO_MAIN', { kind: 'trello' as const, projects: ['p1'] }]]);
    const out = resolveBoardCredentials(refs, {
      TRELLO_MAIN_API_KEY: 'k',
      TRELLO_MAIN_TOKEN: 't',
    });
    expect(out.get('TRELLO_MAIN')).toEqual({
      kind: 'trello',
      ref: 'TRELLO_MAIN',
      apiKey: 'k',
      token: 't',
    });
  });

  it('fails naming the project that needs the missing credential', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const refs = new Map([['TRELLO_WORK', { kind: 'trello' as const, projects: ['acts-portal'] }]]);
    expect(() => resolveBoardCredentials(refs, {})).toThrow(/board credentials/);
    expect(spy.mock.calls.flat().join('\n')).toMatch(/acts-portal/);
  });

  it('resolves an Azure DevOps PAT and Jira email + API token', () => {
    const refs = new Map([
      ['ADO_MAIN', { kind: 'azure-devops' as const, projects: ['a'] }],
      ['JIRA_MAIN', { kind: 'jira' as const, projects: ['j'] }],
    ]);
    const out = resolveBoardCredentials(refs, {
      ADO_MAIN_PAT: 'pat',
      JIRA_MAIN_EMAIL: 'bot@example.com',
      JIRA_MAIN_API_TOKEN: 'tok',
    });
    expect(out.get('ADO_MAIN')).toEqual({ kind: 'azure-devops', ref: 'ADO_MAIN', pat: 'pat' });
    expect(out.get('JIRA_MAIN')).toEqual({
      kind: 'jira',
      ref: 'JIRA_MAIN',
      email: 'bot@example.com',
      apiToken: 'tok',
    });
  });

  it('asks each provider for its own variables', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const refs = new Map([['JIRA_X', { kind: 'jira' as const, projects: ['j'] }]]);
    expect(() => resolveBoardCredentials(refs, { JIRA_X_EMAIL: 'a@b.c' })).toThrow();
    expect(spy.mock.calls.flat().join('\n')).toMatch(/JIRA_X_API_TOKEN/);
  });
});

describe('credentialOf', () => {
  it('narrows to the provider that needs it and rejects a mismatch', () => {
    const ado = { kind: 'azure-devops' as const, ref: 'R', pat: 'p' };
    expect(credentialOf(ado, 'azure-devops', 'R').pat).toBe('p');
    expect(() => credentialOf(ado, 'jira', 'R')).toThrow(/azure-devops credential/);
    expect(() => credentialOf(undefined, 'jira', 'R')).toThrow(/unresolved/);
  });
});
