import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { planFinishStep } from '../board/board.actions.js';
import { BoardStore } from '../board/board.store.js';
import { BoardSync } from '../board/board.sync.js';
import { BoardWriter } from '../board/board.writer.js';
import { loadConfigFromString } from '../config/config.loader.js';
import type { Role } from '../config/config.schema.js';
import { SqliteStore, type TaskRow } from '../db/sqlite.store.js';
import { FakeBoardSource } from '../testing/fake.board.source.js';
import { aSummary, type ScriptedAttempt, ScriptedDriver } from '../testing/scripted.driver.js';
import { WorktreeManager } from '../workspace/worktree.manager.js';

import { executeTask } from './task.runner.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const quiet = { info: () => {}, warn: () => {} };

let base: string;
let repo: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'flow-e2e-'));
  repo = join(base, 'repo');
  const remote = join(base, 'remote.git');
  mkdirSync(repo);
  git(base, 'init', '--bare', remote);
  git(base, 'init', '-b', 'main', repo);
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'README.md'), '# demo\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
});

const COLUMNS = [
  'Requirements',
  'Refinement',
  'Ready',
  'In Progress',
  'Testing',
  'Blocked',
  'Done',
];

const yaml = (repoPath: string, wt: string) => `
version: 1
projects:
  - id: demo
    name: Demo
    repo: { path: ${JSON.stringify(repoPath)}, worktreeRoot: ${JSON.stringify(wt)}, githubRepo: me/demo }
    board:
      provider: jira
      site: acme
      projectKey: DEMO
      credentials: JIRA_X
      botMemberId: bot
      poll: { intervalSeconds: 5, reconcileEveryTicks: 100, reconcileOnStart: false }
      columns:
        requirements: Requirements
        refinement: Refinement
        ready: Ready
        inProgress: In Progress
        testing: Testing
        blocked: Blocked
        done: Done
    agents:
      BA: { enabled: true, writeback: { onSuccess: { handTo: PM, comment: report } } }
      PM: { enabled: true, writeback: { onSuccess: { handTo: DEV, comment: report } } }
      DEV: { enabled: true, workflowCommand: false, writeback: { onSuccess: { handTo: QA, comment: report } } }
      QA: { enabled: true, writeback: { onSuccess: { move: done, comment: report } } }
    routes:
      - { when: { column: Requirements }, agent: BA }
      - { when: { column: Refinement }, agent: PM }
      - { when: { column: Ready }, agent: DEV }
      - { when: { column: Testing }, agent: QA }
    writeback:
      onStart: { move: inProgress, comment: started }
      onFailure: { move: blocked, comment: report }
    flow:
      closed: done
      humanColumn: blocked
      newItems: { story: PM, bug: DEV }
      escalation: { QA: { onFailure: DEV } }
`;

const boardOnlySummary = (title: string, extra: Record<string, unknown> = {}) => ({
  title,
  summary: `${title}: the deliverable is on the card, with the reasoning behind it.`,
  testPlan: 'Not applicable to a board-only role.',
  filesTouched: [],
  ...extra,
});

describe('User → BA → PM → DEV → QA → back to DEV, unattended', () => {
  it('hands the card along with handTo, applies agent board actions, and routes a QA defect back', async () => {
    const store = new SqliteStore(':memory:');
    const boardStore = new BoardStore(store);
    const board = new FakeBoardSource('acme/DEMO', COLUMNS, [], [], {
      provider: 'jira',
      freeformLabels: true,
    });
    const project = loadConfigFromString(yaml(repo, join(base, 'wt')), 'x').project('demo');

    const script: Record<Role, ScriptedAttempt> = {
      BA: {
        calls: [
          [
            'record_decision',
            {
              title: 'Exports are CSV only',
              rationale: 'Stakeholder confirmed nobody needs Excel.',
            },
          ],
          [
            'propose_summary',
            boardOnlySummary('Story: export orders', {
              acceptanceCriteria: ['Given orders, when I export, then I get a CSV'],
            }),
          ],
        ],
      },
      PM: {
        calls: [
          [
            'set_fields',
            {
              priority: 'high',
              storyPoints: 3,
              startDate: '2026-09-28',
              dueDate: '2026-10-02',
              rationale: 'Small, well-understood change; customers are waiting on it.',
            },
          ],
          ['propose_summary', boardOnlySummary('Planned: export orders')],
        ],
      },
      DEV: {
        work: (cwd) => writeFileSync(join(cwd, 'export.ts'), 'export const toCsv = () => "";\n'),
        calls: [
          [
            'create_work_item',
            {
              type: 'subtask',
              parent: 'current',
              assignTo: 'none',
              title: 'QA: verify the CSV export',
              description: 'Open Orders, click Export, expect a CSV with a header row.',
            },
          ],
          [
            'propose_summary',
            aSummary({ testability: { testable: true, reason: 'A user-visible export button.' } }),
          ],
        ],
      },
      QA: {
        calls: [
          [
            'create_work_item',
            {
              type: 'bug',
              title: 'CSV export has no header row',
              description:
                'Exported file starts with data; the acceptance criteria require a header.',
            },
          ],
          ['reassign', { to: 'DEV', reason: 'The export misses its header row — see the bug.' }],
          [
            'propose_summary',
            boardOnlySummary('QA found a defect', {
              findings: [
                { severity: 'major', title: 'No header row', detail: 'The CSV starts with data.' },
              ],
              commit: { type: 'test', subject: 'cover the csv header' },
            }),
          ],
        ],
      },
      DEVOPS: {},
    };
    const drivers = new Map<Role, ScriptedDriver>(
      (Object.keys(script) as Role[]).map((r) => [r, new ScriptedDriver([script[r]])]),
    );

    const sync = new BoardSync(project, board, store, boardStore, quiet);
    const created: string[] = [];
    const writer = new BoardWriter(project, board, boardStore, sync.router, quiet, {
      onCreated: (_row, card) => created.push(card.title),
    });
    const worktrees = new WorktreeManager(store, []);

    // The same sink the daemon builds in Orchestrator.runOne.
    const run = async (t: TaskRow) => {
      const role = t.role as Role;
      const writeback = project.agents[role].writeback;
      const claimed = store.transitionTask(t.id, 'queued', 'claimed');
      return executeTask(
        {
          store,
          worktrees,
          driver: drivers.get(role)!,
          log: () => {},
          board,
          sink: {
            onStart: (tk, c) =>
              writer.enqueueStep('onStart', writeback.onStart, tk.id, tk.card_id, c),
            onProgress: () => {},
            onFinish: (tk, verdict, c, details) => {
              const step = verdict === 'review' ? 'onSuccess' : 'onFailure';
              const actions = details?.actions ?? [];
              writer.enqueueActions(tk.id, tk.card_id, actions);
              const planned = planFinishStep(writeback[step], {
                verdict,
                actions,
                untestable: details?.untestable ?? false,
                flow: project.flow,
              });
              writer.enqueueStep(step, planned, tk.id, tk.card_id, c);
            },
          },
        },
        project,
        claimed,
        { keepWorkspace: true, dryRun: true },
      );
    };

    /** Run the queued task, drain the outbox, and hand the card on. */
    const step = async (cardId: string, expectRole: Role) => {
      const task = store.listTasks({ state: 'queued' })[0];
      expect(task?.role).toBe(expectRole);
      const r = await run(task!);
      await writer.drain(await sync.getTopology());
      await sync.handoff(cardId);
      return r;
    };
    const columnOf = async (id: string) =>
      board.columns.find((c) => c.id === (board.cards.get(id)?.columnId ?? ''))?.name;

    await sync.tick();
    const card = board.addCard('DEMO-1', 'Export orders', 'Requirements', {
      description: 'Sales wants to export orders.',
    });
    expect((await sync.tick()).dispatched.map((d) => d.role)).toEqual(['BA']);

    // BA → PM: decisions travel on the card.
    const ba = await step(card.id, 'BA');
    expect(ba.comment).toContain('## Decisions');
    expect(ba.comment).toContain('Exports are CSV only');
    expect(await columnOf(card.id)).toBe('Refinement');

    // PM → DEV: planning fields land on the card.
    await step(card.id, 'PM');
    expect(board.fields.get(card.id)).toMatchObject({ priority: 'high', storyPoints: 3 });
    expect(await columnOf(card.id)).toBe('Ready');

    // DEV → QA: the QA sub-task exists before QA wakes up.
    const dev = await step(card.id, 'DEV');
    expect(dev.verdict).toBe('review');
    expect(dev.comment).toContain('**QA:** testable');
    expect((await board.listChildren(card.id)).map((c) => c.title)).toEqual([
      'QA: verify the CSV export',
    ]);
    expect(await columnOf(card.id)).toBe('Testing');

    // QA finds a defect: a bug for DEV, and the card itself goes back to DEV.
    const qa = await step(card.id, 'QA');
    expect(qa.comment).toContain('Handed to **DEV**');
    expect(created).toEqual(['QA: verify the CSV export', 'CSV export has no header row']);
    expect(await columnOf(card.id)).toBe('Ready');
    const bug = [...board.cards.values()].find((c) => c.title === 'CSV export has no header row')!;
    expect(await columnOf(bug.id)).toBe('Ready'); // newItems.bug: DEV

    // DEV is queued again for the same card: the loop continues without a human.
    const next = store.listTasks({ state: 'queued' });
    expect(next.map((t) => [t.role, t.card_id])).toContainEqual(['DEV', card.id]);
    store.close();
  }, 120_000);
});
