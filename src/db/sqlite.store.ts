import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import Database from 'better-sqlite3';

import { type RunId, type TaskId, type WorkspaceId } from '../domain/ids.js';
import { assertTransition, type TaskState } from '../domain/task.state.js';

const SCHEMA_VERSION = 2;

const DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL,
  role           TEXT NOT NULL,
  card_id        TEXT NOT NULL,
  card_short_id  TEXT NOT NULL,
  card_url       TEXT NOT NULL DEFAULT '',
  title          TEXT NOT NULL,
  spec           TEXT NOT NULL DEFAULT '',
  labels_json    TEXT NOT NULL DEFAULT '[]',
  state          TEXT NOT NULL,
  attempts       INTEGER NOT NULL DEFAULT 0,
  max_attempts   INTEGER NOT NULL DEFAULT 2,
  current_run_id TEXT,
  workspace_id   TEXT,
  branch         TEXT,
  pr_url         TEXT,
  blocked_reason TEXT,
  last_error     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks (state, project_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS ux_one_active_task_per_card
  ON tasks (project_id, card_id)
  WHERE state IN ('queued','claimed','preparing','running','verifying','publishing');

CREATE TABLE IF NOT EXISTS workspaces (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  task_id      TEXT,
  path         TEXT NOT NULL UNIQUE,
  branch       TEXT NOT NULL,
  base_branch  TEXT NOT NULL,
  base_sha     TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('active','retained','cleanup_pending','removed')),
  prepare_ms   INTEGER,
  created_at   TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  removed_at   TEXT
);

CREATE TABLE IF NOT EXISTS runs (
  id                       TEXT PRIMARY KEY,
  task_id                  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  project_id               TEXT NOT NULL,
  workspace_id             TEXT,
  attempt                  INTEGER NOT NULL,
  role                     TEXT NOT NULL,
  driver                   TEXT NOT NULL,
  container_id             TEXT,
  image                    TEXT,
  model                    TEXT NOT NULL,
  state                    TEXT NOT NULL CHECK (state IN ('starting','running','finished','interrupted')),
  session_id               TEXT,
  resumed_from             TEXT,
  outcome                  TEXT,
  num_turns                INTEGER,
  duration_ms              INTEGER,
  cost_usd                 REAL,
  cost_usd_reported        REAL,
  cost_estimated           INTEGER NOT NULL DEFAULT 0,
  input_tokens             INTEGER,
  output_tokens            INTEGER,
  cache_read_tokens        INTEGER,
  cache_creation_tokens    INTEGER,
  model_usage_json         TEXT,
  permission_denials_json  TEXT,
  summary_json             TEXT,
  blocked_json             TEXT,
  decisions_json           TEXT NOT NULL DEFAULT '[]',
  verify_exit_code         INTEGER,
  verify_tail              TEXT,
  diff_stat_json           TEXT,
  head_sha                 TEXT,
  pr_url                   TEXT,
  error_text               TEXT,
  started_at               TEXT NOT NULL,
  heartbeat_at             TEXT NOT NULL,
  ended_at                 TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_runs_attempt ON runs (task_id, attempt);

CREATE TABLE IF NOT EXISTS run_events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       TEXT NOT NULL,
  task_id      TEXT NOT NULL,
  ts           TEXT NOT NULL,
  type         TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events (run_id, seq);
`;

export interface TaskRow {
  id: TaskId;
  project_id: string;
  role: string;
  card_id: string;
  card_short_id: string;
  card_url: string;
  title: string;
  spec: string;
  labels_json: string;
  state: TaskState;
  attempts: number;
  max_attempts: number;
  current_run_id: RunId | null;
  workspace_id: WorkspaceId | null;
  branch: string | null;
  pr_url: string | null;
  blocked_reason: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceRow {
  id: WorkspaceId;
  project_id: string;
  task_id: TaskId | null;
  path: string;
  branch: string;
  base_branch: string;
  base_sha: string;
  state: 'active' | 'retained' | 'cleanup_pending' | 'removed';
  prepare_ms: number | null;
  created_at: string;
  last_used_at: string;
  removed_at: string | null;
}

export interface RunRow {
  id: RunId;
  task_id: TaskId;
  project_id: string;
  workspace_id: WorkspaceId | null;
  attempt: number;
  role: string;
  driver: string;
  container_id: string | null;
  image: string | null;
  model: string;
  state: 'starting' | 'running' | 'finished' | 'interrupted';
  session_id: string | null;
  resumed_from: string | null;
  outcome: string | null;
  num_turns: number | null;
  duration_ms: number | null;
  cost_usd: number | null;
  cost_usd_reported: number | null;
  cost_estimated: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  model_usage_json: string | null;
  permission_denials_json: string | null;
  summary_json: string | null;
  blocked_json: string | null;
  decisions_json: string;
  verify_exit_code: number | null;
  verify_tail: string | null;
  diff_stat_json: string | null;
  head_sha: string | null;
  pr_url: string | null;
  error_text: string | null;
  started_at: string;
  heartbeat_at: string;
  ended_at: string | null;
}

export interface RunEventRow {
  seq: number;
  run_id: RunId;
  task_id: TaskId;
  ts: string;
  type: string;
  payload_json: string;
}

const now = (): string => new Date().toISOString();

/**
 * Single-file SQLite store. Synchronous by design: the task state machine wants
 * compare-and-swap transitions inside real transactions.
 */
export class SqliteStore {
  readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = NORMAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(DDL);
    const applied = this.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as {
      v: number | null;
    };
    const from = applied.v ?? 0;

    // v2: which container and image a run used, for the docker driver.
    if (from < 2) {
      for (const column of ['container_id TEXT', 'image TEXT']) {
        try {
          this.db.exec(`ALTER TABLE runs ADD COLUMN ${column}`);
        } catch {
          // Already present: a fresh database gets these from DDL.
        }
      }
    }

    if (from < SCHEMA_VERSION) {
      this.db
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(SCHEMA_VERSION, now());
    }
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ── tasks ────────────────────────────────────────────────────────────────

  insertTask(t: {
    id: TaskId;
    projectId: string;
    role: string;
    cardId: string;
    cardShortId: string;
    cardUrl?: string;
    title: string;
    spec: string;
    labels?: readonly string[];
    maxAttempts?: number;
  }): TaskRow {
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO tasks (id, project_id, role, card_id, card_short_id, card_url, title, spec,
           labels_json, state, max_attempts, created_at, updated_at)
         VALUES (@id, @projectId, @role, @cardId, @cardShortId, @cardUrl, @title, @spec,
           @labels, 'queued', @maxAttempts, @ts, @ts)`,
      )
      .run({
        id: t.id,
        projectId: t.projectId,
        role: t.role,
        cardId: t.cardId,
        cardShortId: t.cardShortId,
        cardUrl: t.cardUrl ?? '',
        title: t.title,
        spec: t.spec,
        labels: JSON.stringify(t.labels ?? []),
        maxAttempts: t.maxAttempts ?? 2,
        ts,
      });
    return this.getTask(t.id);
  }

  getTask(id: TaskId): TaskRow {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    if (!row) throw new Error(`task ${id} not found`);
    return row;
  }

  /**
   * Mirrors `ux_one_active_task_per_card`: a card may only have one task in
   * flight. Callers that create a second task for the same card (the role
   * handoff) check this rather than letting the index throw.
   */
  hasActiveTaskForCard(projectId: string, cardId: string): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 FROM tasks WHERE project_id = ? AND card_id = ?
           AND state IN ('queued','claimed','preparing','running','verifying','publishing')
         LIMIT 1`,
      )
      .get(projectId, cardId);
  }

  listTasks(where?: { state?: TaskState; projectId?: string }): TaskRow[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    if (where?.state) {
      clauses.push('state = @state');
      params['state'] = where.state;
    }
    if (where?.projectId) {
      clauses.push('project_id = @projectId');
      params['projectId'] = where.projectId;
    }
    const sql = `SELECT * FROM tasks ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''} ORDER BY created_at`;
    return this.db.prepare(sql).all(params) as TaskRow[];
  }

  /**
   * Compare-and-swap state transition. Throws if the row is not in `from`
   * (someone else moved it) or if the transition is illegal.
   */
  transitionTask(
    id: TaskId,
    from: TaskState,
    to: TaskState,
    patch: Partial<
      Pick<
        TaskRow,
        | 'current_run_id'
        | 'workspace_id'
        | 'branch'
        | 'pr_url'
        | 'blocked_reason'
        | 'last_error'
        | 'attempts'
      >
    > = {},
  ): TaskRow {
    assertTransition(from, to);
    const sets = ['state = @to', 'updated_at = @ts'];
    const params: Record<string, unknown> = { id, from, to, ts: now() };
    for (const [k, v] of Object.entries(patch)) {
      sets.push(`${k} = @${k}`);
      params[k] = v;
    }
    const info = this.db
      .prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = @id AND state = @from`)
      .run(params);
    if (info.changes !== 1) {
      const actual = this.getTask(id).state;
      throw new Error(`task ${id}: expected state ${from} but found ${actual}`);
    }
    return this.getTask(id);
  }

  // ── workspaces ───────────────────────────────────────────────────────────

  insertWorkspace(w: Omit<WorkspaceRow, 'created_at' | 'last_used_at' | 'removed_at'>): void {
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO workspaces (id, project_id, task_id, path, branch, base_branch, base_sha, state,
           prepare_ms, created_at, last_used_at)
         VALUES (@id, @project_id, @task_id, @path, @branch, @base_branch, @base_sha, @state,
           @prepare_ms, @ts, @ts)`,
      )
      .run({ ...w, ts });
  }

  getWorkspace(id: WorkspaceId): WorkspaceRow | undefined {
    return this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as
      WorkspaceRow | undefined;
  }

  listWorkspaces(projectId?: string): WorkspaceRow[] {
    return (
      projectId
        ? this.db.prepare('SELECT * FROM workspaces WHERE project_id = ?').all(projectId)
        : this.db.prepare('SELECT * FROM workspaces').all()
    ) as WorkspaceRow[];
  }

  setWorkspaceState(id: WorkspaceId, state: WorkspaceRow['state']): void {
    this.db
      .prepare(
        `UPDATE workspaces SET state = @state, last_used_at = @ts,
           removed_at = CASE WHEN @state = 'removed' THEN @ts ELSE removed_at END
         WHERE id = @id`,
      )
      .run({ id, state, ts: now() });
  }

  // ── runs ─────────────────────────────────────────────────────────────────

  insertRun(r: {
    id: RunId;
    taskId: TaskId;
    projectId: string;
    workspaceId: WorkspaceId | null;
    attempt: number;
    role: string;
    driver: string;
    model: string;
    resumedFrom?: string | null;
  }): void {
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO runs (id, task_id, project_id, workspace_id, attempt, role, driver, model, state,
           resumed_from, started_at, heartbeat_at)
         VALUES (@id, @taskId, @projectId, @workspaceId, @attempt, @role, @driver, @model, 'starting',
           @resumedFrom, @ts, @ts)`,
      )
      .run({ ...r, resumedFrom: r.resumedFrom ?? null, ts });
  }

  getRun(id: RunId): RunRow {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
    if (!row) throw new Error(`run ${id} not found`);
    return row;
  }

  listRunsForTask(taskId: TaskId): RunRow[] {
    return this.db
      .prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY attempt')
      .all(taskId) as RunRow[];
  }

  updateRun(id: RunId, patch: Partial<Omit<RunRow, 'id'>>): void {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = @${k}`).join(', ');
    this.db.prepare(`UPDATE runs SET ${sets} WHERE id = @id`).run({ ...patch, id });
  }

  heartbeatRun(id: RunId): void {
    this.db.prepare('UPDATE runs SET heartbeat_at = ? WHERE id = ?').run(now(), id);
  }

  /** Boot-time recovery: anything that claims to be live from a previous process is not. */
  markInterruptedRuns(): number {
    return this.db
      .prepare(
        `UPDATE runs SET state = 'interrupted', ended_at = ?, outcome = COALESCE(outcome, 'interrupted')
         WHERE state IN ('starting','running')`,
      )
      .run(now()).changes;
  }

  // ── events ───────────────────────────────────────────────────────────────

  appendEvent(runId: RunId, taskId: TaskId, type: string, payload: unknown): number {
    const info = this.db
      .prepare(
        'INSERT INTO run_events (run_id, task_id, ts, type, payload_json) VALUES (?, ?, ?, ?, ?)',
      )
      .run(runId, taskId, now(), type, JSON.stringify(payload ?? null));
    return Number(info.lastInsertRowid);
  }

  listEvents(runId: RunId, afterSeq = 0, limit = 1000): RunEventRow[] {
    return this.db
      .prepare('SELECT * FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(runId, afterSeq, limit) as RunEventRow[];
  }
}
