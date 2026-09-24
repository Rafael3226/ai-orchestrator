import type { BoardCapabilities, BoardPollResult, BoardSource } from './board.source.js';
import type { SyncLogger } from './board.sync.js';
import type {
  BoardCard,
  BoardComment,
  BoardEvent,
  BoardProviderKey,
  BoardTopology,
} from './board.types.js';

export interface BufferStats {
  readonly buffered: number;
  readonly deliveredTotal: number;
  readonly droppedTotal: number;
  readonly lastDeliveryAt: string | null;
  readonly overflowed: boolean;
}

export interface WebhookBufferOptions {
  readonly maxBuffered: number;
  /** Called when a delivery is worth hurrying for. Never called for bot echoes. */
  readonly onWake?: () => void;
  readonly log?: SyncLogger;
}

/**
 * The webhook seam: a receiver pushes events in, and the existing poll() drains
 * them. Everything downstream — BoardSync, BoardRouter, BoardWriter — sees one
 * ordinary BoardSource and does not know webhooks exist.
 *
 * Two invariants make this safe enough to keep in memory:
 *
 * 1. The cursor NEVER comes from the buffer. A delivery carries an action id but
 *    we cannot know it is the newest one, and advancing the cursor from it would
 *    skip actions we never saw. Only a real poll moves the cursor.
 * 2. The inner poll() ALWAYS runs, even when the buffer is full. It costs one
 *    request against a limiter we already have, and it is what guarantees the
 *    cursor advances and that anything the webhook dropped is recovered.
 *
 * Together those mean the provider's change feed stays the write-ahead log: a
 * delivery that is lost to a crash, an overflow or a 500 is still behind the
 * persisted cursor and comes back on the next poll. So this buffer is a latency
 * cache, not durable state, and deliberately has no table behind it.
 */
export class WebhookBufferedSource implements BoardSource {
  readonly provider: BoardProviderKey;
  readonly boardId: string;
  readonly capabilities: BoardCapabilities;

  #buffer: BoardEvent[] = [];
  #deliveredTotal = 0;
  #droppedTotal = 0;
  #lastDeliveryAt: string | null = null;
  #overflowed = false;

  constructor(
    private readonly inner: BoardSource,
    private readonly opts: WebhookBufferOptions,
  ) {
    this.provider = inner.provider;
    this.boardId = inner.boardId;
    this.capabilities = inner.capabilities;
  }

  /**
   * Buffer a delivered event. `wake` is false for events we caused ourselves:
   * they still have to reach the router (which is the only thing allowed to
   * decide an event is our own echo), but they must not make the daemon tick.
   */
  push(events: readonly BoardEvent[], opts: { wake: boolean }): void {
    if (events.length === 0) return;
    for (const event of events) {
      this.#buffer.push(event);
      this.#deliveredTotal += 1;
      if (this.#buffer.length > this.opts.maxBuffered) {
        this.#buffer.shift();
        this.#droppedTotal += 1;
        this.#overflowed = true;
      }
    }
    this.#lastDeliveryAt = new Date().toISOString();
    if (opts.wake) this.opts.onWake?.();
  }

  /**
   * True once if the buffer has overflowed since the last call. BoardSync uses
   * it to force a reconcile on the tick after a drop, which is how a lost
   * delivery turns back into a dispatch.
   */
  consumeOverflow(): boolean {
    const was = this.#overflowed;
    this.#overflowed = false;
    return was;
  }

  stats(): BufferStats {
    return {
      buffered: this.#buffer.length,
      deliveredTotal: this.#deliveredTotal,
      droppedTotal: this.#droppedTotal,
      lastDeliveryAt: this.#lastDeliveryAt,
      overflowed: this.#overflowed,
    };
  }

  async poll(cursor: string | null): Promise<BoardPollResult> {
    const drained = this.#buffer;
    this.#buffer = [];
    if (this.#droppedTotal > 0 && this.#overflowed) {
      this.opts.log?.warn(
        `${this.boardId}: webhook buffer overflowed — ${this.#droppedTotal} delivery(ies) dropped; ` +
          `the next reconcile recovers them from the change feed`,
      );
    }
    // Always poll: the cursor must advance, and the feed is what recovers drops.
    const result = await this.inner.poll(cursor);
    if (drained.length === 0) return result;
    // Duplicates between the two are expected — markEventSeen dedupes on eventId.
    return { events: [...drained, ...result.events], cursor: result.cursor };
  }

  describe(): Promise<BoardTopology> {
    return this.inner.describe();
  }

  listCards(): Promise<readonly BoardCard[]> {
    return this.inner.listCards();
  }

  getCard(cardId: string): Promise<BoardCard> {
    return this.inner.getCard(cardId);
  }

  moveCard(cardId: string, columnId: string): Promise<void> {
    return this.inner.moveCard(cardId, columnId);
  }

  comment(cardId: string, body: string): Promise<void> {
    return this.inner.comment(cardId, body);
  }

  listRecentComments(cardId: string, limit: number): Promise<readonly BoardComment[]> {
    return this.inner.listRecentComments(cardId, limit);
  }

  addLabel(cardId: string, labelId: string): Promise<void> {
    return this.inner.addLabel(cardId, labelId);
  }

  removeLabel(cardId: string, labelId: string): Promise<void> {
    return this.inner.removeLabel(cardId, labelId);
  }

  assignMember(cardId: string, memberId: string): Promise<void> {
    return this.inner.assignMember(cardId, memberId);
  }

  whoAmI(): Promise<{ id: string; username: string }> {
    return this.inner.whoAmI();
  }
}
