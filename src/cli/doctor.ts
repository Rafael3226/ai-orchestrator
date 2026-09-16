import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { loadConfig } from '../config/config.loader.js';
import { resolveBoardCredentials } from '../config/credentials.js';
import { loadOrchestratorEnv, type OrchestratorEnv } from '../config/env.js';

type Status = 'ok' | 'warn' | 'fail';
interface Check {
  readonly name: string;
  readonly status: Status;
  readonly detail: string;
}

const ICON: Record<Status, string> = { ok: '✔', warn: '⚠', fail: '✖' };

function run(cmd: string, args: readonly string[]): string {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  }).trim();
}

function tool(name: string, args: readonly string[], min?: string): Check {
  try {
    const out = run(name, args).split('\n')[0] ?? '';
    const version = /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? out;
    if (min && compareVersions(version, min) < 0) {
      return { name, status: 'fail', detail: `${version} found, need >= ${min}` };
    }
    return { name, status: 'ok', detail: version };
  } catch {
    return { name, status: 'fail', detail: 'not found on PATH' };
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function ghAuth(): Check {
  try {
    run('gh', ['auth', 'status']);
  } catch (e) {
    return {
      name: 'gh auth',
      status: 'fail',
      detail: `not logged in (${String(e).split('\n')[0]})`,
    };
  }
  // Pushes go through git, not gh; the credential helper must be wired.
  try {
    const helper = run('git', ['config', '--global', '--get-regexp', 'credential.*helper']);
    if (!/gh/.test(helper)) {
      return {
        name: 'gh auth',
        status: 'warn',
        detail: 'logged in, but git credential helper is not gh — run `gh auth setup-git`',
      };
    }
  } catch {
    return {
      name: 'gh auth',
      status: 'warn',
      detail: 'logged in, but no git credential helper — run `gh auth setup-git`',
    };
  }
  return { name: 'gh auth', status: 'ok', detail: 'logged in, git credential helper set' };
}

function envCheck(env: OrchestratorEnv): Check[] {
  return [
    {
      name: 'ANTHROPIC_API_KEY',
      status: env.ANTHROPIC_API_KEY ? 'ok' : 'warn',
      detail: env.ANTHROPIC_API_KEY
        ? 'set'
        : 'unset — the Agent SDK will fall back to the local Claude Code login',
    },
  ];
}

function configChecks(env: OrchestratorEnv): Check[] {
  const path = resolve(env.ORCHESTRATOR_CONFIG);
  if (!existsSync(path)) {
    return [
      {
        name: 'config',
        status: 'fail',
        detail: `${path} not found — copy orchestrator.example.yaml to orchestrator.yaml`,
      },
    ];
  }
  const out: Check[] = [];
  let loaded;
  try {
    loaded = loadConfig(path);
  } catch (e) {
    return [{ name: 'config', status: 'fail', detail: (e as Error).message }];
  }
  out.push({
    name: 'config',
    status: loaded.diagnostics.length ? 'warn' : 'ok',
    detail: `${loaded.config.projects.length} project(s), ${loaded.diagnostics.length} warning(s)`,
  });
  for (const d of loaded.diagnostics) {
    out.push({
      name: `  ${d.projectId ?? '-'}`,
      status: 'warn',
      detail: `${d.code}: ${d.message}`,
    });
  }

  try {
    resolveBoardCredentials(loaded.credentialRefs);
    out.push({
      name: 'board credentials',
      status: 'ok',
      detail: [...loaded.credentialRefs.keys()].join(', '),
    });
  } catch (e) {
    out.push({ name: 'board credentials', status: 'fail', detail: (e as Error).message });
  }

  for (const p of loaded.config.projects) {
    const repoOk = existsSync(resolve(p.repo.path, '.git'));
    out.push({
      name: `repo ${p.id}`,
      status: repoOk ? 'ok' : 'fail',
      detail: repoOk ? p.repo.path : `${p.repo.path} is not a git repository`,
    });
    if (repoOk) {
      try {
        run('git', [
          '-C',
          p.repo.path,
          'rev-parse',
          '--verify',
          '--quiet',
          `${p.repo.remote}/${p.repo.baseBranch}`,
        ]);
        out.push({
          name: `  base ${p.repo.remote}/${p.repo.baseBranch}`,
          status: 'ok',
          detail: 'exists',
        });
      } catch {
        out.push({
          name: `  base ${p.repo.remote}/${p.repo.baseBranch}`,
          status: 'warn',
          detail: 'not fetched yet — run `git fetch` in the repo',
        });
      }
    }
  }
  return out;
}

export function runDoctor(): number {
  const checks: Check[] = [
    tool('node', ['--version'], '22.0.0'),
    tool('pnpm', ['--version'], '10.0.0'),
    tool('git', ['--version'], '2.40.0'),
    tool('gh', ['--version'], '2.40.0'),
    tool('claude', ['--version'], '2.1.0'),
    ghAuth(),
  ];

  let env: OrchestratorEnv | undefined;
  try {
    env = loadOrchestratorEnv();
    checks.push({
      name: 'env',
      status: 'ok',
      detail: `config=${env.ORCHESTRATOR_CONFIG} db=${env.ORCHESTRATOR_DB}`,
    });
  } catch (e) {
    checks.push({ name: 'env', status: 'fail', detail: (e as Error).message });
  }
  if (env) {
    checks.push(...envCheck(env), ...configChecks(env));
  }

  const width = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) {
    console.log(`${ICON[c.status]} ${c.name.padEnd(width)}  ${c.detail}`);
  }
  const fails = checks.filter((c) => c.status === 'fail').length;
  console.log(fails ? `\n${fails} check(s) failed.` : '\nAll checks passed.');
  return fails ? 1 : 0;
}
