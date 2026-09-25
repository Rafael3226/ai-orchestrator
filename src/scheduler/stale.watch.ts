import type { BoardSource } from '../board/board.source.js';
import type { BoardStore } from '../board/board.store.js';
import { type BoardCard, type BoardTopology, normalizeColumnName } from '../board/board.types.js';
import type { ProjectConfig } from '../config/config.loader.js';
import type { Role } from '../config/config.schema.js';
import type { SqliteStore } from '../db/sqlite.store.js';
import type { AttentionItem } from '../server/state.types.js';

/**
 * When each card entered its current column, and whether we already said so.
 * The provider's `changedAt` cannot answer "how long has this sat here": our
 * own comments and labels bump it.
 */
const STALE_DDL = `
CREATE TABLE IF NOT EXISTS card_positions (
  project_id  TEXT NOT NULL,
  card_id     TEXT NOT NULL,
  column_id   TEXT NOT NULL,
  column_name TEXT NOT NULL,
  short_id    TEXT NOT NULL,
  title       TEXT NOT NULL,
  url         TEXT NOT NULL,
  since       TEXT NOT NULL,
  flagged_at  TEXT,
  PRIMARY KEY (project_id, card_id)
);
`;

interface PositionRow {
  project_id: string;
  card_id: string;
  column_id: string;
  column_name: string;
  short_id: string;
  title: string;
  url: string;
  since: string;
  flagged_at: string | null;
}

export interface StaleWatchLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

const HOUR = 3600_000;
const LIVE = "('queued','claimed','preparing','running','verifying','publishing')";
const NEEDS_HUMAN = "('needs_human','blocked','failed')";
/** Older unresolved failures stop being news. */
const NEEDS_HUMAN_WINDOW_MS = 14 * 24 * HOUR;

/** One card as this check sees it, with what we recorded last time. */
interface Sighting {
  readonly card: BoardCard;
  readonly columnName: string;
  readonly row: PositionRow | undefined;
}

interface StuckTaskRow {
  project_id: string;
  card_id: string;
  card_short_id: string;
  card_url: string;
  title: string;
  role: string;
  state: string;
  blocked_reason: string | null;
  last_error: string | null;
  updated_at: string;
}

interface DeadOutboxRow {
  project_id: string;
  card_id: string;
  op: string;
  last_error: string | null;
  settled_at: string | null;
  created_at: string;
  card_short_id: string | null;
  card_url: string | null;
  title: string | null;
  role: string | null;
}

/**
 * Finds work that stopped moving: a card that has sat in one column past its
 * threshold with nothing running on it. It labels the card and comments once
 * (through the outbox, like every board write), and clears the label when the
 * card moves on. The office Attention panel reads the same table.
 */
export class StaleWatch {
  constructor(
    private readonly store: SqliteStore,
    private readonly boardStore: BoardStore,
    private readonly log: StaleWatchLogger,
  ) {
    store.db.exec(STALE_DDL);
  }

  async check(
    project: ProjectConfig,
    source: BoardSource,
    topology: BoardTopology,
    now = Date.now(),
  ): Promise<number> {
    if (!project.flow.stale.enabled) return 0;
    const cards = await source.listCards();
    const known = new Map(this.positions(project.id).map((r) => [r.card_id, r]));
    let flagged = 0;
    for (const card of cards) {
      const row = known.get(card.id);
      known.delete(card.id);
      const columnName = topology.columns.find((c) => c.id === card.columnId)?.name;
      const current = this.track(
        project,
        { card, columnName: columnName ?? card.columnId, row },
        now,
      );
      if (current && this.isStale(project, current, now)) {
        this.flag(project, current, now);
        flagged++;
      }
    }
    // Cards that left the watched columns (closed, archived, moved off-board) stop being tracked.
    const drop = this.store.db.prepare(
      'DELETE FROM card_positions WHERE project_id = ? AND card_id = ?',
    );
    for (const gone of known.values()) drop.run(project.id, gone.card_id);
    return flagged;
  }

  /**
   * Record where the card is. Returns the row when the card has not moved
   * since the last check (so it may be stale), null when it just arrived.
   */
  private track(project: ProjectConfig, seen: Sighting, now: number): PositionRow | null {
    const { card, columnName, row } = seen;
    if (row && row.column_id === card.columnId) return row;
    if (row?.flagged_at) this.unflag(project, card.id, row, project.flow.stale.label);
    const nowIso = new Date(now).toISOString();
    this.upsert({
      project_id: project.id,
      card_id: card.id,
      column_id: card.columnId,
      column_name: columnName,
      short_id: card.shortId,
      title: card.title,
      url: card.url,
      // First sighting: the provider's change stamp is the best guess we have.
      since: row ? nowIso : card.changedAt || nowIso,
      flagged_at: null,
    });
    return null;
  }

  private isStale(project: ProjectConfig, row: PositionRow, now: number): boolean {
    if (row.flagged_at) return false;
    const closed = aliasColumn(project, project.flow.closed);
    if (closed && sameColumn(row.column_name, closed)) return false;
    if (this.store.hasActiveTaskForCard(project.id, row.card_id)) return false;
    return (now - Date.parse(row.since)) / HOUR >= thresholdHours(project, row.column_name);
  }

  /** Label and comment once, through the outbox like every board write. */
  private flag(project: ProjectConfig, row: PositionRow, now: number): void {
    const hours = thresholdHours(project, row.column_name);
    const age = Math.floor((now - Date.parse(row.since)) / HOUR);
    const owner = ownerOf(project, row.column_name);
    const key = `stale:${row.card_id}:${row.column_id}:${row.since}`;
    const base = { projectId: project.id, taskId: null, cardId: row.card_id };
    this.boardStore.enqueue({
      ...base,
      op: 'add-label',
      payload: { label: project.flow.stale.label },
      idempotencyKey: `${key}:label`,
    });
    const waiting = owner
      ? `It is waiting on **${owner}**.`
      : 'No agent picks up this column — it needs a person.';
    this.boardStore.enqueue({
      ...base,
      op: 'comment',
      payload: {
        body:
          `⏳ This card has been in **${row.column_name}** for ${age} h with nothing running ` +
          `(threshold ${hours} h). ${waiting}`,
        marker: `stale ${row.column_id} ${row.since}`,
      },
      idempotencyKey: `${key}:comment`,
    });
    this.store.db
      .prepare('UPDATE card_positions SET flagged_at = ? WHERE project_id = ? AND card_id = ?')
      .run(new Date(now).toISOString(), project.id, row.card_id);
    this.log.warn(`${project.id}: [${row.short_id}] stale in "${row.column_name}" for ${age} h`);
  }

  /** Everything the office should show as needing a person, newest first. */
  attention(projects: readonly ProjectConfig[]): AttentionItem[] {
    if (!projects.length) return [];
    const ids = projects.map((p) => p.id);
    return [
      ...this.staleItems(ids),
      ...this.needsHumanItems(projects),
      ...this.deadItems(ids),
    ].sort((a, b) => b.since.localeCompare(a.since));
  }

  private staleItems(ids: readonly string[]): AttentionItem[] {
    const rows = this.store.db
      .prepare(
        `SELECT * FROM card_positions WHERE flagged_at IS NOT NULL AND project_id IN (${marks(ids)})`,
      )
      .all(...ids) as PositionRow[];
    return rows.map((r) => ({
      kind: 'stale-card',
      projectId: r.project_id,
      cardId: r.card_id,
      cardShortId: r.short_id,
      cardUrl: r.url,
      title: r.title,
      reason: `in "${r.column_name}" since ${r.since.slice(0, 16).replace('T', ' ')}`,
      role: null,
      since: r.flagged_at ?? r.since,
    }));
  }

  /**
   * The latest task per card, when it ended needing a human, nothing has run
   * since, and nobody has moved the card on into an agent's or the closed column.
   */
  private needsHumanItems(projects: readonly ProjectConfig[]): AttentionItem[] {
    const ids = projects.map((p) => p.id);
    const stuck = this.store.db
      .prepare(
        `SELECT t.* FROM tasks t
         WHERE t.state IN ${NEEDS_HUMAN} AND t.project_id IN (${marks(ids)})
           AND t.updated_at >= ?
           AND NOT EXISTS (
             SELECT 1 FROM tasks n WHERE n.project_id = t.project_id AND n.card_id = t.card_id
               AND (n.created_at > t.created_at OR n.state IN ${LIVE}))`,
      )
      .all(...ids, new Date(Date.now() - NEEDS_HUMAN_WINDOW_MS).toISOString()) as StuckTaskRow[];
    const positions = new Map(
      (
        this.store.db
          .prepare(`SELECT * FROM card_positions WHERE project_id IN (${marks(ids)})`)
          .all(...ids) as PositionRow[]
      ).map((r) => [`${r.project_id}:${r.card_id}`, r]),
    );
    const byId = new Map(projects.map((p) => [p.id, p]));
    return stuck
      .filter((t) => {
        const pos = positions.get(`${t.project_id}:${t.card_id}`);
        const project = byId.get(t.project_id);
        return !(pos && project && handledColumn(project, pos.column_name));
      })
      .map((t) => ({
        kind: 'needs-human',
        projectId: t.project_id,
        cardId: t.card_id,
        cardShortId: t.card_short_id,
        cardUrl: t.card_url || null,
        title: t.title,
        reason: stuckReason(t),
        role: t.role,
        since: t.updated_at,
      }));
  }

  private deadItems(ids: readonly string[]): AttentionItem[] {
    const rows = this.store.db
      .prepare(
        `SELECT o.*, t.card_short_id, t.card_url, t.title, t.role FROM writeback_outbox o
         LEFT JOIN tasks t ON t.id = o.task_id
         WHERE o.state = 'dead' AND o.project_id IN (${marks(ids)})
         ORDER BY o.id DESC LIMIT 50`,
      )
      .all(...ids) as DeadOutboxRow[];
    return rows.map((o) => ({
      kind: 'dead-writeback',
      projectId: o.project_id,
      cardId: o.card_id,
      cardShortId: o.card_short_id,
      cardUrl: o.card_url,
      title: o.title ?? `(${o.op})`,
      reason: `${o.op} gave up: ${(o.last_error ?? 'unknown error').slice(0, 160)}`,
      role: o.role,
      since: o.settled_at ?? o.created_at,
    }));
  }

  private positions(projectId: string): PositionRow[] {
    return this.store.db
      .prepare('SELECT * FROM card_positions WHERE project_id = ?')
      .all(projectId) as PositionRow[];
  }

  private upsert(r: PositionRow): void {
    this.store.db
      .prepare(
        `INSERT INTO card_positions (project_id, card_id, column_id, column_name, short_id, title, url, since, flagged_at)
         VALUES (@project_id, @card_id, @column_id, @column_name, @short_id, @title, @url, @since, @flagged_at)
         ON CONFLICT(project_id, card_id) DO UPDATE SET
           column_id = excluded.column_id, column_name = excluded.column_name,
           short_id = excluded.short_id, title = excluded.title, url = excluded.url,
           since = excluded.since, flagged_at = excluded.flagged_at`,
      )
      .run(r);
  }

  private unflag(project: ProjectConfig, cardId: string, row: PositionRow, label: string): void {
    this.boardStore.enqueue({
      projectId: project.id,
      taskId: null,
      cardId,
      op: 'remove-label',
      payload: { label },
      idempotencyKey: `stale:${cardId}:${row.column_id}:${row.since}:unlabel`,
    });
  }
}

const marks = (ids: readonly string[]): string => ids.map(() => '?').join(',');

const sameColumn = (a: string, b: string): boolean =>
  normalizeColumnName(a) === normalizeColumnName(b);

/** Moved on into an agent's column, or closed: someone is handling it. */
function handledColumn(project: ProjectConfig, column: string): boolean {
  const closed = aliasColumn(project, project.flow.closed);
  return (closed !== null && sameColumn(closed, column)) || ownerOf(project, column) !== null;
}

function stuckReason(t: StuckTaskRow): string {
  const detail = (t.blocked_reason ?? t.last_error ?? '').split(/\r?\n/)[0]?.slice(0, 160);
  return `${t.role} ended ${t.state.replace('_', ' ')}${detail ? `: ${detail}` : ''}`;
}

function aliasColumn(project: ProjectConfig, alias: string | undefined): string | null {
  return alias ? (project.board.columns[alias] ?? null) : null;
}

/** Per-column threshold by alias, falling back to the default. */
function thresholdHours(project: ProjectConfig, columnName: string): number {
  const stale = project.flow.stale;
  for (const [alias, hours] of Object.entries(stale.columns)) {
    const name = project.board.columns[alias];
    if (name && normalizeColumnName(name) === normalizeColumnName(columnName)) return hours;
  }
  return stale.defaultHours;
}

/** The role whose home this column is, if any — who the card is waiting on. */
function ownerOf(project: ProjectConfig, columnName: string): Role | null {
  for (const [role, home] of Object.entries(project.flow.homes)) {
    if (home && normalizeColumnName(home.column) === normalizeColumnName(columnName)) {
      return role as Role;
    }
  }
  return null;
}
