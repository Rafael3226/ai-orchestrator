import { createBoardSource, isWebhookRegistrar } from '../board/board.factory.js';
import type { BoardSource, WebhookRegistrar } from '../board/board.source.js';
import { BoardStore } from '../board/board.store.js';
import { BoardSync } from '../board/board.sync.js';
import { WebhookBufferedSource } from '../board/board.webhook-buffer.js';
import { BoardWriter } from '../board/board.writer.js';
import {
  assertPublicUrl,
  callbackUrlFor,
  ensureWebhook,
  removeWebhook,
  requireApiSecret,
} from '../cli/webhook.commands.js';
import { type LoadedConfig, type ProjectConfig } from '../config/config.loader.js';
import { roleSchema, ROLES } from '../config/config.schema.js';
import { type BoardCredential, resolveBoardCredentials } from '../config/credentials.js';
import type { SqliteStore, TaskRow } from '../db/sqlite.store.js';
import { newRunId } from '../domain/ids.js';
import { DockerCli } from '../exec/docker/docker.cli.js';
import { dockerGc } from '../exec/docker/docker.gc.js';
import { DriverRegistry } from '../exec/driver.factory.js';
import type { ExecDriver } from '../exec/exec.driver.js';
import type { ProgressReport } from '../mcp/board.schemas.js';
import type { WebhookServer } from '../server/webhook.server.js';
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
  /** Under any webhook buffer: the provider itself, for webhook registration. */
  readonly registrar: WebhookRegistrar | null;
  readonly sync: BoardSync;
  readonly writer: BoardWriter;
  readonly buffer: WebhookBufferedSource | null;
  readonly cred: BoardCredential;
  webhookId: string | null;
  pollTimer: NodeJS.Timeout | null;
  lastWakeAt: number;
  running: number;
}

const DISPATCH_TICK_MS = 5_000;
const OUTBOX_TICK_MS = 3_000;
const MIN_START_GAP_MS = 20_000;
/** Batch a burst of deliveries — a card move is several actions — into one tick. */
const WAKE_DEBOUNCE_MS = 250;
/** However fast Trello pushes, never tick faster than this. */
const WAKE_MIN_GAP_MS = 2_000;

/**
 * The daemon. Per project: poll → route → enqueue, and drain the writeback
 * outbox. Globally: a dispatcher that claims queued tasks under the
 * concurrency caps with a ramp between starts, and boot-time recovery.
 */
export class Orchestrator {
  private readonly boardStore: BoardStore;
  private readonly worktrees: WorktreeManager;
  /** One boot id per process, so the container sweep can tell live from stale. */
  private readonly bootId = newRunId();
  private readonly drivers: DriverRegistry;
  private readonly runtimes = new Map<string, ProjectRuntime>();
  private dispatchTimer: NodeJS.Timeout | null = null;
  private outboxTimer: NodeJS.Timeout | null = null;
  private lastStartAt = 0;
  private stopping = false;
  private inFlight = new Set<Promise<void>>();

  constructor(
    private readonly loaded: LoadedConfig,
    private readonly store: SqliteStore,
    /**
     * The default driver. Per-project and per-role `exec.driver` are resolved
     * through the registry below; this stays for single-driver callers
     * (`run-task`, `smoke`) and as the local fallback.
     */
    private readonly driver: ExecDriver,
    private readonly log: OrchestratorLogger,
    private readonly sourceFactory: (
      p: ProjectConfig,
      cred: BoardCredential,
    ) => BoardSource = createBoardSource,
    /** Absent when webhooks are off or `start --no-webhook` was passed. */
    private readonly webhookServer: WebhookServer | null = null,
    private readonly webhookEnv: {
      publicUrl?: string | undefined;
      pathPrefix: string;
      pathSecret: string;
    } = { pathPrefix: '/hooks/trello', pathSecret: 'none' },
  ) {
    this.boardStore = new BoardStore(store);
    this.worktrees = new WorktreeManager(store);
    this.drivers = new DriverRegistry({ bootId: this.bootId, log: (m) => this.log.info(m) });
  }

  get globalRunning(): number {
    return [...this.runtimes.values()].reduce((n, r) => n + r.running, 0);
  }

  async start(): Promise<void> {
    // Preflight every driver any enabled role could need, not just the default —
    // a missing docker daemon should fail at boot, not on the first card.
    this.drivers.warm(this.loaded.config.projects, ROLES);
    await this.driver.preflight();
    await this.drivers.preflightAll();
    const creds = resolveBoardCredentials(this.loaded.credentialRefs);

    for (const project of this.loaded.config.projects) {
      if (!project.enabled) continue;
      const cred = creds.get(project.board.credentials);
      if (!cred)
        throw new Error(`${project.id}: credential ref ${project.board.credentials} unresolved`);
      const inner = this.sourceFactory(project, cred);
      // The decorator is transparent: BoardSync, BoardWriter and the loop guard
      // are all built against one ordinary BoardSource either way.
      const buffer =
        this.webhookServer && project.board.webhook.enabled
          ? new WebhookBufferedSource(inner, {
              maxBuffered: project.board.webhook.maxBufferedEvents,
              onWake: () => this.wake(project.id),
              log: this.log,
            })
          : null;
      const source: BoardSource = buffer ?? inner;
      const sync = new BoardSync(project, source, this.store, this.boardStore, this.log);
      const writer = new BoardWriter(project, source, this.boardStore, sync.router, this.log, {
        // One role finishing can wake the next one. See BoardSync.handoff.
        onMoved: (cardId) => void this.handoff(project.id, sync, cardId),
      });
      await sync.assertLoopGuard();
      await this.worktrees.gc(project, (m) => this.log.info(m));
      this.runtimes.set(project.id, {
        project,
        source,
        registrar: isWebhookRegistrar(inner) ? inner : null,
        sync,
        writer,
        buffer,
        cred,
        webhookId: null,
        pollTimer: null,
        lastWakeAt: 0,
        running: 0,
      });
    }

    await this.sweepContainers();

    // Order matters: Trello runs its callback verification HEAD synchronously
    // inside `POST /1/webhooks`, so we must already be listening — and publicly
    // reachable — before registering.
    await this.startWebhooks();

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
    await this.stopWebhooks();
    this.log.info(`stopping — waiting for ${this.inFlight.size} run(s)`);
    await Promise.allSettled([...this.inFlight]);
  }

  /**
   * Remove containers and volumes a previous boot leaked. `--rm` covers the
   * happy path; a daemon crash or a Docker Desktop restart does not.
   */
  private async sweepContainers(): Promise<void> {
    if (!this.drivers.kinds().includes('docker')) return;
    const live = new Set<string>();
    const dead = (workspaceId: string): boolean =>
      this.store.getWorkspace(workspaceId as never)?.state === 'removed';
    try {
      const r = await dockerGc(new DockerCli(), this.bootId, live, dead);
      if (r.containersRemoved.length || r.volumesRemoved.length) {
        this.log.info(
          `docker gc: removed ${r.containersRemoved.length} container(s), ${r.volumesRemoved.length} volume(s)`,
        );
      }
    } catch (err) {
      this.log.warn(`docker gc failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── webhooks ──────────────────────────────────────────────────────────

  private async startWebhooks(): Promise<void> {
    const server = this.webhookServer;
    if (!server) return;
    const wired = [...this.runtimes.values()].filter((rt) => rt.buffer !== null);
    if (wired.length === 0) return;

    const publicUrl = assertPublicUrl(
      this.webhookEnv.publicUrl,
      wired.map((rt) => rt.project.id),
    );
    await server.start();

    for (const rt of wired) {
      const { project, cred, buffer, registrar } = rt;
      const callbackURL = callbackUrlFor(
        publicUrl,
        this.webhookEnv.pathPrefix,
        this.webhookEnv.pathSecret,
        project.id,
      );
      try {
        const apiSecret = requireApiSecret(cred, project.id);
        if (project.board.webhook.manageRegistration) {
          if (!registrar) throw new Error(`${project.board.provider} cannot register webhooks`);
          const r = await ensureWebhook(registrar, project.board.boardId, project.id, callbackURL);
          rt.webhookId = r.id;
          this.boardStore.noteWebhookRegistration(project.id, r.id, callbackURL);
          this.log.info(
            `${project.id}: webhook ${r.action}` +
              (r.removed.length ? `, ${r.removed.length} stale registration(s) swept` : ''),
          );
        }
        server.register({
          projectId: project.id,
          boardId: project.board.boardId,
          botMemberId: project.board.botMemberId ?? null,
          callbackURL,
          apiSecret,
          maxEventAgeMs: project.board.webhook.maxEventAgeSeconds * 1000,
          push: (event, o) => buffer?.push([event], o),
          note: (outcome) =>
            this.boardStore.noteWebhookDelivery(
              project.id,
              outcome === 'stale' ? 'dropped' : outcome,
            ),
        });
      } catch (err) {
        // Never fatal. Degrading to the poller is the entire reason the poller
        // is still here.
        this.log.warn(
          `${project.id}: webhook registration failed (${err instanceof Error ? err.message : String(err)}) — ` +
            `falling back to polling every ${project.board.poll.intervalSeconds}s`,
        );
      }
    }
  }

  private async stopWebhooks(): Promise<void> {
    if (!this.webhookServer) return;
    for (const rt of this.runtimes.values()) {
      if (!rt.webhookId || !rt.registrar || !rt.project.board.webhook.deleteOnShutdown) continue;
      try {
        await removeWebhook(rt.registrar, rt.webhookId);
      } catch (err) {
        this.log.warn(
          `${rt.project.id}: could not delete webhook: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    await this.webhookServer.stop().catch(() => {});
  }

  private async handoff(projectId: string, sync: BoardSync, cardId: string): Promise<void> {
    if (this.stopping) return;
    try {
      const dispatch = await sync.handoff(cardId);
      if (dispatch) this.wake(projectId);
    } catch (err) {
      this.log.warn(
        `${projectId}: handoff for ${cardId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Bring the next poll forward. Debounced so a burst of deliveries becomes one
   * tick, and floored so no amount of push traffic can spin the loop. The
   * existing poll timer re-arms itself in its own `finally`, so the normal
   * cadence resumes on its own — no second timer, no drift.
   */
  private wake(projectId: string): void {
    if (this.stopping) return;
    const rt = this.runtimes.get(projectId);
    if (!rt) return;
    const since = Date.now() - rt.lastWakeAt;
    const delay = Math.max(WAKE_DEBOUNCE_MS, WAKE_MIN_GAP_MS - since);
    rt.lastWakeAt = Date.now();
    if (rt.pollTimer) clearTimeout(rt.pollTimer);
    this.schedulePoll(rt, delay);
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
    // Per role, not per project: QA's success must not put the card back into
    // the column that dispatched QA.
    const writeback = project.agents[roleSchema.parse(task.role)].writeback;
    const sink: TaskSink = {
      onStart: (t, comment) => {
        writer.enqueueStep('onStart', writeback.onStart, t.id, t.card_id, comment);
      },
      onProgress: (_t: TaskRow, _runId, _p: ProgressReport) => {
        /* surfaced through run_events for the office UI */
      },
      onFinish: (t, verdict: Verdict, comment) => {
        this.boardStore.saveReport(t.id, verdict, comment);
        const step =
          verdict === 'review' ? 'onSuccess' : verdict === 'blocked' ? 'onBlocked' : 'onFailure';
        writer.enqueueStep(step, writeback[step], t.id, t.card_id, comment);
      },
    };
    try {
      const r = await executeTask(
        {
          store: this.store,
          worktrees: this.worktrees,
          driver: this.drivers.for(rt.project, roleSchema.parse(task.role)),
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
