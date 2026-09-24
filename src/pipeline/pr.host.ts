import type { ProjectConfig } from '../config/config.loader.js';
import type { RepoHostProvider } from '../config/config.schema.js';

import { AzureReposPrHost } from './azure.repos.js';
import { PrPublisher } from './pr.publisher.js';

export interface PrRequest {
  readonly cwd: string;
  readonly base: string;
  readonly head: string;
  readonly title: string;
  readonly body: string;
  readonly draft: boolean;
  readonly labels: readonly string[];
  /** Azure Repos links these work items to the PR when the board is in the same organization. */
  readonly workItemIds?: readonly string[];
}

/** Where pull requests are opened. Idempotent: an open PR for the branch is reused. */
export interface PrHost {
  readonly provider: RepoHostProvider;
  /** `owner/name` or `organization/project/repository`, for messages. */
  readonly repoName: string;
  findExisting(cwd: string, head: string): Promise<string | null>;
  createDraft(req: PrRequest): Promise<string>;
}

class GithubPrHost implements PrHost {
  readonly provider = 'github' as const;
  private readonly gh: PrPublisher;

  constructor(
    readonly repoName: string,
    warn: (m: string) => void,
  ) {
    this.gh = new PrPublisher(warn);
  }

  findExisting(cwd: string, head: string): Promise<string | null> {
    return this.gh.findExisting({ cwd, githubRepo: this.repoName, head });
  }

  createDraft(req: PrRequest): Promise<string> {
    const { workItemIds: _ignored, ...rest } = req;
    return this.gh.createDraft({ ...rest, githubRepo: this.repoName });
  }
}

export function createPrHost(
  project: Pick<ProjectConfig, 'repo'>,
  warn: (m: string) => void = () => {},
  env: Readonly<Record<string, string | undefined>> = process.env,
): PrHost {
  const host = project.repo.host;
  switch (host.provider) {
    case 'github':
      return new GithubPrHost(host.githubRepo, warn);
    case 'azure-devops': {
      const pat = env[`${host.credentials}_PAT`];
      if (!pat)
        throw new Error(
          `${host.credentials}_PAT is not set — Azure Repos needs it for pull requests`,
        );
      return new AzureReposPrHost(host, { ref: host.credentials, pat }, warn);
    }
  }
}

/**
 * The work items to link: only when the card is itself an Azure DevOps work
 * item in the organization that hosts the repository.
 */
export function linkedWorkItems(
  project: Pick<ProjectConfig, 'repo' | 'board'>,
  cardShortId: string,
): string[] {
  const { host } = project.repo;
  const { board } = project;
  return host.provider === 'azure-devops' &&
    board.provider === 'azure-devops' &&
    board.organization.toLowerCase() === host.organization.toLowerCase() &&
    /^\d+$/.test(cardShortId)
    ? [cardShortId]
    : [];
}
