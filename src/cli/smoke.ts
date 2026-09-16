import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { newRunId } from '../domain/ids.js';
import { LocalDriver } from '../exec/local.driver.js';
import { buildGuardHooks } from '../policy/pretooluse.hook.js';
import { AGENT_ENV } from '../policy/tool.policy.js';

/**
 * Validate the assumption the whole driver rests on: a streaming-input
 * generator that yields ONE user message and returns lets the turn complete
 * unattended, we receive the result message (with session_id + modelUsage),
 * and the run ends without hanging. Costs a fraction of a cent on haiku.
 */
export async function runSmoke(opts: { model: string; cancelAfterMs?: number }): Promise<number> {
  const driver = new LocalDriver();
  await driver.preflight();
  const cwd = mkdtempSync(join(tmpdir(), 'ai-orch-smoke-'));
  const runId = newRunId();
  const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

  log(`smoke: model=${opts.model} cwd=${cwd}`);
  const started = Date.now();
  const session = await driver.start({
    runId,
    cwd,
    additionalReadDirs: [],
    systemPromptAppend: 'You are a smoke test. Follow the user instruction literally and briefly.',
    prompt: opts.cancelAfterMs
      ? 'Count from 1 to 200, one number per line, slowly and without stopping.'
      : 'Reply with exactly the single word: ok',
    model: opts.model,
    allowedTools: ['Read'],
    disallowedTools: ['Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch'],
    permissionMode: 'dontAsk',
    maxTurns: 3,
    maxBudgetUsd: 0.1,
    wallClockMs: 120_000,
    mcpServers: {},
    hooks: buildGuardHooks({ root: cwd, onDenial: (t, r) => log(`denied ${t}: ${r}`) }),
    extraEnv: AGENT_ENV,
  });

  if (opts.cancelAfterMs) {
    setTimeout(() => {
      log(`cancelling after ${opts.cancelAfterMs}ms`);
      void session.cancel('smoke cancel');
    }, opts.cancelAfterMs);
  }

  for await (const ev of session.events()) {
    if (ev.kind === 'init')
      log(
        `init: session=${ev.sessionId} model=${ev.model} cc=${ev.claudeCodeVersion} tools=${ev.tools.length}`,
      );
    else if (ev.kind === 'assistant-text')
      log(`text: ${ev.text.replace(/\s+/g, ' ').slice(0, 80)}`);
    else if (ev.kind === 'stderr') log(`stderr: ${ev.line.slice(0, 160)}`);
    else if (ev.kind !== 'status') log(`${ev.kind}: ${JSON.stringify(ev).slice(0, 160)}`);
  }
  const r = await session.result();
  const wall = Date.now() - started;

  console.log('\nresult');
  console.log(`  outcome     ${r.outcome}`);
  console.log(`  session     ${r.sessionId}`);
  console.log(`  turns       ${r.numTurns}`);
  console.log(
    `  duration    ${r.durationMs}ms (wall ${wall}ms — the gap is process spawn + teardown)`,
  );
  console.log(`  final text  ${JSON.stringify(r.finalText)}`);
  console.log(
    `  cost        $${r.cost.totalCostUsd} (reported $${r.cost.reportedCostUsd}) estimated=${r.cost.estimated}`,
  );
  console.log(
    `  tokens      in=${r.cost.inputTokens} out=${r.cost.outputTokens} cacheRead=${r.cost.cacheReadTokens} cacheCreate=${r.cost.cacheCreationTokens}`,
  );
  console.log(`  models      ${Object.keys(r.cost.perModel).join(', ') || '(none)'}`);
  if (r.errors.length) console.log(`  errors      ${r.errors.join(' | ')}`);

  const expected = opts.cancelAfterMs
    ? r.outcome === 'cancelled'
    : r.outcome === 'success' && r.sessionId !== null;
  console.log(
    expected ? '\n✔ streaming-input assumption holds' : '\n✖ unexpected outcome — see above',
  );
  return expected ? 0 : 1;
}
