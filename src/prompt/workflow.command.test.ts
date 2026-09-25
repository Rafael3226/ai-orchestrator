import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  expandWorkflowCommand,
  renderWorkflowSection,
  resolveCommandFile,
  stripFrontmatter,
} from './workflow.command.js';

let repo: string;
let worktree: string;

function command(root: string, rel: string, body: string): void {
  const file = join(root, '.claude', rel);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, body);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'wf-repo-'));
  worktree = mkdtempSync(join(tmpdir(), 'wf-wt-'));
  command(
    repo,
    'commands/acts-workflow-managed.md',
    [
      '---',
      'description: managed flow',
      '---',
      '# Managed Feature Workflow',
      'Usage: `/acts-workflow-managed $ARGUMENTS`',
      'Run `/acts-jira-load $ARGUMENTS`, then `/openspec:proposal`.',
      'Call the API at /rest/api/3/issue — not a command.',
      '```bash',
      'git push',
      '```',
    ].join('\n'),
  );
  command(repo, 'commands/acts-jira-load.md', 'Load $ARGUMENTS and read `/acts-git-branch`.');
  command(repo, 'commands/openspec/proposal.md', 'Write a proposal.');
  command(repo, 'skills/acts-git-branch/SKILL.md', '---\nname: x\n---\nCreate a branch.');
});

describe('resolveCommandFile', () => {
  it('maps a namespaced command to a nested file and falls back to skills', () => {
    expect(resolveCommandFile([repo], '/openspec:proposal')).toBe(
      join(repo, '.claude', 'commands', 'openspec', 'proposal.md'),
    );
    expect(resolveCommandFile([repo], '/acts-git-branch')).toBe(
      join(repo, '.claude', 'skills', 'acts-git-branch', 'SKILL.md'),
    );
    expect(resolveCommandFile([repo], '/nope')).toBeNull();
  });

  it('looks in the main checkout first — .claude/ is often gitignored', () => {
    command(worktree, 'commands/acts-workflow-managed.md', 'stale worktree copy');
    expect(resolveCommandFile([repo, worktree], '/acts-workflow-managed')).toContain(repo);
  });
});

describe('expandWorkflowCommand', () => {
  it('substitutes the card key, strips frontmatter and inlines referenced commands', () => {
    const cmd = expandWorkflowCommand([repo, worktree], '/acts-workflow-managed', 'EDCARD-42');
    expect(cmd).not.toBeNull();
    expect(cmd!.body).toContain('/acts-jira-load EDCARD-42');
    expect(cmd!.body).not.toContain('description: managed flow');
    // Breadth first, two levels deep; `/rest/api/3/issue` is not a command.
    expect(cmd!.nested.map((n) => n.name)).toEqual([
      '/acts-jira-load',
      '/openspec:proposal',
      '/acts-git-branch',
    ]);
    expect(cmd!.nested[2]!.body).toBe('Create a branch.');
  });

  it('stops at the configured depth', () => {
    const cmd = expandWorkflowCommand([repo], '/acts-workflow-managed', 'X-1', 1);
    expect(cmd!.nested.map((n) => n.name)).not.toContain('/acts-git-branch');
  });

  it('returns null when the repo does not define the command', () => {
    expect(expandWorkflowCommand([worktree], '/acts-workflow-managed', 'X-1')).toBeNull();
  });
});

describe('renderWorkflowSection', () => {
  it('puts the unattended-run overrides first and fences the body safely', () => {
    const cmd = expandWorkflowCommand([repo], '/acts-workflow-managed', 'EDCARD-42')!;
    const text = renderWorkflowSection(cmd, 'EDCARD-42');
    expect(text.indexOf('No human will answer')).toBeLessThan(text.indexOf('# Managed Feature'));
    expect(text).toContain('Nothing is ever merged from this run');
    expect(text).toContain('Do not read `.claude/config.json`');
    // Tilde fences: the command's own ``` block must not close ours.
    expect(text).toContain('~~~~markdown');
    expect(text).toContain('### Referenced command: /openspec:proposal');
  });
});

describe('stripFrontmatter', () => {
  it('leaves a file without frontmatter alone', () => {
    expect(stripFrontmatter('# Title\nbody')).toBe('# Title\nbody');
  });
});
