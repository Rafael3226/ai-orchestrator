import { describe, expect, it, vi } from 'vitest';

import type { CommandResult } from '../../process/command.runner.js';

import { DockerCli } from './docker.cli.js';
import { dockerGc, sweepContainers, sweepVolumes } from './docker.gc.js';

const ok = (stdout: string): CommandResult => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  durationMs: 1,
  output: stdout,
  stdout,
});

const fail = (): CommandResult => ({
  exitCode: 1,
  signal: null,
  timedOut: false,
  durationMs: 1,
  output: 'Cannot connect to the Docker daemon',
  stdout: '',
});

const psRow = (name: string, labels: Record<string, string>) =>
  JSON.stringify({
    ID: `id-${name}`,
    Names: name,
    Labels: Object.entries(labels)
      .map(([k, v]) => `${k}=${v}`)
      .join(','),
  });

const volRow = (name: string, workspaceId: string) =>
  JSON.stringify({ Name: name, Labels: `aiorch.workspace=${workspaceId}` });

/** A DockerCli whose underlying runner is a spy. */
function cliWith(responses: Record<string, CommandResult>) {
  const calls: string[][] = [];
  const run = vi.fn(async (_cmd: string, args: readonly string[]) => {
    calls.push([...args]);
    const key = args.find((a) => ['ps', 'volume', 'rm'].includes(a)) ?? args[0] ?? '';
    return responses[key] ?? ok('');
  });
  return { cli: new DockerCli({}, run as never), calls };
}

describe('sweepContainers', () => {
  it('removes an orphan from a previous boot', async () => {
    const { cli, calls } = cliWith({
      ps: ok(psRow('aiorch-old', { 'aiorch.daemon': 'boot-0', 'aiorch.run': 'run-old' })),
    });

    const removed = await sweepContainers(cli, 'boot-1', new Set());

    expect(removed).toEqual(['aiorch-old']);
    expect(calls.some((c) => c[0] === 'rm' && c.includes('aiorch-old'))).toBe(true);
  });

  it('spares a container of this boot whose run is still live', async () => {
    const { cli } = cliWith({
      ps: ok(psRow('aiorch-live', { 'aiorch.daemon': 'boot-1', 'aiorch.run': 'run-live' })),
    });

    expect(await sweepContainers(cli, 'boot-1', new Set(['run-live']))).toEqual([]);
  });

  it('removes a container of this boot whose run already finished', async () => {
    // `--rm` should have handled it; that it is still here means it leaked.
    const { cli } = cliWith({
      ps: ok(psRow('aiorch-stale', { 'aiorch.daemon': 'boot-1', 'aiorch.run': 'run-done' })),
    });

    expect(await sweepContainers(cli, 'boot-1', new Set(['run-other']))).toEqual(['aiorch-stale']);
  });

  it('only ever looks at containers labelled by us', async () => {
    const { cli, calls } = cliWith({ ps: ok('') });
    await sweepContainers(cli, 'boot-1', new Set());
    expect(calls[0]?.join(' ')).toContain('label=aiorch.daemon');
  });

  it('is a no-op when the daemon is unreachable', async () => {
    const { cli } = cliWith({ ps: fail() });
    expect(await sweepContainers(cli, 'boot-1', new Set())).toEqual([]);
  });

  it('skips unparseable rows rather than throwing', async () => {
    const { cli } = cliWith({
      ps: ok(`not json\n${psRow('aiorch-x', { 'aiorch.daemon': 'boot-0', 'aiorch.run': 'r' })}`),
    });
    expect(await sweepContainers(cli, 'boot-1', new Set())).toEqual(['aiorch-x']);
  });
});

describe('sweepVolumes', () => {
  it('removes volumes whose workspace is gone and keeps the rest', async () => {
    const { cli } = cliWith({
      volume: ok(
        `${volRow('aiorch-nm-ws-dead', 'ws-dead')}\n${volRow('aiorch-nm-ws-live', 'ws-live')}`,
      ),
    });

    const removed = await sweepVolumes(cli, (id) => id === 'ws-dead');

    expect(removed).toEqual(['aiorch-nm-ws-dead']);
  });

  it('ignores volumes with no workspace label', async () => {
    const { cli } = cliWith({ volume: ok(JSON.stringify({ Name: 'other', Labels: '' })) });
    expect(await sweepVolumes(cli, () => true)).toEqual([]);
  });
});

describe('dockerGc', () => {
  it('reports both sweeps together', async () => {
    const { cli } = cliWith({
      ps: ok(psRow('aiorch-old', { 'aiorch.daemon': 'boot-0', 'aiorch.run': 'r' })),
      volume: ok(volRow('aiorch-nm-ws-dead', 'ws-dead')),
    });

    const r = await dockerGc(cli, 'boot-1', new Set(), () => true);

    expect(r).toEqual({
      containersRemoved: ['aiorch-old'],
      volumesRemoved: ['aiorch-nm-ws-dead'],
    });
  });
});
