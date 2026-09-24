export type BoardProviderKey = 'trello' | 'azure-devops' | 'jira';

export interface BoardColumn {
  /** Trello list id | ADO column name | Jira status id */
  readonly id: string;
  readonly name: string;
  readonly position: number;
}

export interface BoardLabel {
  readonly id: string;
  readonly name: string;
  readonly color: string | null;
}

export interface BoardMember {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
}

export interface BoardComment {
  readonly id: string;
  readonly authorId: string;
  readonly text: string;
  readonly at: string;
}

export interface BoardCard {
  readonly id: string;
  /** What humans type: Trello idShort, ADO work item id, Jira key. */
  readonly shortId: string;
  readonly url: string;
  readonly title: string;
  readonly description: string;
  readonly columnId: string;
  readonly labelIds: readonly string[];
  readonly labelNames: readonly string[];
  readonly memberIds: readonly string[];
  readonly closed: boolean;
  /** Provider change stamp. */
  readonly changedAt: string;
}

/** Name -> id resolution, built once per board from `describe()`. */
export interface BoardTopology {
  readonly boardId: string;
  readonly name: string;
  readonly columns: readonly BoardColumn[];
  readonly labels: readonly BoardLabel[];
  readonly members: readonly BoardMember[];
  readonly fetchedAt: string;
}

export type BoardEventKind =
  | 'card.created'
  | 'card.moved'
  | 'card.labeled'
  | 'card.unlabeled'
  | 'card.assigned'
  | 'card.unassigned'
  | 'card.updated'
  | 'card.commented'
  | 'card.archived';

/** One shape for polling, webhooks and reconcile-synthesized events. */
export interface BoardEvent {
  /** Provider-stable and globally unique — the dedupe key. */
  readonly eventId: string;
  readonly kind: BoardEventKind;
  readonly provider: BoardProviderKey;
  readonly boardId: string;
  readonly cardId: string;
  readonly occurredAt: string;
  /** Who caused it; null when unknown. The loop guard reads this. */
  readonly actorMemberId: string | null;
  readonly fromColumnId: string | null;
  readonly toColumnId: string | null;
  readonly labelId: string | null;
  readonly memberId: string | null;
  /** Cheap snapshot when the provider gives one for free. */
  readonly card: BoardCard | null;
  /** True when synthesized by a reconcile diff rather than read from a change feed. */
  readonly synthetic: boolean;
  /**
   * Set only for a re-route triggered by our OWN settled move, so one role can
   * hand a card to another. It deliberately bypasses the echo guard and the
   * reconcile ledger check — the arrival counter in the dedupe key and the
   * per-role circuit breaker are what keep that from looping.
   */
  readonly handoff?: boolean;
}

export const normalizeColumnName = (name: string): string => name.trim().toLocaleLowerCase();

export function findColumnByName(topology: BoardTopology, name: string): BoardColumn | undefined {
  const target = normalizeColumnName(name);
  return topology.columns.find((c) => normalizeColumnName(c.name) === target);
}

export function findLabelByName(topology: BoardTopology, name: string): BoardLabel | undefined {
  const target = name.trim().toLocaleLowerCase();
  return topology.labels.find((l) => l.name.trim().toLocaleLowerCase() === target);
}
