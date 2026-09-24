import type { ProjectConfig } from '../config/config.loader.js';
import type { ExecResult } from '../exec/exec.driver.js';
import type { BlockedReport, Decision, ProposedSummary } from '../mcp/board.schemas.js';
import type { DeliveryPolicy } from '../policy/delivery.policy.js';
import { gitAuthEnv, pushAuthHint } from '../workspace/git.auth.js';
import type { WorkspaceHandle } from '../workspace/worktree.manager.js';

import { type DiffStat, GitPublisher, PublishAbort } from './git.publisher.js';
import { createPrHost, linkedWorkItems, type PrHost } from './pr.host.js';
import { buildPrBody, type ReportInput } from './report.builder.js';
import type { VerifyResult } from './verify.runner.js';

export interface PublishInput {
  readonly project: ProjectConfig;
  readonly workspace: WorkspaceHandle;
  readonly runId: string;
  readonly cardShortId: string;
  readonly cardUrl: string;
  readonly role: string;
  readonly attempt: number;
  readonly summary: ProposedSummary;
  readonly decisions: readonly Decision[];
  readonly verify: readonly VerifyResult[];
  readonly exec: ExecResult;
  readonly denials: readonly { toolName: string; reason: string }[];
  readonly log: (msg: string) => void;
  /** Push and open a PR even though verification failed (WIP for a human). */
  readonly wip?: boolean;
  /** The acting role's contract; `diff: 'optional'` is what allows an empty diff. */
  readonly delivery: DeliveryPolicy;
}

/**
 * Both members carry every field, so the caller can keep destructuring without
 * narrowing first; `kind` is there for the callers that do care.
 */
export type PublishOutput =
  | {
      readonly kind: 'pull-request';
      readonly diff: DiffStat;
      readonly sha: string;
      readonly prUrl: string;
      readonly hooksBypassed: boolean;
    }
  | {
      readonly kind: 'board-only';
      readonly diff: null;
      readonly sha: null;
      readonly prUrl: null;
      readonly hooksBypassed: false;
    };

/** Seams for tests: publishing otherwise needs a real remote and a real PR host. */
export interface PublishDeps {
  readonly git?: GitPublisher;
  readonly pr?: PrHost;
}

/**
 * verify (done by caller) → stage+scan → commit → push → draft PR.
 * Every step is idempotent so a crash mid-way can be resumed by re-running.
 */
export async function publish(input: PublishInput, deps: PublishDeps = {}): Promise<PublishOutput> {
  const { project, workspace, log } = input;
  const git = deps.git ?? new GitPublisher();
  const pr = deps.pr ?? createPrHost(project, (m) => log(`⚠ ${m}`));
  const allowEmpty = input.delivery.diff === 'optional';

  log('stage + scan diff');
  const diff = await git.stageAndInspect(workspace.path, workspace.copiedIncludes, { allowEmpty });
  log(`diff: ${diff.files} files, +${diff.insertions} −${diff.deletions}`);

  if (diff.files === 0) {
    // Only reachable when allowEmpty let it through: the role reviewed rather
    // than changed anything. Nothing is committed, nothing is pushed, and the
    // report goes to the board instead of a PR.
    log('no changes — finishing without a commit');
    return { kind: 'board-only', diff: null, sha: null, prUrl: null, hooksBypassed: false };
  }

  if (!input.summary.commit) {
    throw new PublishAbort('nothing-to-commit', 'a diff was produced but no commit was proposed');
  }
  const commit = input.summary.commit;

  const trailers = [
    input.cardUrl ? `Refs: ${input.cardUrl}` : `Refs: card ${input.cardShortId}`,
    'Co-Authored-By: Claude <noreply@anthropic.com>',
  ];
  const message = git.renderCommitMessage(
    input.wip ? { ...commit, subject: `wip: ${commit.subject}`.slice(0, 72) } : commit,
    trailers,
  );
  log('commit');
  const { sha, hooksBypassed } = await git.commit(workspace.path, message);
  if (hooksBypassed) log('commit hooks failed — committed with --no-verify');

  log(`push ${project.repo.remote} ${workspace.branch}`);
  await git.push(workspace.path, project.repo.remote, workspace.branch, {
    env: gitAuthEnv(project),
    authHint: pushAuthHint(project),
  });

  const report: ReportInput = {
    runId: input.runId,
    cardShortId: input.cardShortId,
    cardUrl: input.cardUrl,
    role: input.role,
    attempt: input.attempt,
    branch: workspace.branch,
    summary: input.summary,
    blocked: null,
    decisions: input.decisions,
    verify: input.verify,
    diff,
    exec: input.exec,
    prUrl: null,
    hooksBypassed,
    denials: input.denials,
    verdict: input.wip ? 'needs_human' : 'review',
    verdictReason: input.wip ? 'verification failed twice; pushed as WIP' : '',
  };

  log('open draft PR');
  const prUrl = await pr.createDraft({
    cwd: workspace.path,
    base: project.repo.baseBranch,
    head: workspace.branch,
    title: `${input.wip ? '[WIP] ' : ''}[${input.cardShortId}] ${input.summary.title}`.slice(
      0,
      200,
    ),
    body: buildPrBody(report),
    draft: project.pr.draft,
    labels: input.wip ? [...project.pr.labels, 'ai-needs-human'] : project.pr.labels,
    workItemIds: linkedWorkItems(project, input.cardShortId),
  });
  log(`PR: ${prUrl}`);
  return { kind: 'pull-request', diff, sha, prUrl, hooksBypassed };
}

export { PublishAbort };
export type { BlockedReport };
