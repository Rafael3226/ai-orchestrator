import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig, type ProjectConfig } from '../config/config.loader.js';
import { type Role, roleSchema } from '../config/config.schema.js';
import { loadOrchestratorEnv } from '../config/env.js';
import { SqliteStore } from '../db/sqlite.store.js';
import { newRunId, newTaskId, type RunId, type TaskId } from '../domain/ids.js';
import type { ExecDriver, ExecResult } from '../exec/exec.driver.js';
import { LocalDriver } from '../exec/local.driver.js';
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
import { buildGuardHooks } from '../policy/pretooluse.hook.js';
import { AGENT_ENV, ROLE_POLICIES } from '../policy/tool.policy.js';
import { runCommand } from '../process/command.runner.js';
import { buildSystemAppend } from '../prompt/system.append.js';
import { buildUserPrompt } from '../prompt/user.prompt.js';
import { type WorkspaceHandle, WorktreeManager } from '../workspace/worktree.manager.js';

export interface RunTaskOptions {
  readonly project: string;
  readonly role: Role;
  readonly title: string;
  readonly spec: string;
  readonly cardShortId?: string;
  readonly cardUrl?: string;
  readonly labels?: readonly string[];
  /** Skip publish; just prove agent + worktree + verify work. */
  readonly dryRun?: boolean;
  readonly keepWorkspace?: boolean;
}

interface RunOutcome {
  readonly exec: ExecResult;
  readonly summary: ProposedSummary | null;
  readonly blocked: BlockedReport | null;
  readonly decisions: Decision[];
  readonly denials: { toolName: string; reason: string }[];
}

/**
 * Drive one task end to end with no board involved:
 * worktree → agent → verify (retry once) → commit/push/draft PR → report.
 * This is the Phase 2 milestone and the spine every later phase reuses.
 */
export async function runTask(opts: RunTaskOptions): Promise<number> {
  const env = loadOrchestratorEnv();
  const loaded = loadConfig(env.ORCHESTRATOR_CONFIG);
  const project = loaded.project(opts.project);
  const role = roleSchema.parse(opts.role);
  const agent = project.agents[role];
  if (!agent.enabled)
    console.warn(
      `⚠ ${role} is not enabled for ${project.id}; running anyway (run-task ignores enablement)`,
    );

  const store = new SqliteStore(env.ORCHESTRATOR_DB);
  const worktrees = new WorktreeManager(store);
  const driver: ExecDriver = new LocalDriver();
  await driver.preflight();

  const taskId = newTaskId();
  const cardShortId = opts.cardShortId ?? taskId.slice(-6);
  const log = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

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
  store.transitionTask(taskId, 'queued', 'claimed');
  store.transitionTask(taskId, 'claimed', 'preparing');

  let workspace: WorkspaceHandle;
  try {
    workspace = await worktrees.acquire({
      project,
      taskId,
      role,
      cardShortId,
      cardTitle: opts.title,
      log,
    });
  } catch (err) {
    store.transitionTask(taskId, 'preparing', 'failed', { last_error: String(err) });
    console.error(`✖ workspace: ${err instanceof Error ? err.message : err}`);
    return 1;
  }
  store.transitionTask(taskId, 'preparing', 'running', {
    workspace_id: workspace.id,
    branch: workspace.branch,
  });

  const verifyCmd = project.checks.test ?? null;
  const verifies: VerifyResult[] = [];
  let sessionId: string | null = null;
  let attempt = 0;
  let outcome: RunOutcome | null = null;
  let finalState: 'review' | 'blocked' | 'needs_human' | 'failed' = 'failed';
  let reason = '';
  let prUrl: string | null = null;
  let diff: ReportInput['diff'] = null;
  let hooksBypassed = false;

  try {
    while (attempt < 2) {
      attempt++;
      const runId = newRunId();
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
      log(
        `attempt ${attempt}: agent ${role} (${agent.model}) — budget $${agent.budget.maxUsd}, ${agent.budget.maxTurns} turns`,
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
        taskView: {
          projectId: project.id,
          role,
          cardShortId,
          cardUrl: opts.cardUrl ?? '',
          title: opts.title,
          spec: opts.spec,
          labels: opts.labels ?? [],
          attempt,
          maxAttempts: 2,
          branch: workspace.branch,
        },
        previousFailure:
          prev && !prev.ok
            ? { command: prev.command, exitCode: prev.exitCode, outputTail: prev.outputTail }
            : undefined,
      });
      sessionId = outcome.exec.sessionId;
      log(
        `agent finished: ${outcome.exec.outcome} — ${outcome.exec.numTurns} turns, $${outcome.exec.cost.totalCostUsd.toFixed(3)}`,
      );

      if (outcome.blocked) {
        finalState = 'blocked';
        reason = `${outcome.blocked.category}: ${outcome.blocked.reason}`;
        break;
      }
      if (outcome.exec.outcome !== 'success') {
        finalState = 'failed';
        reason = `agent run ended with ${outcome.exec.outcome}: ${outcome.exec.errors.join('; ')}`;
        break;
      }
      if (!outcome.summary) {
        finalState = 'needs_human';
        reason = 'agent finished without calling propose_summary';
        break;
      }

      if (!verifyCmd) {
        finalState = 'review';
        break;
      }
      store.transitionTask(taskId, 'running', 'verifying');
      log(`verify: ${verifyCmd}`);
      const v = await runVerify(verifyCmd, workspace.path, project.checks.timeoutMinutes);
      verifies.push(v);
      store.updateRun(runId, { verify_exit_code: v.exitCode, verify_tail: v.outputTail });
      log(
        `verify ${v.ok ? 'passed' : `failed (exit ${v.exitCode ?? 'timeout'})`} in ${Math.round(v.durationMs / 1000)}s`,
      );

      if (v.ok) {
        finalState = 'review';
        break;
      }
      if (attempt < 2 && sessionId) {
        store.transitionTask(taskId, 'verifying', 'running');
        log('retrying once with the failing output appended to the same session');
        continue;
      }
      finalState = 'needs_human';
      reason = 'verification failed twice';
    }

    // Publish when we have a summary and either passed or are pushing WIP.
    const canPublish =
      outcome?.summary &&
      (finalState === 'review' || finalState === 'needs_human') &&
      !outcome.blocked;
    if (canPublish && !opts.dryRun) {
      const from = store.getTask(taskId).state;
      if (from === 'running' || from === 'verifying')
        store.transitionTask(taskId, from, 'publishing');
      try {
        const out = await publish({
          project,
          workspace,
          runId: store.getTask(taskId).current_run_id ?? 'run',
          cardShortId,
          cardUrl: opts.cardUrl ?? '',
          role,
          attempt,
          summary: outcome!.summary!,
          decisions: outcome!.decisions,
          verify: verifies,
          exec: outcome!.exec,
          denials: outcome!.denials,
          log,
          wip: finalState === 'needs_human',
        });
        prUrl = out.prUrl;
        diff = out.diff;
        hooksBypassed = out.hooksBypassed;
      } catch (err) {
        if (err instanceof PublishAbort) {
          finalState = err.code === 'nothing-to-commit' ? 'failed' : 'needs_human';
          reason = `${err.code}: ${err.message}`;
        } else throw err;
      }
    } else if (canPublish && opts.dryRun) {
      log('dry run — skipping commit/push/PR');
    }
  } finally {
    const current = store.getTask(taskId).state;
    const patch = {
      pr_url: prUrl,
      blocked_reason: finalState === 'blocked' ? reason : null,
      last_error: finalState === 'failed' ? reason : null,
    };
    if (
      current !== finalState &&
      !['review', 'blocked', 'failed', 'needs_human', 'cancelled'].includes(current)
    ) {
      try {
        store.transitionTask(taskId, current, finalState, patch);
      } catch {
        // publishing -> blocked is not a legal edge; fall through to needs_human.
        store.transitionTask(taskId, store.getTask(taskId).state, 'needs_human', patch);
      }
    }
  }

  if (outcome) {
    const report: ReportInput = {
      runId: store.getTask(taskId).current_run_id ?? '',
      cardShortId,
      cardUrl: opts.cardUrl ?? '',
      role,
      attempt,
      branch: workspace.branch,
      summary: outcome.summary,
      blocked: outcome.blocked,
      decisions: outcome.decisions,
      verify: verifies,
      diff,
      exec: outcome.exec,
      prUrl,
      hooksBypassed,
      denials: outcome.denials,
      verdict: finalState,
      verdictReason: reason,
    };
    console.log('\n' + buildBoardComment(report) + '\n');
  }

  if (finalState === 'review' && !opts.keepWorkspace && !opts.dryRun) {
    await worktrees.release(project, workspace.id, log);
  } else {
    worktrees.retain(workspace.id);
    log(`workspace retained at ${workspace.path}`);
  }
  store.close();
  return finalState === 'review' ? 0 : 1;
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
  log: (m: string) => void;
}

async function runAgent(input: RunAgentInput): Promise<RunOutcome> {
  const { driver, store, project, role, runId, taskId, workspace, log } = input;
  const agent = project.agents[role];
  const policy = ROLE_POLICIES[role];

  let summary: ProposedSummary | null = null;
  let blocked: BlockedReport | null = null;
  const decisions: Decision[] = [];
  const denials: { toolName: string; reason: string }[] = [];

  const board = createBoardMcpServer({
    loadTask: () => input.taskView,
    emitProgress: (p: ProgressReport) => {
      store.appendEvent(runId, taskId, 'progress', p);
      log(`  ▸ ${p.phase}: ${p.message}`);
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
      const errors = await validateCommitWithRepo(workspace.path, s);
      if (!errors.length) {
        summary = s;
        store.updateRun(runId, { summary_json: JSON.stringify(s) });
        store.appendEvent(runId, taskId, 'summary', { title: s.title });
      }
      return errors;
    },
  });

  const hooks = buildGuardHooks({
    root: workspace.path,
    onDenial: (toolName, reason, toolInput) => {
      denials.push({ toolName, reason });
      store.appendEvent(runId, taskId, 'denied', { toolName, reason, input: toolInput });
      log(`  ⛔ ${toolName}: ${reason}`);
    },
  });

  const session = await driver.start({
    runId,
    cwd: workspace.path,
    additionalReadDirs: [],
    systemPromptAppend: buildSystemAppend(project, role),
    prompt: buildUserPrompt({
      task: input.taskView,
      worktreePath: workspace.path,
      baseRef: `${project.repo.remote}/${workspace.baseBranch} @ ${workspace.baseSha.slice(0, 8)}`,
      budget: agent.budget,
      verifyCommand: project.checks.test ?? null,
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
async function validateCommitWithRepo(cwd: string, s: ProposedSummary): Promise<string[]> {
  const header = `${s.commit.type}${s.commit.scope ? `(${s.commit.scope})` : ''}: ${s.commit.subject}`;
  const message = s.commit.body ? `${header}\n\n${s.commit.body}` : header;

  const bin = join(
    cwd,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'commitlint.cmd' : 'commitlint',
  );
  if (existsSync(bin)) {
    const r = await runCommand(bin, [], {
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
  if (/^[A-Z]/.test(s.commit.subject))
    errors.push('subject must not start with an uppercase letter');
  if (/\.$/.test(s.commit.subject)) errors.push('subject must not end with a period');
  return errors;
}
