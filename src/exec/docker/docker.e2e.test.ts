import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { dockerConfigSchema } from '../../config/config.schema.js';
import { DockerExecutor } from '../workspace.executor.js';

import { DockerCli } from './docker.cli.js';
import { resolveGitDir } from './gitdir.resolver.js';

/**
 * The lane the CI suite cannot cover.
 *
 * Everything else about the Docker driver is pure and tested without a daemon:
 * argv, env hygiene, path dialects, event mapping, cleanup logic. None of that
 * proves Docker Desktop will bind-mount a Windows drive, or that a worktree's
 * gitdir link really resolves through `/gitcommon`. That is what this is for.
 *
 *   pnpm test:docker
 */
const enabled = !!process.env['AIORCH_DOCKER_E2E'];
const IMAGE = process.env['AIORCH_DOCKER_IMAGE'] ?? 'ai-orchestrator/agent:latest';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const cfg = dockerConfigSchema.parse({ image: IMAGE, nodeModulesVolume: false });

describe.skipIf(!enabled)('docker driver against a real daemon', () => {
  let base: string;
  let repo: string;
  let wt: string;
  let cli: DockerCli;

  beforeAll(() => {
    cli = new DockerCli();
    base = mkdtempSync(join(tmpdir(), 'docker-e2e-'));
    repo = join(base, 'repo');
    mkdirSync(repo);
    git(base, 'init', '-b', 'main', repo);
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'README.md'), '# demo\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');

    wt = join(base, 'wt');
    git(
      repo,
      '-c',
      'core.autocrlf=false',
      '-c',
      'core.eol=lf',
      'worktree',
      'add',
      '-q',
      '-b',
      'feature',
      wt,
    );
  });

  it('has the image, with a CLI in it', async () => {
    const inspected = await cli.imageInspect(IMAGE);
    expect(inspected.exitCode, `run \`orchestrator image build\` first`).toBe(0);

    const version = await cli.exec(['run', '--rm', IMAGE, 'claude', '--version'], 120_000);
    expect(version.exitCode).toBe(0);
    expect(version.stdout).toMatch(/\d+\.\d+\.\d+/);
  }, 180_000);

  it('can bind-mount the worktree path (the Windows file-sharing trap)', async () => {
    const r = await cli.exec(
      ['run', '--rm', '--mount', `type=bind,source=${wt},target=/probe`, IMAGE, 'ls', '/probe'],
      120_000,
    );
    expect(r.exitCode, r.output).toBe(0);
    expect(r.stdout).toContain('README.md');
  }, 180_000);

  it('resolves the worktree gitdir through /gitcommon, and leaves .git untouched', async () => {
    const before = readFileSync(join(wt, '.git'), 'utf8');
    const exec = new DockerExecutor({
      cfg,
      repoPath: repo,
      workspaceId: 'e2e',
      gitDir: resolveGitDir(wt, repo),
    });

    const branch = await exec.run('git rev-parse --abbrev-ref HEAD', {
      cwd: wt,
      timeoutMs: 120_000,
    });

    expect(branch.exitCode, branch.output).toBe(0);
    expect(branch.stdout.trim()).toBe('feature');
    // The host's link file is read by the publisher moments later; it must not change.
    expect(readFileSync(join(wt, '.git'), 'utf8')).toBe(before);
  }, 180_000);

  it('stages inside the container and the host sees it', async () => {
    writeFileSync(join(wt, 'thing.ts'), 'export const thing = 1;\n');
    const exec = new DockerExecutor({
      cfg,
      repoPath: repo,
      workspaceId: 'e2e',
      gitDir: resolveGitDir(wt, repo),
    });

    const added = await exec.run('git add thing.ts', { cwd: wt, timeoutMs: 120_000 });
    expect(added.exitCode, added.output).toBe(0);

    // The shared index is what makes the host publisher able to commit this.
    expect(git(wt, 'diff', '--cached', '--name-only')).toContain('thing.ts');
  }, 180_000);

  it('runs a command as a non-root user with no network when asked', async () => {
    const exec = new DockerExecutor({
      cfg: dockerConfigSchema.parse({ image: IMAGE, network: 'none', nodeModulesVolume: false }),
      repoPath: repo,
      workspaceId: 'e2e',
      gitDir: null,
    });

    const id = await exec.run('id -u', { cwd: wt, timeoutMs: 120_000 });
    expect(id.stdout.trim()).toBe('1000');
  }, 180_000);

  it('leaves no container behind', async () => {
    const listed = await cli.ps('aiorch.workspace=e2e');
    expect(listed.stdout.trim()).toBe('');
  }, 60_000);
});
