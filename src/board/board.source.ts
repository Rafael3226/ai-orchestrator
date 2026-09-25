import type {
  BoardCard,
  BoardComment,
  BoardEvent,
  BoardProviderKey,
  BoardTopology,
  CardFields,
  NewCard,
} from './board.types.js';

export interface BoardCapabilities {
  readonly hasChangeFeed: boolean;
  readonly canComment: boolean;
  readonly canMoveCard: boolean;
  readonly canAssignMember: boolean;
  readonly canAddLabel: boolean;
  /** Trello: false — labels must pre-exist on the board. */
  readonly labelsAreFreeform: boolean;
  /** The provider can register a push callback; see WebhookRegistrar. */
  readonly canRegisterWebhook: boolean;
  /** Agents may create stories, bugs and tasks. */
  readonly canCreateCard: boolean;
  /** Trello: false — there is no parent/child card, so a sub-task degrades to a comment. */
  readonly canCreateSubtask: boolean;
  /** Priority, story points and dates. Trello supports only the dates natively. */
  readonly canSetFields: boolean;
}

export interface RegisteredWebhook {
  readonly id: string;
  readonly idModel: string;
  readonly callbackURL: string;
  readonly description: string;
  readonly active: boolean;
}

/**
 * Implemented by sources that can manage their own push registration. Kept off
 * BoardSource so a provider without webhooks is not forced to stub four methods.
 */
export interface WebhookRegistrar {
  listWebhooks(): Promise<readonly RegisteredWebhook[]>;
  createWebhook(callbackURL: string, description: string): Promise<RegisteredWebhook>;
  updateWebhook(id: string, callbackURL: string): Promise<RegisteredWebhook>;
  deleteWebhook(id: string): Promise<void>;
}

export interface BoardPollResult {
  readonly events: readonly BoardEvent[];
  /** Opaque; persisted verbatim. Trello: newest action id. */
  readonly cursor: string | null;
}

/**
 * Pull-based on purpose: a webhook source buffers internally and drains on
 * poll(), so there is one sync loop and one test harness for every provider.
 */
export interface BoardSource {
  readonly provider: BoardProviderKey;
  readonly boardId: string;
  readonly capabilities: BoardCapabilities;

  describe(): Promise<BoardTopology>;
  listCards(): Promise<readonly BoardCard[]>;
  getCard(cardId: string): Promise<BoardCard>;
  /** `cursor === null` means first poll ever. */
  poll(cursor: string | null): Promise<BoardPollResult>;

  moveCard(cardId: string, columnId: string): Promise<void>;
  comment(cardId: string, body: string): Promise<void>;
  listRecentComments(cardId: string, limit: number): Promise<readonly BoardComment[]>;
  addLabel(cardId: string, labelId: string): Promise<void>;
  removeLabel(cardId: string, labelId: string): Promise<void>;
  assignMember(cardId: string, memberId: string): Promise<void>;
  /** Create a card. Returns it as the board now sees it. */
  createCard(card: NewCard): Promise<BoardCard>;
  /**
   * Apply planning fields. Returns the names of the fields the provider could
   * not store, so the caller can say so instead of failing the whole op.
   */
  setFields(cardId: string, fields: CardFields): Promise<readonly (keyof CardFields)[]>;
  /** Direct children (sub-tasks). Empty where the provider has none. */
  listChildren(cardId: string): Promise<readonly BoardCard[]>;
  /** Trello: the member that owns the token. Used by the loop guard check at boot. */
  whoAmI(): Promise<{ id: string; username: string }>;
}

export type BoardErrorKind =
  'auth' | 'permission' | 'not-found' | 'rate-limited' | 'unavailable' | 'network' | 'parse';

export class BoardError extends Error {
  constructor(
    readonly kind: BoardErrorKind,
    message: string,
    readonly status: number | null = null,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'BoardError';
  }

  get retryable(): boolean {
    return this.kind === 'rate-limited' || this.kind === 'unavailable' || this.kind === 'network';
  }
}
