import type { ResolvedFlow } from '../config/config.loader.js';
import type { HandTarget, WritebackStep } from '../config/config.schema.js';

import type { CardFields, WorkItemType } from './board.types.js';

/** A work item an agent (or the BA chat) wants created. */
export interface WorkItemDraft {
  readonly type: WorkItemType;
  readonly title: string;
  /** Markdown. */
  readonly description: string;
  readonly acceptanceCriteria?: readonly string[];
  /** `current` is the card the run is working on; anything else is a provider card id/key. */
  readonly parent?: string;
  /**
   * Who picks it up. `default` (or absent) defers to `flow.newItems[type]`;
   * `none` leaves it wherever the provider creates it.
   */
  readonly assignTo?: HandTarget | 'none' | 'default';
}

/**
 * What an agent asked the board to do during a run. Recorded by the board MCP
 * tools and applied through the outbox after the run, never live: the agent
 * never holds board credentials, and a crash loses nothing.
 */
export type AgentBoardAction =
  | { readonly kind: 'create'; readonly item: WorkItemDraft }
  | { readonly kind: 'reassign'; readonly to: HandTarget; readonly reason: string }
  | { readonly kind: 'set-fields'; readonly fields: CardFields; readonly rationale: string }
  | { readonly kind: 'comment'; readonly body: string };

export type Verdictish = 'review' | 'blocked' | 'needs_human' | 'failed';

export interface FinishContext {
  readonly verdict: Verdictish;
  readonly actions: readonly AgentBoardAction[];
  /** DEV said the change has nothing QA can test. */
  readonly untestable: boolean;
  readonly flow: Pick<ResolvedFlow, 'untestableTo'>;
}

/**
 * Decide where the card goes when a run ends. The configured step is the
 * default; an explicit `reassign` from the agent wins over it (the agent knows
 * the card needs BA, say), and an untestable DEV change skips QA.
 *
 * Only the destination changes — the comment and labels of the step stay.
 */
export function planFinishStep(step: WritebackStep, ctx: FinishContext): WritebackStep {
  const reassign = ctx.actions.filter((a) => a.kind === 'reassign').at(-1);
  if (reassign) {
    const { move: _move, ...rest } = step;
    return { ...rest, handTo: reassign.to };
  }
  if (ctx.verdict === 'review' && ctx.untestable && ctx.flow.untestableTo) {
    const { handTo: _handTo, ...rest } = step;
    return { ...rest, move: ctx.flow.untestableTo };
  }
  return step;
}

/** The description a created card gets: the body plus acceptance criteria as a checklist. */
export function renderDraftDescription(item: WorkItemDraft): string {
  const ac = item.acceptanceCriteria?.length
    ? ['', '## Acceptance criteria', ...item.acceptanceCriteria.map((c) => `- [ ] ${c}`)]
    : [];
  return [item.description.trim(), ...ac].join('\n');
}
