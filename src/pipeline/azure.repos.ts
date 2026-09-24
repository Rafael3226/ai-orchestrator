import { sharedAdoLimiter } from '../board/azure-devops/ado.source.js';
import { BoardError } from '../board/board.source.js';
import { basicAuth, RestClient } from '../board/http/rest.client.js';
import type { RepoHostConfig } from '../config/config.schema.js';

import type { PrHost, PrRequest } from './pr.host.js';

const API = '7.1';
/** Azure Repos rejects a PR description over 4000 characters. */
export const MAX_DESCRIPTION = 4000;
const TRUNCATED = '\n\n_…truncated — the full report is on the work item / card._';

type AzureRepos = Extract<RepoHostConfig, { provider: 'azure-devops' }>;

interface RawPr {
  readonly pullRequestId: number;
}

/** Azure Repos pull requests over REST. Push and fetch stay in git; see workspace/git.auth. */
export class AzureReposPrHost implements PrHost {
  readonly provider = 'azure-devops' as const;
  readonly repoName: string;
  private readonly http: RestClient;
  private readonly base: string;

  constructor(
    private readonly host: Pick<AzureRepos, 'organization' | 'project' | 'repository'>,
    cred: { ref: string; pat: string },
    private readonly warn: (m: string) => void = () => {},
    fetchImpl?: typeof fetch,
  ) {
    this.repoName = `${host.organization}/${host.project}/${host.repository}`;
    this.http = new RestClient({
      baseUrl: `https://dev.azure.com/${encodeURIComponent(host.organization)}`,
      ref: cred.ref,
      limiter: sharedAdoLimiter,
      headers: { Authorization: basicAuth('', cred.pat) },
      ...(fetchImpl ? { fetchImpl } : {}),
    });
    this.base =
      `/${encodeURIComponent(host.project)}/_apis/git/repositories/` +
      encodeURIComponent(host.repository);
  }

  prUrl(id: number): string {
    const { organization, project, repository } = this.host;
    return (
      `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(project)}` +
      `/_git/${encodeURIComponent(repository)}/pullrequest/${id}`
    );
  }

  /** `doctor`: the PAT can read the repository and the base branch exists on it. */
  async checkAccess(baseBranch: string): Promise<{ baseExists: boolean }> {
    await this.call(() => this.http.get(this.base, { query: { 'api-version': API } }));
    const refs = await this.call(() =>
      this.http.get<{ value: { name: string }[] }>(`${this.base}/refs`, {
        query: { filter: `heads/${baseBranch}`, 'api-version': API },
      }),
    );
    // `filter` is a prefix match: heads/main also finds heads/main-old.
    return { baseExists: refs.value.some((r) => r.name === `refs/heads/${baseBranch}`) };
  }

  async findExisting(_cwd: string, head: string): Promise<string | null> {
    const r = await this.call(() =>
      this.http.get<{ value: RawPr[] }>(`${this.base}/pullrequests`, {
        query: {
          'searchCriteria.sourceRefName': `refs/heads/${head}`,
          'searchCriteria.status': 'active',
          $top: 1,
          'api-version': API,
        },
      }),
    );
    const pr = r.value[0];
    return pr ? this.prUrl(pr.pullRequestId) : null;
  }

  async createDraft(req: PrRequest): Promise<string> {
    const existing = await this.findExisting(req.cwd, req.head);
    if (existing) return existing;

    const pr = await this.call(() =>
      this.http.post<RawPr>(`${this.base}/pullrequests`, {
        query: { 'api-version': API },
        body: {
          sourceRefName: `refs/heads/${req.head}`,
          targetRefName: `refs/heads/${req.base}`,
          title: req.title,
          description: clampDescription(req.body),
          isDraft: req.draft,
          ...(req.workItemIds?.length
            ? { workItemRefs: req.workItemIds.map((id) => ({ id })) }
            : {}),
        },
      }),
    );

    // Labels are freeform on Azure Repos, so a failure here is a permission
    // problem, not a missing label — say so and keep the PR.
    for (const name of req.labels) {
      try {
        await this.http.post(`${this.base}/pullRequests/${pr.pullRequestId}/labels`, {
          query: { 'api-version': API },
          body: { name },
        });
      } catch (e) {
        this.warn(`PR ${pr.pullRequestId}: could not add label "${name}": ${message(e)}`);
      }
    }
    return this.prUrl(pr.pullRequestId);
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      const hint =
        e instanceof BoardError && e.kind === 'auth'
          ? ' — the PAT needs Code (read & write) and must not be expired'
          : '';
      throw new Error(`Azure Repos ${this.repoName}: ${message(e)}${hint}`);
    }
  }
}

export function clampDescription(body: string): string {
  return body.length <= MAX_DESCRIPTION
    ? body
    : body.slice(0, MAX_DESCRIPTION - TRUNCATED.length) + TRUNCATED;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
