import type { TaskView } from '../mcp/board.server.js';

/**
 * Card text is untrusted input reaching a tool-using agent. Neutralize the
 * obvious injection shapes without mangling ordinary markdown.
 */
export function sanitizeCardText(text: string, max = 12_000): string {
  return text
    .replace(
      /<\/?\s*(system|assistant|human|instructions?|system-reminder)[^>]*>/gi,
      (m) => `[${m.replace(/[<>]/g, '')}]`,
    )
    .replace(/^\s*(ignore|disregard) (all )?(previous|prior|above) instructions.*$/gim, '[removed]')
    .slice(0, max);
}

export interface UserPromptInput {
  readonly task: TaskView;
  readonly worktreePath: string;
  readonly baseRef: string; // e.g. origin/main @ 0f8d4a9
  readonly budget: { maxTurns: number; maxUsd: number; wallClockMinutes: number };
  readonly verifyCommand: string | null;
  /** Present on the retry attempt. */
  readonly previousFailure?: { command: string; exitCode: number | null; outputTail: string };
}

export function buildUserPrompt(input: UserPromptInput): string {
  const { task } = input;
  const lines: string[] = [
    '## Work item',
    `[${task.cardShortId}] ${task.title}`,
    task.cardUrl ? `Card: ${task.cardUrl}` : '',
    task.labels.length ? `Labels: ${task.labels.join(', ')}` : '',
    '',
    '### Description',
    sanitizeCardText(task.spec) || '(no description — the title is the whole brief)',
    '',
    '## Context for this run',
    `Project: ${task.projectId}`,
    `Worktree: ${input.worktreePath}   (this is your cwd)`,
    `Branch: ${task.branch}`,
    `Base: ${input.baseRef}`,
    `Attempt: ${task.attempt} of ${task.maxAttempts}`,
    `Budget: ${input.budget.maxTurns} turns, $${input.budget.maxUsd.toFixed(2)}, ${input.budget.wallClockMinutes} minutes wall clock`,
  ];

  if (input.previousFailure) {
    lines.push(
      '',
      '## Your previous attempt did not pass verification',
      `Command: ${input.previousFailure.command}`,
      `Exit code: ${input.previousFailure.exitCode ?? 'killed'}`,
      '```',
      input.previousFailure.outputTail.slice(-8000),
      '```',
      'Fix the failures. You still have your context — do not re-explore the codebase from scratch.',
      'Call mcp__board__propose_summary again when done.',
    );
  } else {
    lines.push(
      '',
      '## Start',
      'Call mcp__board__get_task if you need the full card payload. Explore before editing.',
      input.verifyCommand ? `Run \`${input.verifyCommand}\` yourself before finishing.` : '',
      'Call mcp__board__propose_summary exactly once when the work is complete.',
    );
  }
  return lines.filter((l) => l !== '').join('\n');
}
