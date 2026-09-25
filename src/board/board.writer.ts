import type { ProjectConfig } from '../config/config.loader.js';
import type { HandTarget, WritebackStep } from '../config/config.schema.js';
import type { TaskId } from '../domain/ids.js';
import type { BoardRouter } from '../router/board.router.js';

import {
  type AgentBoardAction,
  renderDraftDescription,
  type WorkItemDraft,
} from './board.actions.js';
import { BoardError, type BoardSource } from './board.source.js';
import type { BoardStore, OutboxOp, OutboxRow } from './board.store.js';
import {
  type BoardCard,
  type BoardColumn,
  type BoardTopology,
  type CardFields,
  type NewCard,
  findColumnByName,
  findLabelByName,
} from './board.types.js';

/** Added when the bounce cap diverts a card to a human. */
export const LOOP_LABEL = 'ai-loop';
/** Effectively "ever": the bounce cap counts every dispatch of a role for a card. */
const ALL_TIME_MS = 100 * 365 * 24 * 3600_000;

export interface WriterLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

const MAX_ATTEMPTS = 6;
const backoff = (attempt: number): number => Math.min(4 * 60_000, 2_000 * 2 ** attempt);

/**
 * Every board mutation goes through the outbox, so a crash between "agent
 * finished" and "comment posted" loses nothing. Single-threaded drain keeps
 * ordering (move, then comment). Each op is idempotent on delivery.
 */
export interface WriterOptions {
  /**
   * Called after one of OUR moves has settled on the board. It is how a role
   * hands a card to the next one: the move is suppressed as an echo by design,
   * so the re-route has to be triggered from here rather than waiting for a
   * poll that will drop it. Defaults to a noop.
   */
  readonly onMoved?: (cardId: string) => void;
  /** Called when a create-card op produced a card. The chat uses it to show the link. */
  readonly onCreated?: (row: OutboxRow, card: BoardCard) => void;
}

/** Where a hand-off resolves to on the board. */
interface Destination {
  readonly column: BoardColumn;
  readonly label: string | null;
  /** The role the card is being handed to, when it is one. */
  readonly role: string | null;
}

export class BoardWriter {
  constructor(
    private readonly project: ProjectConfig,
    private readonly source: BoardSource,
    private readonly boardStore: BoardStore,
    private readonly router: BoardRouter,
    private readonly log: WriterLogger,
    private readonly opts: WriterOptions = {},
  ) {}

  /** Expand a configured writeback step into outbox rows. Called from the task lifecycle. */
  enqueueStep(
    stepName: 'onStart' | 'onSuccess' | 'onFailure' | 'onBlocked',
    step: WritebackStep,
    taskId: TaskId,
    cardId: string,
    comment: string | null,
  ): void {
    const key = (op: string, extra = '') =>
      `${taskId}:${stepName}:${op}${extra ? ':' + extra : ''}`;
    const p = this.project;
    if (step.handTo) {
      this.boardStore.enqueue({
        projectId: p.id,
        taskId,
        cardId,
        op: 'hand-to',
        payload: { target: step.handTo },
        idempotencyKey: key('hand-to'),
      });
    }
    if (step.move) {
      this.boardStore.enqueue({
        projectId: p.id,
        taskId,
        cardId,
        op: 'move',
        payload: { alias: step.move },
        idempotencyKey: key('move'),
      });
    }
    if (step.assign === 'bot' && p.board.botMemberId) {
      this.boardStore.enqueue({
        projectId: p.id,
        taskId,
        cardId,
        op: 'assign',
        payload: { memberId: p.board.botMemberId },
        idempotencyKey: key('assign'),
      });
    }
    for (const label of toList(step.addLabel)) {
      this.boardStore.enqueue({
        projectId: p.id,
        taskId,
        cardId,
        op: 'add-label',
        payload: { label },
        idempotencyKey: key('add-label', label),
      });
    }
    for (const label of toList(step.removeLabel)) {
      this.boardStore.enqueue({
        projectId: p.id,
        taskId,
        cardId,
        op: 'remove-label',
        payload: { label },
        idempotencyKey: key('remove-label', label),
      });
    }
    if (step.comment !== 'none' && comment) {
      this.boardStore.enqueue({
        projectId: p.id,
        taskId,
        cardId,
        op: 'comment',
        payload: { body: comment, marker: `run \`${taskId}\`` },
        idempotencyKey: key('comment'),
      });
    }
  }

  /**
   * Queue what an agent asked for during its run. Call this BEFORE enqueueStep:
   * the outbox drains in order, and a sub-task should exist before the move
   * that wakes the role who will read it. `reassign` is not queued here — it
   * changes the step's destination (see planFinishStep).
   */
  enqueueActions(
    taskId: TaskId | null,
    cardId: string,
    actions: readonly AgentBoardAction[],
    keyPrefix: string = taskId ?? 'manual',
  ): void {
    const p = this.project;
    actions.forEach((a, i) => {
      const key = `${keyPrefix}:action:${i}:${a.kind}`;
      const base = { projectId: p.id, taskId, cardId, idempotencyKey: key };
      if (a.kind === 'create') {
        this.boardStore.enqueue({ ...base, op: 'create-card', payload: { item: a.item } });
      } else if (a.kind === 'set-fields') {
        this.boardStore.enqueue({
          ...base,
          op: 'set-fields',
          payload: { fields: a.fields, rationale: a.rationale },
        });
      } else if (a.kind === 'comment') {
        this.boardStore.enqueue({
          ...base,
          op: 'comment',
          payload: { body: a.body, marker: `${keyPrefix} note ${i}` },
        });
      }
    });
  }

  /** Drain due rows for THIS project. Returns how many were attempted. */
  async drain(topology: BoardTopology): Promise<number> {
    const rows = this.boardStore.dueOutbox(20).filter((r) => r.project_id === this.project.id);
    for (const row of rows) await this.deliver(row, topology);
    return rows.length;
  }

  private async deliver(row: OutboxRow, topology: BoardTopology): Promise<void> {
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    try {
      const outcome = await this.apply(row, payload, topology);
      if (row.card_id) this.router.noteWriteback(row.card_id);
      this.boardStore.settleOutbox(row.id, outcome);
      this.log.info(
        `${this.project.id}: writeback ${row.op} on ${row.card_id || '(new card)'} → ${outcome}`,
      );
      if ((row.op === 'move' || row.op === 'hand-to') && outcome === 'done') {
        this.opts.onMoved?.(row.card_id);
      }
    } catch (err) {
      const e =
        err instanceof BoardError
          ? err
          : new BoardError('unavailable', err instanceof Error ? err.message : String(err));
      if (e.kind === 'not-found')
        return this.boardStore.settleOutbox(row.id, 'skipped', 'card gone');
      if (e.kind === 'permission') return this.boardStore.settleOutbox(row.id, 'dead', e.message);
      if (e.kind === 'auth') {
        this.log.warn(`${this.project.id}: board auth failed — leaving outbox pending`);
        return this.boardStore.retryOutbox(row.id, 5 * 60_000, e.message);
      }
      if (row.attempts + 1 >= MAX_ATTEMPTS)
        return this.boardStore.settleOutbox(row.id, 'dead', e.message);
      const delay = e.retryAfterMs ?? backoff(row.attempts);
      this.boardStore.retryOutbox(row.id, delay, e.message);
      this.log.warn(
        `${this.project.id}: writeback ${row.op} failed (${e.kind}), retry in ${Math.round(delay / 1000)}s: ${e.message}`,
      );
    }
  }

  private async apply(
    row: OutboxRow,
    payload: Record<string, unknown>,
    topology: BoardTopology,
  ): Promise<'done' | 'skipped'> {
    const op: OutboxOp = row.op;
    const cardId = row.card_id;
    const str = (k: string): string => {
      const v = payload[k];
      return typeof v === 'string' ? v : '';
    };
    const caps = this.source.capabilities;
    switch (op) {
      case 'hand-to': {
        if (!caps.canMoveCard) return 'skipped';
        const dest = this.destination(str('target') as HandTarget, cardId, topology);
        await this.moveTo(cardId, dest, topology);
        return 'done';
      }
      case 'create-card':
        return this.createCard(row, payload['item'] as WorkItemDraft, topology);
      case 'set-fields': {
        if (!caps.canSetFields) return 'skipped';
        const missing = await this.source.setFields(cardId, payload['fields'] as CardFields);
        if (missing.length) {
          this.log.warn(
            `${this.project.id}: ${cardId}: the board does not store ${missing.join(', ')} — left in the report only`,
          );
        }
        return 'done';
      }
      case 'move': {
        if (!caps.canMoveCard) return 'skipped';
        const col = this.aliasColumn(str('alias'), topology);
        const card = await this.source.getCard(cardId);
        if (card.columnId === col.id) return 'done'; // already there — idempotent
        await this.source.moveCard(cardId, col.id);
        return 'done';
      }
      case 'comment': {
        if (!caps.canComment) return 'skipped';
        const marker = str('marker');
        const recent = await this.source.listRecentComments(cardId, 20);
        if (marker && recent.some((c) => c.text.includes(marker))) return 'done';
        await this.source.comment(cardId, str('body'));
        return 'done';
      }
      case 'add-label':
      case 'remove-label': {
        if (!caps.canAddLabel) return 'skipped';
        const name = str('label').trim();
        // Freeform providers (Azure DevOps tags, Jira labels) create a label on
        // first use, and their label id IS the name.
        const label =
          findLabelByName(topology, name) ??
          (caps.labelsAreFreeform && name ? { id: name, name, color: null } : undefined);
        if (!label) {
          this.log.warn(
            `${this.project.id}: label "${name}" does not exist on the board — skipped`,
          );
          return 'skipped';
        }
        if (op === 'add-label') await this.source.addLabel(cardId, label.id);
        else await this.source.removeLabel(cardId, label.id);
        return 'done';
      }
      case 'assign': {
        if (!caps.canAssignMember) return 'skipped';
        await this.source.assignMember(cardId, str('memberId'));
        return 'done';
      }
    }
  }

  private aliasColumn(alias: string, topology: BoardTopology): BoardColumn {
    const name = this.project.board.columns[alias];
    const col = name ? findColumnByName(topology, name) : undefined;
    if (!col) {
      throw new BoardError('permission', `column alias "${alias}" does not resolve on the board`);
    }
    return col;
  }

  /**
   * A role's home column (derived from its routes at load), or the human
   * column. The bounce cap lives here: a role that has already been handed
   * this card `maxBounces` times sends it to a human instead, labelled.
   */
  private destination(target: HandTarget, cardId: string, topology: BoardTopology): Destination {
    const flow = this.project.flow;
    const human = (): Destination => {
      if (!flow.humanColumn) {
        throw new BoardError('permission', 'hand-off to a human needs flow.humanColumn');
      }
      return { column: this.aliasColumn(flow.humanColumn, topology), label: null, role: null };
    };
    if (target === 'human') return human();
    const home = flow.homes[target];
    if (!home) {
      throw new BoardError('permission', `${target} has no home column to hand the card to`);
    }
    if (cardId && this.bouncedTooOften(cardId, target)) return { ...human(), label: LOOP_LABEL };
    const column = findColumnByName(topology, home.column);
    if (!column) {
      throw new BoardError('permission', `${target}'s column "${home.column}" is not on the board`);
    }
    return { column, label: home.label, role: target };
  }

  /** The bounce cap: this role has already been handed the card `maxBounces` times. */
  private bouncedTooOften(cardId: string, role: HandTarget): boolean {
    const flow = this.project.flow;
    if (!flow.humanColumn) return false;
    const handed = this.boardStore.recentDispatchCount(this.project.id, cardId, ALL_TIME_MS, role);
    if (handed < flow.maxBounces) return false;
    this.log.warn(
      `${this.project.id}: ${cardId} has gone to ${role} ${handed} times — handing it to a human`,
    );
    return true;
  }

  private async moveTo(cardId: string, dest: Destination, topology: BoardTopology): Promise<void> {
    const card = await this.source.getCard(cardId);
    if (card.columnId !== dest.column.id) await this.source.moveCard(cardId, dest.column.id);
    if (dest.label) await this.addLabelByName(cardId, dest.label, topology);
  }

  private async addLabelByName(
    cardId: string,
    name: string,
    topology: BoardTopology,
  ): Promise<void> {
    const caps = this.source.capabilities;
    if (!caps.canAddLabel) return;
    const label =
      findLabelByName(topology, name) ??
      (caps.labelsAreFreeform ? { id: name, name, color: null } : undefined);
    if (label) await this.source.addLabel(cardId, label.id);
    else this.log.warn(`${this.project.id}: label "${name}" does not exist on the board — skipped`);
  }

  /**
   * At-least-once like every op: a crash between the provider accepting the
   * card and the row settling can create it twice. That is the price of never
   * losing one, and a duplicate is visible where a lost card is not.
   */
  private async createCard(
    row: OutboxRow,
    item: WorkItemDraft,
    topology: BoardTopology,
  ): Promise<'done' | 'skipped'> {
    const parentId = item.parent === 'current' ? row.card_id || undefined : item.parent;
    const input = { ...item, description: renderDraftDescription(item), parentId };
    const early = await this.subtaskGuard(input);
    if (early) return early;
    if (!this.source.capabilities.canCreateCard) return 'skipped';

    const target = this.newItemTarget(item);
    const place =
      target === 'none' ? null : { target, dest: this.destination(target, '', topology) };
    const columnId = place?.dest.column.id ?? (await this.defaultColumn(row, topology));
    const card = await this.source.createCard(newCard(input, columnId));
    this.log.info(`${this.project.id}: created ${item.type} [${card.shortId}] ${item.title}`);
    // Settle before the move: a failed move must be retried as a move, never as a second create.
    this.boardStore.settleOutbox(row.id, 'done');
    this.opts.onCreated?.(row, card);
    if (place) await this.placeCreated(row, card, place, topology);
    return 'done';
  }

  /**
   * A sub-task needs a parent; on a board without sub-tasks it degrades to a
   * comment on the parent. Returns the outcome when it handled the item.
   */
  private async subtaskGuard(input: DraftInput): Promise<'done' | 'skipped' | null> {
    if (input.type !== 'subtask') return null;
    if (!input.parentId) throw new BoardError('permission', 'a sub-task needs a parent card');
    if (this.source.capabilities.canCreateSubtask) return null;
    return this.subtaskAsComment(input.parentId, input.title, input.description);
  }

  /** Degrade visibly rather than drop it: the parent carries the sub-task as a comment. */
  private async subtaskAsComment(
    parentId: string,
    title: string,
    description: string,
  ): Promise<'done' | 'skipped'> {
    if (!this.source.capabilities.canComment) return 'skipped';
    await this.source.comment(parentId, `### Sub-task: ${title}\n\n${description}`);
    return 'done';
  }

  private newItemTarget(item: WorkItemDraft): HandTarget | 'none' {
    return item.assignTo === undefined || item.assignTo === 'default'
      ? (this.project.flow.newItems[item.type] ?? 'none')
      : item.assignTo;
  }

  /** Trello has no initial state: a card must be created in some list. Others need none. */
  private async defaultColumn(
    row: OutboxRow,
    topology: BoardTopology,
  ): Promise<string | undefined> {
    if (this.source.provider !== 'trello') return undefined;
    return row.card_id
      ? (await this.source.getCard(row.card_id)).columnId
      : topology.columns[0]?.id;
  }

  private async placeCreated(
    row: OutboxRow,
    card: BoardCard,
    to: { dest: Destination; target: HandTarget },
    topology: BoardTopology,
  ): Promise<void> {
    try {
      await this.moveTo(card.id, to.dest, topology);
      this.router.noteWriteback(card.id);
      if (to.dest.role) this.opts.onMoved?.(card.id);
    } catch (err) {
      // The create row is settled, so the move gets a row of its own and the usual retries.
      this.boardStore.enqueue({
        projectId: this.project.id,
        taskId: row.task_id,
        cardId: card.id,
        op: 'hand-to',
        payload: { target: to.target },
        idempotencyKey: `${row.idempotency_key}:hand-to`,
      });
      const why = err instanceof Error ? err.message : String(err);
      this.log.warn(
        `${this.project.id}: [${card.shortId}] created but not yet moved (${why}) — retrying`,
      );
    }
  }
}

type DraftInput = WorkItemDraft & {
  readonly description: string;
  readonly parentId: string | undefined;
};

function newCard(input: DraftInput, columnId: string | undefined): NewCard {
  return {
    type: input.type,
    title: input.title,
    description: input.description,
    ...(input.parentId ? { parentId: input.parentId } : {}),
    ...(columnId ? { columnId } : {}),
  };
}

const toList = (v: string | string[] | undefined): string[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];
