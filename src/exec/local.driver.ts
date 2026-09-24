import { query } from '@anthropic-ai/claude-agent-sdk';

import type { ExecDriver, ExecRunSpec, ExecSession, PathMapping } from './exec.driver.js';
import { runSdkSession } from './sdk.session.js';

export interface LocalDriverOptions {
  readonly pathToClaudeCodeExecutable?: string;
}

/**
 * Runs Claude Code in-process via the Agent SDK against a host worktree.
 *
 * The session itself lives in `sdk.session.ts`, shared with the Docker driver;
 * all this adds is "no path translation, no custom spawner".
 */
export class LocalDriver implements ExecDriver {
  readonly kind = 'local' as const;
  /** The agent sees the host filesystem as it is. */
  readonly paths: PathMapping = { mode: 'native', toAgent: (p) => p };

  constructor(private readonly opts: LocalDriverOptions = {}) {}

  async preflight(): Promise<void> {
    // The SDK bundles its own CLI binary; a missing platform package throws at import time.
    // A cheap `query()` would spend money, so preflight is limited to verifying the import.
    if (typeof query !== 'function') throw new Error('claude-agent-sdk import failed');
  }

  async start(spec: ExecRunSpec): Promise<ExecSession> {
    return runSdkSession(spec, {
      options: this.opts.pathToClaudeCodeExecutable
        ? { pathToClaudeCodeExecutable: this.opts.pathToClaudeCodeExecutable }
        : {},
    });
  }
}
