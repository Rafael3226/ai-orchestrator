import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCommand } from '../process/command.runner.js';

export interface PrInput {
  readonly cwd: string;
  readonly githubRepo: string; // owner/name
  readonly base: string;
  readonly head: string;
  readonly title: string;
  readonly body: string;
  readonly draft: boolean;
  readonly labels: readonly string[];
}

/** gh.exe is a real executable, so Windows resolves it from PATH without a shell. */
const GH = 'gh';

/** Idempotent: finds an existing open PR for the branch before creating one. */
export class PrPublisher {
  constructor(private readonly warn: (message: string) => void = () => {}) {}

  async findExisting(input: Pick<PrInput, 'cwd' | 'githubRepo' | 'head'>): Promise<string | null> {
    const r = await runCommand(
      GH,
      [
        'pr',
        'list',
        '--repo',
        input.githubRepo,
        '--head',
        input.head,
        '--state',
        'open',
        '--json',
        'url',
        '--limit',
        '1',
      ],
      {
        cwd: input.cwd,
        timeoutMs: 60_000,
        env: { GH_PROMPT_DISABLED: '1' },
      },
    );
    if (r.exitCode !== 0) throw new Error(`gh pr list failed:\n${r.output.slice(-2000)}`);
    try {
      const arr = JSON.parse(r.stdout || '[]') as { url: string }[];
      return arr[0]?.url ?? null;
    } catch {
      return null;
    }
  }

  async createDraft(input: PrInput): Promise<string> {
    const existing = await this.findExisting(input);
    if (existing) return existing;

    // Body goes to a temp file outside the worktree — never into the repo.
    const dir = mkdtempSync(join(tmpdir(), 'ai-orch-pr-'));
    const bodyFile = join(dir, 'body.md');
    writeFileSync(bodyFile, input.body, 'utf8');

    const args = [
      'pr',
      'create',
      '--repo',
      input.githubRepo,
      '--base',
      input.base,
      '--head',
      input.head,
      '--title',
      input.title,
      '--body-file',
      bodyFile,
    ];
    if (input.draft) args.push('--draft');
    for (const l of input.labels) args.push('--label', l);

    // Never through a shell: on Windows that re-splits the quoted title on spaces.
    const r = await runCommand(GH, args, {
      cwd: input.cwd,
      timeoutMs: 120_000,
      env: { GH_PROMPT_DISABLED: '1' },
    });
    if (r.exitCode !== 0) {
      // Labels that don't exist on the repo make gh fail; retry without them once,
      // and say so — a silently unlabelled PR looked like a config that never applied.
      if (input.labels.length && /label/i.test(r.output)) {
        this.warn(
          `PR opened without labels [${input.labels.join(', ')}]: gh rejected them — ` +
            `create them on ${input.githubRepo} (\`orchestrator doctor\` checks this)`,
        );
        return this.createDraft({ ...input, labels: [] });
      }
      throw new Error(`gh pr create failed:\n${r.output.slice(-3000)}`);
    }
    const url = /https:\/\/github\.com\/\S+\/pull\/\d+/.exec(r.stdout + r.output)?.[0];
    if (!url)
      throw new Error(
        `gh pr create succeeded but no URL found in output:\n${r.output.slice(-1000)}`,
      );
    return url;
  }
}
