import type { CostSummary, ExecResult } from '../exec/exec.driver.js';
import type { BlockedReport, Decision, ProposedSummary } from '../mcp/board.schemas.js';

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
}

const money = (n: number): string => `$${n.toFixed(2)}`;
const mins = (ms: number): string => `${Math.round(ms / 6000) / 10} min`;

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
  if (r.summary) lines.push(r.summary.summary.split('\n').slice(0, 6).join('\n'), '');
  if (r.blocked)
    lines.push(
      `**Blocked (${r.blocked.category}):** ${r.blocked.reason}`,
      '',
      'Needs:',
      ...r.blocked.needs.map((n) => `- ${n}`),
      '',
    );
  if (r.verdictReason && r.verdict !== 'review') lines.push(`Reason: ${r.verdictReason}`, '');
  if (r.prUrl) lines.push(`PR: ${r.prUrl}`);
  lines.push(`Branch: \`${r.branch}\``);
  if (r.diff)
    lines.push(`Changes: ${r.diff.files} files, +${r.diff.insertions} −${r.diff.deletions}`);
  for (const v of r.verify) lines.push(`${v.ok ? '✔' : '✖'} \`${v.command}\``);
  lines.push(`Cost: ${costLine(r.exec.cost, r.exec.numTurns, r.exec.durationMs)}`);
  lines.push('', `<sub>ai-orch · run \`${r.runId}\`</sub>`);
  return lines.join('\n');
}
