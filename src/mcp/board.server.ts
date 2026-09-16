import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  tool,
} from '@anthropic-ai/claude-agent-sdk';

import {
  type BlockedReport,
  type Decision,
  type ProgressReport,
  type ProposedSummary,
  proposeSummaryShape,
  recordDecisionShape,
  reportBlockedShape,
  reportProgressShape,
} from './board.schemas.js';

export interface TaskView {
  readonly projectId: string;
  readonly role: string;
  readonly cardShortId: string;
  readonly cardUrl: string;
  readonly title: string;
  readonly spec: string;
  readonly labels: readonly string[];
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly branch: string;
}

/** What the tools need from the orchestrator. Everything is local — the agent never touches Trello. */
export interface BoardToolContext {
  loadTask(): TaskView;
  emitProgress(p: ProgressReport): void;
  markBlocked(b: BlockedReport): void;
  addDecision(d: Decision): void;
  /** Returns validation errors (e.g. from the target repo's commitlint); empty means accepted. */
  storeSummary(s: ProposedSummary): Promise<readonly string[]>;
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

export const BOARD_SERVER_KEY = 'board';

export function createBoardMcpServer(ctx: BoardToolContext): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: BOARD_SERVER_KEY,
    version: '1.0.0',
    instructions: [
      'Authoritative source for the work item you are implementing.',
      'Call get_task first. Call report_progress at each phase change.',
      'Call propose_summary EXACTLY ONCE when the work is complete and verified — the orchestrator',
      'uses its `commit` field verbatim as the commit message and `summary`/`testPlan` as the PR body.',
      'If you cannot proceed, call report_blocked instead of guessing; no commit will be made.',
      'You must never commit, push, or open a PR yourself.',
    ].join(' '),
    tools: [
      tool(
        'get_task',
        'Full details of the card this run implements: spec, labels, branch, attempt and budget.',
        {},
        async () => text(renderTask(ctx.loadTask())),
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        'report_progress',
        'Report the current phase and a one-line status. Drives the live office view.',
        reportProgressShape,
        async (args) => {
          ctx.emitProgress(args);
          return text('recorded');
        },
      ),
      tool(
        'report_blocked',
        'Declare the task blocked. Suppresses commit and PR; a human will pick it up.',
        reportBlockedShape,
        async (args) => {
          ctx.markBlocked(args);
          return text(
            'Task marked blocked. Stop working and summarize what you learned in your final message.',
          );
        },
      ),
      tool(
        'record_decision',
        'Record a notable design decision so it appears in the PR body.',
        recordDecisionShape,
        async (args) => {
          ctx.addDecision(args);
          return text('recorded');
        },
      ),
      tool(
        'propose_summary',
        'Hand the orchestrator the commit message and PR body. Call exactly once, after tests pass.',
        proposeSummaryShape,
        async (args) => {
          const errors = await ctx.storeSummary(args);
          if (errors.length) {
            return {
              ...text(`Rejected: ${errors.join('; ')}. Fix and call propose_summary again.`),
              isError: true,
            };
          }
          return text('accepted — you may finish now');
        },
      ),
    ],
  });
}

export function renderTask(t: TaskView): string {
  return [
    `# [${t.cardShortId}] ${t.title}`,
    t.cardUrl ? `Card: ${t.cardUrl}` : '',
    `Project: ${t.projectId}   Role: ${t.role}   Attempt: ${t.attempt} of ${t.maxAttempts}`,
    `Branch: ${t.branch}`,
    t.labels.length ? `Labels: ${t.labels.join(', ')}` : '',
    '',
    '## Specification',
    t.spec.trim() || '(the card has no description — treat the title as the whole brief)',
  ]
    .filter((l) => l !== '')
    .join('\n');
}
