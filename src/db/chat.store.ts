import type { ChatMessage, ChatStatus, CreatedCard, StoryDraft } from '../server/chat.types.js';

import type { SqliteStore } from './sqlite.store.js';

/** BA chat sessions. One row per conversation; messages are append-only. */
export const CHAT_DDL = `
CREATE TABLE IF NOT EXISTS chat_sessions (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL,
  sdk_session_id    TEXT,
  status            TEXT NOT NULL DEFAULT 'open',
  draft_json        TEXT,
  created_card_json TEXT,
  cost_usd          REAL NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role       TEXT NOT NULL,
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages (session_id, id);
`;

export interface ChatSessionRow {
  readonly id: string;
  readonly projectId: string;
  readonly sdkSessionId: string | null;
  readonly status: ChatStatus;
  readonly draft: StoryDraft | null;
  readonly createdCard: CreatedCard | null;
  readonly costUsd: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface RawSession {
  id: string;
  project_id: string;
  sdk_session_id: string | null;
  status: ChatStatus;
  draft_json: string | null;
  created_card_json: string | null;
  cost_usd: number;
  created_at: string;
  updated_at: string;
}

const now = (): string => new Date().toISOString();

export class ChatStore {
  constructor(private readonly store: SqliteStore) {
    store.db.exec(CHAT_DDL);
  }

  private get db() {
    return this.store.db;
  }

  create(id: string, projectId: string): ChatSessionRow {
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO chat_sessions (id, project_id, status, created_at, updated_at)
         VALUES (?, ?, 'open', ?, ?)`,
      )
      .run(id, projectId, ts, ts);
    return this.get(id) as ChatSessionRow;
  }

  get(id: string): ChatSessionRow | null {
    const r = this.db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id) as
      RawSession | undefined;
    return r ? toRow(r) : null;
  }

  messages(sessionId: string): ChatMessage[] {
    return (
      this.db
        .prepare(
          'SELECT role, text, created_at FROM chat_messages WHERE session_id = ? ORDER BY id',
        )
        .all(sessionId) as { role: ChatMessage['role']; text: string; created_at: string }[]
    ).map((m) => ({ role: m.role, text: m.text, at: m.created_at }));
  }

  addMessage(sessionId: string, role: ChatMessage['role'], text: string): void {
    const ts = now();
    this.db
      .prepare('INSERT INTO chat_messages (session_id, role, text, created_at) VALUES (?, ?, ?, ?)')
      .run(sessionId, role, text, ts);
    this.touch(sessionId, ts);
  }

  setDraft(sessionId: string, draft: StoryDraft): void {
    this.db
      .prepare('UPDATE chat_sessions SET draft_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(draft), now(), sessionId);
  }

  /** Records the SDK session to resume and adds the turn's cost. */
  finishTurn(sessionId: string, sdkSessionId: string | null, costUsd: number): void {
    this.db
      .prepare(
        `UPDATE chat_sessions
         SET sdk_session_id = COALESCE(?, sdk_session_id), cost_usd = cost_usd + ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(sdkSessionId, costUsd, now(), sessionId);
  }

  setStatus(sessionId: string, status: ChatStatus): void {
    this.db
      .prepare('UPDATE chat_sessions SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, now(), sessionId);
  }

  setCreated(sessionId: string, card: CreatedCard): void {
    this.db
      .prepare(
        `UPDATE chat_sessions SET status = 'created', created_card_json = ?, updated_at = ? WHERE id = ?`,
      )
      .run(JSON.stringify(card), now(), sessionId);
  }

  private touch(sessionId: string, ts: string): void {
    this.db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(ts, sessionId);
  }
}

function toRow(r: RawSession): ChatSessionRow {
  return {
    id: r.id,
    projectId: r.project_id,
    sdkSessionId: r.sdk_session_id,
    status: r.status,
    draft: r.draft_json ? (JSON.parse(r.draft_json) as StoryDraft) : null,
    createdCard: r.created_card_json ? (JSON.parse(r.created_card_json) as CreatedCard) : null,
    costUsd: r.cost_usd,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
