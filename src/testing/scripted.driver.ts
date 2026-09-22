import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';

import type {
  ExecDriver,
  ExecEvent,
  ExecOutcome,
  ExecResult,
  ExecRunSpec,
  ExecSession,
} from '../exec/exec.driver.js';
import { BOARD_SERVER_KEY } from '../mcp/board.server.js';

/**
 * The SDK exposes no public way to invoke an in-process MCP tool without a
 * transport, so the test driver reaches the registered handler directly. This
 * is exactly what the SDK's own dispatcher does with the same object.
 */
interface ToolRegistry {
  readonly _registeredTools: Record<
    string,
    { handler(args: unknown, extra: unknown): Promise<{ isError?: boolean }> }
  >;
}

/** Call a `mcp__board__*` tool the way the agent would. Returns true when accepted. */
export async function callBoardTool(
  spec: ExecRunSpec,
  name: string,
  args: unknown,
): Promise<boolean> {
  const server = spec.mcpServers[BOARD_SERVER_KEY] as McpSdkServerConfigWithInstance;
  const tool = (server.instance as unknown as ToolRegistry)._registeredTools[name];
  if (!tool) throw new Error(`board tool ${name} is not registered`);
  const res = await tool.handler(args, {});
  return res.isError !== true;
}

/** What one agent attempt does, in order, before returning its result. */
export interface ScriptedAttempt {
  /** Board tools to call, as [name, args] — `propose_summary`, `report_blocked`, … */
  readonly calls?: readonly [string, unknown][];
  /** Run inside the worktree; use it to make the edits the agent would make. */
  readonly work?: (cwd: string) => void;
  readonly events?: readonly ExecEvent[];
  readonly outcome?: ExecOutcome;
  readonly errors?: readonly string[];
}

/**
 * An `ExecDriver` that replays a script instead of running Claude: no network,
 * no cost, one entry per attempt so retries can differ from first tries.
 */
export class ScriptedDriver implements ExecDriver {
  readonly kind = 'local' as const;
  readonly specs: ExecRunSpec[] = [];
  private index = 0;

  constructor(private readonly attempts: readonly ScriptedAttempt[]) {}

  async preflight(): Promise<void> {}

  async start(spec: ExecRunSpec): Promise<ExecSession> {
    this.specs.push(spec);
    // The last entry repeats, so a one-entry script covers every retry.
    const step = this.attempts[Math.min(this.index++, this.attempts.length - 1)] ?? {};
    step.work?.(spec.cwd);
    for (const [name, args] of step.calls ?? []) await callBoardTool(spec, name, args);

    const events: readonly ExecEvent[] = step.events ?? [
      {
        kind: 'init',
        sessionId: `session-${this.index}`,
        model: spec.model,
        tools: [],
        mcp: [{ name: 'board', status: 'connected' }],
        claudeCodeVersion: 'scripted',
      },
      { kind: 'assistant-text', text: 'done', messageId: 'm1' },
    ];
    const result: ExecResult = {
      outcome: step.outcome ?? 'success',
      sessionId: `session-${this.index}`,
      finalText: 'done',
      numTurns: 1,
      durationMs: 5,
      cost: {
        totalCostUsd: 0.01,
        reportedCostUsd: 0.01,
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        perModel: {},
        estimated: false,
      },
      permissionDenials: [],
      errors: step.errors ?? [],
    };
    return {
      runId: spec.runId,
      events: () =>
        (async function* () {
          for (const e of events) yield e;
        })(),
      result: async () => result,
      cancel: async () => {},
    };
  }
}

export const aSummary = (over: Record<string, unknown> = {}) => ({
  title: 'Add the thing that was asked for',
  summary: 'Adds the thing, with a test that covers the empty case.',
  testPlan: 'pnpm test in the package',
  filesTouched: ['thing.ts'],
  commit: { type: 'feat', subject: 'add the thing' },
  ...over,
});
