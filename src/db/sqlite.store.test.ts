import { describe, expect, it } from 'vitest';

import { newRunId, newTaskId } from '../domain/ids.js';

import { SqliteStore } from './sqlite.store.js';

const task = (store: SqliteStore, cardId = 'c1') =>
  store.insertTask({
    id: newTaskId(),
    projectId: 'p',
    role: 'DEV-BE',
    cardId,
    cardShortId: '42',
    title: 'Do a thing',
    spec: 'spec',
  });

describe('SqliteStore', () => {
  it('inserts a queued task and walks legal transitions with CAS', () => {
    const store = new SqliteStore(':memory:');
    const t = task(store);
    expect(t.state).toBe('queued');
    store.transitionTask(t.id, 'queued', 'claimed');
    store.transitionTask(t.id, 'claimed', 'preparing');
    expect(store.getTask(t.id).state).toBe('preparing');
  });

  it('rejects an illegal transition before touching the row', () => {
    const store = new SqliteStore(':memory:');
    const t = task(store);
    expect(() => store.transitionTask(t.id, 'queued', 'review')).toThrow(/Illegal/);
    expect(store.getTask(t.id).state).toBe('queued');
  });

  it('rejects a CAS from the wrong state', () => {
    const store = new SqliteStore(':memory:');
    const t = task(store);
    store.transitionTask(t.id, 'queued', 'claimed');
    expect(() => store.transitionTask(t.id, 'queued', 'claimed')).toThrow(
      /expected state queued but found claimed/,
    );
  });

  it('enforces one active task per (project, card) via partial unique index', () => {
    const store = new SqliteStore(':memory:');
    task(store, 'same');
    expect(() => task(store, 'same')).toThrow(/UNIQUE/);
  });

  it('allows a new task for a card whose previous task is terminal', () => {
    const store = new SqliteStore(':memory:');
    const t = task(store, 'same');
    store.transitionTask(t.id, 'queued', 'cancelled');
    expect(() => task(store, 'same')).not.toThrow();
  });

  it('records runs and events and marks stale live runs interrupted on recovery', () => {
    const store = new SqliteStore(':memory:');
    const t = task(store);
    const runId = newRunId();
    store.insertRun({
      id: runId,
      taskId: t.id,
      projectId: 'p',
      workspaceId: null,
      attempt: 1,
      role: 'DEV-BE',
      driver: 'local',
      model: 'opus',
    });
    store.updateRun(runId, { state: 'running' });
    const seq = store.appendEvent(runId, t.id, 'tool-use', { name: 'Read' });
    expect(seq).toBe(1);
    expect(store.listEvents(runId)).toHaveLength(1);
    expect(store.markInterruptedRuns()).toBe(1);
    expect(store.getRun(runId).state).toBe('interrupted');
  });
});
