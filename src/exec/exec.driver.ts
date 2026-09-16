import type {
  HookCallbackMatcher,
  HookEvent,
  McpServerConfig,
  PermissionMode,
} from '@anthropic-ai/claude-agent-sdk';

import type { RunId } from '../domain/ids.js';

export type DriverKind = 'local' | 'docker';

export interface ExecRunSpec {
  readonly runId: RunId;
  /** Absolute host path of the worktree. Local uses it as cwd; Docker bind-mounts it. */
  readonly cwd: string;
  readonly additionalReadDirs: readonly string[];

  /** Byte-stable per (project, role) so the prompt cache hits across worktrees. */
  readonly systemPromptAppend: string;
  /** Everything that varies per card. */
  readonly prompt: string;

  readonly model: string;
  readonly fallbackModel?: string;

  readonly allowedTools: readonly string[];
  readonly disallowedTools: readonly string[];
  readonly permissionMode: PermissionMode;

  readonly maxTurns: number;
  readonly maxBudgetUsd: number;
  /** Orchestrator-enforced. The SDK has no timeout flag. */
  readonly wallClockMs: number;

  readonly mcpServers: Readonly<Record<string, McpServerConfig>>;
  readonly hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  /** Extra vars only; the driver merges over process.env. */
  readonly extraEnv: Readonly<Record<string, string>>;

  readonly resume?: { readonly sessionId: string };
}

export type ExecEvent =
  | {
      kind: 'init';
      sessionId: string;
      model: string;
      tools: readonly string[];
      mcp: readonly { name: string; status: string }[];
      claudeCodeVersion: string;
    }
  | { kind: 'assistant-text'; text: string; messageId: string }
  | { kind: 'tool-use'; toolUseId: string; name: string; inputPreview: string }
  | { kind: 'tool-result'; toolUseId: string; isError: boolean; preview: string }
  | { kind: 'permission-denied'; toolName: string; reason: string }
  | {
      kind: 'api-retry';
      attempt: number;
      maxRetries: number;
      delayMs: number;
      status: number | null;
    }
  | { kind: 'rate-limit'; status: string; resetsAt: number | null }
  | { kind: 'stderr'; line: string }
  | { kind: 'status'; status: string }
  | { kind: 'compact' };

export type ExecOutcome =
  | 'success'
  | 'error_max_turns'
  | 'error_during_execution'
  | 'error_max_budget_usd'
  | 'error_max_structured_output_retries'
  | 'timeout'
  | 'cancelled'
  | 'driver_error';

export interface CostSummary {
  /** Derived from modelUsage (includes subagents). The number we store and report. */
  readonly totalCostUsd: number;
  /** result.total_cost_usd — client-side estimate, for cross-checking. */
  readonly reportedCostUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly perModel: Readonly<
    Record<
      string,
      { costUsd: number; input: number; output: number; cacheRead: number; cacheCreation: number }
    >
  >;
  /** True when the result carried zeroed/missing usage (crash path). */
  readonly estimated: boolean;
}

export interface ExecResult {
  readonly outcome: ExecOutcome;
  readonly sessionId: string | null;
  readonly finalText: string | null;
  readonly numTurns: number;
  readonly durationMs: number;
  readonly cost: CostSummary;
  readonly permissionDenials: readonly { toolName: string; toolUseId: string }[];
  readonly errors: readonly string[];
}

export interface ExecSession {
  readonly runId: RunId;
  /** Consume exactly once. Never throws — SDK errors become the final result. */
  events(): AsyncIterable<ExecEvent>;
  /** Resolves after events() drains. Never rejects. */
  result(): Promise<ExecResult>;
  /** Graceful: interrupt -> close -> abort. */
  cancel(reason: string): Promise<void>;
}

export interface ExecDriver {
  readonly kind: DriverKind;
  /** Fail fast at boot: binary present, auth present, docker daemon up, etc. */
  preflight(): Promise<void>;
  start(spec: ExecRunSpec): Promise<ExecSession>;
}
