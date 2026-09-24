import { type DockerCli } from './docker.cli.js';

export interface GcResult {
  readonly containersRemoved: readonly string[];
  readonly volumesRemoved: readonly string[];
}

interface PsRow {
  ID?: string;
  Names?: string;
  Labels?: string;
}

interface VolumeRow {
  Name?: string;
  Labels?: string;
}

const parseLabels = (s: string | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const pair of (s ?? '').split(',')) {
    const i = pair.indexOf('=');
    if (i > 0) out[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return out;
};

const parseJsonLines = <T>(text: string): T[] =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as T];
      } catch {
        return [];
      }
    });

/**
 * Sweep containers and volumes this orchestrator left behind.
 *
 * `--rm` covers the happy path, but a daemon crash, a Docker Desktop restart or
 * a killed `docker run` client all leave a container running. Every container we
 * start carries `aiorch.daemon=<bootId>`, so anything labelled by us whose run is
 * not live in THIS boot is ours to remove.
 */
export async function sweepContainers(
  cli: DockerCli,
  bootId: string,
  liveRunIds: ReadonlySet<string>,
): Promise<readonly string[]> {
  const listed = await cli.ps('aiorch.daemon').catch(() => null);
  if (!listed || listed.exitCode !== 0) return [];

  const removed: string[] = [];
  for (const row of parseJsonLines<PsRow>(listed.stdout)) {
    const labels = parseLabels(row.Labels);
    const runId = labels['aiorch.run'];
    const daemon = labels['aiorch.daemon'];
    // Live containers of this very boot are the only ones we must not touch.
    if (daemon === bootId && runId && liveRunIds.has(runId)) continue;
    const id = row.Names ?? row.ID;
    if (!id) continue;
    if ((await cli.rm(id).catch(() => null))?.exitCode === 0) removed.push(id);
  }
  return removed;
}

/** Volumes are per workspace; `isDead` decides from the workspace table. */
export async function sweepVolumes(
  cli: DockerCli,
  isDead: (workspaceId: string) => boolean,
): Promise<readonly string[]> {
  const listed = await cli.volumeLs('aiorch.workspace').catch(() => null);
  if (!listed || listed.exitCode !== 0) return [];

  const removed: string[] = [];
  for (const row of parseJsonLines<VolumeRow>(listed.stdout)) {
    const workspaceId = parseLabels(row.Labels)['aiorch.workspace'];
    if (!row.Name || !workspaceId || !isDead(workspaceId)) continue;
    if ((await cli.volumeRm(row.Name).catch(() => null))?.exitCode === 0) removed.push(row.Name);
  }
  return removed;
}

export async function dockerGc(
  cli: DockerCli,
  bootId: string,
  liveRunIds: ReadonlySet<string>,
  isDeadWorkspace: (workspaceId: string) => boolean,
): Promise<GcResult> {
  return {
    containersRemoved: await sweepContainers(cli, bootId, liveRunIds),
    volumesRemoved: await sweepVolumes(cli, isDeadWorkspace),
  };
}
