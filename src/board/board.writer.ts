import type { ProjectConfig } from '../config/config.loader.js';
import type { WritebackStep } from '../config/config.schema.js';
import type { TaskId } from '../domain/ids.js';
import type { BoardRouter } from '../router/board.router.js';

import { BoardError, type BoardSource } from './board.source.js';
import type { BoardStore, OutboxOp, OutboxRow } from './board.store.js';
import { type BoardTopology, findColumnByName, findLabelByName } from './board.types.js';

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
export class BoardWriter {
  constructor(
    private readonly project: ProjectConfig,
    private readonly source: BoardSource,
    private readonly boardStore: BoardStore,
    private readonly router: BoardRouter,
    private readonly log: WriterLogger,
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

  /** Drain due rows for THIS project. Returns how many were attempted. */
  async drain(topology: BoardTopology): Promise<number> {
    const rows = this.boardStore.dueOutbox(20).filter((r) => r.project_id === this.project.id);
    for (const row of rows) await this.deliver(row, topology);
    return rows.length;
  }

  private async deliver(row: OutboxRow, topology: BoardTopology): Promise<void> {
    const payload = JSON.parse(row.payload_json) as Record<string, string>;
    try {
      const outcome = await this.apply(row.op, row.card_id, payload, topology);
      this.router.noteWriteback(row.card_id);
      this.boardStore.settleOutbox(row.id, outcome);
      this.log.info(`${this.project.id}: writeback ${row.op} on ${row.card_id} → ${outcome}`);
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
    op: OutboxOp,
    cardId: string,
    payload: Record<string, string>,
    topology: BoardTopology,
  ): Promise<'done' | 'skipped'> {
    const caps = this.source.capabilities;
    switch (op) {
      case 'move': {
        if (!caps.canMoveCard) return 'skipped';
        const name = this.project.board.columns[payload['alias'] ?? ''];
        const col = name ? findColumnByName(topology, name) : undefined;
        if (!col)
          throw new BoardError(
            'permission',
            `column alias "${payload['alias']}" does not resolve on the board`,
          );
        const card = await this.source.getCard(cardId);
        if (card.columnId === col.id) return 'done'; // already there — idempotent
        await this.source.moveCard(cardId, col.id);
        return 'done';
      }
      case 'comment': {
        if (!caps.canComment) return 'skipped';
        const marker = payload['marker'] ?? '';
        const recent = await this.source.listRecentComments(cardId, 20);
        if (marker && recent.some((c) => c.text.includes(marker))) return 'done';
        await this.source.comment(cardId, payload['body'] ?? '');
        return 'done';
      }
      case 'add-label':
      case 'remove-label': {
        if (!caps.canAddLabel) return 'skipped';
        const label = findLabelByName(topology, payload['label'] ?? '');
        if (!label) {
          if (caps.labelsAreFreeform)
            throw new BoardError('permission', 'freeform labels not implemented');
          this.log.warn(
            `${this.project.id}: label "${payload['label']}" does not exist on the board — skipped`,
          );
          return 'skipped';
        }
        if (op === 'add-label') await this.source.addLabel(cardId, label.id);
        else await this.source.removeLabel(cardId, label.id);
        return 'done';
      }
      case 'assign': {
        if (!caps.canAssignMember) return 'skipped';
        await this.source.assignMember(cardId, payload['memberId'] ?? '');
        return 'done';
      }
    }
  }
}

const toList = (v: string | string[] | undefined): string[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];
