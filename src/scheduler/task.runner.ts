import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { ProjectConfig } from '../config/config.loader.js';
import { type Role, roleSchema } from '../config/config.schema.js';
import type { SqliteStore, TaskRow } from '../db/sqlite.store.js';
import { newRunId, type RunId, type TaskId } from '../domain/ids.js';
import type { TaskState } from '../domain/task.state.js';
import { resolveGitDir } from '../exec/docker/gitdir.resolver.js';
import type { ExecDriver, ExecResult } from '../exec/exec.driver.js';
import {
  DockerExecutor,
  HostExecutor,
  type WorkspaceExecutor,
} from '../exec/workspace.executor.js';
import type {
  BlockedReport,
  Decision,
  ProgressReport,
  ProposedSummary,
} from '../mcp/board.schemas.js';
import { BOARD_SERVER_KEY, createBoardMcpServer, type TaskView } from '../mcp/board.server.js';
import { publish, PublishAbort } from '../pipeline/post.run.pipeline.js';
import { buildBoardComment, type ReportInput } from '../pipeline/report.builder.js';
import { runVerify, type VerifyResult } from '../pipeline/verify.runner.js';
import { ROLE_DELIVERY } from '../policy/delivery.policy.js';
import { buildGuardHooks } from '../policy/pretooluse.hook.js';
import { AGENT_ENV, ROLE_POLICIES } from '../policy/tool.policy.js';
import { runCommand } from '../process/command.runner.js';
import { buildSystemAppend } from '../prompt/system.append.js';
import { buildUserPrompt } from '../prompt/user.prompt.js';
import type { WorkspaceHandle, WorktreeManager } from '../workspace/worktree.manager.js';

export type Verdict = 'review' | 'blocked' | 'needs_human' | 'failed';

/** How a task's lifecycle reaches the board (or the console). */
export interface TaskSink {
  onStart(task: TaskRow, comment: string): void;
  onProgress(task: TaskRow, runId: RunId, p: ProgressReport): void;
  onFinish(task: TaskRow, verdict: Verdict, comment: string): void;
}

export interface TaskRunnerDeps {
  readonly store: SqliteStore;
  readonly worktrees: WorktreeManager;
  readonly driver: ExecDriver;
  readonly sink: TaskSink;
  readonly log: (msg: string) => void;
}

export interface ExecuteOptions {
  readonly dryRun?: boolean;
  readonly keepWorkspace?: boolean;
}

export interface ExecuteResult {
  readonly verdict: Verdict;
  readonly reason: string;
  readonly prUrl: string | null;
  readonly comment: string;
}

const TERMINAL: readonly TaskState[] = ['review', 'blocked', 'failed', 'needs_human', 'cancelled'];

/**
 * The lifecycle every dispatch path shares:
 * claimed → worktree → agent (retry once on a failed verify) → publish → report.
 * The task row must already be in `claimed` when this is called.
 */
export async function executeTask(
  deps: TaskRunnerDeps,
  project: ProjectConfig,
  task: TaskRow,
  opts: ExecuteOptions = {},
): Promise<ExecuteResult> {
  const { store, worktrees, driver, sink, log } = deps;
  const role = roleSchema.parse(task.role);
  const delivery = ROLE_DELIVERY[role];
  const agent = project.agents[role];
  const taskId = task.id;
  const labels = JSON.parse(task.labels_json) as string[];

  store.transitionTask(taskId, 'claimed', 'preparing');
  sink.onStart(task, `🤖 **${role}** picked up this card (attempt ${task.attempts + 1}).`);

  const containerized = driver.kind === 'docker';
  // Install and verify must run where the agent runs: a host `pnpm install`
  // produces win32 native binaries a Linux container cannot load.
  const executorFor = (workspacePath: string, workspaceId: string): WorkspaceExecutor =>
    containerized
      ? new DockerExecutor({
          cfg: agent.exec.docker,
          repoPath: project.repo.path,
          workspaceId,
          gitDir: resolveGitDir(workspacePath, project.repo.path),
        })
      : new HostExecutor();

  let workspace: WorkspaceHandle;
  try {
    workspace = await worktrees.acquire({
      project,
      taskId,
      role,
      cardShortId: task.card_short_id,
      cardTitle: task.title,
      log,
      install: delivery.install,
      executorFor,
      ...(containerized ? { lineEndings: 'lf' as const } : {}),
      ...(task.workspace_id ? { reuseWorkspaceId: task.workspace_id } : {}),
    });
  } catch (err) {
    const reason = `workspace: ${err instanceof Error ? err.message : String(err)}`;
    store.transitionTask(taskId, 'preparing', 'failed', { last_error: reason });
    const comment = `🔴 **${role}** — failed before starting\n\n${reason}`;
    sink.onFinish(store.getTask(taskId), 'failed', comment);
    return { verdict: 'failed', reason, prUrl: null, comment };
  }
  store.transitionTask(taskId, 'preparing', 'running', {
    workspace_id: workspace.id,
    branch: workspace.branch,
  });

  // PM verifies nothing; DEVOPS prefers its own check and falls back to `test`.
  const verifyCmd =
    delivery.verifyWith === null
      ? null
      : delivery.verifyWith === 'infra'
        ? (project.checks.infra ?? project.checks.test ?? null)
        : (project.checks.test ?? null);
  const verifies: VerifyResult[] = [];
  let sessionId: string | null = null;
  let attempt = task.attempts;
  let outcome: AgentOutcome | null = null;
  let verdict: Verdict = 'failed';
  let reason = '';
  let prUrl: string | null = null;
  let diff: ReportInput['diff'] = null;
  let hooksBypassed = false;
  let lastRunId: RunId | null = null;

  try {
    while (attempt < task.max_attempts) {
      attempt++;
      const runId = newRunId();
      lastRunId = runId;
      store.insertRun({
        id: runId,
        taskId,
        projectId: project.id,
        workspaceId: workspace.id,
        attempt,
        role,
        driver: driver.kind,
        model: agent.model,
        resumedFrom: sessionId,
      });
      // Point the task at its run immediately so the office can follow live events.
      store.db
        .prepare('UPDATE tasks SET current_run_id = ?, attempts = ? WHERE id = ?')
        .run(runId, attempt, taskId);
      log(
        `[${task.card_short_id}] attempt ${attempt}: ${role} (${agent.model}) — $${agent.budget.maxUsd}, ${agent.budget.maxTurns} turns`,
      );

      const prev = verifies.at(-1);
      outcome = await runAgent({
        driver,
        store,
        project,
        role,
        runId,
        taskId,
        attempt,
        workspace,
        log,
        sessionId,
        executor: executorFor(workspace.path, workspace.id),
        onProgress: (p) => sink.onProgress(store.getTask(taskId), runId, p),
        taskView: {
          projectId: project.id,
          role,
          cardShortId: task.card_short_id,
          cardUrl: task.card_url,
          title: task.title,
          spec: task.spec,
          labels,
          attempt,
          maxAttempts: task.max_attempts,
          branch: workspace.branch,
        },
        previousFailure:
          prev && !prev.ok
            ? { command: prev.command, exitCode: prev.exitCode, outputTail: prev.outputTail }
            : undefined,
      });
      sessionId = outcome.exec.sessionId;
      log(
        `[${task.card_short_id}] agent: ${outcome.exec.outcome} — ${outcome.exec.numTurns} turns, $${outcome.exec.cost.totalCostUsd.toFixed(3)}`,
      );

      if (outcome.blocked) {
        verdict = 'blocked';
        reason = `${outcome.blocked.category}: ${outcome.blocked.reason}`;
        break;
      }
      if (outcome.exec.outcome !== 'success') {
        verdict = 'failed';
        reason = `agent run ended with ${outcome.exec.outcome}${outcome.exec.errors.length ? ': ' + outcome.exec.errors.join('; ') : ''}`;
        break;
      }
      if (!outcome.summary) {
        verdict = 'needs_human';
        reason = 'agent finished without calling propose_summary';
        break;
      }
      if (!verifyCmd) {
        verdict = 'review';
        break;
      }

      store.transitionTask(taskId, 'running', 'verifying');
      log(`[${task.card_short_id}] verify: ${verifyCmd}`);
      const v = await runVerify(
        verifyCmd,
        workspace.path,
        project.checks.timeoutMinutes,
        undefined,
        executorFor(workspace.path, workspace.id),
      );
      verifies.push(v);
      store.updateRun(runId, { verify_exit_code: v.exitCode, verify_tail: v.outputTail });
      log(
        `[${task.card_short_id}] verify ${v.ok ? 'passed' : `failed (${v.exitCode ?? 'timeout'})`} in ${Math.round(v.durationMs / 1000)}s`,
      );
      if (v.ok) {
        verdict = 'review';
        break;
      }
      if (attempt < task.max_attempts && sessionId) {
        store.transitionTask(taskId, 'verifying', 'running');
        log(`[${task.card_short_id}] retrying in the same session with the failing output`);
        continue;
      }
      verdict = 'needs_human';
      reason = 'verification failed twice';
    }

    const canPublish =
      !!outcome?.summary && !outcome.blocked && (verdict === 'review' || verdict === 'needs_human');
    if (canPublish && delivery.kind === 'board-only') {
      // Nothing to commit, branch or open. The summary body IS the deliverable,
      // and it reaches the card through the report below. `running -> review` is
      // already a legal edge, so the state machine needs no new one.
      log('board-only role — no commit, no branch, no pull request');
    } else if (canPublish && !opts.dryRun && outcome?.summary) {
      const from = store.getTask(taskId).state;
      if (from === 'running' || from === 'verifying')
        store.transitionTask(taskId, from, 'publishing');
      try {
        const out = await publish({
          project,
          workspace,
          runId: lastRunId ?? 'run',
          cardShortId: task.card_short_id,
          cardUrl: task.card_url,
          role,
          attempt,
          summary: outcome.summary,
          decisions: outcome.decisions,
          verify: verifies,
          exec: outcome.exec,
          denials: outcome.denials,
          log,
          wip: verdict === 'needs_human',
          delivery,
        });
        prUrl = out.prUrl;
        diff = out.diff;
        hooksBypassed = out.hooksBypassed;
        if (out.kind === 'board-only') {
          // QA reviewed the branch and changed nothing. That is a success.
          log('nothing to commit, and this role is allowed to finish without a diff');
        }
      } catch (err) {
        if (err instanceof PublishAbort) {
          verdict = err.code === 'nothing-to-commit' ? 'failed' : 'needs_human';
          reason = `${err.code}: ${err.message}`;
        } else throw err;
      }
    } else if (canPublish && opts.dryRun) {
      log('dry run — skipping commit/push/PR');
    }
  } catch (err) {
    verdict = 'failed';
    reason = `unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`;
    log(reason);
  } finally {
    const current = store.getTask(taskId).state;
    const patch = {
      pr_url: prUrl,
      blocked_reason: verdict === 'blocked' ? reason : null,
      last_error: verdict === 'failed' ? reason : null,
    };
    if (!TERMINAL.includes(current)) {
      try {
        store.transitionTask(taskId, current, verdict, patch);
      } catch {
        // e.g. publishing -> blocked is not an edge; land in needs_human rather than leave it live.
        store.transitionTask(taskId, store.getTask(taskId).state, 'needs_human', patch);
      }
    }
  }

  const report: ReportInput = {
    runId: lastRunId ?? '',
    cardShortId: task.card_short_id,
    cardUrl: task.card_url,
    role,
    attempt,
    branch: workspace.branch,
    summary: outcome?.summary ?? null,
    blocked: outcome?.blocked ?? null,
    decisions: outcome?.decisions ?? [],
    verify: verifies,
    diff,
    exec: outcome?.exec ?? emptyExec(),
    prUrl,
    hooksBypassed,
    denials: outcome?.denials ?? [],
    verdict,
    verdictReason: reason,
    outcome: delivery.kind,
  };
  const comment = buildBoardComment(report);
  sink.onFinish(store.getTask(taskId), verdict, comment);

  if (verdict === 'review' && !opts.keepWorkspace && !opts.dryRun) {
    await worktrees.release(project, workspace.id, log);
  } else {
    worktrees.retain(workspace.id);
    log(`[${task.card_short_id}] workspace retained at ${workspace.path}`);
  }
  return { verdict, reason, prUrl, comment };
}

interface AgentOutcome {
  readonly exec: ExecResult;
  readonly summary: ProposedSummary | null;
  readonly blocked: BlockedReport | null;
  readonly decisions: Decision[];
  readonly denials: { toolName: string; reason: string }[];
}

interface RunAgentInput {
  driver: ExecDriver;
  store: SqliteStore;
  project: ProjectConfig;
  role: Role;
  runId: RunId;
  taskId: TaskId;
  attempt: number;
  workspace: WorkspaceHandle;
  taskView: TaskView;
  sessionId: string | null;
  previousFailure: { command: string; exitCode: number | null; outputTail: string } | undefined;
  /** Runs the target repo's commitlint, in the container under the docker driver. */
  executor: WorkspaceExecutor;
  onProgress: (p: ProgressReport) => void;
  log: (m: string) => void;
}

async function runAgent(input: RunAgentInput): Promise<AgentOutcome> {
  const { driver, store, project, role, runId, taskId, workspace, log } = input;
  const agent = project.agents[role];
  const policy = ROLE_POLICIES[role];
  const delivery = ROLE_DELIVERY[role];

  let summary: ProposedSummary | null = null;
  let blocked: BlockedReport | null = null;
  const decisions: Decision[] = [];
  const denials: { toolName: string; reason: string }[] = [];

  const board = createBoardMcpServer({
    loadTask: () => input.taskView,
    emitProgress: (p) => {
      store.appendEvent(runId, taskId, 'progress', p);
      log(`  ▸ ${p.phase}: ${p.message}`);
      input.onProgress(p);
    },
    markBlocked: (b) => {
      blocked = b;
      store.updateRun(runId, { blocked_json: JSON.stringify(b) });
      store.appendEvent(runId, taskId, 'blocked', b);
    },
    addDecision: (d) => {
      decisions.push(d);
      store.updateRun(runId, { decisions_json: JSON.stringify(decisions) });
    },
    storeSummary: async (s) => {
      // Whether a commit is required is a property of the role, not the schema:
      // a board-only role has nothing to commit and must not be made to invent
      // a message. The rejection round-trips back to the agent either way.
      const errors =
        delivery.requireCommit && !s.commit
          ? ['this role must supply a `commit` message with its summary']
          : s.commit
            ? await validateCommitWithRepo(workspace.path, s, input.executor)
            : [];
      if (!errors.length) {
        summary = s;
        store.updateRun(runId, { summary_json: JSON.stringify(s) });
        store.appendEvent(runId, taskId, 'summary', { title: s.title });
      }
      return errors;
    },
  });

  // Under a container driver the agent sees /work, not the host path — the guard
  // has to judge the paths the agent actually uses, in the right dialect.
  const agentCwd = driver.paths.toAgent(workspace.path);
  const hooks = buildGuardHooks({
    root: agentCwd,
    writeGlobs: delivery.writeGlobs,
    mode: driver.paths.mode,
    onDenial: (toolName, reason, toolInput) => {
      denials.push({ toolName, reason });
      store.appendEvent(runId, taskId, 'denied', { toolName, reason, input: toolInput });
      log(`  ⛔ ${toolName}: ${reason}`);
    },
  });

  const session = await driver.start({
    runId,
    cwd: workspace.path,
    workspaceId: workspace.id,
    repoPath: project.repo.path,
    additionalReadDirs: [],
    systemPromptAppend: buildSystemAppend(project, role),
    prompt: buildUserPrompt({
      task: input.taskView,
      worktreePath: agentCwd,
      baseRef: `${project.repo.remote}/${workspace.baseBranch} @ ${workspace.baseSha.slice(0, 8)}`,
      budget: agent.budget,
      // Delivery-gated, so PM is never told to run a test suite it must not run.
      verifyCommand:
        delivery.verifyWith === null
          ? null
          : delivery.verifyWith === 'infra'
            ? (project.checks.infra ?? project.checks.test ?? null)
            : (project.checks.test ?? null),
      ...(input.previousFailure ? { previousFailure: input.previousFailure } : {}),
    }),
    model: agent.model,
    allowedTools: policy.allowedTools,
    disallowedTools: policy.disallowedTools,
    permissionMode: policy.permissionMode,
    maxTurns: agent.budget.maxTurns,
    maxBudgetUsd: agent.budget.maxUsd,
    wallClockMs: agent.budget.wallClockMinutes * 60_000,
    mcpServers: { [BOARD_SERVER_KEY]: board },
    hooks,
    extraEnv: AGENT_ENV,
    ...(input.sessionId ? { resume: { sessionId: input.sessionId } } : {}),
  });

  store.updateRun(runId, { state: 'running' });
  const heartbeat = setInterval(() => store.heartbeatRun(runId), 10_000);
  try {
    for await (const ev of session.events()) {
      store.appendEvent(runId, taskId, ev.kind, ev);
      if (ev.kind === 'init') {
        store.updateRun(runId, { session_id: ev.sessionId });
        log(
          `  session ${ev.sessionId} · ${ev.model} · mcp ${ev.mcp.map((m) => `${m.name}=${m.status}`).join(',')}`,
        );
      } else if (ev.kind === 'tool-use') log(`  → ${ev.name} ${ev.inputPreview.slice(0, 100)}`);
      else if (ev.kind === 'assistant-text')
        log(`  💬 ${ev.text.replace(/\s+/g, ' ').slice(0, 160)}`);
      else if (ev.kind === 'api-retry')
        log(
          `  ⏳ api retry ${ev.attempt}/${ev.maxRetries} in ${ev.delayMs}ms (status ${ev.status})`,
        );
      else if (ev.kind === 'stderr' && ev.line) log(`  stderr: ${ev.line.slice(0, 200)}`);
    }
  } finally {
    clearInterval(heartbeat);
  }

  const exec = await session.result();
  store.updateRun(runId, {
    state: 'finished',
    ended_at: new Date().toISOString(),
    session_id: exec.sessionId,
    outcome: exec.outcome,
    num_turns: exec.numTurns,
    duration_ms: exec.durationMs,
    cost_usd: exec.cost.totalCostUsd,
    cost_usd_reported: exec.cost.reportedCostUsd,
    cost_estimated: exec.cost.estimated ? 1 : 0,
    input_tokens: exec.cost.inputTokens,
    output_tokens: exec.cost.outputTokens,
    cache_read_tokens: exec.cost.cacheReadTokens,
    cache_creation_tokens: exec.cost.cacheCreationTokens,
    model_usage_json: JSON.stringify(exec.cost.perModel),
    permission_denials_json: JSON.stringify(exec.permissionDenials),
    error_text: exec.errors.length ? exec.errors.join('\n') : null,
  });
  store.db
    .prepare('UPDATE tasks SET current_run_id = ?, attempts = ? WHERE id = ?')
    .run(runId, input.attempt, taskId);

  return { exec, summary, blocked, decisions, denials };
}

/**
 * Enforce the TARGET repo's own commitlint when it has one (closed scope-enum,
 * subject-case…), so the rejection message comes from the repo's rules.
 * Falls back to the basic Conventional Commits shape otherwise.
 */
export async function validateCommitWithRepo(
  cwd: string,
  s: ProposedSummary,
  /** Under docker, the repo's commitlint is a Linux binary in the container. */
  executor?: WorkspaceExecutor,
): Promise<string[]> {
  // A role that is not required to commit has nothing to validate here.
  const commit = s.commit;
  if (!commit) return [];
  const header = `${commit.type}${commit.scope ? `(${commit.scope})` : ''}: ${commit.subject}`;
  const message = commit.body ? `${header}\n\n${commit.body}` : header;

  // In the container the binary is the posix one, at the same relative path.
  const relBin = join('node_modules', '.bin', 'commitlint');
  const hostBin = join(cwd, relBin + (process.platform === 'win32' ? '.cmd' : ''));
  if (existsSync(join(cwd, relBin)) || existsSync(hostBin)) {
    const r = executor
      ? // `sh -lc` in the container: stdin carries the message, as commitlint expects.
        await executor.run(`printf '%s' "$COMMIT_MSG" | ${relBin}`, {
          cwd,
          timeoutMs: 60_000,
          env: { CI: '1', COMMIT_MSG: message },
        })
      : await runCommand(hostBin, [], {
          cwd,
          shell: true,
          timeoutMs: 60_000,
          env: { CI: '1' },
          input: message,
        });
    if (r.exitCode === 0) return [];
    const errors = r.output
      .split(/\r?\n/)
      .filter((l) => /✖|\[error\]/i.test(l) && !/found \d+ problems/i.test(l))
      .map((l) => l.replace(/^\s*✖\s*/, '').trim())
      .filter(Boolean);
    return errors.length ? errors : [`commitlint rejected the message:\n${r.output.slice(-800)}`];
  }

  const errors: string[] = [];
  if (header.length > 100) errors.push(`header is ${header.length} chars (max 100)`);
  if (/^[A-Z]/.test(commit.subject)) errors.push('subject must not start with an uppercase letter');
  if (/\.$/.test(commit.subject)) errors.push('subject must not end with a period');
  return errors;
}

function emptyExec(): ExecResult {
  return {
    outcome: 'driver_error',
    sessionId: null,
    finalText: null,
    numTurns: 0,
    durationMs: 0,
    cost: {
      totalCostUsd: 0,
      reportedCostUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      perModel: {},
      estimated: true,
    },
    permissionDenials: [],
    errors: [],
  };
}
