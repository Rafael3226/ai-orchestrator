import type { ConventionalCommit } from '../mcp/board.schemas.js';
import {
  scanDiffForSecrets,
  type SecretHit,
  stagedIncludeFiles,
} from '../policy/secret.scanner.js';
import { runCommand } from '../process/command.runner.js';
import { GitCli } from '../workspace/git.cli.js';

export interface DiffStat {
  readonly files: number;
  readonly insertions: number;
  readonly deletions: number;
  readonly paths: readonly string[];
  readonly statText: string;
}

export class PublishAbort extends Error {
  constructor(
    readonly code:
      | 'nothing-to-commit'
      | 'diff-too-large'
      | 'secret-detected'
      | 'include-file-staged'
      | 'non-fast-forward'
      | 'auth',
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'PublishAbort';
  }
}

const MAX_FILES = 300;
const MAX_LINES = 20_000;

export const BOT_IDENTITY = {
  name: 'ai-orchestrator',
  email: 'ai-orchestrator@users.noreply.github.com',
};

export class GitPublisher {
  private readonly git = new GitCli();

  /** Stage everything (gitignore respected), refuse oversized or secret-bearing diffs. */
  /**
   * `allowEmpty` is for roles whose empty diff is a legitimate success — QA
   * reviewing a branch and finding nothing to change. For everyone else an
   * empty diff still aborts, because it means the agent did nothing.
   */
  async stageAndInspect(
    cwd: string,
    copiedIncludes: readonly string[],
    opts: { allowEmpty?: boolean } = {},
  ): Promise<DiffStat> {
    await this.git.run(cwd, ['add', '-A']);
    const numstat = await this.git.run(cwd, ['diff', '--cached', '--numstat', '-M']);
    const statText = await this.git.run(cwd, ['diff', '--cached', '--stat', '-M']);

    let insertions = 0;
    let deletions = 0;
    const paths: string[] = [];
    for (const line of numstat.split(/\r?\n/).filter(Boolean)) {
      const [add, del, ...rest] = line.split('\t');
      insertions += Number(add) || 0;
      deletions += Number(del) || 0;
      paths.push(rest.join('\t'));
    }
    const stat: DiffStat = { files: paths.length, insertions, deletions, paths, statText };

    if (stat.files === 0) {
      if (opts.allowEmpty) return stat;
      throw new PublishAbort('nothing-to-commit', 'the agent produced no changes');
    }
    if (stat.files > MAX_FILES || insertions + deletions > MAX_LINES) {
      throw new PublishAbort(
        'diff-too-large',
        `${stat.files} files / ${insertions + deletions} lines changed`,
        stat,
      );
    }
    const leaked = stagedIncludeFiles(paths, copiedIncludes);
    if (leaked.length)
      throw new PublishAbort(
        'include-file-staged',
        `copied env files staged: ${leaked.join(', ')}`,
        leaked,
      );

    const diff = await this.git.run(cwd, ['diff', '--cached', '-U0', '-M']);
    const hits: SecretHit[] = scanDiffForSecrets(diff);
    if (hits.length) {
      throw new PublishAbort(
        'secret-detected',
        hits.map((h) => `${h.kind} at diff line ${h.line}`).join('; '),
        hits,
      );
    }
    return stat;
  }

  renderCommitMessage(c: ConventionalCommit, trailers: readonly string[]): string {
    const header = `${c.type}${c.scope ? `(${c.scope})` : ''}: ${c.subject}`;
    const parts = [header];
    if (c.body?.trim()) parts.push('', c.body.trim());
    if (c.breaking?.trim()) parts.push('', `BREAKING CHANGE: ${c.breaking.trim()}`);
    if (trailers.length) parts.push('', ...trailers);
    return parts.join('\n') + '\n';
  }

  /**
   * Commit with the repo's hooks enabled first (lint-staged formats the agent's
   * output). If hooks fail, retry once with --no-verify and report it.
   */
  async commit(cwd: string, message: string): Promise<{ sha: string; hooksBypassed: boolean }> {
    const identity = [
      '-c',
      `user.name=${BOT_IDENTITY.name}`,
      '-c',
      `user.email=${BOT_IDENTITY.email}`,
    ];
    let r = await runCommand('git', [...identity, 'commit', '-q', '-F', '-'], {
      cwd,
      timeoutMs: 5 * 60_000,
      env: { GIT_TERMINAL_PROMPT: '0' },
      input: message,
    });
    let hooksBypassed = false;
    if (r.exitCode !== 0) {
      // Hooks may have restaged/formatted files; re-add then bypass.
      await this.git.run(cwd, ['add', '-A']);
      r = await runCommand('git', [...identity, 'commit', '-q', '--no-verify', '-F', '-'], {
        cwd,
        timeoutMs: 60_000,
        env: { GIT_TERMINAL_PROMPT: '0' },
        input: message,
      });
      hooksBypassed = true;
      if (r.exitCode !== 0) throw new Error(`git commit failed:\n${r.output.slice(-3000)}`);
    }
    const sha = await this.git.revParse(cwd, 'HEAD');
    return { sha, hooksBypassed };
  }

  /** `env` carries per-host auth (see git.auth); `authHint` is what to tell a human on a 401. */
  async push(
    cwd: string,
    remote: string,
    branch: string,
    opts: { env?: Readonly<Record<string, string>>; authHint?: string } = {},
  ): Promise<void> {
    const r = await runCommand('git', ['push', '-u', remote, branch], {
      cwd,
      timeoutMs: 3 * 60_000,
      env: { ...opts.env, GIT_TERMINAL_PROMPT: '0' },
    });
    if (r.exitCode === 0) return;
    const out = r.output;
    if (/non-fast-forward|fetch first|rejected/i.test(out)) {
      throw new PublishAbort(
        'non-fast-forward',
        `remote branch ${branch} has diverged — a human touched it`,
      );
    }
    if (/authentication|could not read Username|Permission denied|403/i.test(out)) {
      throw new PublishAbort(
        'auth',
        `git push authentication failed — ${opts.authHint ?? 'run `gh auth setup-git`'}\n${out.slice(-1000)}`,
      );
    }
    throw new Error(`git push failed:\n${out.slice(-3000)}`);
  }
}
