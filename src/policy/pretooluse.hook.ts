import type {
  HookCallback,
  HookCallbackMatcher,
  HookJSONOutput,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';

import { checkBash } from './bash.guard.js';
import { checkRead, checkWrite } from './path.guard.js';

export interface GuardContext {
  /** The worktree. Every write must resolve inside it. */
  readonly root: string;
  readonly additionalReadRoots?: readonly string[];
  readonly onDenial?: (toolName: string, reason: string, input: unknown) => void;
}

const decide = (
  permissionDecision: 'allow' | 'deny',
  permissionDecisionReason: string,
): HookJSONOutput => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason },
});

/**
 * The only gate that holds in every permission mode: hooks run before deny/ask
 * rules, before the permission mode, before allow rules, and a hook deny
 * applies even under bypassPermissions.
 */
export function buildGuardHooks(
  ctx: GuardContext,
): Partial<Record<'PreToolUse', HookCallbackMatcher[]>> {
  const guard: HookCallback = async (input) => {
    const { tool_name: name, tool_input: rawInput } = input as PreToolUseHookInput;
    const raw = (rawInput ?? {}) as Record<string, unknown>;
    const str = (k: string): string => (typeof raw[k] === 'string' ? (raw[k] as string) : '');

    const reject = (reason: string): HookJSONOutput => {
      ctx.onDenial?.(name, reason, rawInput);
      return decide(
        'deny',
        `${reason}. Do not work around this — call mcp__board__report_blocked if you cannot proceed.`,
      );
    };

    switch (name) {
      case 'Write':
      case 'Edit':
      case 'MultiEdit': {
        const r = checkWrite(ctx.root, str('file_path'));
        return r.ok ? decide('allow', 'inside worktree') : reject(r.reason);
      }
      case 'NotebookEdit': {
        const r = checkWrite(ctx.root, str('notebook_path'));
        return r.ok ? decide('allow', 'inside worktree') : reject(r.reason);
      }
      case 'Read': {
        const r = checkRead(ctx.root, str('file_path'), ctx.additionalReadRoots ?? []);
        return r.ok ? decide('allow', 'inside worktree') : reject(r.reason);
      }
      case 'Bash': {
        const r = checkBash(ctx.root, str('command'));
        return r.ok ? decide('allow', 'allowed command') : reject(r.reason);
      }
      default:
        // Grep/Glob are cwd-scoped by the CLI; mcp__board__* is ours; anything
        // else not in allowedTools is denied by permissionMode 'dontAsk'.
        return {};
    }
  };

  return { PreToolUse: [{ matcher: '.*', hooks: [guard], timeout: 10 }] };
}
