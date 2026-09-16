import { describe, expect, it } from 'vitest';

import { BoardStore } from '../board/board.store.js';
import { loadConfigFromString } from '../config/config.loader.js';
import { SqliteStore } from '../db/sqlite.store.js';
import { newRunId, newTaskId } from '../domain/ids.js';

import { StateProjector, toLogLine } from './state.projection.js';

const yaml = `
version: 1
office: { roomsPerRow: 2 }
projects:
  - id: pa
    name: A
    repo: { path: /a, worktreeRoot: /w, githubRepo: x/a }
    board: { provider: trello, boardId: b1, credentials: T, columns: {} }
    agents: { DEV-BE: { enabled: true } }
    routes: [{ when: { list: Ready }, agent: DEV-BE }]
  - id: pb
    name: B
    repo: { path: /b, worktreeRoot: /w, githubRepo: x/b }
    board: { provider: trello, boardId: b2, credentials: T, columns: {} }
    routes: [{ when: { list: Ready }, agent: QA }]
`;

describe('StateProjector', () => {
  it('lays rooms out on a grid and derives one agent per (project, role)', () => {
    const store = new SqliteStore(':memory:');
    const p = new StateProjector(loadConfigFromString(yaml, 'x'), store, new BoardStore(store));
    const s = p.snapshot(1);
    expect(s.projects.map((x) => [x.room.x, x.room.y])).toEqual([
      [0, 0],
      [640, 0],
    ]);
    expect(s.agents).toHaveLength(10);
    const devBe = s.agents.find((a) => a.key === 'pa:DEV-BE')!;
    expect(devBe.status).toBe('idle');
    expect(s.agents.find((a) => a.key === 'pa:QA')!.status).toBe('offline');
  });

  it('derives typing vs thinking from recent tool events and exposes the run pill', () => {
    const store = new SqliteStore(':memory:');
    const p = new StateProjector(loadConfigFromString(yaml, 'x'), store, new BoardStore(store));
    const t = store.insertTask({
      id: newTaskId(),
      projectId: 'pa',
      role: 'DEV-BE',
      cardId: 'c',
      cardShortId: '1',
      title: 'T',
      spec: '',
    });
    store.transitionTask(t.id, 'queued', 'claimed');
    store.transitionTask(t.id, 'claimed', 'preparing');
    expect(p.snapshot(1).agents.find((a) => a.key === 'pa:DEV-BE')!.status).toBe('preparing');

    store.transitionTask(t.id, 'preparing', 'running');
    const runId = newRunId();
    store.insertRun({
      id: runId,
      taskId: t.id,
      projectId: 'pa',
      workspaceId: null,
      attempt: 1,
      role: 'DEV-BE',
      driver: 'local',
      model: 'opus',
    });
    store.updateRun(runId, { state: 'running', num_turns: 3, cost_usd: 0.5 });
    store.db.prepare('UPDATE tasks SET current_run_id = ? WHERE id = ?').run(runId, t.id);
    expect(p.snapshot(2).agents.find((a) => a.key === 'pa:DEV-BE')!.status).toBe('thinking');

    store.appendEvent(runId, t.id, 'progress', { phase: 'implementing', message: 'working' });
    store.appendEvent(runId, t.id, 'tool-use', { name: 'Edit', inputPreview: '{}' });
    const a = p.snapshot(3).agents.find((x) => x.key === 'pa:DEV-BE')!;
    expect(a.status).toBe('typing');
    expect(a.run).toMatchObject({
      cardShortId: '1',
      turns: 3,
      costUsd: 0.5,
      budgetUsd: 6,
      phase: 'implementing',
      lastToolName: 'Edit',
    });

    store.transitionTask(t.id, 'running', 'verifying');
    expect(p.snapshot(4).agents.find((x) => x.key === 'pa:DEV-BE')!.status).toBe('verifying');
    store.transitionTask(t.id, 'verifying', 'publishing');
    store.transitionTask(t.id, 'publishing', 'review');
    expect(p.snapshot(5).agents.find((x) => x.key === 'pa:DEV-BE')!.status).toBe('done');
  });

  it('renders run events as readable log lines', () => {
    expect(
      toLogLine({
        seq: 1,
        run_id: 'r' as never,
        task_id: 't' as never,
        ts: 'now',
        type: 'tool-use',
        payload_json: JSON.stringify({ name: 'Bash', inputPreview: 'pnpm test' }),
      }).text,
    ).toBe('→ Bash pnpm test');
    expect(
      toLogLine({
        seq: 2,
        run_id: 'r' as never,
        task_id: 't' as never,
        ts: 'now',
        type: 'denied',
        payload_json: JSON.stringify({ toolName: 'Bash', reason: 'push' }),
      }).text,
    ).toContain('⛔ Bash: push');
  });
});
