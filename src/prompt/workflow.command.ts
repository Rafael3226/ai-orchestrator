import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A target repo's own slash command (e.g. `/acts-workflow-managed`), expanded
 * by the orchestrator into the prompt instead of being run by the CLI.
 *
 * Why not let the CLI run it: that needs `settingSources: ['project']`, which
 * would also load the target repo's hooks and `.mcp.json` into an unattended
 * run. Inlining the text gets the team's workflow without handing the repo
 * control of the agent's runtime.
 */
export interface ExpandedCommand {
  readonly name: string;
  readonly body: string;
  /** Commands the body invokes, expanded once each, breadth first. */
  readonly nested: readonly { readonly name: string; readonly body: string }[];
}

const MAX_TOTAL_CHARS = 60_000;
/** Tildes, so the command's own triple-backtick blocks cannot close the fence early. */
const FENCE = '~~~~';
/** A slash token at a word boundary: `/acts-git-commit`, `/openspec:apply`. Not `/rest/api`. */
const SLASH_TOKEN = /(?<![\w/.:-])\/([a-z][\w.-]*(?::[\w.-]+)*)(?![\w/])/gi;

/**
 * Where a command lives, in the order Claude Code looks: project commands
 * (`/ns:name` → `commands/ns/name.md`), then project skills.
 */
export function resolveCommandFile(roots: readonly string[], command: string): string | null {
  const name = command.replace(/^\//, '');
  const parts = name.split(':');
  const leaf = parts.at(-1) ?? name;
  for (const root of roots) {
    const candidates = [
      join(root, '.claude', 'commands', ...parts) + '.md',
      join(root, '.claude', 'skills', leaf, 'SKILL.md'),
      join(root, '.claude', 'skills', parts.join('-'), 'SKILL.md'),
    ];
    const hit = candidates.find((c) => existsSync(c));
    if (hit) return hit;
  }
  return null;
}

export function stripFrontmatter(text: string): string {
  // A UTF-8 BOM (0xfeff) would stop the frontmatter matching at ^.
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
}

/**
 * Expand `command` with `args` in place of `$ARGUMENTS`, plus every command it
 * references that resolves to a file, up to `depth` levels. Nested bodies keep
 * their `$ARGUMENTS`: they mean whatever the parent passes where it invokes them.
 * Returns null when the command does not exist.
 */
export function expandWorkflowCommand(
  roots: readonly string[],
  command: string,
  args: string,
  depth = 2,
): ExpandedCommand | null {
  const file = resolveCommandFile(roots, command);
  if (!file) return null;
  const body = readCommand(file).replaceAll('$ARGUMENTS', args);
  const name = normalize(command);
  return { name, body, nested: expandNested(roots, name, body, depth) };
}

const OMITTED = '(omitted — the workflow is too long to inline in full)';

/** Breadth first, each command once, within the size budget. */
function expandNested(
  roots: readonly string[],
  name: string,
  body: string,
  depth: number,
): { name: string; body: string }[] {
  const seen = new Set([name]);
  const budget = { used: body.length };
  const nested: { name: string; body: string }[] = [];
  let frontier = [body];
  for (let level = 0; level < depth && frontier.length; level++) {
    const refs = frontier.flatMap(references).filter((r) => !seen.has(r) && !!seen.add(r));
    frontier = [];
    for (const ref of refs) {
      const entry = inlineReference(roots, ref, budget);
      if (!entry) continue;
      nested.push(entry);
      if (entry.body !== OMITTED) frontier.push(entry.body);
    }
  }
  return nested;
}

function inlineReference(
  roots: readonly string[],
  ref: string,
  budget: { used: number },
): { name: string; body: string } | null {
  const file = resolveCommandFile(roots, ref);
  if (!file) return null;
  const body = readCommand(file);
  if (budget.used + body.length > MAX_TOTAL_CHARS) return { name: ref, body: OMITTED };
  budget.used += body.length;
  return { name: ref, body };
}

function readCommand(file: string): string {
  return stripFrontmatter(readFileSync(file, 'utf8'));
}

function references(text: string): string[] {
  return [...text.matchAll(SLASH_TOKEN)].map((m) => normalize(m[1] ?? ''));
}

function normalize(command: string): string {
  return '/' + command.replace(/^\//, '');
}

/**
 * The prompt section. The overrides come first and are fixed: this is an
 * unattended run, so questions are answered by moving forward, and every
 * step that touches the tracker or the remote belongs to the orchestrator.
 */
export function renderWorkflowSection(cmd: ExpandedCommand, args: string): string {
  const lines = [
    `## Project workflow: ${cmd.name} ${args}`,
    'This repository defines the workflow for this kind of work. Follow its steps in order,',
    'with these overrides — this is an unattended run inside an orchestrator:',
    '- **No human will answer.** Wherever the workflow asks the user (AskUserQuestion, "wait for',
    '  review", an approval), take the option that moves the work forward — approve, yes, proceed —',
    '  and continue. Record each such assumption with mcp__board__record_decision.',
    '- **Skip every step that changes the tracker or the remote:** moving or transitioning the work',
    '  item, commenting on it via an MCP server or CLI, creating or switching branches, committing,',
    '  pushing, creating, approving or merging pull requests, posting review comments, opening a',
    '  browser, and any `az`, `gh` or `git push` command. The orchestrator does these after you',
    '  finish: your branch is already checked out, and your propose_summary becomes the commit and',
    '  the draft pull request. Nothing is ever merged from this run.',
    '- **Tracker context is already here:** call mcp__board__get_task and',
    '  mcp__board__list_work_items instead of loading the issue. Attachments are not available;',
    '  mention it in followUps if they would have mattered.',
    '- **Do** the steps that read the repo, write code, write tests, run local builds and tests, and',
    '  review your own diff against the project guides.',
    '- Do not read `.claude/config.json` or any other credentials file — nothing in it is needed.',
    '- A step skipped under these rules is not a failure; list it in followUps only if a human must',
    '  do it.',
    '',
    `${FENCE}markdown`,
    cmd.body,
    FENCE,
  ];
  for (const n of cmd.nested) {
    lines.push('', `### Referenced command: ${n.name}`, `${FENCE}markdown`, n.body, FENCE);
  }
  return lines.join('\n');
}
