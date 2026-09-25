import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';

import type { Role } from '../config/config.schema.js';

export interface RolePolicy {
  readonly permissionMode: PermissionMode;
  readonly allowedTools: readonly string[];
  readonly disallowedTools: readonly string[];
}

const WRITE_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'NotebookEdit', 'TodoWrite', 'Bash'];
const BOARD_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'TodoWrite'];

/** Never network, never target-repo slash commands, never subagents in M1. */
const DISALLOWED = ['WebFetch', 'WebSearch', 'SlashCommand', 'Skill', 'Agent', 'Task'];

const BOARD = 'mcp__board__*';

/**
 * `permissionMode: 'dontAsk'` auto-approves the allowlist and denies the rest.
 * Never bypassPermissions — `allowedTools` does not constrain it. Real
 * confinement lives in the PreToolUse hook (see pretooluse.hook.ts).
 */
const BOARD_ONLY_POLICY: RolePolicy = {
  permissionMode: 'dontAsk',
  allowedTools: [...BOARD_ONLY_TOOLS, BOARD],
  disallowedTools: [...DISALLOWED, 'Edit', 'Write', 'NotebookEdit', 'Bash'],
};

export const ROLE_POLICIES: Readonly<Record<Role, RolePolicy>> = {
  BA: BOARD_ONLY_POLICY,
  PM: BOARD_ONLY_POLICY,
  DEV: {
    permissionMode: 'dontAsk',
    allowedTools: [...WRITE_TOOLS, BOARD],
    disallowedTools: DISALLOWED,
  },
  DEVOPS: {
    permissionMode: 'dontAsk',
    allowedTools: [...WRITE_TOOLS, BOARD],
    disallowedTools: DISALLOWED,
  },
  // QA writes test suites. Its delivery writeGlobs confine it to test paths;
  // the PreToolUse guard enforces that, so the tool list does not have to.
  QA: {
    permissionMode: 'dontAsk',
    allowedTools: [...WRITE_TOOLS, BOARD],
    disallowedTools: DISALLOWED,
  },
};

/** Environment hardening for every agent subprocess. Merged over process.env by the driver. */
export const AGENT_ENV: Readonly<Record<string, string>> = {
  BASH_MAX_TIMEOUT_MS: '300000',
  MCP_TOOL_TIMEOUT: '120000',
  CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1',
  CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '2',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  GIT_TERMINAL_PROMPT: '0',
  GH_PROMPT_DISABLED: '1',
  CI: '1',
  TURBO_TELEMETRY_DISABLED: '1',
  NEXT_TELEMETRY_DISABLED: '1',
};
