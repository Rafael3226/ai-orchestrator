export const TASK_STATES = [
  'queued',
  'claimed',
  'preparing',
  'running',
  'verifying',
  'publishing',
  'review',
  'blocked',
  'failed',
  'needs_human',
  'cancelled',
] as const;

export type TaskState = (typeof TASK_STATES)[number];

const TERMINAL: ReadonlySet<TaskState> = new Set([
  'review',
  'blocked',
  'failed',
  'needs_human',
  'cancelled',
]);

/** Legal transitions. Anything not listed here is a bug, not a retry. */
const TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  queued: ['claimed', 'cancelled'],
  claimed: ['preparing', 'queued', 'failed', 'cancelled'],
  preparing: ['running', 'queued', 'failed', 'cancelled'],
  // running -> publishing: a project with no `checks.test` has nothing to verify
  // running -> review: a dry run reaches a verdict without ever publishing
  // running -> needs_human: the agent finished without propose_summary (nothing to publish)
  running: [
    'verifying',
    'publishing',
    'review',
    'blocked',
    'needs_human',
    'failed',
    'queued',
    'cancelled',
  ],
  // verifying -> running is the one retry (same session, test output appended)
  verifying: ['publishing', 'running', 'review', 'needs_human', 'failed', 'cancelled'],
  publishing: ['review', 'needs_human', 'failed'],
  review: [],
  blocked: [],
  failed: [],
  needs_human: [],
  cancelled: [],
};

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: TaskState,
    readonly to: TaskState,
  ) {
    super(`Illegal task transition ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TaskState, to: TaskState): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

export function isTerminal(state: TaskState): boolean {
  return TERMINAL.has(state);
}
