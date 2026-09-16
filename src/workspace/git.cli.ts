import { type CommandResult, runCommand, runOrThrow } from '../process/command.runner.js';

const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
const LOCK_RE = /index\.lock|Unable to create .* File exists|could not lock/i;

/** Thin git wrapper: no prompts, retries on index.lock contention. */
export class GitCli {
  constructor(private readonly timeoutMs = 120_000) {}

  async run(cwd: string, args: readonly string[], timeoutMs = this.timeoutMs): Promise<string> {
    let attempt = 0;
    for (;;) {
      try {
        const r = await runOrThrow('git', args, { cwd, timeoutMs, env: GIT_ENV });
        return r.stdout.trim();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (LOCK_RE.test(msg) && attempt < 5) {
          await new Promise((r) => setTimeout(r, 250 * 2 ** attempt++));
          continue;
        }
        throw err;
      }
    }
  }

  async tryRun(cwd: string, args: readonly string[]): Promise<CommandResult> {
    return runCommand('git', args, { cwd, timeoutMs: this.timeoutMs, env: GIT_ENV });
  }

  async isRepo(path: string): Promise<boolean> {
    const r = await this.tryRun(path, ['rev-parse', '--is-inside-work-tree']);
    return r.exitCode === 0 && r.stdout.trim() === 'true';
  }

  async revParse(cwd: string, ref: string): Promise<string> {
    return this.run(cwd, ['rev-parse', '--verify', '--quiet', ref]);
  }

  async refExists(cwd: string, ref: string): Promise<boolean> {
    const r = await this.tryRun(cwd, ['rev-parse', '--verify', '--quiet', ref]);
    return r.exitCode === 0;
  }

  async remoteBranchExists(cwd: string, remote: string, branch: string): Promise<boolean> {
    const r = await this.tryRun(cwd, ['ls-remote', '--exit-code', '--heads', remote, branch]);
    return r.exitCode === 0;
  }

  async fetch(cwd: string, remote: string, branch: string): Promise<void> {
    await this.run(cwd, ['fetch', '--no-tags', '--prune', remote, branch], 180_000);
  }

  async worktreeList(
    cwd: string,
  ): Promise<{ path: string; branch: string | null; locked: boolean }[]> {
    const out = await this.run(cwd, ['worktree', 'list', '--porcelain']);
    const entries: { path: string; branch: string | null; locked: boolean }[] = [];
    let cur: { path: string; branch: string | null; locked: boolean } | null = null;
    for (const line of out.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) {
        cur = { path: line.slice(9), branch: null, locked: false };
        entries.push(cur);
      } else if (cur && line.startsWith('branch ')) {
        cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
      } else if (cur && line.startsWith('locked')) {
        cur.locked = true;
      }
    }
    return entries;
  }
}
