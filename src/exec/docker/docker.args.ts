import type { DockerConfig } from '../../config/config.schema.js';

import type { GitDirMapping } from './gitdir.resolver.js';

export const WORK_DIR = '/work';
export const GIT_COMMON_DIR = '/gitcommon';
export const AGENT_HOME = '/home/agent';

/** Model credentials, forwarded by NAME so the value never reaches argv. */
export const MODEL_AUTH_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
] as const;

export interface ContainerNames {
  readonly container: string;
  readonly nodeModulesVolume: string;
  readonly claudeVolume: string;
  readonly storeVolume: string;
}

export const names = (runId: string, workspaceId: string): ContainerNames => ({
  container: `aiorch-${runId}`,
  nodeModulesVolume: `aiorch-nm-${workspaceId}`,
  claudeVolume: `aiorch-claude-${workspaceId}`,
  storeVolume: 'aiorch-pnpm-store',
});

export interface RunArgsInput {
  readonly cfg: DockerConfig;
  readonly runId: string;
  readonly taskId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  /** Identifies this daemon boot, so the orphan sweep can tell live from stale. */
  readonly bootId: string;
  readonly worktreeHostPath: string;
  readonly gitDir: GitDirMapping | null;
  /** Names only — values are inherited from the docker client's own environment. */
  readonly envNames: readonly string[];
  /** The CLI command and flags the SDK built for us. */
  readonly command: readonly string[];
}

/**
 * The full `docker run` argv.
 *
 * Deliberate choices, each of which has a test:
 * - **no `-t`**: a TTY echoes and line-wraps, which corrupts the NDJSON control
 *   stream the SDK speaks over stdout.
 * - `--sig-proxy=false`: a Ctrl-C on the orchestrator must not race the SDK's
 *   own graceful interrupt ladder.
 * - secrets as `-e NAME` with no `=value`: docker inherits the value from its
 *   own environment, so it never appears in argv, logs or `docker inspect`.
 * - the Windows source path is passed verbatim in `--mount`; we spawn docker
 *   with `shell: false`, so MSYS never sees it.
 */
export function buildRunArgs(input: RunArgsInput): string[] {
  const { cfg, gitDir } = input;
  const n = names(input.runId, input.workspaceId);
  const args: string[] = [];

  if (cfg.dockerHost) args.push('--host', cfg.dockerHost);

  args.push(
    'run',
    '--rm',
    '-i',
    '--init',
    '--sig-proxy=false',
    '--name',
    n.container,
    '--label',
    `aiorch.run=${input.runId}`,
    '--label',
    `aiorch.task=${input.taskId}`,
    '--label',
    `aiorch.project=${input.projectId}`,
    '--label',
    `aiorch.workspace=${input.workspaceId}`,
    '--label',
    `aiorch.daemon=${input.bootId}`,
    '-w',
    WORK_DIR,
    '--mount',
    `type=bind,source=${input.worktreeHostPath},target=${WORK_DIR}`,
  );

  if (gitDir && cfg.mountGitDir) {
    // Read-write: `git status` refreshes and `git add` writes <gitdir>/index.
    args.push('--mount', `type=bind,source=${gitDir.gitCommonHostDir},target=${GIT_COMMON_DIR}`);
  }

  if (cfg.nodeModulesVolume) {
    // Keeps a Linux node_modules off the bind mount — both a large speed win on
    // Windows and the reason host-built win32 native binaries never appear.
    args.push(
      '--mount',
      `type=volume,source=${n.nodeModulesVolume},target=${WORK_DIR}/node_modules,volume-label=aiorch.workspace=${input.workspaceId}`,
    );
  }
  // The CLI's session JSONL lives here; --resume on attempt 2 needs it back.
  args.push(
    '--mount',
    `type=volume,source=${n.claudeVolume},target=${AGENT_HOME}/.claude,volume-label=aiorch.workspace=${input.workspaceId}`,
  );
  if (cfg.sharedStoreVolume) {
    args.push(
      '--mount',
      `type=volume,source=${n.storeVolume},target=${AGENT_HOME}/.local/share/pnpm/store`,
    );
  }
  for (const m of cfg.extraMounts) args.push('--mount', m);

  args.push(
    '--network',
    cfg.network,
    '--cpus',
    String(cfg.cpus),
    '--memory',
    `${cfg.memoryMb}m`,
    // Equal to --memory: no swap, so a runaway hits the limit instead of thrashing.
    '--memory-swap',
    `${cfg.memoryMb}m`,
    '--pids-limit',
    String(cfg.pidsLimit),
    '--security-opt',
    'no-new-privileges',
    '--cap-drop',
    'ALL',
    '--tmpfs',
    `/tmp:rw,exec,size=${cfg.tmpfsMb}m`,
    '--user',
    cfg.user,
  );

  for (const name of input.envNames) args.push('-e', name);

  args.push(cfg.image, ...input.command);
  return args;
}

export interface ContainerEnvInput {
  /** What the SDK asked the process to run with. */
  readonly sdkEnv: Readonly<Record<string, string | undefined>>;
  readonly extraEnv: Readonly<Record<string, string>>;
  /** The orchestrator's own environment, used only to spot SDK-injected keys. */
  readonly hostEnv: Readonly<Record<string, string | undefined>>;
  readonly gitDir: GitDirMapping | null;
  readonly agentEnvKeys: readonly string[];
}

/**
 * The one place the Docker driver is deliberately STRICTER than local.
 *
 * `LocalDriver` spreads `process.env` because the child needs PATH and the
 * whole host toolchain. A container brings its own, and the host environment is
 * where the board token, the GitHub token and the database path live — none of
 * which the agent has any business seeing. So this is an allowlist, not a
 * filter: only `AGENT_ENV` keys, model auth, the git/home vars we set
 * ourselves, and keys the SDK injected that the host did not have.
 */
export function buildContainerEnv(input: ContainerEnvInput): Record<string, string> {
  const out: Record<string, string> = {};

  const take = (key: string, value: string | undefined): void => {
    if (value !== undefined && value !== '') out[key] = value;
  };

  for (const key of input.agentEnvKeys) take(key, input.sdkEnv[key] ?? input.extraEnv[key]);
  for (const key of MODEL_AUTH_VARS) take(key, input.sdkEnv[key] ?? input.hostEnv[key]);
  for (const [key, value] of Object.entries(input.extraEnv)) take(key, value);

  // Anything the SDK itself added (CLAUDE_CODE_ENTRYPOINT and friends) that did
  // not come from the host: it is about the protocol, not about this machine.
  for (const [key, value] of Object.entries(input.sdkEnv)) {
    if (input.hostEnv[key] === undefined) take(key, value);
  }

  out['HOME'] = AGENT_HOME;
  out['CLAUDE_CONFIG_DIR'] = `${AGENT_HOME}/.claude`;

  if (input.gitDir) {
    out['GIT_DIR'] = input.gitDir.containerGitDir;
    out['GIT_WORK_TREE'] = WORK_DIR;
  }
  // Windows bind mounts surface as uid 0 / 0777, which trips git's dubious
  // ownership check and its mode detection. Fixed by env so no file is written.
  out['GIT_CONFIG_COUNT'] = '2';
  out['GIT_CONFIG_KEY_0'] = 'safe.directory';
  out['GIT_CONFIG_VALUE_0'] = '*';
  out['GIT_CONFIG_KEY_1'] = 'core.fileMode';
  out['GIT_CONFIG_VALUE_1'] = 'false';

  return out;
}
