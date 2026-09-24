import type { DockerConfig } from '../config/config.schema.js';
import { runCommand, type CommandResult } from '../process/command.runner.js';

import { AGENT_HOME, GIT_COMMON_DIR, WORK_DIR } from './docker/docker.args.js';
import type { GitDirMapping } from './docker/gitdir.resolver.js';

export interface WorkspaceRunOptions {
  /** Host path of the worktree. A container executor mounts it. */
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly tailBytes?: number;
  readonly onLine?: (stream: 'stdout' | 'stderr', line: string) => void;
}

/**
 * Where the orchestrator's OWN commands run against a workspace — dependency
 * install, the verification command, and the target repo's commitlint.
 *
 * Under the docker driver these must move into the container, and not for
 * speed: a host `pnpm install` produces win32 native binaries (better-sqlite3,
 * esbuild) that a Linux container cannot load, so a host install followed by a
 * container test run fails in a thoroughly confusing way.
 */
export interface WorkspaceExecutor {
  run(command: string, opts: WorkspaceRunOptions): Promise<CommandResult>;
}

/** Byte-for-byte today's behaviour. */
export class HostExecutor implements WorkspaceExecutor {
  constructor(private readonly runImpl = runCommand) {}

  run(command: string, opts: WorkspaceRunOptions): Promise<CommandResult> {
    return this.runImpl(command, [], {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
      shell: true,
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.tailBytes !== undefined ? { tailBytes: opts.tailBytes } : {}),
      ...(opts.onLine ? { onLine: opts.onLine } : {}),
    });
  }
}

export interface DockerExecutorOptions {
  readonly cfg: DockerConfig;
  readonly repoPath: string;
  readonly workspaceId: string;
  readonly gitDir: GitDirMapping | null;
  /** Injected in tests. */
  readonly runImpl?: typeof runCommand;
}

/**
 * The same mount, env and limit recipe as `DockerDriver`, in a one-shot
 * container. Deliberately a separate `docker run --rm` rather than an exec into
 * the agent's container: install and verify happen before and after the agent
 * runs, when no container exists.
 */
export class DockerExecutor implements WorkspaceExecutor {
  constructor(private readonly opts: DockerExecutorOptions) {}

  buildArgs(command: string, cwd: string): string[] {
    const { cfg, gitDir, workspaceId } = this.opts;
    const args: string[] = [];
    if (cfg.dockerHost) args.push('--host', cfg.dockerHost);
    args.push(
      'run',
      '--rm',
      '--label',
      `aiorch.workspace=${workspaceId}`,
      '-w',
      WORK_DIR,
      '--mount',
      `type=bind,source=${cwd},target=${WORK_DIR}`,
    );
    if (gitDir && cfg.mountGitDir) {
      args.push('--mount', `type=bind,source=${gitDir.gitCommonHostDir},target=${GIT_COMMON_DIR}`);
    }
    if (cfg.nodeModulesVolume) {
      args.push(
        '--mount',
        `type=volume,source=aiorch-nm-${workspaceId},target=${WORK_DIR}/node_modules,volume-label=aiorch.workspace=${workspaceId}`,
      );
    }
    if (cfg.sharedStoreVolume) {
      args.push(
        '--mount',
        `type=volume,source=aiorch-pnpm-store,target=${AGENT_HOME}/.local/share/pnpm/store`,
      );
    }
    args.push(
      '--network',
      cfg.network,
      '--cpus',
      String(cfg.cpus),
      '--memory',
      `${cfg.memoryMb}m`,
      '--pids-limit',
      String(cfg.pidsLimit),
      '--security-opt',
      'no-new-privileges',
      '--cap-drop',
      'ALL',
      '--user',
      cfg.user,
      '-e',
      `HOME=${AGENT_HOME}`,
      '-e',
      'CI=1',
      '-e',
      'GIT_CONFIG_COUNT=2',
      '-e',
      'GIT_CONFIG_KEY_0=safe.directory',
      '-e',
      'GIT_CONFIG_VALUE_0=*',
      '-e',
      'GIT_CONFIG_KEY_1=core.fileMode',
      '-e',
      'GIT_CONFIG_VALUE_1=false',
    );
    if (gitDir) {
      args.push('-e', `GIT_DIR=${gitDir.containerGitDir}`, '-e', `GIT_WORK_TREE=${WORK_DIR}`);
    }
    args.push(cfg.image, 'sh', '-lc', command);
    return args;
  }

  run(command: string, opts: WorkspaceRunOptions): Promise<CommandResult> {
    const run = this.opts.runImpl ?? runCommand;
    return run('docker', this.buildArgs(command, opts.cwd), {
      cwd: this.opts.repoPath,
      timeoutMs: opts.timeoutMs,
      shell: false,
      env: { ...opts.env, MSYS2_ARG_CONV_EXCL: '*' },
      ...(opts.tailBytes !== undefined ? { tailBytes: opts.tailBytes } : {}),
      ...(opts.onLine ? { onLine: opts.onLine } : {}),
    });
  }
}
