import { describe, expect, it } from 'vitest';

import { assertTransition, canTransition, isTerminal, TASK_STATES } from './task.state.js';

describe('task state machine', () => {
  it('permits the happy path', () => {
    const path = [
      'queued',
      'claimed',
      'preparing',
      'running',
      'verifying',
      'publishing',
      'review',
    ] as const;
    for (let i = 1; i < path.length; i++) expect(canTransition(path[i - 1]!, path[i]!)).toBe(true);
  });
  it('permits exactly one retry edge verifying -> running', () => {
    expect(canTransition('verifying', 'running')).toBe(true);
  });
  it('terminal states have no exits', () => {
    for (const s of TASK_STATES.filter(isTerminal)) {
      for (const t of TASK_STATES) expect(canTransition(s, t)).toBe(false);
    }
  });
  it('throws a typed error on illegal edges', () => {
    expect(() => assertTransition('queued', 'publishing')).toThrow(
      /Illegal task transition queued -> publishing/,
    );
  });
});
