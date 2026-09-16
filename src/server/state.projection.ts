import type { BoardStore } from '../board/board.store.js';
import type { LoadedConfig, ProjectConfig } from '../config/config.loader.js';
import { ROLES, type Role } from '../config/config.schema.js';
import type { RunEventRow, RunRow, SqliteStore, TaskRow } from '../db/sqlite.store.js';
import type { RunId } from '../domain/ids.js';

import type { AgentState, AgentStatus, LogLine, RunSummary, StateSnapshot } from './state.types.js';

const ROOM_W = 640;
const ROOM_H = 360;
const TYPING_WINDOW_MS = 6_000;
const DONE_WINDOW_MS = 10_000;
const FAIL_WINDOW_MS = 5 * 60_000;
const LIVE_TASK_STATES = ['claimed', 'preparing', 'running', 'verifying', 'publishing'];

/** Desk positions per role inside a room, in room-local pixels. Two per row. */
const DESKS: Readonly<Record<Role, { x: number; y: number }>> = {
  PM: { x: 96, y: 120 },
  'DEV-BE': { x: 288, y: 120 },
  'DEV-FE': { x: 480, y: 120 },
  QA: { x: 192, y: 260 },
  DEVOPS: { x: 384, y: 260 },
};

/**
 * SQLite + config → one snapshot. Agent status is derived HERE, never in the
 * client, so the office stays a pure function of state.
 */
export class StateProjector {
  constructor(
    private readonly loaded: LoadedConfig,
    private readonly store: SqliteStore,
    private readonly boardStore: BoardStore,
  ) {}

  snapshot(eventId: number): StateSnapshot {
    const now = Date.now();
    const cfg = this.loaded.config;
    const roomsPerRow = cfg.office.roomsPerRow;
    const tasks = this.store.listTasks();
    const projects = cfg.projects.map((p, i) => {
      const own = tasks.filter((t) => t.project_id === p.id);
      const cursor = this.boardStore.getCursor(p.id);
      return {
        id: p.id,
        name: p.name,
        color: p.color,
        enabled: p.enabled,
        room: {
          x: (i % roomsPerRow) * ROOM_W,
          y: Math.floor(i / roomsPerRow) * ROOM_H,
          w: ROOM_W,
          h: ROOM_H,
        },
        board: { provider: p.board.provider, cursor: cursor.cursor, tick: cursor.tick },
        queue: {
          queued: own.filter((t) => t.state === 'queued').length,
          running: own.filter((t) => LIVE_TASK_STATES.includes(t.state)).length,
        },
      };
    });

    const agents: AgentState[] = [];
    for (const p of cfg.projects) {
      for (const role of ROLES) agents.push(this.agentState(p, role, tasks, now));
    }

    const allRuns = this.store.db
      .prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT 30')
      .all() as RunRow[];
    const taskById = new Map(tasks.map((t) => [t.id, t]));
    const recent: RunSummary[] = allRuns.map((r) => {
      const t = taskById.get(r.task_id);
      return {
        id: r.id,
        taskId: r.task_id,
        projectId: r.project_id,
        role: r.role,
        cardShortId: t?.card_short_id ?? '?',
        cardTitle: t?.title ?? '',
        state: r.state,
        outcome: r.outcome,
        startedAt: r.started_at,
        endedAt: r.ended_at,
        durationMs: r.duration_ms,
        costUsd: r.cost_usd,
        prUrl: r.pr_url ?? t?.pr_url ?? null,
      };
    });

    return {
      serverTime: new Date(now).toISOString(),
      eventId,
      configRevision: this.loaded.revision,
      office: { roomsPerRow, roomW: ROOM_W, roomH: ROOM_H },
      diagnostics: this.loaded.diagnostics,
      projects,
      agents,
      runs: {
        recent,
        active: allRuns
          .filter((r) => r.state === 'running' || r.state === 'starting')
          .map((r) => r.id),
      },
      cards: tasks
        .filter((t) => t.state !== 'cancelled')
        .slice(-100)
        .map((t) => ({
          taskId: t.id,
          projectId: t.project_id,
          cardShortId: t.card_short_id,
          title: t.title,
          state: t.state,
          role: t.role,
          prUrl: t.pr_url,
          updatedAt: t.updated_at,
        })),
      outbox: this.boardStore.outboxCounts(),
    };
  }

  private agentState(p: ProjectConfig, role: Role, tasks: TaskRow[], now: number): AgentState {
    const key = `${p.id}:${role}`;
    const desk = DESKS[role];
    const base = { key, projectId: p.id, role, enabled: p.agents[role].enabled, desk };
    if (!p.agents[role].enabled) return { ...base, status: 'offline', since: '', run: null };

    const own = tasks.filter((t) => t.project_id === p.id && t.role === role);
    const live = own.find((t) => LIVE_TASK_STATES.includes(t.state));
    if (live) {
      const run = live.current_run_id ? this.store.getRun(live.current_run_id) : null;
      const status = this.liveStatus(live, run, now);
      const last = run ? this.lastEvents(run.id) : { phase: null, tool: null, message: null };
      return {
        ...base,
        status,
        since: live.updated_at,
        run: {
          id: run?.id ?? '',
          taskId: live.id,
          cardShortId: live.card_short_id,
          cardTitle: live.title,
          cardUrl: live.card_url,
          phase: last.phase,
          lastMessage: last.message,
          startedAt: run?.started_at ?? live.updated_at,
          elapsedMs: now - Date.parse(run?.started_at ?? live.updated_at),
          turns: run?.num_turns ?? 0,
          costUsd: run?.cost_usd ?? 0,
          budgetUsd: p.agents[role].budget.maxUsd,
          lastToolName: last.tool,
          branch: live.branch,
        },
      };
    }

    // Recently finished: show the verdict briefly, then idle.
    const lastDone = [...own].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
    if (lastDone) {
      const age = now - Date.parse(lastDone.updated_at);
      let status: AgentStatus | null = null;
      if (lastDone.state === 'review' && age < DONE_WINDOW_MS) status = 'done';
      else if (lastDone.state === 'blocked' && age < FAIL_WINDOW_MS) status = 'blocked';
      else if (
        (lastDone.state === 'failed' || lastDone.state === 'needs_human') &&
        age < FAIL_WINDOW_MS
      )
        status = 'failed';
      if (status) return { ...base, status, since: lastDone.updated_at, run: null };
    }
    return { ...base, status: 'idle', since: lastDone?.updated_at ?? '', run: null };
  }

  private liveStatus(task: TaskRow, run: RunRow | null, now: number): AgentStatus {
    if (task.state === 'claimed' || task.state === 'preparing') return 'preparing';
    if (task.state === 'verifying') return 'verifying';
    if (task.state === 'publishing') return 'publishing';
    if (!run) return 'thinking';
    const lastTool = this.store.db
      .prepare(
        `SELECT ts FROM run_events WHERE run_id = ? AND type IN ('tool-use','tool-result') ORDER BY seq DESC LIMIT 1`,
      )
      .get(run.id) as { ts: string } | undefined;
    return lastTool && now - Date.parse(lastTool.ts) < TYPING_WINDOW_MS ? 'typing' : 'thinking';
  }

  private lastEvents(runId: RunId): {
    phase: string | null;
    tool: string | null;
    message: string | null;
  } {
    const rows = this.store.db
      .prepare(
        `SELECT type, payload_json FROM run_events WHERE run_id = ? AND type IN ('progress','tool-use','assistant-text') ORDER BY seq DESC LIMIT 30`,
      )
      .all(runId) as { type: string; payload_json: string }[];
    let phase: string | null = null;
    let tool: string | null = null;
    let message: string | null = null;
    for (const r of rows) {
      const p = JSON.parse(r.payload_json) as Record<string, unknown>;
      if (r.type === 'progress' && phase === null) {
        phase = String(p['phase'] ?? '');
        message ??= String(p['message'] ?? '');
      }
      if (r.type === 'tool-use' && tool === null) tool = String(p['name'] ?? '');
      if (r.type === 'assistant-text' && message === null)
        message = String(p['text'] ?? '').slice(0, 160);
      if (phase && tool && message) break;
    }
    return { phase, tool, message };
  }

  /** Render run_events into human log lines for the drawer. */
  logLines(runId: RunId, afterSeq: number, limit: number): LogLine[] {
    return this.store.listEvents(runId, afterSeq, limit).map(toLogLine);
  }

  runIsLive(runId: RunId): boolean {
    try {
      const r = this.store.getRun(runId);
      return r.state === 'running' || r.state === 'starting';
    } catch {
      return false;
    }
  }
}

export function toLogLine(e: RunEventRow): LogLine {
  const p = JSON.parse(e.payload_json) as Record<string, unknown>;
  const s = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : '');
  let text: string;
  switch (e.type) {
    case 'init':
      text = `session ${s('sessionId')} · ${s('model')} · claude-code ${s('claudeCodeVersion')}`;
      break;
    case 'tool-use':
      text = `→ ${s('name')} ${s('inputPreview')}`;
      break;
    case 'tool-result':
      text = `${p['isError'] ? '✖' : '←'} ${s('preview')}`;
      break;
    case 'assistant-text':
      text = `💬 ${s('text')}`;
      break;
    case 'progress':
      text = `▸ ${s('phase')}: ${s('message')}`;
      break;
    case 'denied':
      text = `⛔ ${s('toolName')}: ${s('reason')}`;
      break;
    case 'blocked':
      text = `🟠 blocked (${s('category')}): ${s('reason')}`;
      break;
    case 'summary':
      text = `📝 propose_summary accepted: ${s('title')}`;
      break;
    case 'api-retry':
      text = `⏳ api retry ${String(p['attempt'])}/${String(p['maxRetries'])} in ${String(p['delayMs'])}ms`;
      break;
    case 'stderr':
      text = `stderr: ${s('line')}`;
      break;
    default:
      text = JSON.stringify(p).slice(0, 300);
  }
  return { seq: e.seq, ts: e.ts, kind: e.type, text };
}
