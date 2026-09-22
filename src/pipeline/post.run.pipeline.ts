import type { ProjectConfig } from '../config/config.loader.js';
import type { ExecResult } from '../exec/exec.driver.js';
import type { BlockedReport, Decision, ProposedSummary } from '../mcp/board.schemas.js';
import type { WorkspaceHandle } from '../workspace/worktree.manager.js';

import { type DiffStat, GitPublisher, PublishAbort } from './git.publisher.js';
import { PrPublisher } from './pr.publisher.js';
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
}

export interface PublishOutput {
  readonly diff: DiffStat;
  readonly sha: string;
  readonly prUrl: string;
  readonly hooksBypassed: boolean;
}

/**
 * verify (done by caller) → stage+scan → commit → push → draft PR.
 * Every step is idempotent so a crash mid-way can be resumed by re-running.
 */
export async function publish(input: PublishInput): Promise<PublishOutput> {
  const git = new GitPublisher();
  const { project, workspace, log } = input;
  const pr = new PrPublisher((m) => log(`⚠ ${m}`));

  log('stage + scan diff');
  const diff = await git.stageAndInspect(workspace.path, workspace.copiedIncludes);
  log(`diff: ${diff.files} files, +${diff.insertions} −${diff.deletions}`);

  const trailers = [
    input.cardUrl ? `Refs: ${input.cardUrl}` : `Refs: card ${input.cardShortId}`,
    'Co-Authored-By: Claude <noreply@anthropic.com>',
  ];
  const message = git.renderCommitMessage(
    input.wip
      ? { ...input.summary.commit, subject: `wip: ${input.summary.commit.subject}`.slice(0, 72) }
      : input.summary.commit,
    trailers,
  );
  log('commit');
  const { sha, hooksBypassed } = await git.commit(workspace.path, message);
  if (hooksBypassed) log('commit hooks failed — committed with --no-verify');

  log(`push ${project.repo.remote} ${workspace.branch}`);
  await git.push(workspace.path, project.repo.remote, workspace.branch);

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
    githubRepo: project.repo.githubRepo,
    base: project.repo.baseBranch,
    head: workspace.branch,
    title: `${input.wip ? '[WIP] ' : ''}[${input.cardShortId}] ${input.summary.title}`.slice(
      0,
      200,
    ),
    body: buildPrBody(report),
    draft: project.pr.draft,
    labels: input.wip ? [...project.pr.labels, 'ai-needs-human'] : project.pr.labels,
  });
  log(`PR: ${prUrl}`);
  return { diff, sha, prUrl, hooksBypassed };
}

export { PublishAbort };
export type { BlockedReport };
