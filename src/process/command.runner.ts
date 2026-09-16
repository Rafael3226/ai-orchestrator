import { spawn } from 'node:child_process';

export interface CommandOptions {
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Run through the platform shell (needed for `pnpm turbo run test`-style strings). */
  readonly shell?: boolean;
  /** Keep at most this many trailing bytes of combined output. */
  readonly tailBytes?: number;
  readonly onLine?: (stream: 'stdout' | 'stderr', line: string) => void;
  /** Written to stdin then closed. Omit for no stdin. */
  readonly input?: string;
}

export interface CommandResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  /** Combined stdout+stderr, trailing `tailBytes`. */
  readonly output: string;
  readonly stdout: string;
}

export class CommandError extends Error {
  constructor(
    readonly command: string,
    readonly result: CommandResult,
  ) {
    super(
      result.timedOut
        ? `${command} timed out after ${result.durationMs}ms`
        : `${command} exited with ${result.exitCode ?? result.signal}\n${result.output.slice(-2000)}`,
    );
    this.name = 'CommandError';
  }
}

/**
 * Spawn a process with a hard wall clock and bounded output capture.
 *
 * Never throws on a non-zero exit — callers decide what a failure means. It
 * only rejects on spawn errors (binary missing).
 */
export function runCommand(
  command: string,
  args: readonly string[],
  opts: CommandOptions,
): Promise<CommandResult> {
  const started = Date.now();
  const tailBytes = opts.tailBytes ?? 64 * 1024;

  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env } as NodeJS.ProcessEnv,
      shell: opts.shell ?? false,
      stdio: [opts.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    if (opts.input !== undefined && child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(opts.input);
    }

    let output = '';
    let stdout = '';
    let timedOut = false;

    const append = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      const text = chunk.toString('utf8');
      output = (output + text).slice(-tailBytes);
      if (stream === 'stdout') stdout = (stdout + text).slice(-tailBytes);
      if (opts.onLine) {
        for (const line of text.split(/\r?\n/)) if (line) opts.onLine(stream, line);
      }
    };
    child.stdout?.on('data', (c: Buffer) => append('stdout', c));
    child.stderr?.on('data', (c: Buffer) => append('stderr', c));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, opts.timeoutMs);

    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode,
        signal,
        timedOut,
        durationMs: Date.now() - started,
        output,
        stdout,
      });
    });
  });
}

/** Like runCommand but throws CommandError on non-zero exit or timeout. */
export async function runOrThrow(
  command: string,
  args: readonly string[],
  opts: CommandOptions,
): Promise<CommandResult> {
  const result = await runCommand(command, args, opts);
  if (result.timedOut || result.exitCode !== 0) {
    throw new CommandError([command, ...args].join(' '), result);
  }
  return result;
}
