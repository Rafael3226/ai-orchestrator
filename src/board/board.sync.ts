import type { ProjectConfig } from '../config/config.loader.js';
import type { SqliteStore } from '../db/sqlite.store.js';
import { newTaskId, type TaskId } from '../domain/ids.js';
import { BoardRouter, type Dispatch, syntheticArrival } from '../router/board.router.js';

import type { BoardSource } from './board.source.js';
import type { BoardStore } from './board.store.js';
import type { BoardCard, BoardEvent, BoardTopology } from './board.types.js';

export interface SyncLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface SyncTickResult {
  readonly events: number;
  readonly dispatched: Dispatch[];
  readonly skipped: { event: BoardEvent; reason: string }[];
  readonly reconciled: boolean;
}

/**
 * One project's poll → route → enqueue loop body. Stateless between ticks
 * except for the topology cache; every durable fact lives in SQLite so a
 * restart resumes from the cursor.
 */
export class BoardSync {
  readonly router: BoardRouter;
  private topology: BoardTopology | null = null;
  private topologyAt = 0;

  constructor(
    private readonly project: ProjectConfig,
    private readonly source: BoardSource,
    private readonly store: SqliteStore,
    private readonly boardStore: BoardStore,
    private readonly log: SyncLogger,
  ) {
    this.router = new BoardRouter(project, boardStore);
  }

  async getTopology(force = false): Promise<BoardTopology> {
    if (force || !this.topology || Date.now() - this.topologyAt > 10 * 60_000) {
      this.topology = await this.source.describe();
      this.topologyAt = Date.now();
    }
    return this.topology;
  }

  /** Boot-time: the token's member must be the configured bot when we move cards. */
  async assertLoopGuard(): Promise<void> {
    // Role overlays can introduce a move even when the project default has none.
    const moves =
      Object.values(this.project.writeback).some((s) => s.move !== undefined) ||
      Object.values(this.project.agents).some((a) =>
        Object.values(a.writeback).some((s) => s.move !== undefined),
      );
    if (!moves) return;
    const me = await this.source.whoAmI();
    if (me.id !== this.project.board.botMemberId) {
      throw new Error(
        `project ${this.project.id}: botMemberId is "${this.project.board.botMemberId}" but the token belongs to ` +
          `${me.username} (${me.id}). Writeback would loop. Set board.botMemberId: "${me.id}".`,
      );
    }
  }

  async tick(): Promise<SyncTickResult> {
    const p = this.project;
    const topology = await this.getTopology();
    const state = this.boardStore.getCursor(p.id);
    const dispatched: Dispatch[] = [];
    const skipped: { event: BoardEvent; reason: string }[] = [];

    // Cold start (first tick ever, not "cursor is null" — an empty board legitimately has no
    // cursor): never replay history. Seed the cursor, then reconcile cards parked in routed columns.
    if (state.tick === 0) {
      const seed = await this.source.poll(null);
      this.boardStore.setCursor(p.id, seed.cursor, true);
      this.log.info(
        `${p.id}: cold start — cursor seeded at ${seed.cursor ?? 'none'}, ${seed.events.length} historical events ignored`,
      );
      if (p.board.poll.reconcileOnStart) {
        const r = await this.reconcile(topology);
        dispatched.push(...r.dispatched);
        skipped.push(...r.skipped);
      }
      return { events: 0, dispatched, skipped, reconciled: true };
    }

    const result = await this.source.poll(state.cursor);
    for (const event of result.events) {
      if (!this.boardStore.markEventSeen(p.id, event.eventId)) continue;
      const card = event.card ?? (await this.safeGetCard(event.cardId));
      const decision = this.router.route(event, topology, card);
      if (decision.kind === 'dispatch') {
        this.enqueue(decision.dispatch);
        dispatched.push(decision.dispatch);
      } else {
        skipped.push({ event, reason: decision.reason });
      }
    }

    // A dropped delivery is recoverable, but only by looking at the board: force
    // the reconcile rather than waiting up to reconcileEveryTicks for one.
    const overflowed = this.consumeSourceOverflow();
    const reconcile = overflowed || (state.tick + 1) % p.board.poll.reconcileEveryTicks === 0;
    this.boardStore.setCursor(p.id, result.cursor ?? state.cursor, reconcile);
    if (reconcile) {
      const r = await this.reconcile(topology);
      dispatched.push(...r.dispatched);
      skipped.push(...r.skipped);
    }
    return { events: result.events.length, dispatched, skipped, reconciled: reconcile };
  }

  /**
   * Re-route one card after our own move settled, so a finished role can hand
   * it to the next one. Without this the chain is impossible unattended: the
   * move is dropped as an echo, and reconcile skips any card that already has a
   * ledger row.
   *
   * The arrival is re-recorded first so the dedupe key differs from the one the
   * previous dispatch used; that plus the per-role circuit breaker is what stops
   * this from looping.
   */
  async handoff(cardId: string): Promise<Dispatch | null> {
    const topology = await this.getTopology();
    const card = await this.safeGetCard(cardId);
    if (!card || card.closed) return null;

    const ev = syntheticArrival(this.project, card, topology, { handoff: true });
    if (!ev) return null;

    // A card may only have one task in flight. In the normal flow the previous
    // role is already terminal by the time its move settles, so this only fires
    // when something is genuinely still running on the card.
    if (this.store.hasActiveTaskForCard(this.project.id, card.id)) {
      this.log.warn(
        `${this.project.id}: handoff for [${card.shortId}] skipped — a task is still in flight`,
      );
      return null;
    }

    this.boardStore.recordArrival(this.project.id, card.id, card.columnId);
    if (!this.boardStore.markEventSeen(this.project.id, ev.eventId)) return null;

    const decision = this.router.route(ev, topology, card);
    if (decision.kind !== 'dispatch') return null;
    this.enqueue(decision.dispatch);
    this.log.info(
      `${this.project.id}: handoff — ${decision.dispatch.role} picked up [${card.shortId}] after our move`,
    );
    return decision.dispatch;
  }

  /** Emit synthetic arrivals for cards in routed columns with no ledger entry at all. */
  private async reconcile(
    topology: BoardTopology,
  ): Promise<Pick<SyncTickResult, 'dispatched' | 'skipped'>> {
    const dispatched: Dispatch[] = [];
    const skipped: { event: BoardEvent; reason: string }[] = [];
    const cards = await this.source.listCards();
    for (const card of cards) {
      const ev = syntheticArrival(this.project, card, topology);
      if (!ev) continue;
      if (!this.boardStore.markEventSeen(this.project.id, ev.eventId)) continue;
      if (this.boardStore.getArrivals(this.project.id, card.id, card.columnId) === 0) {
        this.boardStore.recordArrival(this.project.id, card.id, card.columnId);
      }
      const decision = this.router.route(ev, topology, card);
      if (decision.kind === 'dispatch') {
        this.enqueue(decision.dispatch);
        dispatched.push(decision.dispatch);
      } else skipped.push({ event: ev, reason: decision.reason });
    }
    if (dispatched.length)
      this.log.info(`${this.project.id}: reconcile dispatched ${dispatched.length} parked card(s)`);
    return { dispatched, skipped };
  }

  /** Ledger row + task row in ONE transaction: a dispatch never exists in only one place. */
  private enqueue(d: Dispatch): TaskId {
    return this.boardStore.transaction(() => {
      const taskId = newTaskId();
      this.store.insertTask({
        id: taskId,
        projectId: d.projectId,
        role: d.role,
        cardId: d.card.id,
        cardShortId: d.card.shortId,
        cardUrl: d.card.url,
        title: d.card.title,
        spec: d.card.description,
        labels: d.card.labelNames,
      });
      this.boardStore.insertLedger({
        dedupeKey: d.dedupeKey,
        projectId: d.projectId,
        cardId: d.card.id,
        role: d.role,
        routeId: d.route.id,
        taskId,
      });
      this.log.info(
        `${d.projectId}: queued ${d.role} for [${d.card.shortId}] ${d.card.title} via ${d.route.id}`,
      );
      return taskId;
    });
  }

  /** True when a webhook buffer under us dropped events since the last tick. */
  private consumeSourceOverflow(): boolean {
    const source = this.source as { consumeOverflow?: () => boolean };
    return source.consumeOverflow?.() ?? false;
  }

  private async safeGetCard(cardId: string): Promise<BoardCard | null> {
    try {
      return await this.source.getCard(cardId);
    } catch (err) {
      this.log.warn(
        `${this.project.id}: could not hydrate card ${cardId}: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
  }
}
