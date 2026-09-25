import {
  BoardError,
  type BoardCapabilities,
  type BoardPollResult,
  type BoardSource,
} from '../board/board.source.js';
import type {
  BoardCard,
  BoardColumn,
  BoardComment,
  BoardEvent,
  BoardEventKind,
  BoardLabel,
  BoardMember,
  BoardProviderKey,
  BoardTopology,
  CardFields,
  NewCard,
} from '../board/board.types.js';

export interface FakeBoardOptions {
  /** Which provider to impersonate; only the key and label semantics change. */
  readonly provider?: BoardProviderKey;
  /** Azure DevOps / Jira: labels are created on first use, and their id is the name. */
  readonly freeformLabels?: boolean;
  /** Each defaults to true; turn one off to exercise the writer's degraded paths. */
  readonly canCreateCard?: boolean;
  readonly canCreateSubtask?: boolean;
  readonly canSetFields?: boolean;
  /** Fields setFields reports as unsupported, like Trello's priority and points. */
  readonly unsupportedFields?: readonly (keyof CardFields)[];
}

/**
 * In-memory board. Every mutation (from a test OR from writeback) appends an
 * event, exactly like Trello's actions feed — so the loop guard and the router
 * are exercised for real without a network.
 */
export class FakeBoardSource implements BoardSource {
  readonly provider: BoardProviderKey;
  readonly capabilities: BoardCapabilities;

  readonly columns: BoardColumn[];
  readonly labels: BoardLabel[];
  readonly members: BoardMember[];
  readonly cards = new Map<string, BoardCard>();
  readonly comments = new Map<string, BoardComment[]>();
  readonly events: BoardEvent[] = [];
  /** Planning fields as the board holds them, per card id. */
  readonly fields = new Map<string, CardFields>();
  /** parent card id -> child card ids, in creation order. */
  readonly children = new Map<string, string[]>();
  /** The NewCard each created card came from, per card id. */
  readonly created = new Map<string, NewCard>();
  private readonly unsupportedFields: readonly (keyof CardFields)[];
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
    opts: FakeBoardOptions = {},
  ) {
    this.provider = opts.provider ?? 'trello';
    this.capabilities = {
      hasChangeFeed: true,
      canComment: true,
      canMoveCard: true,
      canAssignMember: true,
      canAddLabel: true,
      labelsAreFreeform: opts.freeformLabels ?? false,
      canRegisterWebhook: false,
      canCreateCard: opts.canCreateCard ?? true,
      canCreateSubtask: opts.canCreateSubtask ?? true,
      canSetFields: opts.canSetFields ?? true,
    };
    this.unsupportedFields = opts.unsupportedFields ?? [];
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
    if (!c) throw new BoardError('not-found', `card ${cardId} not found`, 404);
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
    const keep = c.labelIds
      .map((id, i) => [id, c.labelNames[i] ?? id] as const)
      .filter(([id]) => id !== labelId);
    this.patch(cardId, { labelIds: keep.map(([id]) => id), labelNames: keep.map(([, n]) => n) });
    this.emit('card.unlabeled', cardId, this.botId, { labelId });
  }
  async assignMember(cardId: string, memberId: string): Promise<void> {
    const c = await this.getCard(cardId);
    if (!c.memberIds.includes(memberId))
      this.patch(cardId, { memberIds: [...c.memberIds, memberId] });
    this.emit('card.assigned', cardId, this.botId, { memberId });
  }
  async createCard(input: NewCard): Promise<BoardCard> {
    if (input.parentId && !this.cards.has(input.parentId)) {
      throw new BoardError('not-found', `parent ${input.parentId} not found`, 404);
    }
    const shortId = `N${++this.seq}`;
    const card: BoardCard = {
      id: `card-${shortId}`,
      shortId,
      url: `https://fake/c/${shortId}`,
      title: input.title,
      description: input.description,
      columnId: input.columnId ?? this.columns[0]?.id ?? '',
      labelIds: [],
      labelNames: [],
      memberIds: [],
      closed: false,
      changedAt: this.now(),
    };
    this.cards.set(card.id, card);
    this.created.set(card.id, input);
    if (input.parentId) {
      this.children.set(input.parentId, [...(this.children.get(input.parentId) ?? []), card.id]);
    }
    this.emit('card.created', card.id, this.botId, { toColumnId: card.columnId });
    return card;
  }
  async setFields(cardId: string, fields: CardFields): Promise<readonly (keyof CardFields)[]> {
    await this.getCard(cardId);
    const unsupported = this.unsupportedFields.filter((k) => fields[k] !== undefined);
    const kept = Object.fromEntries(
      Object.entries(fields).filter(
        ([k, v]) => v !== undefined && !unsupported.includes(k as keyof CardFields),
      ),
    ) as CardFields;
    this.fields.set(cardId, { ...this.fields.get(cardId), ...kept });
    this.patch(cardId, {});
    this.emit('card.updated', cardId, this.botId, {});
    return unsupported;
  }
  async listChildren(cardId: string): Promise<readonly BoardCard[]> {
    return (this.children.get(cardId) ?? [])
      .map((id) => this.cards.get(id))
      .filter((c): c is BoardCard => c !== undefined);
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
      provider: this.provider,
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
  /** Real wall clock (plus a ms per event for strict ordering) so echo detection behaves as in production. */
  private now(): string {
    return new Date(Date.now() + this.seq).toISOString();
  }
}
