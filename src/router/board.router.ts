import { createHash } from 'node:crypto';

import type { BoardStore } from '../board/board.store.js';
import {
  type BoardCard,
  type BoardEvent,
  type BoardTopology,
  findColumnByName,
  normalizeColumnName,
} from '../board/board.types.js';
import type { ProjectConfig, ResolvedRoute } from '../config/config.loader.js';
import type { Role } from '../config/config.schema.js';

export interface Dispatch {
  readonly projectId: string;
  readonly role: Role;
  readonly route: ResolvedRoute;
  readonly card: BoardCard;
  readonly columnId: string;
  readonly dedupeKey: string;
}

export type RouteDecision =
  { kind: 'dispatch'; dispatch: Dispatch } | { kind: 'skip'; reason: string };

/** A board event this close to one of our writebacks on the same card is its echo. */
const ECHO_WINDOW_MS = 15_000;
const CIRCUIT_WINDOW_MS = 60 * 60 * 1000;
const CIRCUIT_MAX_DISPATCHES = 3;

/**
 * BoardEvent + routes -> at most one Dispatch.
 *
 * A route describes a STATE; a dispatch must be caused by an ARRIVAL at that
 * state. `card.updated` / `card.commented` never dispatch. Our own bot's events
 * are dropped. First matching route in (priority-sorted) file order wins.
 */
export class BoardRouter {
  constructor(
    private readonly project: ProjectConfig,
    private readonly boardStore: BoardStore,
    /** Our recent writeback timestamps per card; events within ECHO_WINDOW_MS of one are echoes. */
    private readonly recentWriteback: Map<string, number[]> = new Map(),
  ) {}

  route(event: BoardEvent, topology: BoardTopology, card: BoardCard | null): RouteDecision {
    const p = this.project;

    // Loop guard layer 1+2. The bot member is often the operator's own account (one Trello
    // token), so a bot-authored event is only an echo when it OCCURRED within a few seconds of
    // our own writeback to that card — compared on the event's timestamp, not on poll time, so
    // the poll interval does not matter. Outside that window the same account is a human.
    if (!event.synthetic && this.isEcho(event.cardId, event.occurredAt)) {
      if (!event.actorMemberId || event.actorMemberId === p.board.botMemberId) {
        return { kind: 'skip', reason: 'own writeback' };
      }
    }
    if (
      event.kind === 'card.updated' ||
      event.kind === 'card.commented' ||
      event.kind === 'card.archived' ||
      event.kind === 'card.unlabeled' ||
      event.kind === 'card.unassigned'
    ) {
      return { kind: 'skip', reason: `${event.kind} never dispatches` };
    }
    if (!card || card.closed) return { kind: 'skip', reason: 'card missing or archived' };

    // Column arrival bookkeeping: only real moves/creates bump the counter.
    if ((event.kind === 'card.moved' || event.kind === 'card.created') && event.toColumnId) {
      if (event.kind === 'card.moved' && event.fromColumnId === event.toColumnId) {
        return { kind: 'skip', reason: 'move within same column' };
      }
      this.boardStore.recordArrival(p.id, card.id, event.toColumnId);
    }

    for (const route of p.routes) {
      if (!route.enabled) continue;
      if (!matches(route, card, topology)) continue;
      if (!isArrival(route, event, topology)) continue;

      if (!p.agents[route.agent].enabled) {
        return { kind: 'skip', reason: `${route.id} matched but ${route.agent} is disabled` };
      }
      if (event.synthetic && this.boardStore.hasAnyLedgerForCard(p.id, card.id)) {
        return { kind: 'skip', reason: 'reconcile: card already has a ledger entry' };
      }
      if (
        this.boardStore.recentDispatchCount(p.id, card.id, CIRCUIT_WINDOW_MS) >=
        CIRCUIT_MAX_DISPATCHES
      ) {
        return {
          kind: 'skip',
          reason: `circuit breaker: >${CIRCUIT_MAX_DISPATCHES} dispatches for this card in the last hour`,
        };
      }

      const arrivals = this.boardStore.getArrivals(p.id, card.id, card.columnId);
      const dedupeKey = sha(
        `${p.id}|${card.id}|${route.agent}|${route.id}|${card.columnId}|${arrivals}`,
      );
      if (this.boardStore.hasLedgerEntry(dedupeKey))
        return { kind: 'skip', reason: 'already dispatched for this arrival' };

      return {
        kind: 'dispatch',
        dispatch: {
          projectId: p.id,
          role: route.agent,
          route,
          card,
          columnId: card.columnId,
          dedupeKey,
        },
      };
    }
    return { kind: 'skip', reason: 'no route matched' };
  }

  /** Called by writeback so the echo of our own action (whenever it is polled) is ignored. */
  noteWriteback(cardId: string, at: number = Date.now()): void {
    const list = this.recentWriteback.get(cardId) ?? [];
    list.push(at);
    // Keep the map bounded: anything older than the echo window is useless.
    const cutoff = Date.now() - ECHO_WINDOW_MS * 4;
    this.recentWriteback.set(
      cardId,
      list.filter((t) => t > cutoff),
    );
  }

  private isEcho(cardId: string, occurredAt: string): boolean {
    const t = Date.parse(occurredAt);
    if (Number.isNaN(t)) return false;
    return (this.recentWriteback.get(cardId) ?? []).some((w) => Math.abs(t - w) <= ECHO_WINDOW_MS);
  }
}

/** Does the card's CURRENT state satisfy the route's predicate? */
export function matches(route: ResolvedRoute, card: BoardCard, topology: BoardTopology): boolean {
  const w = route.when;
  if (w.column !== undefined) {
    const col = findColumnByName(topology, w.column);
    if (!col || col.id !== card.columnId) return false;
  }
  const names = new Set(card.labelNames.map((n) => n.trim().toLocaleLowerCase()));
  if (w.label !== undefined) {
    const any = (Array.isArray(w.label) ? w.label : [w.label]).map((l) =>
      l.trim().toLocaleLowerCase(),
    );
    if (!any.some((l) => names.has(l))) return false;
  }
  if (
    w.labelsAll !== undefined &&
    !w.labelsAll.every((l) => names.has(l.trim().toLocaleLowerCase()))
  )
    return false;
  if (w.member !== undefined) {
    const m = w.member.trim().toLocaleLowerCase();
    const ok = card.memberIds.some((id) => {
      const member = topology.members.find((x) => x.id === id);
      return (
        id === w.member ||
        member?.username.toLocaleLowerCase() === m ||
        member?.displayName.toLocaleLowerCase() === m
      );
    });
    if (!ok) return false;
  }
  if (w.titleMatches !== undefined && !new RegExp(w.titleMatches).test(card.title)) return false;
  return true;
}

/** Was THIS event the arrival into the route's state (vs. the card already being there)? */
function isArrival(route: ResolvedRoute, event: BoardEvent, topology: BoardTopology): boolean {
  const w = route.when;
  switch (event.kind) {
    case 'card.created':
      return true;
    case 'card.moved': {
      if (w.column !== undefined) return true; // predicate is true now and column changed
      // No column condition: only an arrival if it wasn't matching before the move.
      return false;
    }
    case 'card.labeled': {
      if (w.label === undefined && w.labelsAll === undefined) {
        // Label added to a card already in the routed column: not an arrival unless the route is column-only
        // and the card just arrived — which a labeled event is not.
        return false;
      }
      const added = topology.labels
        .find((l) => l.id === event.labelId)
        ?.name.trim()
        .toLocaleLowerCase();
      const wanted = [
        ...(Array.isArray(w.label) ? w.label : w.label ? [w.label] : []),
        ...(w.labelsAll ?? []),
      ].map((l) => l.trim().toLocaleLowerCase());
      return added !== undefined && wanted.includes(added);
    }
    case 'card.assigned':
      return (
        w.member !== undefined &&
        (event.memberId === w.member ||
          topology.members.some(
            (m) =>
              m.id === event.memberId &&
              (m.username.toLocaleLowerCase() === w.member?.toLocaleLowerCase() ||
                m.displayName.toLocaleLowerCase() === w.member?.toLocaleLowerCase()),
          ))
      );
    default:
      return false;
  }
}

/** Reconcile helper: a synthetic "arrival" for cards sitting in a routed column with no ledger entry. */
export function syntheticArrival(
  project: ProjectConfig,
  card: BoardCard,
  topology: BoardTopology,
): BoardEvent | null {
  const routed = project.routes.some(
    (r) =>
      r.enabled &&
      r.when.column !== undefined &&
      normalizeColumnName(r.when.column) ===
        normalizeColumnName(topology.columns.find((c) => c.id === card.columnId)?.name ?? ''),
  );
  if (!routed) return null;
  return {
    eventId: `syn:${sha(`${project.id}|${card.id}|${card.columnId}|${card.changedAt}`)}`,
    kind: 'card.moved',
    provider: project.board.provider,
    boardId: project.board.boardId,
    cardId: card.id,
    occurredAt: card.changedAt,
    actorMemberId: null,
    fromColumnId: null,
    toColumnId: card.columnId,
    labelId: null,
    memberId: null,
    card,
    synthetic: true,
  };
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 32);
