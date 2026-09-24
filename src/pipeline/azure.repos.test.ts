import { describe, expect, it } from 'vitest';

import { stubFetch, type StubRoute } from '../testing/fetch.stub.js';
import { gitAuthEnv, pushAuthHint } from '../workspace/git.auth.js';

import { AzureReposPrHost, clampDescription, MAX_DESCRIPTION } from './azure.repos.js';
import { linkedWorkItems } from './pr.host.js';

const HOST = { organization: 'contoso', project: 'Web Shop', repository: 'shop' };
const REQ = {
  cwd: '/repo',
  base: 'main',
  head: 'ai/dev-be/42-thing',
  title: '[42] Thing',
  body: 'body',
  draft: true,
  labels: ['ai-generated'],
};

const host = (routes: StubRoute[]) => {
  const stub = stubFetch(routes);
  const warnings: string[] = [];
  return {
    ...stub,
    warnings,
    pr: new AzureReposPrHost(
      HOST,
      { ref: 'ADO_T', pat: 'pat' },
      (m) => warnings.push(m),
      stub.fetch,
    ),
  };
};

const PRS = '/Web%20Shop/_apis/git/repositories/shop/pullrequests';

describe('AzureReposPrHost', () => {
  it('opens a draft PR, links work items and adds labels', async () => {
    const { pr, calls } = host([
      { match: PRS, reply: { value: [] } },
      { method: 'POST', match: PRS, reply: { pullRequestId: 17 } },
      { method: 'POST', match: '/pullRequests/17/labels', reply: {} },
    ]);
    const url = await pr.createDraft({ ...REQ, workItemIds: ['42'] });
    expect(url).toBe('https://dev.azure.com/contoso/Web%20Shop/_git/shop/pullrequest/17');
    const lookup = calls[0]?.url ?? '';
    expect(decodeURIComponent(lookup)).toContain(
      'searchCriteria.sourceRefName=refs/heads/ai/dev-be/42-thing',
    );
    expect(lookup).toContain('searchCriteria.status=active');
    expect(calls[1]?.body).toEqual({
      sourceRefName: 'refs/heads/ai/dev-be/42-thing',
      targetRefName: 'refs/heads/main',
      title: '[42] Thing',
      description: 'body',
      isDraft: true,
      workItemRefs: [{ id: '42' }],
    });
    expect(calls[2]?.body).toEqual({ name: 'ai-generated' });
  });

  it('reuses an open PR for the branch', async () => {
    const { pr, calls } = host([{ match: PRS, reply: { value: [{ pullRequestId: 5 }] } }]);
    expect(await pr.createDraft(REQ)).toMatch(/pullrequest\/5$/);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('keeps the PR when a label cannot be added, and says so', async () => {
    const { pr, warnings } = host([
      { match: PRS, reply: { value: [] } },
      { method: 'POST', match: PRS, reply: { pullRequestId: 9 } },
      { method: 'POST', match: '/labels', reply: { status: 403, body: 'nope' } },
    ]);
    expect(await pr.createDraft(REQ)).toMatch(/pullrequest\/9$/);
    expect(warnings[0]).toMatch(/could not add label "ai-generated"/);
  });

  it('names the repository and the PAT scope on an auth failure', async () => {
    const { pr } = host([{ match: PRS, reply: { status: 401 } }]);
    await expect(pr.createDraft(REQ)).rejects.toThrow(
      /contoso\/Web Shop\/shop.*Code \(read & write\)/,
    );
  });

  it('checks the repository and an exact base branch', async () => {
    const { pr } = host([
      { match: '/refs', reply: { value: [{ name: 'refs/heads/main-old' }] } },
      { match: '/repositories/shop', reply: { id: 'r' } },
    ]);
    expect(await pr.checkAccess('main')).toEqual({ baseExists: false });
  });
});

describe('clampDescription', () => {
  it('fits Azure Repos’ limit and says it was cut', () => {
    const out = clampDescription('x'.repeat(10_000));
    expect(out.length).toBe(MAX_DESCRIPTION);
    expect(out).toMatch(/truncated/);
    expect(clampDescription('short')).toBe('short');
  });
});

describe('gitAuthEnv', () => {
  const ado = {
    repo: {
      host: {
        provider: 'azure-devops',
        organization: 'contoso',
        project: 'W',
        repository: 'r',
        credentials: 'ADO_T',
      },
    },
  } as never;
  const gh = { repo: { host: { provider: 'github', githubRepo: 'me/x' } } } as never;

  it('scopes a PAT header to Azure DevOps URLs through env config', () => {
    const env = gitAuthEnv(ado, { ADO_T_PAT: 'pat' });
    const header = `Authorization: Basic ${Buffer.from(':pat').toString('base64')}`;
    expect(env).toEqual({
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'http.https://dev.azure.com/.extraheader',
      GIT_CONFIG_VALUE_0: header,
      GIT_CONFIG_KEY_1: 'http.https://contoso.visualstudio.com/.extraheader',
      GIT_CONFIG_VALUE_1: header,
    });
  });

  it('adds nothing for GitHub, or without a PAT', () => {
    expect(gitAuthEnv(gh, { ADO_T_PAT: 'pat' })).toEqual({});
    expect(gitAuthEnv(ado, {})).toEqual({});
  });

  it('tells a human what to fix for each host', () => {
    expect(pushAuthHint(ado)).toMatch(/ADO_T_PAT/);
    expect(pushAuthHint(gh)).toMatch(/gh auth setup-git/);
  });
});

describe('linkedWorkItems', () => {
  const project = (boardOrg: string | null, repoOrg: string | null) =>
    ({
      board: boardOrg ? { provider: 'azure-devops', organization: boardOrg } : { provider: 'jira' },
      repo: {
        host: repoOrg
          ? { provider: 'azure-devops', organization: repoOrg }
          : { provider: 'github', githubRepo: 'a/b' },
      },
    }) as never;

  it('links only an ADO work item to a PR in the same organization', () => {
    expect(linkedWorkItems(project('Contoso', 'contoso'), '42')).toEqual(['42']);
    expect(linkedWorkItems(project('other', 'contoso'), '42')).toEqual([]);
    expect(linkedWorkItems(project(null, 'contoso'), 'SHOP-1')).toEqual([]);
    expect(linkedWorkItems(project('contoso', null), '42')).toEqual([]);
  });
});
