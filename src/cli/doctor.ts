import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { loadConfig, type LoadedConfig } from '../config/config.loader.js';
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
    out.push(prLabelsCheck(p.repo.githubRepo, p.pr.labels));
  }
  return out;
}

/**
 * `gh pr create --label` fails for a label the repo does not have, and the
 * publisher then opens the PR unlabelled. Catch that here, before a live run.
 */
function prLabelsCheck(githubRepo: string, wanted: readonly string[]): Check {
  const name = `  pr labels ${githubRepo}`;
  if (wanted.length === 0) return { name, status: 'ok', detail: 'none configured' };
  let existing: string[];
  try {
    const raw = run('gh', [
      'label',
      'list',
      '--repo',
      githubRepo,
      '--json',
      'name',
      '--limit',
      '200',
    ]);
    existing = (JSON.parse(raw || '[]') as { name: string }[]).map((l) => l.name.toLowerCase());
  } catch (e) {
    return { name, status: 'warn', detail: `could not list labels (${String(e).split('\n')[0]})` };
  }
  const missing = wanted.filter((l) => !existing.includes(l.toLowerCase()));
  if (missing.length === 0) return { name, status: 'ok', detail: wanted.join(', ') };
  return {
    name,
    status: 'warn',
    detail: `missing on the repo: ${missing.join(', ')} — create them with \`gh label create <name> --repo ${githubRepo}\` or PRs will be opened unlabelled`,
  };
}

/**
 * Webhook plumbing fails in ways that are invisible until a card is dropped:
 * the wrong one of three Trello credentials, an http URL Trello refuses, or a
 * tunnel that is simply not up. Catch all of it here, before a live run.
 */
async function webhookChecks(env: OrchestratorEnv, loaded: LoadedConfig): Promise<Check[]> {
  const enabled = loaded.config.projects.filter((p) => p.enabled && p.board.webhook.enabled);
  if (enabled.length === 0) {
    return [{ name: 'webhooks', status: 'ok', detail: 'not enabled — polling only' }];
  }

  const out: Check[] = [
    {
      name: 'webhooks',
      status: 'ok',
      detail: `enabled for ${enabled.map((p) => p.id).join(', ')}`,
    },
  ];

  for (const p of enabled) {
    const ref = p.board.credentials;
    const secret = process.env[`${ref}_API_SECRET`];
    out.push({
      name: `  ${ref}_API_SECRET`,
      status: secret ? 'ok' : 'fail',
      detail: secret
        ? 'set'
        : 'missing — the OAuth secret next to your API key at https://trello.com/power-ups/admin ' +
          '(neither the API key nor the token)',
    });
  }

  const publicUrl = env.ORCHESTRATOR_WEBHOOK_PUBLIC_URL;
  if (!publicUrl) {
    out.push({
      name: '  public url',
      status: 'fail',
      detail: 'ORCHESTRATOR_WEBHOOK_PUBLIC_URL is not set — see docs/webhooks.md',
    });
  } else if (!publicUrl.startsWith('https://')) {
    out.push({
      name: '  public url',
      status: 'fail',
      detail: `must be https (Trello refuses http and localhost); got ${publicUrl}`,
    });
  } else {
    out.push({ name: '  public url', status: 'ok', detail: publicUrl });
    // The tunnel may legitimately not be running yet, so this is a warning.
    const probe = `${publicUrl.replace(/\/+$/, '')}${env.ORCHESTRATOR_WEBHOOK_PATH_PREFIX}/healthz`;
    try {
      const res = await fetch(probe, { signal: AbortSignal.timeout(5000) });
      out.push({
        name: '  tunnel',
        status: res.ok ? 'ok' : 'warn',
        detail: res.ok ? `reaches the daemon (${probe})` : `${probe} → ${res.status}`,
      });
    } catch (e) {
      out.push({
        name: '  tunnel',
        status: 'warn',
        detail: `cannot reach ${probe} (${e instanceof Error ? e.message : String(e)}) — is the daemon and the tunnel up?`,
      });
    }
  }

  out.push({
    name: '  path secret',
    status: env.ORCHESTRATOR_WEBHOOK_PATH_SECRET ? 'ok' : 'fail',
    detail: env.ORCHESTRATOR_WEBHOOK_PATH_SECRET
      ? 'set'
      : 'ORCHESTRATOR_WEBHOOK_PATH_SECRET is not set',
  });

  return out;
}

/**
 * Docker checks. Every one of these is a failure that would otherwise only
 * surface mid-run: no daemon, Windows-container mode, a worktreeRoot Docker
 * Desktop will not share, or an image whose CLI cannot talk to our SDK.
 */
async function dockerChecks(env: OrchestratorEnv, loaded: LoadedConfig): Promise<Check[]> {
  const containerized = loaded.config.projects.filter(
    (p) =>
      p.enabled && Object.values(p.agents).some((a) => a.enabled && a.exec.driver === 'docker'),
  );
  if (containerized.length === 0) {
    return [{ name: 'docker', status: 'ok', detail: 'not used — every role runs locally' }];
  }

  const { DockerCli } = await import('../exec/docker/docker.cli.js');
  const { sdkBundledCliVersion } = await import('./image.js');
  const cli = new DockerCli();
  const out: Check[] = [];

  const version = await cli.version().catch(() => null);
  if (!version || version.exitCode !== 0) {
    out.push({
      name: 'docker',
      status: 'fail',
      detail: 'daemon not reachable — start Docker Desktop (WSL2 backend)',
    });
    return out;
  }
  out.push({
    name: 'docker',
    status: 'ok',
    detail: `used by ${containerized.map((p) => p.id).join(', ')}`,
  });

  const info = await cli.info();
  const linux = /"OSType"\s*:\s*"linux"/.test(info.stdout);
  out.push({
    name: '  containers',
    status: linux ? 'ok' : 'fail',
    detail: linux ? 'linux' : 'daemon is in Windows-container mode — the agent image cannot run',
  });

  const expected = sdkBundledCliVersion();
  const images = new Set(
    containerized.flatMap((p) =>
      Object.values(p.agents)
        .filter((a) => a.enabled && a.exec.driver === 'docker')
        .map((a) => a.exec.docker.image),
    ),
  );
  for (const image of images) {
    const inspected = await cli.imageInspect(image);
    if (inspected.exitCode !== 0) {
      out.push({
        name: `  image ${image}`,
        status: 'fail',
        detail: 'not present — run `orchestrator image build`',
      });
      continue;
    }
    const labelled = /"org\.aiorch\.cli-version"\s*:\s*"([^"]+)"/.exec(inspected.stdout)?.[1];
    const drift = expected && labelled && labelled !== expected;
    out.push({
      name: `  image ${image}`,
      status: drift ? 'warn' : 'ok',
      detail: drift
        ? `CLI ${labelled} but the SDK bundles ${expected} — rebuild if runs stall after init`
        : `CLI ${labelled ?? 'unlabelled'}`,
    });
  }

  // The real Windows trap: a drive Docker Desktop will not share.
  for (const p of containerized) {
    const root = resolve(p.repo.worktreeRoot);
    const probe = await cli.exec(
      ['run', '--rm', '--mount', `type=bind,source=${root},target=/probe`, 'alpine', 'true'],
      60_000,
    );
    out.push({
      name: `  mount ${p.id}`,
      status: probe.exitCode === 0 ? 'ok' : 'warn',
      detail:
        probe.exitCode === 0
          ? `${root} is bind-mountable`
          : `could not bind-mount ${root} — check Docker Desktop file sharing (${probe.output.slice(-160).trim()})`,
    });
  }

  if (!env.ANTHROPIC_API_KEY && !process.env['CLAUDE_CODE_OAUTH_TOKEN']) {
    out.push({
      name: '  model auth',
      status: 'fail',
      detail:
        'containers get no host environment — set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN',
    });
  }
  return out;
}

export async function runDoctor(): Promise<number> {
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
    try {
      const loaded = loadConfig(resolve(env.ORCHESTRATOR_CONFIG));
      checks.push(...(await webhookChecks(env, loaded)));
      checks.push(...(await dockerChecks(env, loaded)));
    } catch {
      // configChecks already reported why the config could not load.
    }
  }

  const width = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) {
    console.log(`${ICON[c.status]} ${c.name.padEnd(width)}  ${c.detail}`);
  }
  const fails = checks.filter((c) => c.status === 'fail').length;
  console.log(fails ? `\n${fails} check(s) failed.` : '\nAll checks passed.');
  return fails ? 1 : 0;
}
