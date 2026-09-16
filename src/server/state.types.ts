/**
 * Wire types shared by the server projector and the office client
 * (the client imports this file type-only via a path alias).
 */

export type AgentStatus =
  | 'offline' // role not enabled for the project
  | 'idle'
  | 'preparing' // worktree + install
  | 'thinking' // run alive, no tool call in the last few seconds
  | 'typing' // tool call in the last few seconds
  | 'verifying'
  | 'publishing'
  | 'done' // briefly after a success
  | 'blocked'
  | 'failed';

export interface AgentState {
  readonly key: string; // `${projectId}:${role}`
  readonly projectId: string;
  readonly role: string;
  readonly enabled: boolean;
  readonly status: AgentStatus;
  readonly since: string;
  readonly desk: { x: number; y: number };
  readonly run: {
    readonly id: string;
    readonly taskId: string;
    readonly cardShortId: string;
    readonly cardTitle: string;
    readonly cardUrl: string;
    readonly phase: string | null;
    readonly lastMessage: string | null;
    readonly startedAt: string;
    readonly elapsedMs: number;
    readonly turns: number;
    readonly costUsd: number;
    readonly budgetUsd: number;
    readonly lastToolName: string | null;
    readonly branch: string | null;
  } | null;
}

export interface ProjectState {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly enabled: boolean;
  readonly room: { x: number; y: number; w: number; h: number };
  readonly board: { provider: string; cursor: string | null; tick: number };
  readonly queue: { queued: number; running: number };
}

export interface RunSummary {
  readonly id: string;
  readonly taskId: string;
  readonly projectId: string;
  readonly role: string;
  readonly cardShortId: string;
  readonly cardTitle: string;
  readonly state: string;
  readonly outcome: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly durationMs: number | null;
  readonly costUsd: number | null;
  readonly prUrl: string | null;
}

export interface CardState {
  readonly taskId: string;
  readonly projectId: string;
  readonly cardShortId: string;
  readonly title: string;
  readonly state: string;
  readonly role: string;
  readonly prUrl: string | null;
  readonly updatedAt: string;
}

export interface StateSnapshot {
  readonly serverTime: string;
  readonly eventId: number;
  readonly configRevision: number;
  readonly office: { roomsPerRow: number; roomW: number; roomH: number };
  readonly diagnostics: readonly {
    level: string;
    code: string;
    projectId?: string;
    message: string;
  }[];
  readonly projects: readonly ProjectState[];
  readonly agents: readonly AgentState[];
  readonly runs: { readonly recent: readonly RunSummary[]; readonly active: readonly string[] };
  readonly cards: readonly CardState[];
  readonly outbox: Readonly<Record<string, number>>;
}

export type OfficeEvent =
  | { type: 'state.snapshot'; data: StateSnapshot }
  | { type: 'log.tail'; data: { runId: string; lines: LogLine[] } }
  | { type: 'log.lines'; data: { runId: string; lines: LogLine[] } }
  | { type: 'log.truncated'; data: { runId: string; dropped: number } }
  | { type: 'log.end'; data: { runId: string } };

export interface LogLine {
  readonly seq: number;
  readonly ts: string;
  readonly kind: string;
  readonly text: string;
}
