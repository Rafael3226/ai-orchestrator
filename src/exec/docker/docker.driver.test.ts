import { describe, expect, it, vi } from 'vitest';

import { dockerConfigSchema, type DockerConfig } from '../../config/config.schema.js';
import type { CommandResult } from '../../process/command.runner.js';

import { DockerCli } from './docker.cli.js';
import { DockerDriver } from './docker.driver.js';

const ok = (stdout = ''): CommandResult => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  durationMs: 1,
  output: stdout,
  stdout,
});

const fail = (output: string): CommandResult => ({
  exitCode: 1,
  signal: null,
  timedOut: false,
  durationMs: 1,
  output,
  stdout: '',
});

const cfg = (over: Partial<DockerConfig> = {}): DockerConfig => ({
  ...dockerConfigSchema.parse({}),
  ...over,
});

/**
 * Drives DockerCli through an injected runner, so every branch is reachable
 * with no daemon. The key is the first recognisable docker subcommand.
 */
function cliWith(responses: Record<string, CommandResult>, throwOn?: string) {
  const calls: string[][] = [];
  const run = vi.fn(async (_cmd: string, args: readonly string[]) => {
    calls.push([...args]);
    const key = args[0] ?? '';
    if (throwOn && key === throwOn) throw new Error('spawn docker ENOENT');
    return responses[key] ?? ok();
  });
  return { cli: new DockerCli({}, run as never), calls };
}

const driver = (cli: DockerCli, over: Partial<DockerConfig> = {}) =>
  new DockerDriver({ cfg: cfg(over), bootId: 'boot-1', cli });

describe('DockerDriver.preflight', () => {
  it('passes when the daemon is up, Linux, and the image is present', async () => {
    const { cli } = cliWith({
      version: ok('{"Client":{}}'),
      info: ok('{"OSType":"linux"}'),
      image: ok('{}'),
    });
    await expect(driver(cli).preflight()).resolves.toBeUndefined();
  });

  it('names the missing binary rather than a generic failure', async () => {
    const { cli } = cliWith({}, 'version');
    await expect(driver(cli).preflight()).rejects.toThrow(/docker binary not found/);
  });

  it('reports an unreachable daemon', async () => {
    const { cli } = cliWith({ version: fail('Cannot connect to the Docker daemon') });
    await expect(driver(cli).preflight()).rejects.toThrow(/daemon is not reachable/);
  });

  it('rejects Windows-container mode, which cannot run the image', async () => {
    const { cli } = cliWith({
      version: ok(),
      info: ok('{"OSType":"windows"}'),
      image: ok('{}'),
    });
    await expect(driver(cli).preflight()).rejects.toThrow(/Linux-container mode/);
  });

  it('pulls a missing image under the default policy', async () => {
    const { cli, calls } = cliWith({
      version: ok(),
      info: ok('{"OSType":"linux"}'),
      image: fail('No such image'),
      pull: ok(),
    });

    await driver(cli).preflight();

    expect(calls.some((c) => c[0] === 'pull')).toBe(true);
  });

  it('refuses to pull when the policy says never, and says what to run', async () => {
    const { cli } = cliWith({
      version: ok(),
      info: ok('{"OSType":"linux"}'),
      image: fail('No such image'),
    });

    await expect(driver(cli, { pullPolicy: 'never' }).preflight()).rejects.toThrow(
      /orchestrator image build/,
    );
  });

  it('pulls every time under the always policy, even when present', async () => {
    const { cli, calls } = cliWith({
      version: ok(),
      info: ok('{"OSType":"linux"}'),
      image: ok('{}'),
      pull: ok(),
    });

    await driver(cli, { pullPolicy: 'always' }).preflight();

    expect(calls.some((c) => c[0] === 'pull')).toBe(true);
  });
});

describe('DockerDriver paths', () => {
  it('maps every host worktree onto the single container mount point', () => {
    const { cli } = cliWith({});
    const d = driver(cli);
    expect(d.paths.mode).toBe('posix');
    expect(d.paths.toAgent('D:\\aow\\demo\\42-add-a-thing')).toBe('/work');
    expect(d.kind).toBe('docker');
  });
});

describe('DockerDriver teardown', () => {
  it('stops the container by name, and only kills if the stop failed', async () => {
    const { cli, calls } = cliWith({ stop: ok() });
    // teardown is private; onCancel reaches it through the session's cancel path.
    await (driver(cli) as unknown as { teardown(name: string): Promise<void> }).teardown(
      'aiorch-run-1',
    );

    expect(calls.some((c) => c[0] === 'stop' && c.includes('aiorch-run-1'))).toBe(true);
    expect(calls.some((c) => c[0] === 'kill')).toBe(false);
  });

  it('escalates to kill when the container will not stop', async () => {
    const { cli, calls } = cliWith({ stop: fail('timeout'), kill: ok() });

    await (driver(cli) as unknown as { teardown(name: string): Promise<void> }).teardown(
      'aiorch-run-1',
    );

    expect(calls.some((c) => c[0] === 'kill' && c.includes('aiorch-run-1'))).toBe(true);
  });
});
