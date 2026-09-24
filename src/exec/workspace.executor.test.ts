import { describe, expect, it, vi } from 'vitest';

import { dockerConfigSchema, type DockerConfig } from '../config/config.schema.js';
import type { CommandOptions, CommandResult } from '../process/command.runner.js';

import { GIT_COMMON_DIR, WORK_DIR } from './docker/docker.args.js';
import type { GitDirMapping } from './docker/gitdir.resolver.js';
import { DockerExecutor, HostExecutor } from './workspace.executor.js';

const ok = (): CommandResult => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  durationMs: 1,
  output: '',
  stdout: '',
});

const cfg = (over: Partial<DockerConfig> = {}): DockerConfig => ({
  ...dockerConfigSchema.parse({}),
  ...over,
});

const gitDir: GitDirMapping = {
  gitCommonHostDir: 'D:\\Repos\\demo\\.git',
  containerGitDir: '/gitcommon/worktrees/wt-1',
  worktreeName: 'wt-1',
};

function spyRunner() {
  const calls: { command: string; args: readonly string[]; opts: CommandOptions }[] = [];
  const run = vi.fn(async (command: string, args: readonly string[], opts: CommandOptions) => {
    calls.push({ command, args, opts });
    return ok();
  });
  return { calls, run: run as never };
}

describe('HostExecutor', () => {
  it('runs the command through the shell, in the worktree, unchanged', async () => {
    const { calls, run } = spyRunner();

    await new HostExecutor(run).run('pnpm test', {
      cwd: 'D:\\aow\\wt',
      timeoutMs: 1000,
      env: { CI: '1' },
      tailBytes: 4096,
    });

    expect(calls[0]?.command).toBe('pnpm test');
    expect(calls[0]?.opts).toMatchObject({
      cwd: 'D:\\aow\\wt',
      shell: true,
      timeoutMs: 1000,
      tailBytes: 4096,
    });
  });
});

describe('DockerExecutor', () => {
  const make = (over: Partial<DockerConfig> = {}, gd: GitDirMapping | null = gitDir) =>
    new DockerExecutor({
      cfg: cfg(over),
      repoPath: 'D:\\Repos\\demo',
      workspaceId: 'wt-1',
      gitDir: gd,
    });

  it('runs the command under sh -lc inside the image', () => {
    const args = make().buildArgs('pnpm install', 'D:\\aow\\wt');
    expect(args.slice(-3)).toEqual(['sh', '-lc', 'pnpm install']);
    expect(args).toContain(cfg().image);
  });

  it('mounts the worktree at /work with the host path verbatim', () => {
    const args = make().buildArgs('pnpm test', 'D:\\aow\\wt');
    expect(args).toContain(`type=bind,source=D:\\aow\\wt,target=${WORK_DIR}`);
    expect(args[args.indexOf('-w') + 1]).toBe(WORK_DIR);
  });

  it('mounts the parent .git and pins GIT_DIR so git works in the worktree', () => {
    const args = make().buildArgs('git status', 'D:\\aow\\wt');
    expect(args).toContain(`type=bind,source=D:\\Repos\\demo\\.git,target=${GIT_COMMON_DIR}`);
    expect(args).toContain('GIT_DIR=/gitcommon/worktrees/wt-1');
    expect(args).toContain(`GIT_WORK_TREE=${WORK_DIR}`);
  });

  it('omits the git mount and GIT_DIR for a plain clone', () => {
    const args = make({}, null).buildArgs('pnpm test', 'D:\\aow\\wt');
    expect(args.join(' ')).not.toContain(GIT_COMMON_DIR);
    expect(args.some((a) => a.startsWith('GIT_DIR='))).toBe(false);
  });

  it('shares the node_modules volume with the agent container', () => {
    // Same volume name as docker.args.names(), so install and run agree.
    const args = make().buildArgs('pnpm install', 'D:\\aow\\wt');
    expect(args.some((a) => a.includes('source=aiorch-nm-wt-1'))).toBe(true);
  });

  it('silences git ownership and file-mode complaints without writing a config', () => {
    const args = make().buildArgs('git status', 'D:\\aow\\wt');
    expect(args).toContain('GIT_CONFIG_KEY_0=safe.directory');
    expect(args).toContain('GIT_CONFIG_VALUE_0=*');
    expect(args).toContain('GIT_CONFIG_KEY_1=core.fileMode');
  });

  it('drops privileges and applies the limits, like the agent container', () => {
    const args = make({ memoryMb: 8192 }).buildArgs('pnpm test', 'D:\\aow\\wt');
    expect(args).toContain('--rm');
    expect(args).toContain('no-new-privileges');
    expect(args).toContain('ALL');
    expect(args[args.indexOf('--memory') + 1]).toBe('8192m');
  });

  it('spawns docker without a shell, so MSYS never rewrites a mount path', async () => {
    const { calls, run } = spyRunner();
    const exec = new DockerExecutor({
      cfg: cfg(),
      repoPath: 'D:\\Repos\\demo',
      workspaceId: 'wt-1',
      gitDir,
      runImpl: run,
    });

    await exec.run('pnpm test', { cwd: 'D:\\aow\\wt', timeoutMs: 5000 });

    expect(calls[0]?.command).toBe('docker');
    expect(calls[0]?.opts.shell).toBe(false);
    expect(calls[0]?.opts.env?.['MSYS2_ARG_CONV_EXCL']).toBe('*');
  });
});
