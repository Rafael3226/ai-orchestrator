import type { AgentBoardAction, WorkItemDraft } from '../board/board.actions.js';
import type { CardFields } from '../board/board.types.js';
import type { CostSummary, ExecResult } from '../exec/exec.driver.js';
import type {
  BlockedReport,
  Decision,
  Finding,
  FindingSeverity,
  ProposedSummary,
} from '../mcp/board.schemas.js';
import type { DeliveryKind } from '../policy/delivery.policy.js';

import type { DiffStat } from './git.publisher.js';
import type { VerifyResult } from './verify.runner.js';

export interface ReportInput {
  readonly runId: string;
  readonly cardShortId: string;
  readonly cardUrl: string;
  readonly role: string;
  readonly attempt: number;
  readonly branch: string;
  readonly summary: ProposedSummary | null;
  readonly blocked: BlockedReport | null;
  readonly decisions: readonly Decision[];
  readonly verify: readonly VerifyResult[];
  readonly diff: DiffStat | null;
  readonly exec: ExecResult;
  readonly prUrl: string | null;
  readonly hooksBypassed: boolean;
  readonly denials: readonly { toolName: string; reason: string }[];
  readonly verdict: 'review' | 'blocked' | 'needs_human' | 'failed';
  readonly verdictReason: string;
  /** `board-only` inverts the comment: the summary IS the deliverable. */
  readonly outcome?: DeliveryKind;
  /** Board changes the agent asked for; applied by the outbox after this comment is queued. */
  readonly actions?: readonly AgentBoardAction[];
}

const oneLine = (text: string): string => text.replace(/\s*\n+\s*/g, ' ').trim();

/** What the agent asked the board to do, so a human reading the card can see it. */
export function actionLines(actions: readonly AgentBoardAction[]): string[] {
  if (!actions.length) return [];
  return ['## Board changes', ...actions.flatMap(actionLine), ''];
}

function actionLine(a: AgentBoardAction): string[] {
  switch (a.kind) {
    case 'create':
      return [createdLine(a.item)];
    case 'reassign':
      return [`- Handed to **${a.to}**: ${a.reason}`];
    case 'set-fields':
      return [`- Planning: ${fieldsSummary(a.fields)}`, `  ${oneLine(a.rationale)}`];
    case 'comment':
      return ['- Added a comment'];
  }
}

function createdLine(item: WorkItemDraft): string {
  const to = item.assignTo && item.assignTo !== 'default' ? ` → ${item.assignTo}` : '';
  const under = item.type === 'subtask' && item.parent ? ' (sub-task of this card)' : '';
  return `- Created ${item.type}: **${item.title}**${under}${to}`;
}

function fieldsSummary(f: CardFields): string {
  return [
    f.priority ? `priority ${f.priority}` : null,
    f.storyPoints !== undefined ? `${f.storyPoints} points` : null,
    f.startDate ? `start ${f.startDate}` : null,
    f.dueDate ? `due ${f.dueDate}` : null,
  ]
    .filter(Boolean)
    .join(', ');
}

const money = (n: number): string => `$${n.toFixed(2)}`;
const mins = (ms: number): string => `${Math.round(ms / 6000) / 10} min`;

/** Trello rejects comments past ~16k; leave headroom for the footer. */
const COMMENT_MAX = 15_000;

const SEVERITY_ORDER: Record<FindingSeverity, number> = {
  blocker: 0,
  major: 1,
  minor: 2,
  nit: 3,
};

function findingLines(findings: readonly Finding[]): string[] {
  const lines: string[] = ['', '## Findings'];
  const sorted = [...findings].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
  let current = '';
  for (const f of sorted) {
    if (f.severity !== current) {
      current = f.severity;
      lines.push('', `**${f.severity}**`);
    }
    lines.push(`- **${f.title}**${f.location ? ` (\`${f.location}\`)` : ''} — ${f.detail}`);
  }
  return lines;
}

function clamp(text: string, max = COMMENT_MAX): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n\n…truncated`;
}

export function costLine(c: CostSummary, turns: number, durationMs: number): string {
  const est = c.estimated ? ' (estimated — usage was incomplete)' : '';
  return `${money(c.totalCostUsd)}${est} · ${turns} turns · ${mins(durationMs)} · ${c.inputTokens.toLocaleString()} in / ${c.outputTokens.toLocaleString()} out / ${c.cacheReadTokens.toLocaleString()} cached`;
}

/** PR body: full detail for a reviewer. */
export function buildPrBody(r: ReportInput): string {
  const s = r.summary;
  const lines: string[] = [];
  if (s) {
    lines.push('## Summary', s.summary, '', '## Test plan', s.testPlan);
    if (s.filesTouched.length)
      lines.push('', '## Files', ...s.filesTouched.slice(0, 60).map((f) => `- \`${f}\``));
    if (s.followUps?.length) lines.push('', '## Follow-ups', ...s.followUps.map((f) => `- ${f}`));
    if (s.findings?.length) lines.push(...findingLines(s.findings));
  }
  if (r.decisions.length) {
    lines.push('', '## Decisions');
    for (const d of r.decisions) {
      lines.push(`- **${d.title}** — ${d.rationale}`);
      if (d.alternatives?.length) lines.push(`  - considered: ${d.alternatives.join('; ')}`);
    }
  }
  lines.push('', '## Verification');
  for (const v of r.verify) {
    lines.push(
      `- \`${v.command}\` → ${v.ok ? '✅ passed' : v.timedOut ? '⏱ timed out' : `❌ exit ${v.exitCode}`} (${mins(v.durationMs)})`,
    );
  }
  if (r.hooksBypassed) lines.push('- ⚠ commit hooks failed and were bypassed with `--no-verify`');
  if (r.denials.length) {
    lines.push(
      '',
      '## Guard denials',
      ...r.denials.slice(0, 20).map((d) => `- \`${d.toolName}\`: ${d.reason}`),
    );
  }
  lines.push(
    '',
    '## Run',
    `- Card: ${r.cardUrl || r.cardShortId} · Role: ${r.role} · Attempt: ${r.attempt}`,
    `- Cost: ${costLine(r.exec.cost, r.exec.numTurns, r.exec.durationMs)} — client-side estimate, not a bill`,
    `- Run id: \`${r.runId}\``,
    '',
    '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
  );
  return lines.join('\n');
}

/** Board comment: short, scannable, links out. */
export function buildBoardComment(r: ReportInput): string {
  const icon = { review: '✅', blocked: '🟠', needs_human: '🟡', failed: '🔴' }[r.verdict];
  const lines = [
    `${icon} **${r.role}** — ${r.verdict.replace('_', ' ')} (attempt ${r.attempt})`,
    '',
  ];
  const boardOnly = r.outcome === 'board-only';
  if (r.summary) {
    // For a board-only role the summary is the whole point, so it is printed in
    // full rather than clipped to a six-line teaser pointing at a PR.
    lines.push(
      boardOnly ? r.summary.summary : r.summary.summary.split('\n').slice(0, 6).join('\n'),
      '',
    );
    if (r.summary.acceptanceCriteria?.length) {
      lines.push(
        '## Acceptance criteria',
        ...r.summary.acceptanceCriteria.map((c) => `- [ ] ${c}`),
        '',
      );
    }
    if (r.summary.findings?.length) lines.push(...findingLines(r.summary.findings), '');
    if (r.summary.testability) {
      lines.push(
        r.summary.testability.testable
          ? `**QA:** testable — ${r.summary.testability.reason}`
          : `**QA:** not needed — ${r.summary.testability.reason}`,
        '',
      );
    }
  }
  // Board-only roles have no PR body to carry their decisions, and BA's decisions
  // are part of the deliverable: they go on the card.
  if (boardOnly && r.decisions.length) {
    lines.push(
      '## Decisions',
      ...r.decisions.map((d) => `- **${d.title}** — ${oneLine(d.rationale)}`),
      '',
    );
  }
  lines.push(...actionLines(r.actions ?? []));
  if (r.blocked)
    lines.push(
      `**Blocked (${r.blocked.category}):** ${r.blocked.reason}`,
      '',
      'Needs:',
      ...r.blocked.needs.map((n) => `- ${n}`),
      '',
    );
  if (r.verdictReason && r.verdict !== 'review') lines.push(`Reason: ${r.verdictReason}`, '');
  // A board-only run has no branch, no diff and no PR — printing those headings
  // empty just makes the comment look broken.
  if (!boardOnly) {
    if (r.prUrl) lines.push(`PR: ${r.prUrl}`);
    lines.push(`Branch: \`${r.branch}\``);
    if (r.diff)
      lines.push(`Changes: ${r.diff.files} files, +${r.diff.insertions} −${r.diff.deletions}`);
  }
  for (const v of r.verify) lines.push(`${v.ok ? '✔' : '✖'} \`${v.command}\``);
  lines.push(`Cost: ${costLine(r.exec.cost, r.exec.numTurns, r.exec.durationMs)}`);
  lines.push('', `<sub>ai-orch · run \`${r.runId}\`</sub>`);
  return clamp(lines.join('\n'));
}
