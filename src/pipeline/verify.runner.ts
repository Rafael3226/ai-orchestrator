import { runCommand } from '../process/command.runner.js';

export interface VerifyResult {
  readonly command: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly outputTail: string;
  readonly ok: boolean;
}

/**
 * The orchestrator runs verification itself. An agent's "tests pass" is a
 * claim, not evidence.
 */
export async function runVerify(
  command: string,
  cwd: string,
  timeoutMinutes: number,
  onLine?: (line: string) => void,
): Promise<VerifyResult> {
  const r = await runCommand(command, [], {
    cwd,
    shell: true,
    timeoutMs: timeoutMinutes * 60_000,
    tailBytes: 16 * 1024,
    env: { CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', TURBO_TELEMETRY_DISABLED: '1' },
    ...(onLine ? { onLine: (_s: string, line: string) => onLine(line) } : {}),
  });
  return {
    command,
    exitCode: r.exitCode,
    timedOut: r.timedOut,
    durationMs: r.durationMs,
    outputTail: r.output,
    ok: !r.timedOut && r.exitCode === 0,
  };
}
