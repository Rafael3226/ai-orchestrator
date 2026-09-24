import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';

import type { DockerConfig } from '../../config/config.schema.js';
import { AGENT_ENV } from '../../policy/tool.policy.js';
import type {
  ExecDriver,
  ExecEvent,
  ExecRunSpec,
  ExecSession,
  PathMapping,
} from '../exec.driver.js';
import { runSdkSession } from '../sdk.session.js';

import { spawnContainer } from './container.spawn.js';
import { buildContainerEnv, buildRunArgs, names, WORK_DIR } from './docker.args.js';
import { DockerCli } from './docker.cli.js';
import { resolveGitDir } from './gitdir.resolver.js';

export interface DockerDriverOptions {
  readonly cfg: DockerConfig;
  /** Identifies this daemon boot for the orphan sweep. */
  readonly bootId: string;
  readonly cli?: DockerCli;
  /** Injected in tests so no daemon is needed. */
  readonly spawn?: typeof spawnContainer;
  readonly log?: (msg: string) => void;
}

/**
 * Containerized agent runs: the Agent SDK client stays HERE, the `claude` CLI
 * runs in the container, and the two are bridged by `docker run -i` stdio via
 * the SDK's `spawnClaudeCodeProcess` hook.
 *
 * Why this split rather than moving the SDK into the container: the in-process
 * board MCP server (`src/mcp/board.server.ts`) and the PreToolUse guards are
 * plain JS objects handed to the SDK, and the SDK drives both over the stdio
 * control protocol rather than serializing them. Keeping the client host-side
 * means `report_progress`, `propose_summary`, the path guard and the bash guard
 * all keep working with no new RPC surface and no settings file in the image.
 *
 * What that costs, stated plainly:
 * - `Options.stderr` never fires under a custom spawner, so we pump the
 *   container's stderr into the event sink ourselves.
 * - The CLI version in the image is not the one the SDK bundles; the `init`
 *   event carries it, and preflight compares it against the image label.
 * - The container protects the HOST from the agent. It does not protect the
 *   orchestrator, which still holds the board token and `gh`. This is a
 *   blast-radius boundary, not a security milestone.
 */
export class DockerDriver implements ExecDriver {
  readonly kind = 'docker' as const;
  /** Every worktree is mounted at the same place, so the mapping is constant. */
  readonly paths: PathMapping = { mode: 'posix', toAgent: () => WORK_DIR };

  private readonly cli: DockerCli;
  private readonly spawnImpl: typeof spawnContainer;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: DockerDriverOptions) {
    this.cli = opts.cli ?? new DockerCli({ host: opts.cfg.dockerHost });
    this.spawnImpl = opts.spawn ?? spawnContainer;
    this.log = opts.log ?? (() => {});
  }

  async preflight(): Promise<void> {
    const version = await this.cli.version().catch((e: unknown) => {
      throw new Error(
        `docker binary not found on PATH (${e instanceof Error ? e.message : String(e)})`,
      );
    });
    if (version.exitCode !== 0) {
      throw new Error(`docker daemon is not reachable: ${version.output.slice(-400).trim()}`);
    }

    const info = await this.cli.info();
    if (info.exitCode !== 0) {
      throw new Error(`docker info failed: ${info.output.slice(-400).trim()}`);
    }
    if (/"OSType"\s*:\s*"(?!linux)/.test(info.stdout)) {
      throw new Error('docker is not in Linux-container mode — switch the daemon and retry');
    }

    const { image, pullPolicy } = this.opts.cfg;
    const present = (await this.cli.imageInspect(image)).exitCode === 0;
    if (pullPolicy === 'always' || (!present && pullPolicy === 'missing')) {
      this.log(`pulling ${image}`);
      const pulled = await this.cli.pull(image);
      if (pulled.exitCode !== 0) {
        throw new Error(`could not pull ${image}: ${pulled.output.slice(-400).trim()}`);
      }
    } else if (!present) {
      throw new Error(
        `image ${image} is not present and pullPolicy is "never" — run \`orchestrator image build\``,
      );
    }
  }

  async start(spec: ExecRunSpec): Promise<ExecSession> {
    const cfg = this.opts.cfg;
    const gitDir = resolveGitDir(spec.cwd, spec.repoPath);
    if (!gitDir && cfg.mountGitDir) {
      this.log(
        `${spec.runId}: ${spec.cwd} has no worktree gitdir link — running without ${'/gitcommon'}`,
      );
    }
    const n = names(spec.runId, spec.workspaceId);
    let pushEvent: ((e: ExecEvent) => void) | null = null;

    const spawnClaudeCodeProcess = (o: SpawnOptions): SpawnedProcess => {
      const env = buildContainerEnv({
        sdkEnv: o.env,
        extraEnv: spec.extraEnv,
        hostEnv: process.env,
        gitDir,
        agentEnvKeys: Object.keys(AGENT_ENV),
      });
      const dockerArgs = buildRunArgs({
        cfg,
        runId: spec.runId,
        taskId: spec.runId,
        projectId: spec.workspaceId,
        workspaceId: spec.workspaceId,
        bootId: this.opts.bootId,
        worktreeHostPath: spec.cwd,
        gitDir,
        envNames: Object.keys(env),
        // The SDK built the argv; we only change where it runs. The command is
        // resolved inside the image, so a host-side path is irrelevant here.
        command: ['claude', ...o.args],
      });
      this.log(`${spec.runId}: docker run ${n.container} (${cfg.image})`);
      return this.spawnImpl({
        dockerArgs,
        containerName: n.container,
        env,
        onKill: (name) => this.teardown(name),
        onStderr: (line) => pushEvent?.({ kind: 'stderr', line }),
      });
    };

    return runSdkSession(spec, {
      options: {
        // The agent's cwd is the mount point, not the host path.
        cwd: WORK_DIR,
        additionalDirectories: [],
        spawnClaudeCodeProcess,
      },
      attach: (push) => {
        pushEvent = push;
        return () => {
          pushEvent = null;
        };
      },
      onCancel: () => this.teardown(n.container),
    });
  }

  /** stop, then kill. Always by container name — see container.spawn.ts. */
  private async teardown(container: string): Promise<void> {
    const stopped = await this.cli.stop(container).catch(() => null);
    if (stopped?.exitCode === 0) return;
    await this.cli.kill(container).catch(() => null);
  }
}
