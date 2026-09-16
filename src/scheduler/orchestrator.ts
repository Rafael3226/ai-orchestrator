import type { BoardSource } from '../board/board.source.js';
import { BoardStore } from '../board/board.store.js';
import { BoardSync } from '../board/board.sync.js';
import { BoardWriter } from '../board/board.writer.js';
import { TrelloSource } from '../board/trello/trello.source.js';
import { type LoadedConfig, type ProjectConfig } from '../config/config.loader.js';
import { type BoardCredential, resolveBoardCredentials } from '../config/credentials.js';
import type { SqliteStore, TaskRow } from '../db/sqlite.store.js';
import type { ExecDriver } from '../exec/exec.driver.js';
import type { ProgressReport } from '../mcp/board.schemas.js';
import { WorktreeManager } from '../workspace/worktree.manager.js';

import { executeTask, type TaskSink, type Verdict } from './task.runner.js';

export interface OrchestratorLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

interface ProjectRuntime {
  readonly project: ProjectConfig;
  readonly source: BoardSource;
  readonly sync: BoardSync;
  readonly writer: BoardWriter;
  pollTimer: NodeJS.Timeout | null;
  running: number;
}

const DISPATCH_TICK_MS = 5_000;
const OUTBOX_TICK_MS = 3_000;
const MIN_START_GAP_MS = 20_000;

/**
 * The daemon. Per project: poll → route → enqueue, and drain the writeback
 * outbox. Globally: a dispatcher that claims queued tasks under the
 * concurrency caps with a ramp between starts, and boot-time recovery.
 */
export class Orchestrator {
  private readonly boardStore: BoardStore;
  private readonly worktrees: WorktreeManager;
  private readonly runtimes = new Map<string, ProjectRuntime>();
  private dispatchTimer: NodeJS.Timeout | null = null;
  private outboxTimer: NodeJS.Timeout | null = null;
  private lastStartAt = 0;
  private stopping = false;
  private inFlight = new Set<Promise<void>>();

  constructor(
    private readonly loaded: LoadedConfig,
    private readonly store: SqliteStore,
    private readonly driver: ExecDriver,
    private readonly log: OrchestratorLogger,
    private readonly sourceFactory: (p: ProjectConfig, cred: BoardCredential) => BoardSource = (
      p,
      c,
    ) => new TrelloSource(p.board.boardId, c),
  ) {
    this.boardStore = new BoardStore(store);
    this.worktrees = new WorktreeManager(store);
  }

  get globalRunning(): number {
    return [...this.runtimes.values()].reduce((n, r) => n + r.running, 0);
  }

  async start(): Promise<void> {
    await this.driver.preflight();
    const creds = resolveBoardCredentials(this.loaded.credentialRefs);

    for (const project of this.loaded.config.projects) {
      if (!project.enabled) continue;
      if (project.board.provider !== 'trello') {
        this.log.warn(
          `${project.id}: provider ${project.board.provider} not implemented yet — skipped`,
        );
        continue;
      }
      const cred = creds.get(project.board.credentials);
      if (!cred)
        throw new Error(`${project.id}: credential ref ${project.board.credentials} unresolved`);
      const source = this.sourceFactory(project, cred);
      const sync = new BoardSync(project, source, this.store, this.boardStore, this.log);
      const writer = new BoardWriter(project, source, this.boardStore, sync.router, this.log);
      await sync.assertLoopGuard();
      await this.worktrees.gc(project, (m) => this.log.info(m));
      this.runtimes.set(project.id, { project, source, sync, writer, pollTimer: null, running: 0 });
    }

    this.recover();

    for (const rt of this.runtimes.values())
      this.schedulePoll(rt, jitter(rt.project.id, rt.project.board.poll.intervalSeconds * 1000));
    this.dispatchTimer = setInterval(() => void this.dispatchTick(), DISPATCH_TICK_MS);
    this.outboxTimer = setInterval(() => void this.outboxTick(), OUTBOX_TICK_MS);
    this.log.info(
      `orchestrator started: ${this.runtimes.size} project(s), global cap ${this.loaded.config.defaults.concurrency.global}`,
    );
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.dispatchTimer) clearInterval(this.dispatchTimer);
    if (this.outboxTimer) clearInterval(this.outboxTimer);
    for (const rt of this.runtimes.values()) if (rt.pollTimer) clearTimeout(rt.pollTimer);
    this.log.info(`stopping — waiting for ${this.inFlight.size} run(s)`);
    await Promise.allSettled([...this.inFlight]);
  }

  /** Boot: anything live from a previous process is not. Tasks go back to the queue; worktrees are reused. */
  private recover(): void {
    const interrupted = this.store.markInterruptedRuns();
    let requeued = 0;
    for (const t of this.store.listTasks()) {
      if (['claimed', 'preparing', 'running', 'verifying', 'publishing'].includes(t.state)) {
        if (t.workspace_id) this.store.setWorkspaceState(t.workspace_id, 'retained');
        this.store.db
          .prepare(`UPDATE tasks SET state = 'queued', updated_at = ? WHERE id = ?`)
          .run(new Date().toISOString(), t.id);
        requeued++;
      }
    }
    if (interrupted || requeued)
      this.log.warn(
        `recovery: ${interrupted} run(s) marked interrupted, ${requeued} task(s) re-queued`,
      );
  }

  private schedulePoll(rt: ProjectRuntime, delayMs: number): void {
    if (this.stopping) return;
    rt.pollTimer = setTimeout(async () => {
      try {
        const r = await rt.sync.tick();
        if (r.events || r.dispatched.length) {
          this.log.info(
            `${rt.project.id}: poll — ${r.events} event(s), ${r.dispatched.length} dispatched, ${r.skipped.length} skipped`,
          );
        }
      } catch (err) {
        this.log.error(
          `${rt.project.id}: poll failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        this.schedulePoll(rt, rt.project.board.poll.intervalSeconds * 1000);
      }
    }, delayMs);
  }

  private async outboxTick(): Promise<void> {
    for (const rt of this.runtimes.values()) {
      try {
        await rt.writer.drain(await rt.sync.getTopology());
      } catch (err) {
        this.log.error(
          `${rt.project.id}: outbox drain failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private async dispatchTick(): Promise<void> {
    if (this.stopping) return;
    const caps = this.loaded.config.defaults.concurrency;
    if (this.globalRunning >= caps.global) return;
    if (Date.now() - this.lastStartAt < MIN_START_GAP_MS) return; // ramp: never burst

    for (const rt of this.runtimes.values()) {
      if (rt.running >= caps.perProject) continue;
      const next = this.store.listTasks({ state: 'queued', projectId: rt.project.id })[0];
      if (!next) continue;
      if (!rt.project.agents[next.role as keyof typeof rt.project.agents]?.enabled) continue;

      let claimed: TaskRow;
      try {
        claimed = this.store.transitionTask(next.id, 'queued', 'claimed');
      } catch {
        continue; // someone else got it
      }
      this.lastStartAt = Date.now();
      rt.running++;
      const p = this.runOne(rt, claimed).finally(() => {
        rt.running--;
        this.inFlight.delete(p);
      });
      this.inFlight.add(p);
      return; // one start per tick — that IS the ramp
    }
  }

  private async runOne(rt: ProjectRuntime, task: TaskRow): Promise<void> {
    const { project, writer } = rt;
    const sink: TaskSink = {
      onStart: (t, comment) => {
        writer.enqueueStep('onStart', project.writeback.onStart, t.id, t.card_id, comment);
      },
      onProgress: (_t: TaskRow, _runId, _p: ProgressReport) => {
        /* surfaced through run_events for the office UI */
      },
      onFinish: (t, verdict: Verdict, comment) => {
        this.boardStore.saveReport(t.id, verdict, comment);
        const step =
          verdict === 'review' ? 'onSuccess' : verdict === 'blocked' ? 'onBlocked' : 'onFailure';
        writer.enqueueStep(step, project.writeback[step], t.id, t.card_id, comment);
      },
    };
    try {
      const r = await executeTask(
        {
          store: this.store,
          worktrees: this.worktrees,
          driver: this.driver,
          sink,
          log: (m) => this.log.info(m),
        },
        project,
        task,
      );
      this.log.info(
        `${project.id}: [${task.card_short_id}] → ${r.verdict}${r.prUrl ? ` ${r.prUrl}` : ''}${r.reason ? ` (${r.reason})` : ''}`,
      );
    } catch (err) {
      this.log.error(
        `${project.id}: [${task.card_short_id}] crashed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
    }
  }
}

/** Deterministic start offset so N boards never poll in lockstep. */
function jitter(seed: string, intervalMs: number): number {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % intervalMs;
}
