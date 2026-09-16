import {
  type Options,
  query,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

import { summarizeCost } from './cost.accumulator.js';
import type {
  ExecDriver,
  ExecEvent,
  ExecOutcome,
  ExecResult,
  ExecRunSpec,
  ExecSession,
} from './exec.driver.js';

/** Bounded async queue: producer pushes, one consumer iterates. */
class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private waiters: Array<(r: IteratorResult<T>) => void> = [];
  private closed = false;

  constructor(private readonly capacity: number) {}

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) return waiter({ value: item, done: false });
    if (this.items.length >= this.capacity) this.items.shift(); // drop oldest
    this.items.push(item);
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((r) => this.waiters.push(r));
      },
    };
  }
}

const settledWithin = (p: Promise<unknown>, ms: number): Promise<boolean> =>
  Promise.race([
    p.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((r) => setTimeout(() => r(false), ms)),
  ]);

const preview = (v: unknown, n = 200): string => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return (s ?? '').length > n ? `${(s ?? '').slice(0, n)}…` : (s ?? '');
};

export interface LocalDriverOptions {
  readonly pathToClaudeCodeExecutable?: string;
}

/**
 * Runs Claude Code in-process via the Agent SDK against a host worktree.
 *
 * Uses streaming-input mode (an async generator yielding one user message) so
 * `query.interrupt()` is available for graceful cancellation. Whether a
 * generator that returns after one message lets the turn complete unattended
 * is validated by `run-task --smoke` before anything is built on it.
 */
export class LocalDriver implements ExecDriver {
  readonly kind = 'local' as const;

  constructor(private readonly opts: LocalDriverOptions = {}) {}

  async preflight(): Promise<void> {
    // The SDK bundles its own CLI binary; a missing platform package throws at import time.
    // A cheap `query()` would spend money, so preflight is limited to verifying the import.
    if (typeof query !== 'function') throw new Error('claude-agent-sdk import failed');
  }

  async start(spec: ExecRunSpec): Promise<ExecSession> {
    const abort = new AbortController();
    const sink = new AsyncQueue<ExecEvent>(5000);
    let resultMsg: SDKResultMessage | null = null;
    let sessionId: string | null = spec.resume?.sessionId ?? null;
    let cancelReason: string | null = null;
    let timedOut = false;
    const started = Date.now();
    const errors: string[] = [];

    async function* input(): AsyncGenerator<SDKUserMessage> {
      yield {
        type: 'user',
        session_id: '',
        parent_tool_use_id: null,
        message: { role: 'user', content: spec.prompt },
      } as SDKUserMessage;
    }

    const options: Options = {
      cwd: spec.cwd,
      additionalDirectories: [...spec.additionalReadDirs],
      model: spec.model,
      ...(spec.fallbackModel ? { fallbackModel: spec.fallbackModel } : {}),
      allowedTools: [...spec.allowedTools],
      disallowedTools: [...spec.disallowedTools],
      permissionMode: spec.permissionMode,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: spec.systemPromptAppend,
        excludeDynamicSections: true,
      },
      // Never load the TARGET repo's hooks / .mcp.json — no trust dialog in headless mode.
      settingSources: [],
      mcpServers: { ...spec.mcpServers },
      hooks: spec.hooks,
      maxTurns: spec.maxTurns,
      maxBudgetUsd: spec.maxBudgetUsd,
      includePartialMessages: false,
      abortController: abort,
      stderr: (line) => sink.push({ kind: 'stderr', line: line.trimEnd() }),
      // `env` REPLACES the subprocess environment; spread process.env or lose PATH.
      env: { ...process.env, ...spec.extraEnv } as Record<string, string>,
      ...(spec.resume ? { resume: spec.resume.sessionId } : {}),
      ...(this.opts.pathToClaudeCodeExecutable
        ? { pathToClaudeCodeExecutable: this.opts.pathToClaudeCodeExecutable }
        : {}),
    };

    const q: Query = query({ prompt: input(), options });

    // Armed before the consumer loop; `cancel` is invoked only when it fires, long after definition.
    const timer = setTimeout(() => {
      timedOut = true;
      void cancel('wall-clock exceeded');
    }, spec.wallClockMs);

    const done = (async () => {
      try {
        for await (const msg of q) {
          const ev = mapMessage(msg);
          if (ev) sink.push(ev);
          if (msg.type === 'system' && msg.subtype === 'init') sessionId = msg.session_id;
          if (msg.type === 'result') {
            resultMsg = msg;
            sessionId = msg.session_id;
            // Streaming mode keeps the generator open; the one turn is over.
            break;
          }
        }
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      } finally {
        clearTimeout(timer);
        try {
          q.close();
        } catch {
          /* already closed */
        }
        sink.close();
      }
    })();

    const cancel = async (reason: string): Promise<void> => {
      if (cancelReason) return;
      cancelReason = reason;
      try {
        await q.interrupt();
      } catch {
        /* not streaming / already finished */
      }
      if (await settledWithin(done, 15_000)) return;
      try {
        q.close();
      } catch {
        /* ignore */
      }
      if (await settledWithin(done, 5_000)) return;
      abort.abort(new Error(`exec cancelled: ${reason}`));
    };

    const result = async (): Promise<ExecResult> => {
      await done;
      const r: SDKResultMessage | null = resultMsg;
      const outcome: ExecOutcome = timedOut
        ? 'timeout'
        : cancelReason
          ? 'cancelled'
          : r
            ? r.subtype
            : 'driver_error';
      if (r && r.subtype !== 'success') errors.push(...r.errors);
      return {
        outcome,
        sessionId,
        finalText: r && r.subtype === 'success' ? r.result : null,
        numTurns: r?.num_turns ?? 0,
        durationMs: r?.duration_ms ?? Date.now() - started,
        cost: summarizeCost(r),
        permissionDenials: (r?.permission_denials ?? []).map((d) => ({
          toolName: d.tool_name,
          toolUseId: d.tool_use_id,
        })),
        errors,
      };
    };

    return { runId: spec.runId, events: () => sink, result, cancel };
  }
}

function mapMessage(msg: SDKMessage): ExecEvent | null {
  switch (msg.type) {
    case 'system': {
      if (msg.subtype === 'init') {
        return {
          kind: 'init',
          sessionId: msg.session_id,
          model: msg.model,
          tools: msg.tools,
          mcp: msg.mcp_servers,
          claudeCodeVersion: msg.claude_code_version,
        };
      }
      if (msg.subtype === 'api_retry') {
        return {
          kind: 'api-retry',
          attempt: msg.attempt,
          maxRetries: msg.max_retries,
          delayMs: msg.retry_delay_ms,
          status: msg.error_status,
        };
      }
      if (msg.subtype === 'permission_denied') {
        return {
          kind: 'permission-denied',
          toolName: msg.tool_name,
          reason: msg.decision_reason ?? '',
        };
      }
      if (msg.subtype === 'status') return { kind: 'status', status: String(msg.status) };
      if (msg.subtype === 'compact_boundary') return { kind: 'compact' };
      return null;
    }
    case 'assistant': {
      // One assistant message per content block while streaming; text and tool_use are what we show.
      for (const block of msg.message.content) {
        if (block.type === 'text' && block.text.trim()) {
          return { kind: 'assistant-text', text: block.text, messageId: msg.message.id };
        }
        if (block.type === 'tool_use') {
          return {
            kind: 'tool-use',
            toolUseId: block.id,
            name: block.name,
            inputPreview: preview(block.input),
          };
        }
      }
      return null;
    }
    case 'user': {
      const content = msg.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result') {
            const text = Array.isArray(block.content)
              ? block.content.map((c) => ('text' in c ? c.text : '')).join('')
              : String(block.content ?? '');
            return {
              kind: 'tool-result',
              toolUseId: block.tool_use_id,
              isError: block.is_error ?? false,
              preview: preview(text),
            };
          }
        }
      }
      return null;
    }
    case 'rate_limit_event':
      return {
        kind: 'rate-limit',
        status: msg.rate_limit_info.status,
        resetsAt: msg.rate_limit_info.resetsAt ?? null,
      };
    default:
      return null;
  }
}
