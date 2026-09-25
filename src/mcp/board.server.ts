import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  tool,
} from '@anthropic-ai/claude-agent-sdk';

import type { AgentBoardAction } from '../board/board.actions.js';
import type { CardFields } from '../board/board.types.js';
import type { Capability } from '../config/config.schema.js';

import {
  addCommentShape,
  type BlockedReport,
  createWorkItemShape,
  type Decision,
  type ProgressReport,
  type ProposedSummary,
  proposeSummaryShape,
  reassignShape,
  recordDecisionShape,
  reportBlockedShape,
  reportProgressShape,
  setFieldsShape,
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
  /** Today's date (YYYY-MM-DD) — PM schedules against it. */
  readonly today?: string;
}

/** A child card, as list_work_items shows it. */
export interface WorkItemView {
  readonly shortId: string;
  readonly title: string;
  readonly description: string;
  readonly url: string;
}

/** What the tools need from the orchestrator. Everything is local — the agent never touches Trello. */
export interface BoardToolContext {
  loadTask(): TaskView;
  emitProgress(p: ProgressReport): void;
  markBlocked(b: BlockedReport): void;
  addDecision(d: Decision): void;
  /** Returns validation errors (e.g. from the target repo's commitlint); empty means accepted. */
  storeSummary(s: ProposedSummary): Promise<readonly string[]>;
  /** Which board-changing tools this role gets. A tool not granted is not registered at all. */
  readonly capabilities?: readonly Capability[];
  /**
   * Record a board change for the orchestrator to apply after the run.
   * Returns validation errors; empty means recorded.
   */
  recordAction?(a: AgentBoardAction): readonly string[];
  /** Children (sub-tasks) of the current card. */
  listChildren?(): Promise<readonly WorkItemView[]>;
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
      'Board changes you request (create_work_item, reassign, set_fields, add_comment) are applied',
      'by the orchestrator after your run ends, in the order you made them.',
    ].join(' '),
    tools: [
      ...boardActionTools(ctx),
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

/** The tools that change the board, each gated by a capability. */
function boardActionTools(ctx: BoardToolContext) {
  const caps = new Set(ctx.capabilities ?? []);
  const record = (a: AgentBoardAction, ok: string) => {
    const errors = ctx.recordAction?.(a) ?? ['board actions are not available in this run'];
    return errors.length ? { ...text(`Rejected: ${errors.join('; ')}`), isError: true } : text(ok);
  };
  const tools = [];
  if (ctx.listChildren) {
    const list = ctx.listChildren;
    tools.push(
      tool(
        'list_work_items',
        'Sub-tasks of the current card, with their descriptions. QA: one test suite per sub-task.',
        {},
        async () => {
          const items = await list();
          if (!items.length) return text('The card has no sub-tasks.');
          return text(
            items
              .map((i) => `## [${i.shortId}] ${i.title}\n${i.url}\n\n${i.description.trim()}`)
              .join('\n\n'),
          );
        },
        { annotations: { readOnlyHint: true } },
      ),
    );
  }
  if (caps.has('create-work-item')) {
    tools.push(
      tool(
        'create_work_item',
        'Create a story, bug, task, epic or sub-task. Use parent "current" for a sub-task of this card. ' +
          'assignTo names the role that should pick it up (omit for the project default).',
        createWorkItemShape,
        async (args) =>
          record(
            {
              kind: 'create',
              item: {
                type: args.type,
                title: args.title,
                description: args.description,
                ...(args.acceptanceCriteria ? { acceptanceCriteria: args.acceptanceCriteria } : {}),
                ...(args.parent ? { parent: args.parent } : {}),
                ...(args.assignTo ? { assignTo: args.assignTo } : {}),
              },
            },
            `recorded — the ${args.type} will be created when your run ends`,
          ),
      ),
    );
  }
  if (caps.has('reassign')) {
    tools.push(
      tool(
        'reassign',
        'Hand THIS card to another role (or a human) when it is not yours to finish: missing ' +
          'requirements → BA, needs estimating → PM, a defect → DEV. Overrides the normal next step.',
        reassignShape,
        async (args) =>
          record(
            { kind: 'reassign', to: args.to, reason: args.reason },
            `recorded — the card goes to ${args.to} when your run ends. Finish with propose_summary or report_blocked.`,
          ),
      ),
    );
  }
  if (caps.has('set-fields')) {
    tools.push(
      tool(
        'set_fields',
        'Set planning fields on this card: priority, story points (Fibonacci), start and due dates.',
        setFieldsShape,
        async ({ rationale, ...fields }) =>
          record(
            {
              kind: 'set-fields',
              fields: Object.fromEntries(
                Object.entries(fields).filter(([, v]) => v !== undefined),
              ) as CardFields,
              rationale,
            },
            'recorded',
          ),
      ),
    );
  }
  if (caps.has('comment')) {
    tools.push(
      tool(
        'add_comment',
        'Post a comment on this card, separate from your final report.',
        addCommentShape,
        async (args) => record({ kind: 'comment', body: args.body }, 'recorded'),
      ),
    );
  }
  return tools;
}

export function renderTask(t: TaskView): string {
  return [
    `# [${t.cardShortId}] ${t.title}`,
    t.cardUrl ? `Card: ${t.cardUrl}` : '',
    `Project: ${t.projectId}   Role: ${t.role}   Attempt: ${t.attempt} of ${t.maxAttempts}`,
    `Branch: ${t.branch}`,
    t.today ? `Today: ${t.today}` : '',
    t.labels.length ? `Labels: ${t.labels.join(', ')}` : '',
    '',
    '## Specification',
    t.spec.trim() || '(the card has no description — treat the title as the whole brief)',
  ]
    .filter((l) => l !== '')
    .join('\n');
}
