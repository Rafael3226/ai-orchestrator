import { describe, expect, it } from 'vitest';

import { planFinishStep } from '../board/board.actions.js';
import { roleSummaryErrors, validateAction } from '../scheduler/task.runner.js';
import { aSummary } from '../testing/scripted.driver.js';

import { loadConfigFromString } from './config.loader.js';
import type { WritebackStep } from './config.schema.js';

/** A board with every role at home, and a Blocked column for humans. */
function config(extra = '', agents = '', flow = 'humanColumn: blocked'): string {
  return `
version: 1
projects:
  - id: demo
    name: Demo
    repo: { path: /repo, worktreeRoot: /wt, githubRepo: me/demo }
    board:
      provider: jira
      site: acme
      projectKey: DEMO
      credentials: JIRA_X
      botMemberId: bot
      columns: { req: Requirements, refine: Refinement, ready: Ready, test: Testing, blocked: Blocked, done: Done }
    agents:
      BA: { enabled: true }
      PM: { enabled: true }
      DEV: { enabled: true }
      QA: { enabled: true }
${agents}
    routes:
      - { when: { column: Requirements }, agent: BA }
      - { when: { column: Refinement }, agent: PM }
      - { when: { column: Ready, label: be }, agent: DEV }
      - { when: { column: Testing }, agent: QA }
    writeback:
      onFailure: { move: blocked, comment: report }
    flow:
      ${flow}
${extra}`;
}

const load = (yaml: string) => loadConfigFromString(yaml, 'x').project('demo');
const loadError = (yaml: string): string => {
  const spy = console.error;
  let out = '';
  console.error = (m: string) => (out += m);
  try {
    load(yaml);
  } catch {
    /* expected */
  } finally {
    console.error = spy;
  }
  return out;
};

describe('flow config', () => {
  it('derives each role home from its first column route, with the route label', () => {
    const p = load(config());
    expect(p.flow.homes).toEqual({
      BA: { column: 'Requirements', label: null },
      PM: { column: 'Refinement', label: null },
      DEV: { column: 'Ready', label: 'be' },
      QA: { column: 'Testing', label: null },
      DEVOPS: null,
    });
  });

  it('lets escalation replace the project default destination, but not a role overlay', () => {
    const p = load(
      config(
        '',
        '      DEVOPS: { enabled: false }',
        'humanColumn: blocked\n      escalation: { QA: { onFailure: DEV }, DEV: { onFailure: human } }',
      ),
    );
    expect(p.agents.QA.writeback.onFailure).toMatchObject({ handTo: 'DEV', comment: 'report' });
    expect(p.agents.QA.writeback.onFailure.move).toBeUndefined();
    expect(p.agents.PM.writeback.onFailure).toMatchObject({ move: 'blocked' });

    const own = load(
      config(
        '',
        '      BA: { enabled: true, writeback: { onBlocked: { move: done } } }'.replace(
          'BA',
          'DEVOPS',
        ),
        'humanColumn: blocked\n      escalation: { DEVOPS: { onBlocked: human } }',
      ),
    );
    expect(own.agents.DEVOPS.writeback.onBlocked).toMatchObject({ move: 'done' });
  });

  it.each([
    [
      'a handTo to a disabled role',
      config('', '', 'humanColumn: blocked\n      escalation: { QA: { onFailure: DEVOPS } }'),
      'DEVOPS is not enabled',
    ],
    [
      'handing to a human without a human column',
      config('', '', 'escalation: { QA: { onFailure: human } }'),
      'needs flow.humanColumn',
    ],
    [
      'an undeclared flow alias',
      config('', '', 'humanColumn: nowhere'),
      '"nowhere" is not declared',
    ],
    [
      'a role handing the card to itself',
      config('', '', 'humanColumn: blocked\n      escalation: { QA: { onFailure: QA } }'),
      'hands the card back to itself',
    ],
    [
      'newItems naming a role with no column',
      config(
        '',
        '      DEVOPS: { enabled: true }',
        'humanColumn: blocked\n      newItems: { task: DEVOPS }',
      ),
      'no column route',
    ],
  ])('rejects %s', (_name, yaml, message) => {
    expect(loadError(yaml)).toContain(message);
  });

  it('rejects a step that sets both move and handTo', () => {
    const yaml = config('', '', 'humanColumn: blocked').replace(
      'onFailure: { move: blocked, comment: report }',
      'onFailure: { move: blocked, handTo: DEV }',
    );
    expect(loadError(yaml)).toContain('set `move` or `handTo`, not both');
  });
});

describe('planFinishStep', () => {
  const step: WritebackStep = {
    move: 'done',
    comment: 'report',
    assign: 'none',
    required: false,
    addLabel: 'qa-passed',
  };
  const flow = { untestableTo: 'done' as string | undefined };

  it('keeps the configured step when the agent asked for nothing', () => {
    expect(planFinishStep(step, { verdict: 'review', actions: [], untestable: false, flow })).toBe(
      step,
    );
  });

  it('lets an explicit reassign win, keeping the comment and labels', () => {
    const planned = planFinishStep(step, {
      verdict: 'review',
      actions: [{ kind: 'reassign', to: 'DEV', reason: 'the login test fails on empty input' }],
      untestable: false,
      flow,
    });
    expect(planned).toMatchObject({ handTo: 'DEV', comment: 'report', addLabel: 'qa-passed' });
    expect(planned.move).toBeUndefined();
  });

  it('skips QA for an untestable DEV change, only on success', () => {
    const handToQa: WritebackStep = { ...step, move: undefined, handTo: 'QA' };
    const ok = planFinishStep(handToQa, { verdict: 'review', actions: [], untestable: true, flow });
    expect(ok).toMatchObject({ move: 'done' });
    expect(ok.handTo).toBeUndefined();
    const failed = planFinishStep(handToQa, {
      verdict: 'failed',
      actions: [],
      untestable: true,
      flow,
    });
    expect(failed.handTo).toBe('QA');
  });
});

describe('validateAction', () => {
  const p = load(config());

  it('refuses a reassign to yourself, to a disabled role, or to an absent human column', () => {
    expect(validateAction(p, 'QA', { kind: 'reassign', to: 'QA', reason: 'x'.repeat(12) })).toEqual(
      ['you cannot reassign the card to yourself'],
    );
    expect(
      validateAction(p, 'QA', { kind: 'reassign', to: 'DEVOPS', reason: 'x'.repeat(12) })[0],
    ).toContain('not enabled');
    expect(
      validateAction(p, 'QA', { kind: 'reassign', to: 'DEV', reason: 'x'.repeat(12) }),
    ).toEqual([]);
  });

  it('requires a parent for a sub-task', () => {
    const item = { type: 'subtask' as const, title: 'How to test', description: 'd'.repeat(30) };
    expect(validateAction(p, 'DEV', { kind: 'create', item })[0]).toContain('needs parent');
    expect(
      validateAction(p, 'DEV', { kind: 'create', item: { ...item, parent: 'current' } }),
    ).toEqual([]);
  });

  it('refuses a due date before the start date', () => {
    expect(
      validateAction(p, 'PM', {
        kind: 'set-fields',
        fields: { startDate: '2026-10-10', dueDate: '2026-10-01' },
        rationale: 'r'.repeat(25),
      }),
    ).toEqual(['dueDate is before startDate']);
  });
});

describe('roleSummaryErrors', () => {
  const subtask = {
    kind: 'create' as const,
    item: { type: 'subtask' as const, title: 'QA: login', description: 'steps', parent: 'current' },
  };
  const summary = (testability?: { testable: boolean; reason: string }) =>
    ({ ...aSummary(), testability }) as Parameters<typeof roleSummaryErrors>[1];

  it('only constrains DEV', () => {
    expect(roleSummaryErrors('QA', summary(undefined), [])).toEqual([]);
  });

  it('makes DEV decide testability', () => {
    expect(roleSummaryErrors('DEV', summary(undefined), [])[0]).toContain('testability');
  });

  it('makes a testable DEV change leave QA a sub-task', () => {
    const testable = summary({ testable: true, reason: 'new endpoint behaviour' });
    expect(roleSummaryErrors('DEV', testable, [])[0]).toContain('no QA sub-task');
    expect(roleSummaryErrors('DEV', testable, [subtask])).toEqual([]);
  });
});
