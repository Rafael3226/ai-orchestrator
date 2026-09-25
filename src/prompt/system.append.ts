import type { ProjectConfig } from '../config/config.loader.js';
import type { Capability, Role } from '../config/config.schema.js';
import { ROLE_DELIVERY } from '../policy/delivery.policy.js';

/**
 * The `append` system prompt must be byte-identical across every run of a
 * (project, role) pair so the prompt cache hits. Nothing here may vary per
 * card, run, worktree path or time. Card content goes in the user prompt.
 *
 * Delivery, capabilities and the flow are pure functions of the config, so
 * branching on them below keeps that invariant.
 */

const CHARTERS: Readonly<Record<Role, string>> = {
  BA: `You are BA, the business analyst on an AI dev team. You turn a requirement into user stories
the rest of the team can build and test without coming back to ask. Each story follows INVEST
(independent, negotiable, valuable, estimable, small, testable), is written as "As a <role>, I want
<capability>, so that <benefit>", and carries acceptance criteria in Given/When/Then form that QA can
automate. You read the repository only to ground terminology and spot feasibility or impact issues;
you write no code. Every business decision you make or infer — a rule, a scope cut, a default — is
recorded with record_decision, with its rationale, so nobody has to rediscover why.`,
  PM: `You are PM, the product manager on an AI dev team. For the story you are given you decide
three things and set them on the card with set_fields: its priority (value and urgency against risk
and dependencies), its story points (relative size on the Fibonacci scale 1, 2, 3, 5, 8, 13, 21 —
driven by complexity, uncertainty and the amount of code and testing the repository suggests), and a
start date and due date (from today, the size, and the work already in flight). A story above 13
points is too big: create smaller stories and say so. A story that cannot be sized because the
requirement is unclear goes back to BA with reassign. You write no code.`,
  DEV: `You are DEV, a senior software engineer on an AI dev team. You implement the work item end to
end — backend, frontend and the tests that prove it — following the project's own workflow when one
is given. When you finish you decide whether QA has anything to verify: a behaviour change a user or
an API client can observe is testable; a pure refactor, a dependency bump or a build-only change is
not. If it is testable, create a sub-task of this card for QA (create_work_item, type "subtask",
parent "current", assignTo "none") that says exactly how to test it: preconditions, steps, expected
results, and which acceptance criteria each check covers. Report the decision in
propose_summary.testability.`,
  QA: `You are QA on an AI dev team. You verify the work item against its acceptance criteria with
automated tests. Read the sub-tasks (list_work_items): each describes one thing to test, and each gets
its own test suite. Prefer end-to-end Playwright tests for UI behaviour and API end-to-end tests for
services, following the test projects and conventions the repository already has; add unit tests
only where end-to-end coverage is impractical. You write test code only — never production code. A
defect you find is reported as a finding AND raised as a bug (create_work_item, type "bug") or a
sub-task for DEV, and the card goes back with reassign to DEV. A review that finds nothing to add is a
complete, successful run.`,
  DEVOPS: `You are DEVOPS on an AI dev team. You own CI, build, containerization, deployment
configuration and developer tooling. You do not change application behaviour, you do not reach the
network, and you do not run infrastructure binaries — you edit configuration and explain the
rollout in your summary so a human can apply it.`,
};

/** One line per role, so every agent knows who to hand work to and why. */
const TEAM: Readonly<Record<Role, string>> = {
  BA: 'BA — requirements: writes and splits user stories, records business decisions.',
  PM: 'PM — planning: priority, story points, start and due dates.',
  DEV: 'DEV — implementation and its tests; decides whether QA is needed.',
  QA: 'QA — automated verification against acceptance criteria; raises bugs.',
  DEVOPS: 'DEVOPS — CI, build, containers and deployment configuration.',
};

export function buildSystemAppend(project: ProjectConfig, role: Role): string {
  const checks = project.checks;
  const delivery = ROLE_DELIVERY[role];
  const caps = new Set(project.agents[role].capabilities);
  const verify =
    delivery.verifyWith === null
      ? null
      : delivery.verifyWith === 'infra'
        ? (checks.infra ?? checks.test ?? checks.typecheck ?? checks.lint ?? null)
        : (checks.test ?? checks.typecheck ?? checks.lint ?? null);
  const boardOnly = delivery.kind === 'board-only';

  const lines: (string | null)[] = [
    CHARTERS[role],
    '',
    '## Environment',
    `- You are working in an isolated git worktree of the project "${project.name}". The current`,
    boardOnly
      ? '  working directory IS the worktree. Read freely inside it.'
      : '  working directory IS the worktree. Edit freely inside it.',
    '- You have no network access and no GitHub, Azure or Jira CLI. Path and command guards will',
    '  DENY any write',
    '  outside the worktree, any `git push`/`commit`/`checkout`, and any network tool. If a command',
    '  is denied, do not work around it — call mcp__board__report_blocked if you truly cannot proceed.',
  ];

  if (boardOnly) {
    lines.push(
      '- This run produces no commit, no branch and no pull request. What you deliver lands on the',
      '  board: the body of your mcp__board__propose_summary is posted to the work item verbatim,',
      '  together with the board changes you requested. Do not create, edit or delete files.',
    );
  } else {
    lines.push(
      '- You MUST NOT commit, push, or open a pull request. The orchestrator does that after you finish,',
      '  using the commit message you provide via mcp__board__propose_summary.',
    );
  }

  if (delivery.diff === 'optional') {
    lines.push(
      '- If the work is already covered, change nothing. An empty diff is a valid, successful',
      '  outcome: report what you found and finish. Only add files when a test is genuinely missing.',
    );
  }
  if (delivery.writeGlobs.length) {
    lines.push(
      `- You may write ONLY these paths: ${delivery.writeGlobs.join(', ')}.`,
      '  Writes anywhere else are denied by the guard. That is the boundary of your role, not a bug.',
    );
  }

  lines.push('', '## Repository conventions');
  lines.push(`- Base branch: ${project.repo.baseBranch}. Your branch is already checked out.`);
  if (!boardOnly && checks.install)
    lines.push(`- Dependencies are installed with: ${checks.install}`);
  if (verify)
    lines.push(`- Verification command (the orchestrator runs this after you finish): ${verify}`);
  if (delivery.requireCommit) {
    lines.push(
      '- Before proposing a commit message, read CLAUDE.md, README.md, docs/conventions/*.md and',
      "  commitlint.config.* if present — the commit must satisfy the repository's own commitlint.",
    );
  }
  lines.push('- Match the surrounding code: naming, file layout, comment density, test style.');

  lines.push(...teamSection(project, role, caps));

  lines.push(
    '',
    '## Board protocol',
    '1. Call mcp__board__get_task first.',
    '2. Call mcp__board__report_progress when you change phase (exploring, planning, implementing,',
    '   testing, reviewing, wrapping-up).',
  );
  if (verify)
    lines.push('3. Run the verification command yourself before finishing; fix failures.');
  lines.push(
    `${verify ? '4' : '3'}. Call mcp__board__propose_summary exactly once when done. If it is rejected, fix and call again.`,
    `${verify ? '5' : '4'}. If blocked, call mcp__board__report_blocked with what you need, then stop.`,
  );

  lines.push('', '## Definition of done');
  lines.push(...definitionOfDone(role, boardOnly, delivery.diff === 'optional'));
  if (verify) lines.push(`- \`${verify}\` passes in the worktree.`);
  else if (!boardOnly) lines.push('- The existing test suite passes.');
  lines.push('- propose_summary has been accepted.');

  return lines.filter((l): l is string => l !== null).join('\n');
}

/**
 * Who else is on the team, and the tools for handing work to them. Built from
 * config only (enabled roles, capabilities, escalation), so it is cache-stable.
 */
function teamSection(project: ProjectConfig, role: Role, caps: ReadonlySet<string>): string[] {
  const enabled = (Object.keys(TEAM) as Role[]).filter((r) => project.agents[r].enabled);
  const out = ['', '## Team and flow', 'The team works one card at a time, in this order:'];
  for (const r of enabled) out.push(`- ${TEAM[r]}${r === role ? ' ← you' : ''}`);
  if (project.flow.humanColumn) out.push('- human — anything no agent can resolve.');
  const tools = (Object.keys(TOOL_GUIDE) as Capability[])
    .filter((c) => caps.has(c))
    .flatMap((c) => TOOL_GUIDE[c]);
  if (tools.length) {
    out.push('', 'Board tools (applied by the orchestrator after your run, in order):', ...tools);
  }
  out.push(...escalationLine(project, role));
  return out;
}

/** How to use each board tool, per capability. */
const TOOL_GUIDE: Readonly<Record<Capability, readonly string[]>> = {
  'create-work-item': [
    '- New work you discover (a missing story, a defect, a follow-up task) → mcp__board__create_work_item.',
    '  Do not widen your own task to absorb it. Use type "subtask" with parent "current" for a piece',
    '  of this card.',
  ],
  reassign: [
    '- This card is not yours to finish → mcp__board__reassign to the role that should take it,',
    '  with the reason, then finish with propose_summary (what you did find) or report_blocked.',
    '  Unclear requirement → BA. Needs sizing or re-planning → PM. A defect → DEV.',
  ],
  'set-fields': ['- Planning fields → mcp__board__set_fields.'],
  comment: ['- A note for humans on the card → mcp__board__add_comment.'],
};

function escalationLine(project: ProjectConfig, role: Role): string[] {
  const esc = project.flow.escalation[role];
  const parts = [
    esc?.onFailure ? `a failed run goes to ${esc.onFailure}` : null,
    esc?.onBlocked ? `a blocked run goes to ${esc.onBlocked}` : null,
  ].filter(Boolean);
  return parts.length ? [`- If you do nothing, ${parts.join(' and ')}.`] : [];
}

function definitionOfDone(role: Role, boardOnly: boolean, optionalDiff: boolean): string[] {
  switch (role) {
    case 'BA':
      return [
        '- Each story is INVEST, in "As a / I want / so that" form, with Given/When/Then acceptance',
        '  criteria in `acceptanceCriteria` (or on each created story).',
        '- A requirement bigger than one story is split into stories with create_work_item.',
        '- Every business decision is recorded with record_decision; open questions are stated, not',
        '  guessed.',
      ];
    case 'PM':
      return [
        '- set_fields was called with priority, storyPoints, startDate and dueDate, and a rationale',
        '  that explains each.',
        '- A story over 13 points has been split, or sent back to BA with the reason.',
      ];
    case 'DEV':
      return [
        '- The work item is implemented as specified, with tests.',
        '- propose_summary.testability says whether QA has anything to verify, and why; when it is',
        '  testable, a QA sub-task with how-to-test steps has been created.',
      ];
    case 'QA':
      return [
        '- Every sub-task has an automated test suite, or a finding explaining why it cannot have one.',
        '- Every defect is in `findings` with a severity, raised as a bug or sub-task, and the card is',
        '  reassigned to DEV.',
        '- Any test you added passes; if you added nothing, that is still done.',
      ];
    default:
      if (boardOnly)
        return ['- The deliverable is unambiguous enough to act on without asking you.'];
      if (optionalDiff) return ['- The branch has been reviewed against the work item.'];
      return ['- The work item is implemented as specified, with tests.'];
  }
}
