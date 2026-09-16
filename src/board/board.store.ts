import type { SqliteStore } from '../db/sqlite.store.js';
import type { TaskId } from '../domain/ids.js';

/** Board-sync tables: cursors, dedupe, arrival counters, dispatch ledger, outbox, reports. */
export const BOARD_DDL = `
CREATE TABLE IF NOT EXISTS board_cursors (
  project_id      TEXT PRIMARY KEY,
  cursor          TEXT,
  last_polled_at  TEXT,
  last_reconcile_at TEXT,
  tick            INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS board_events_seen (
  event_id   TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  seen_at    TEXT NOT NULL
);

-- How many times a card has ENTERED a given column. Part of the dedupe key so
-- moving a card out and back in legitimately re-dispatches it.
CREATE TABLE IF NOT EXISTS card_arrivals (
  project_id TEXT NOT NULL,
  card_id    TEXT NOT NULL,
  column_id  TEXT NOT NULL,
  arrivals   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, card_id, column_id)
);

CREATE TABLE IF NOT EXISTS dispatch_ledger (
  dedupe_key TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  card_id    TEXT NOT NULL,
  role       TEXT NOT NULL,
  route_id   TEXT NOT NULL,
  task_id    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_card ON dispatch_ledger (project_id, card_id, created_at);

CREATE TABLE IF NOT EXISTS writeback_outbox (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      TEXT NOT NULL,
  task_id         TEXT,
  card_id         TEXT NOT NULL,
  op              TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  state           TEXT NOT NULL CHECK (state IN ('pending','done','skipped','dead')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  settled_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_due ON writeback_outbox (state, next_attempt_at, id);

CREATE TABLE IF NOT EXISTS task_reports (
  task_id    TEXT PRIMARY KEY,
  verdict    TEXT NOT NULL,
  markdown   TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

export type OutboxOp = 'move' | 'comment' | 'add-label' | 'remove-label' | 'assign';

export interface OutboxRow {
  id: number;
  project_id: string;
  task_id: TaskId | null;
  card_id: string;
  op: OutboxOp;
  payload_json: string;
  idempotency_key: string;
  state: 'pending' | 'done' | 'skipped' | 'dead';
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  created_at: string;
  settled_at: string | null;
}

const now = (): string => new Date().toISOString();

export class BoardStore {
  constructor(private readonly store: SqliteStore) {
    store.db.exec(BOARD_DDL);
  }

  private get db() {
    return this.store.db;
  }

  // cursors
  getCursor(projectId: string): {
    cursor: string | null;
    tick: number;
    lastReconcileAt: string | null;
  } {
    const row = this.db
      .prepare('SELECT cursor, tick, last_reconcile_at FROM board_cursors WHERE project_id = ?')
      .get(projectId) as
      { cursor: string | null; tick: number; last_reconcile_at: string | null } | undefined;
    return row
      ? { cursor: row.cursor, tick: row.tick, lastReconcileAt: row.last_reconcile_at }
      : { cursor: null, tick: 0, lastReconcileAt: null };
  }
  setCursor(projectId: string, cursor: string | null, reconciled = false): void {
    this.db
      .prepare(
        `INSERT INTO board_cursors (project_id, cursor, last_polled_at, last_reconcile_at, tick)
         VALUES (@projectId, @cursor, @ts, CASE WHEN @rec THEN @ts ELSE NULL END, 1)
         ON CONFLICT(project_id) DO UPDATE SET
           cursor = excluded.cursor, last_polled_at = excluded.last_polled_at, tick = tick + 1,
           last_reconcile_at = CASE WHEN @rec THEN excluded.last_polled_at ELSE board_cursors.last_reconcile_at END`,
      )
      .run({ projectId, cursor, ts: now(), rec: reconciled ? 1 : 0 });
  }

  /** Returns false if this event id was already processed. */
  markEventSeen(projectId: string, eventId: string): boolean {
    const info = this.db
      .prepare(
        'INSERT OR IGNORE INTO board_events_seen (event_id, project_id, seen_at) VALUES (?, ?, ?)',
      )
      .run(eventId, projectId, now());
    return info.changes === 1;
  }

  /** Increment and return the arrival count for (card, column). */
  recordArrival(projectId: string, cardId: string, columnId: string): number {
    this.db
      .prepare(
        `INSERT INTO card_arrivals (project_id, card_id, column_id, arrivals) VALUES (?, ?, ?, 1)
         ON CONFLICT(project_id, card_id, column_id) DO UPDATE SET arrivals = arrivals + 1`,
      )
      .run(projectId, cardId, columnId);
    return this.getArrivals(projectId, cardId, columnId);
  }
  getArrivals(projectId: string, cardId: string, columnId: string): number {
    const row = this.db
      .prepare(
        'SELECT arrivals FROM card_arrivals WHERE project_id = ? AND card_id = ? AND column_id = ?',
      )
      .get(projectId, cardId, columnId) as { arrivals: number } | undefined;
    return row?.arrivals ?? 0;
  }

  // ledger
  hasLedgerEntry(dedupeKey: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM dispatch_ledger WHERE dedupe_key = ?').get(dedupeKey);
  }
  hasAnyLedgerForCard(projectId: string, cardId: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM dispatch_ledger WHERE project_id = ? AND card_id = ? LIMIT 1')
      .get(projectId, cardId);
  }
  recentDispatchCount(projectId: string, cardId: string, withinMs: number): number {
    const since = new Date(Date.now() - withinMs).toISOString();
    const row = this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM dispatch_ledger WHERE project_id = ? AND card_id = ? AND created_at >= ?',
      )
      .get(projectId, cardId, since) as { n: number };
    return row.n;
  }
  insertLedger(e: {
    dedupeKey: string;
    projectId: string;
    cardId: string;
    role: string;
    routeId: string;
    taskId: TaskId;
  }): void {
    this.db
      .prepare(
        `INSERT INTO dispatch_ledger (dedupe_key, project_id, card_id, role, route_id, task_id, created_at)
         VALUES (@dedupeKey, @projectId, @cardId, @role, @routeId, @taskId, @ts)`,
      )
      .run({ ...e, ts: now() });
  }

  // outbox
  enqueue(e: {
    projectId: string;
    taskId: TaskId | null;
    cardId: string;
    op: OutboxOp;
    payload: unknown;
    idempotencyKey: string;
  }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO writeback_outbox (project_id, task_id, card_id, op, payload_json, idempotency_key, state, next_attempt_at, created_at)
         VALUES (@projectId, @taskId, @cardId, @op, @payload, @idempotencyKey, 'pending', @ts, @ts)`,
      )
      .run({ ...e, payload: JSON.stringify(e.payload), ts: now() });
  }
  dueOutbox(limit = 20): OutboxRow[] {
    return this.db
      .prepare(
        `SELECT * FROM writeback_outbox WHERE state = 'pending' AND next_attempt_at <= ? ORDER BY id LIMIT ?`,
      )
      .all(now(), limit) as OutboxRow[];
  }
  settleOutbox(id: number, state: 'done' | 'skipped' | 'dead', error: string | null = null): void {
    this.db
      .prepare('UPDATE writeback_outbox SET state = ?, last_error = ?, settled_at = ? WHERE id = ?')
      .run(state, error, now(), id);
  }
  retryOutbox(id: number, delayMs: number, error: string): void {
    this.db
      .prepare(
        'UPDATE writeback_outbox SET attempts = attempts + 1, next_attempt_at = ?, last_error = ? WHERE id = ?',
      )
      .run(new Date(Date.now() + delayMs).toISOString(), error, id);
  }
  outboxCounts(): Record<string, number> {
    const rows = this.db
      .prepare('SELECT state, COUNT(*) AS n FROM writeback_outbox GROUP BY state')
      .all() as { state: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.state, r.n]));
  }

  // reports
  saveReport(taskId: TaskId, verdict: string, markdown: string): void {
    this.db
      .prepare(
        `INSERT INTO task_reports (task_id, verdict, markdown, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET verdict = excluded.verdict, markdown = excluded.markdown, created_at = excluded.created_at`,
      )
      .run(taskId, verdict, markdown, now());
  }
  getReport(taskId: TaskId): { verdict: string; markdown: string } | undefined {
    return this.db
      .prepare('SELECT verdict, markdown FROM task_reports WHERE task_id = ?')
      .get(taskId) as { verdict: string; markdown: string } | undefined;
  }

  transaction<T>(fn: () => T): T {
    return this.store.transaction(fn);
  }
}
