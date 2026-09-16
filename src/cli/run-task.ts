import { loadConfig } from '../config/config.loader.js';
import { type Role, roleSchema } from '../config/config.schema.js';
import { loadOrchestratorEnv } from '../config/env.js';
import { SqliteStore } from '../db/sqlite.store.js';
import { newTaskId } from '../domain/ids.js';
import { LocalDriver } from '../exec/local.driver.js';
import { executeTask, type TaskSink } from '../scheduler/task.runner.js';
import { WorktreeManager } from '../workspace/worktree.manager.js';

export interface RunTaskOptions {
  readonly project: string;
  readonly role: Role;
  readonly title: string;
  readonly spec: string;
  readonly cardShortId?: string;
  readonly cardUrl?: string;
  readonly labels?: readonly string[];
  readonly dryRun?: boolean;
  readonly keepWorkspace?: boolean;
}

/**
 * Drive one task end to end with no board involved. Same lifecycle the
 * daemon uses; the "board" here is stdout.
 */
export async function runTask(opts: RunTaskOptions): Promise<number> {
  const env = loadOrchestratorEnv();
  const loaded = loadConfig(env.ORCHESTRATOR_CONFIG);
  const project = loaded.project(opts.project);
  const role = roleSchema.parse(opts.role);
  if (!project.agents[role].enabled) {
    console.warn(`⚠ ${role} is not enabled for ${project.id}; run-task runs it anyway`);
  }

  const store = new SqliteStore(env.ORCHESTRATOR_DB);
  const driver = new LocalDriver();
  await driver.preflight();
  const log = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

  const taskId = newTaskId();
  const cardShortId = opts.cardShortId ?? taskId.slice(-6);
  store.insertTask({
    id: taskId,
    projectId: project.id,
    role,
    cardId: `local:${cardShortId}`,
    cardShortId,
    cardUrl: opts.cardUrl ?? '',
    title: opts.title,
    spec: opts.spec,
    labels: opts.labels ?? [],
  });
  const task = store.transitionTask(taskId, 'queued', 'claimed');

  const sink: TaskSink = {
    onStart: () => {},
    onProgress: () => {},
    onFinish: (_t, verdict, comment) => console.log(`\n${comment}\n\nverdict: ${verdict}`),
  };

  try {
    const r = await executeTask(
      { store, worktrees: new WorktreeManager(store), driver, sink, log },
      project,
      task,
      {
        ...(opts.dryRun ? { dryRun: true } : {}),
        ...(opts.keepWorkspace ? { keepWorkspace: true } : {}),
      },
    );
    return r.verdict === 'review' ? 0 : 1;
  } finally {
    store.close();
  }
}
