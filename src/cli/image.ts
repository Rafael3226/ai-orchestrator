import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { loadConfig } from '../config/config.loader.js';
import { loadOrchestratorEnv } from '../config/env.js';
import { DockerCli } from '../exec/docker/docker.cli.js';
import { runCommand } from '../process/command.runner.js';

const DOCKERFILE = 'docker/agent.Dockerfile';

/** The CLI version the installed SDK bundles — what the image should match. */
export function sdkBundledCliVersion(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('@anthropic-ai/claude-code/package.json') as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

/** Every distinct image any enabled role could run. */
function configuredImages(): string[] {
  const env = loadOrchestratorEnv();
  const loaded = loadConfig(env.ORCHESTRATOR_CONFIG);
  const images = new Set<string>();
  for (const p of loaded.config.projects) {
    if (!p.enabled) continue;
    for (const agent of Object.values(p.agents)) {
      if (agent.enabled && agent.exec.driver === 'docker') images.add(agent.exec.docker.image);
    }
  }
  return [...images];
}

export async function buildImage(tag?: string, cliVersion?: string): Promise<number> {
  const image = tag ?? configuredImages()[0];
  if (!image) {
    console.error('no project has exec.driver: docker — pass --tag to build anyway');
    return 1;
  }
  const version = cliVersion ?? sdkBundledCliVersion() ?? 'latest';
  console.log(`building ${image} with @anthropic-ai/claude-code@${version}`);

  const r = await runCommand(
    'docker',
    [
      'build',
      '-f',
      DOCKERFILE,
      '--build-arg',
      `CLAUDE_CLI_VERSION=${version}`,
      '-t',
      image,
      resolve('docker'),
    ],
    {
      cwd: process.cwd(),
      timeoutMs: 30 * 60_000,
      shell: false,
      onLine: (_s, line) => console.log(line),
    },
  );
  if (r.exitCode !== 0) console.error(`build failed (${r.exitCode})`);
  return r.exitCode === 0 ? 0 : 1;
}

/**
 * The image's CLI and the SDK's bundled CLI speak the same control protocol
 * only if they are close in version. A mismatch is the failure mode that looks
 * like "the agent hangs after init", so surface it loudly here and in doctor.
 */
export async function checkImage(tag?: string): Promise<number> {
  const images = tag ? [tag] : configuredImages();
  if (images.length === 0) {
    console.log('no docker images configured — nothing to check');
    return 0;
  }
  const expected = sdkBundledCliVersion();
  const cli = new DockerCli();
  let bad = 0;

  for (const image of images) {
    const inspected = await cli.imageInspect(image);
    if (inspected.exitCode !== 0) {
      console.error(`✖ ${image}: not present locally — run \`orchestrator image build\``);
      bad++;
      continue;
    }
    const labelled = /"org\.aiorch\.cli-version"\s*:\s*"([^"]+)"/.exec(inspected.stdout)?.[1];
    const reported = await cli.exec(['run', '--rm', image, 'claude', '--version'], 60_000);
    const actual = /(\d+\.\d+\.\d+)/.exec(reported.stdout)?.[1] ?? labelled ?? 'unknown';

    if (expected && actual !== expected) {
      console.warn(
        `⚠ ${image}: CLI ${actual}, SDK bundles ${expected} — rebuild if the agent stalls after init`,
      );
    } else {
      console.log(`✔ ${image}: CLI ${actual}`);
    }
  }
  return bad ? 1 : 0;
}

export async function pullImage(tag?: string): Promise<number> {
  const images = tag ? [tag] : configuredImages();
  const cli = new DockerCli();
  let bad = 0;
  for (const image of images) {
    const r = await cli.pull(image);
    console.log(r.exitCode === 0 ? `✔ pulled ${image}` : `✖ could not pull ${image}`);
    if (r.exitCode !== 0) bad++;
  }
  return bad ? 1 : 0;
}
