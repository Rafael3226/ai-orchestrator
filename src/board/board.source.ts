import type {
  BoardCard,
  BoardComment,
  BoardEvent,
  BoardProviderKey,
  BoardTopology,
} from './board.types.js';

export interface BoardCapabilities {
  readonly hasChangeFeed: boolean;
  readonly canComment: boolean;
  readonly canMoveCard: boolean;
  readonly canAssignMember: boolean;
  readonly canAddLabel: boolean;
  /** Trello: false — labels must pre-exist on the board. */
  readonly labelsAreFreeform: boolean;
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
