import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

import type { SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';

export interface ContainerSpawnInput {
  readonly dockerArgs: readonly string[];
  readonly containerName: string;
  /** Values for the `-e NAME` flags; docker inherits them from its own env. */
  readonly env: Readonly<Record<string, string>>;
  /** Container teardown, tried before the pipe is abandoned. */
  readonly onKill: (containerName: string) => Promise<void>;
  readonly onStderr?: (line: string) => void;
}

/**
 * Adapts `docker run -i` to the SDK's `SpawnedProcess`, so the Agent SDK client
 * stays in this process while the CLI runs in the container.
 *
 * Two details carry the whole design:
 *
 * - The SDK writes its control protocol to **stdin** — including `interrupt()` —
 *   so cancellation survives the pipe without any signal plumbing.
 * - Under a custom spawner the SDK never reads stderr (there is none on this
 *   interface), so `Options.stderr` is dead. We pump the container's stderr to
 *   `onStderr` ourselves, which is if anything better: it is the container's
 *   stderr, already demultiplexed by the docker client.
 */
export function spawnContainer(input: ContainerSpawnInput): SpawnedProcess {
  const child: ChildProcessWithoutNullStreams = spawn('docker', [...input.dockerArgs], {
    // shell:false so a Windows --mount path is never mangled by MSYS.
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...input.env, MSYS2_ARG_CONV_EXCL: '*' },
  });

  let stderrTail = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderrTail = `${stderrTail}${chunk}`.slice(-8000);
    for (const line of chunk.split(/\r?\n/)) {
      if (line.trim()) input.onStderr?.(line.trimEnd());
    }
  });

  let killing = false;
  const killContainer = (): void => {
    if (killing) return;
    killing = true;
    // Killing the `docker run` client alone can leave the container running —
    // that is where orphans come from, so always name the container.
    void input.onKill(input.containerName).catch(() => {});
  };

  return {
    stdin: child.stdin as Writable,
    stdout: child.stdout as Readable,
    get killed() {
      return child.killed;
    },
    get exitCode() {
      return child.exitCode;
    },
    get signalCode() {
      return child.signalCode;
    },
    kill(signal: NodeJS.Signals): boolean {
      killContainer();
      return child.kill(signal);
    },
    on(event: 'exit' | 'error', listener: never): void {
      child.on(event, listener);
    },
    once(event: 'exit' | 'error', listener: never): void {
      child.once(event, listener);
    },
    off(event: 'exit' | 'error', listener: never): void {
      child.off(event, listener);
    },
  } as SpawnedProcess & { readonly stderrTail?: string };
}

export const tailOf = (s: string, n = 2000): string => (s.length > n ? s.slice(-n) : s);
