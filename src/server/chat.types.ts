/**
 * Wire types for the BA chat, shared by the server and the office client
 * (type-only, like state.types.ts — this file must stay free of runtime imports).
 */

export const STORY_TYPES = ['story', 'bug', 'epic', 'task'] as const;
export type StoryType = (typeof STORY_TYPES)[number];

export interface BusinessDecision {
  readonly title: string;
  readonly rationale: string;
}

/** What the BA proposes through `propose_story`. Replaced wholesale on every call. */
export interface StoryDraft {
  readonly type: StoryType;
  readonly title: string;
  /** As a … I want … so that … */
  readonly userStory: string;
  readonly description: string;
  /** Given / When / Then, one per entry. */
  readonly acceptanceCriteria: readonly string[];
  readonly businessDecisions: readonly BusinessDecision[];
  readonly openQuestions: readonly string[];
}

/**
 * `open`: still talking. `submitted`: queued on the outbox, card not created
 * yet. `created`: the card exists on the board.
 */
export type ChatStatus = 'open' | 'submitted' | 'created';

export interface ChatMessage {
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly at: string;
}

export interface CreatedCard {
  readonly id: string;
  readonly shortId: string;
  readonly url: string;
}

export interface ChatSessionView {
  readonly id: string;
  readonly projectId: string;
  readonly status: ChatStatus;
  readonly messages: readonly ChatMessage[];
  readonly draft: StoryDraft | null;
  readonly createdCard: CreatedCard | null;
  readonly costUsd: number;
  readonly budgetUsd: number;
  /** A turn is running right now. */
  readonly busy: boolean;
}

/** One SSE event on `POST /api/chat/:sid/messages`. */
export type ChatStreamEvent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool'; readonly name: string }
  | { readonly type: 'draft'; readonly draft: StoryDraft }
  | {
      readonly type: 'done';
      readonly draft: StoryDraft | null;
      readonly costUsd: number;
      readonly totalCostUsd: number;
    }
  | { readonly type: 'error'; readonly message: string };
