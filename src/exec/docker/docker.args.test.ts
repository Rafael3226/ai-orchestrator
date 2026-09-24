import { describe, expect, it } from 'vitest';

import { dockerConfigSchema, type DockerConfig } from '../../config/config.schema.js';
import { AGENT_ENV } from '../../policy/tool.policy.js';

import {
  buildContainerEnv,
  buildRunArgs,
  GIT_COMMON_DIR,
  MODEL_AUTH_VARS,
  names,
  WORK_DIR,
  type RunArgsInput,
} from './docker.args.js';
import type { GitDirMapping } from './gitdir.resolver.js';

const cfg = (over: Partial<DockerConfig> = {}): DockerConfig => ({
  ...dockerConfigSchema.parse({}),
  ...over,
});

const gitDir: GitDirMapping = {
  gitCommonHostDir: 'D:\\Repos\\GitHub\\demo\\.git',
  containerGitDir: '/gitcommon/worktrees/42-add-a-thing',
  worktreeName: '42-add-a-thing',
};

const input = (over: Partial<RunArgsInput> = {}): RunArgsInput => ({
  cfg: cfg(),
  runId: 'run-1',
  taskId: 'task-1',
  projectId: 'demo',
  workspaceId: 'ws-1',
  bootId: 'boot-1',
  worktreeHostPath: 'D:\\aow\\demo\\42-add-a-thing',
  gitDir,
  envNames: ['ANTHROPIC_API_KEY', 'CI'],
  command: ['claude', '--output-format', 'stream-json'],
  ...over,
});

/** `--mount a,--mount b` → ['a','b'] */
const mounts = (args: readonly string[]): string[] =>
  args.flatMap((a, i) => (args[i - 1] === '--mount' ? [a] : []));

const flag = (args: readonly string[], name: string): string | undefined =>
  args[args.indexOf(name) + 1];

describe('buildRunArgs', () => {
  it('keeps the Windows source path verbatim in the bind mount', () => {
    // We spawn docker with shell:false, so MSYS never sees this.
    const args = buildRunArgs(input());
    expect(mounts(args)).toContain(
      `type=bind,source=D:\\aow\\demo\\42-add-a-thing,target=${WORK_DIR}`,
    );
  });

  it('mounts the parent .git so the worktree gitdir link resolves', () => {
    const args = buildRunArgs(input());
    expect(mounts(args)).toContain(
      `type=bind,source=D:\\Repos\\GitHub\\demo\\.git,target=${GIT_COMMON_DIR}`,
    );
  });

  it('omits /gitcommon for a plain clone', () => {
    const args = buildRunArgs(input({ gitDir: null }));
    expect(args.join(' ')).not.toContain(GIT_COMMON_DIR);
  });

  it('omits /gitcommon when the operator turned it off', () => {
    const args = buildRunArgs(input({ cfg: cfg({ mountGitDir: false }) }));
    expect(args.join(' ')).not.toContain(GIT_COMMON_DIR);
  });

  it('never allocates a TTY, which would corrupt the NDJSON control stream', () => {
    const args = buildRunArgs(input());
    expect(args).toContain('-i');
    expect(args).not.toContain('-t');
    expect(args).not.toContain('--tty');
  });

  it('runs detached from host signals and cleans itself up', () => {
    const args = buildRunArgs(input());
    expect(args).toContain('--rm');
    expect(args).toContain('--init');
    expect(args).toContain('--sig-proxy=false');
  });

  it('labels every container for the orphan sweep', () => {
    const args = buildRunArgs(input());
    const labels = args.flatMap((a, i) => (args[i - 1] === '--label' ? [a] : []));
    expect(labels).toEqual([
      'aiorch.run=run-1',
      'aiorch.task=task-1',
      'aiorch.project=demo',
      'aiorch.workspace=ws-1',
      'aiorch.daemon=boot-1',
    ]);
  });

  it('applies the resource limits and drops privileges', () => {
    const args = buildRunArgs(input({ cfg: cfg({ cpus: 4, memoryMb: 8192, pidsLimit: 256 }) }));
    expect(flag(args, '--cpus')).toBe('4');
    expect(flag(args, '--memory')).toBe('8192m');
    // Equal to --memory: no swap, so a runaway hits the limit rather than thrashing.
    expect(flag(args, '--memory-swap')).toBe('8192m');
    expect(flag(args, '--pids-limit')).toBe('256');
    expect(flag(args, '--security-opt')).toBe('no-new-privileges');
    expect(flag(args, '--cap-drop')).toBe('ALL');
    expect(flag(args, '--user')).toBe('1000:1000');
  });

  it('honours a per-role image override and a private network', () => {
    const args = buildRunArgs(
      input({ cfg: cfg({ image: 'ai-orchestrator/agent-fe:3', network: 'none' }) }),
    );
    expect(flag(args, '--network')).toBe('none');
    expect(args).toContain('ai-orchestrator/agent-fe:3');
  });

  it('passes secrets by NAME only, so no value reaches argv', () => {
    const args = buildRunArgs(input({ envNames: ['ANTHROPIC_API_KEY'] }));
    const i = args.indexOf('-e');
    expect(args[i + 1]).toBe('ANTHROPIC_API_KEY');
    expect(args.join(' ')).not.toContain('=sk-');
    expect(args.some((a) => a.startsWith('ANTHROPIC_API_KEY='))).toBe(false);
  });

  it('puts node_modules and the session dir on per-workspace volumes', () => {
    const n = names('run-1', 'ws-1');
    const m = mounts(buildRunArgs(input()));
    expect(m.some((x) => x.includes(n.nodeModulesVolume) && x.includes('/work/node_modules'))).toBe(
      true,
    );
    expect(m.some((x) => x.includes(n.claudeVolume))).toBe(true);
    expect(m.some((x) => x.includes(n.storeVolume))).toBe(true);
  });

  it('drops the node_modules volume for a workspace-style monorepo', () => {
    const m = mounts(buildRunArgs(input({ cfg: cfg({ nodeModulesVolume: false }) })));
    expect(m.some((x) => x.includes('/work/node_modules'))).toBe(false);
  });

  it('puts the image and the SDK-built command last, in that order', () => {
    const args = buildRunArgs(input());
    const image = args.indexOf(cfg().image);
    expect(image).toBeGreaterThan(0);
    expect(args.slice(image + 1)).toEqual(['claude', '--output-format', 'stream-json']);
  });

  it('threads a DOCKER_HOST override to the front', () => {
    const args = buildRunArgs(input({ cfg: cfg({ dockerHost: 'tcp://10.0.0.5:2375' }) }));
    expect(args.slice(0, 3)).toEqual(['--host', 'tcp://10.0.0.5:2375', 'run']);
  });
});

describe('buildContainerEnv', () => {
  const base = {
    extraEnv: AGENT_ENV,
    hostEnv: {
      AIORCH_SENTINEL: 'must-not-escape',
      TRELLO_MAIN_TOKEN: 'secret-token',
      GH_TOKEN: 'gh-secret',
      ANTHROPIC_API_KEY: 'sk-test',
      PATH: '/host/bin',
    },
    gitDir,
    agentEnvKeys: Object.keys(AGENT_ENV),
  };

  it('never forwards the host environment wholesale', () => {
    const env = buildContainerEnv({ ...base, sdkEnv: { ...base.hostEnv } });

    // The whole point: board tokens, gh tokens and host PATH stay behind.
    expect(env['AIORCH_SENTINEL']).toBeUndefined();
    expect(env['TRELLO_MAIN_TOKEN']).toBeUndefined();
    expect(env['GH_TOKEN']).toBeUndefined();
    expect(env['PATH']).toBeUndefined();
  });

  it('forwards the model credential', () => {
    const env = buildContainerEnv({ ...base, sdkEnv: { ANTHROPIC_API_KEY: 'sk-test' } });
    expect(env['ANTHROPIC_API_KEY']).toBe('sk-test');
  });

  it.each(MODEL_AUTH_VARS)('forwards %s when it is set', (name) => {
    const env = buildContainerEnv({ ...base, sdkEnv: { [name]: 'v' } });
    expect(env[name]).toBe('v');
  });

  it('carries the full agent hardening set', () => {
    const env = buildContainerEnv({ ...base, sdkEnv: {} });
    for (const [k, v] of Object.entries(AGENT_ENV)) expect(env[k]).toBe(v);
  });

  it('keeps keys the SDK injected that the host did not have', () => {
    const env = buildContainerEnv({
      ...base,
      sdkEnv: { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' },
    });
    expect(env['CLAUDE_CODE_ENTRYPOINT']).toBe('sdk-ts');
  });

  it('pins git so the worktree resolves and Windows ownership does not trip it', () => {
    const env = buildContainerEnv({ ...base, sdkEnv: {} });
    expect(env['GIT_DIR']).toBe('/gitcommon/worktrees/42-add-a-thing');
    expect(env['GIT_WORK_TREE']).toBe(WORK_DIR);
    expect(env['GIT_CONFIG_COUNT']).toBe('2');
    expect(env['GIT_CONFIG_KEY_0']).toBe('safe.directory');
    expect(env['GIT_CONFIG_VALUE_0']).toBe('*');
    expect(env['GIT_CONFIG_KEY_1']).toBe('core.fileMode');
  });

  it('sets no GIT_DIR for a plain clone', () => {
    const env = buildContainerEnv({ ...base, sdkEnv: {}, gitDir: null });
    expect(env['GIT_DIR']).toBeUndefined();
    expect(env['GIT_WORK_TREE']).toBeUndefined();
  });

  it('points HOME and the session dir at the container user', () => {
    const env = buildContainerEnv({ ...base, sdkEnv: {} });
    expect(env['HOME']).toBe('/home/agent');
    expect(env['CLAUDE_CONFIG_DIR']).toBe('/home/agent/.claude');
  });

  it('drops empty values rather than forwarding blanks', () => {
    const env = buildContainerEnv({ ...base, sdkEnv: { ANTHROPIC_BASE_URL: '' } });
    expect('ANTHROPIC_BASE_URL' in env).toBe(false);
  });
});
