import type { BoardCapabilities, BoardPollResult, BoardSource } from '../board/board.source.js';
import type {
  BoardCard,
  BoardColumn,
  BoardComment,
  BoardEvent,
  BoardEventKind,
  BoardLabel,
  BoardMember,
  BoardTopology,
} from '../board/board.types.js';

/**
 * In-memory board. Every mutation (from a test OR from writeback) appends an
 * event, exactly like Trello's actions feed — so the loop guard and the router
 * are exercised for real without a network.
 */
export class FakeBoardSource implements BoardSource {
  readonly provider = 'trello' as const;
  readonly capabilities: BoardCapabilities = {
    hasChangeFeed: true,
    canComment: true,
    canMoveCard: true,
    canAssignMember: true,
    canAddLabel: true,
    labelsAreFreeform: false,
  };

  readonly columns: BoardColumn[];
  readonly labels: BoardLabel[];
  readonly members: BoardMember[];
  readonly cards = new Map<string, BoardCard>();
  readonly comments = new Map<string, BoardComment[]>();
  readonly events: BoardEvent[] = [];
  /** Who performs writeback calls; matches `botMemberId` in tests. */
  botId = 'bot';
  /** Who performs test-driven mutations. */
  humanId = 'human';
  private seq = 0;

  constructor(
    readonly boardId: string,
    columns: readonly string[],
    labels: readonly string[] = [],
    members: readonly BoardMember[] = [],
  ) {
    this.columns = columns.map((name, i) => ({ id: `list-${i}`, name, position: i }));
    this.labels = labels.map((name, i) => ({ id: `label-${i}`, name, color: null }));
    this.members = [
      { id: 'bot', username: 'orchestrator-bot', displayName: 'Orchestrator' },
      ...members,
    ];
  }

  columnId(name: string): string {
    const c = this.columns.find((x) => x.name === name);
    if (!c) throw new Error(`no column ${name}`);
    return c.id;
  }
  labelId(name: string): string {
    const l = this.labels.find((x) => x.name === name);
    if (!l) throw new Error(`no label ${name}`);
    return l.id;
  }

  // ── test-side mutations (as a human) ──────────────────────────────────

  addCard(
    shortId: string,
    title: string,
    columnName: string,
    opts: { description?: string; labels?: string[] } = {},
  ): BoardCard {
    const card: BoardCard = {
      id: `card-${shortId}`,
      shortId,
      url: `https://fake/c/${shortId}`,
      title,
      description: opts.description ?? '',
      columnId: this.columnId(columnName),
      labelIds: (opts.labels ?? []).map((l) => this.labelId(l)),
      labelNames: opts.labels ?? [],
      memberIds: [],
      closed: false,
      changedAt: this.now(),
    };
    this.cards.set(card.id, card);
    this.emit('card.created', card.id, this.humanId, { toColumnId: card.columnId });
    return card;
  }

  humanMove(cardId: string, columnName: string): void {
    this.move(cardId, this.columnId(columnName), this.humanId);
  }
  humanLabel(cardId: string, labelName: string): void {
    this.label(cardId, this.labelId(labelName), this.humanId);
  }
  humanEdit(cardId: string, description: string): void {
    this.patch(cardId, { description });
    this.emit('card.updated', cardId, this.humanId, {});
  }

  // ── BoardSource ───────────────────────────────────────────────────────

  async describe(): Promise<BoardTopology> {
    return {
      boardId: this.boardId,
      name: 'Fake',
      columns: this.columns,
      labels: this.labels,
      members: this.members,
      fetchedAt: this.now(),
    };
  }
  async listCards(): Promise<readonly BoardCard[]> {
    return [...this.cards.values()].filter((c) => !c.closed);
  }
  async getCard(cardId: string): Promise<BoardCard> {
    const c = this.cards.get(cardId);
    if (!c) throw new Error(`card ${cardId} not found`);
    return c;
  }
  async poll(cursor: string | null): Promise<BoardPollResult> {
    const after = cursor ? Number(cursor) : -1;
    const events = this.events.filter((e) => Number(e.eventId.split(':')[1]) > after);
    const last = this.events.at(-1);
    return { events, cursor: last ? (last.eventId.split(':')[1] ?? null) : cursor };
  }
  async moveCard(cardId: string, columnId: string): Promise<void> {
    this.move(cardId, columnId, this.botId);
  }
  async comment(cardId: string, body: string): Promise<void> {
    const list = this.comments.get(cardId) ?? [];
    list.push({ id: `cm-${++this.seq}`, authorId: this.botId, text: body, at: this.now() });
    this.comments.set(cardId, list);
    this.emit('card.commented', cardId, this.botId, {});
  }
  async listRecentComments(cardId: string, limit: number): Promise<readonly BoardComment[]> {
    return (this.comments.get(cardId) ?? []).slice(-limit);
  }
  async addLabel(cardId: string, labelId: string): Promise<void> {
    this.label(cardId, labelId, this.botId);
  }
  async removeLabel(cardId: string, labelId: string): Promise<void> {
    const c = await this.getCard(cardId);
    this.patch(cardId, { labelIds: c.labelIds.filter((l) => l !== labelId) });
    this.emit('card.unlabeled', cardId, this.botId, { labelId });
  }
  async assignMember(cardId: string, memberId: string): Promise<void> {
    const c = await this.getCard(cardId);
    if (!c.memberIds.includes(memberId))
      this.patch(cardId, { memberIds: [...c.memberIds, memberId] });
    this.emit('card.assigned', cardId, this.botId, { memberId });
  }
  async whoAmI(): Promise<{ id: string; username: string }> {
    return { id: this.botId, username: 'orchestrator-bot' };
  }

  // ── internals ─────────────────────────────────────────────────────────

  private move(cardId: string, toColumnId: string, actor: string): void {
    const c = this.cards.get(cardId);
    if (!c) throw new Error(`card ${cardId} not found`);
    const from = c.columnId;
    this.patch(cardId, { columnId: toColumnId });
    this.emit('card.moved', cardId, actor, { fromColumnId: from, toColumnId });
  }
  private label(cardId: string, labelId: string, actor: string): void {
    const c = this.cards.get(cardId);
    if (!c) throw new Error(`card ${cardId} not found`);
    if (!c.labelIds.includes(labelId)) {
      const name = this.labels.find((l) => l.id === labelId)?.name ?? labelId;
      this.patch(cardId, {
        labelIds: [...c.labelIds, labelId],
        labelNames: [...c.labelNames, name],
      });
    }
    this.emit('card.labeled', cardId, actor, { labelId });
  }
  private patch(cardId: string, p: Partial<BoardCard>): void {
    const c = this.cards.get(cardId);
    if (!c) return;
    this.cards.set(cardId, { ...c, ...p, changedAt: this.now() });
  }
  private emit(
    kind: BoardEventKind,
    cardId: string,
    actor: string,
    d: Partial<Pick<BoardEvent, 'fromColumnId' | 'toColumnId' | 'labelId' | 'memberId'>>,
  ): void {
    this.events.push({
      eventId: `fake:${++this.seq}`,
      kind,
      provider: 'trello',
      boardId: this.boardId,
      cardId,
      occurredAt: this.now(),
      actorMemberId: actor,
      fromColumnId: d.fromColumnId ?? null,
      toColumnId: d.toColumnId ?? null,
      labelId: d.labelId ?? null,
      memberId: d.memberId ?? null,
      card: this.cards.get(cardId) ?? null,
      synthetic: false,
    });
  }
  private now(): string {
    return new Date(Date.UTC(2026, 0, 1) + this.seq * 1000).toISOString();
  }
}
