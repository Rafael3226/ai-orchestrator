import { createBoardSource } from '../board/board.factory.js';
import { BoardStore } from '../board/board.store.js';
import { BoardSync } from '../board/board.sync.js';
import { BoardWriter } from '../board/board.writer.js';
import { loadConfig } from '../config/config.loader.js';
import { roleSchema } from '../config/config.schema.js';
import { resolveBoardCredentials } from '../config/credentials.js';
import { loadOrchestratorEnv } from '../config/env.js';
import { SqliteStore } from '../db/sqlite.store.js';
import type { TaskId } from '../domain/ids.js';
import type { ProposedSummary } from '../mcp/board.schemas.js';
import { createPrHost, linkedWorkItems } from '../pipeline/pr.host.js';
import { buildBoardComment, buildPrBody, type ReportInput } from '../pipeline/report.builder.js';
import { gitAuthEnv } from '../workspace/git.auth.js';
import { GitCli } from '../workspace/git.cli.js';

/**
 * `republish <taskId>` — finish a task whose publish step died after the push
 * (e.g. the PR call failed). Idempotent: reuses an open PR if one exists,
 * then flips the task to review and enqueues the onSuccess writeback.
 */
export async function republish(taskIdArg: string): Promise<number> {
  const env = loadOrchestratorEnv();
  const loaded = loadConfig(env.ORCHESTRATOR_CONFIG);
  const store = new SqliteStore(env.ORCHESTRATOR_DB);
  const boardStore = new BoardStore(store);
  const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

  try {
    const task = store.getTask(taskIdArg as TaskId);
    const project = loaded.project(task.project_id);
    const runs = store.listRunsForTask(task.id);
    const run = [...runs].reverse().find((r) => r.summary_json);
    if (!run?.summary_json)
      throw new Error(`task ${task.id} has no accepted propose_summary — nothing to publish`);
    if (!task.branch) throw new Error(`task ${task.id} has no branch`);
    const summary = JSON.parse(run.summary_json) as ProposedSummary;

    const git = new GitCli();
    if (
      !(await git.remoteBranchExists(
        project.repo.path,
        project.repo.remote,
        task.branch,
        gitAuthEnv(project),
      ))
    ) {
      throw new Error(
        `branch ${task.branch} is not on ${project.repo.remote} — run the task again instead`,
      );
    }

    const report: ReportInput = {
      runId: run.id,
      cardShortId: task.card_short_id,
      cardUrl: task.card_url,
      role: task.role,
      attempt: run.attempt,
      branch: task.branch,
      summary,
      blocked: null,
      decisions: JSON.parse(run.decisions_json) as ReportInput['decisions'],
      verify:
        run.verify_exit_code === null
          ? []
          : [
              {
                command: project.checks.test ?? 'verify',
                exitCode: run.verify_exit_code,
                timedOut: false,
                durationMs: 0,
                outputTail: run.verify_tail ?? '',
                ok: run.verify_exit_code === 0,
              },
            ],
      diff: null,
      exec: {
        outcome: 'success',
        sessionId: run.session_id,
        finalText: null,
        numTurns: run.num_turns ?? 0,
        durationMs: run.duration_ms ?? 0,
        cost: {
          totalCostUsd: run.cost_usd ?? 0,
          reportedCostUsd: run.cost_usd_reported ?? 0,
          inputTokens: run.input_tokens ?? 0,
          outputTokens: run.output_tokens ?? 0,
          cacheReadTokens: run.cache_read_tokens ?? 0,
          cacheCreationTokens: run.cache_creation_tokens ?? 0,
          perModel: {},
          estimated: run.cost_estimated === 1,
        },
        permissionDenials: [],
        errors: [],
      },
      prUrl: null,
      hooksBypassed: false,
      denials: [],
      verdict: 'review',
      verdictReason: '',
    };

    log(`opening draft PR for ${task.branch}`);
    const prUrl = await createPrHost(project, log).createDraft({
      cwd: project.repo.path,
      base: project.repo.baseBranch,
      head: task.branch,
      title: `[${task.card_short_id}] ${summary.title}`.slice(0, 200),
      body: buildPrBody(report),
      draft: project.pr.draft,
      labels: project.pr.labels,
      workItemIds: linkedWorkItems(project, task.card_short_id),
    });
    log(`PR: ${prUrl}`);

    // Terminal → terminal is not a state-machine edge; this is an operator repair, so write directly.
    store.db
      .prepare(
        `UPDATE tasks SET state = 'review', pr_url = ?, last_error = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(prUrl, new Date().toISOString(), task.id);
    store.updateRun(run.id, { pr_url: prUrl });

    const comment = buildBoardComment({ ...report, prUrl });
    boardStore.saveReport(task.id, 'review', comment);

    if (!task.card_id.startsWith('local:')) {
      const cred = resolveBoardCredentials(loaded.credentialRefs).get(project.board.credentials);
      if (!cred) throw new Error('credentials unresolved');
      const source = createBoardSource(project, cred);
      const sync = new BoardSync(project, source, store, boardStore, { info: log, warn: log });
      const writer = new BoardWriter(project, source, boardStore, sync.router, {
        info: log,
        warn: log,
      });
      const writeback = project.agents[roleSchema.parse(task.role)].writeback;
      // A fresh idempotency namespace so the earlier onFailure rows do not shadow these.
      writer.enqueueStep(
        'onSuccess',
        writeback.onSuccess,
        `${task.id}:republish` as TaskId,
        task.card_id,
        comment,
      );
      for (const label of toList(writeback.onFailure.addLabel)) {
        boardStore.enqueue({
          projectId: project.id,
          taskId: task.id,
          cardId: task.card_id,
          op: 'remove-label',
          payload: { label },
          idempotencyKey: `${task.id}:republish:remove-label:${label}`,
        });
      }
      await writer.drain(await sync.getTopology());
    }
    log(`task ${task.id} → review`);
    return 0;
  } finally {
    store.close();
  }
}

const toList = (v: string | string[] | undefined): string[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];
