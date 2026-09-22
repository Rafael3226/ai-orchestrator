import { resolve } from 'node:path';

import { type GuardResult, isInside } from './path.guard.js';

/**
 * Bash confinement for an agent working inside a TS/Node worktree.
 *
 * A pure denylist loses (`g=push; git $g`, `node -e "fetch(...)"`), and the
 * legitimate command surface here is small, so the head binary of every
 * pipeline segment is ALLOWLISTED and git verbs are allowlisted on top.
 * Denials are logged; the agent is told to call report_blocked, not to work
 * around them.
 */

const ALLOWED_HEADS: ReadonlySet<string> = new Set([
  // package managers / toolchain
  'pnpm',
  'npm',
  'npx',
  'node',
  'corepack',
  'tsc',
  'tsx',
  'vitest',
  'jest',
  'eslint',
  'prettier',
  'turbo',
  'prisma',
  'next',
  'vite',
  // vcs (verbs filtered below)
  'git',
  // read-only file tooling
  'ls',
  'dir',
  'cat',
  'head',
  'tail',
  'wc',
  'rg',
  'grep',
  'find',
  'sed',
  'awk',
  'cut',
  'sort',
  'uniq',
  'tr',
  'diff',
  'jq',
  'stat',
  'file',
  'which',
  'where',
  'tree',
  'du',
  // basic fs ops (path-confined by cwd; rm -rf outside is denied below)
  'echo',
  'printf',
  'mkdir',
  'cp',
  'mv',
  'rm',
  'touch',
  'true',
  'false',
  'pwd',
  'cd',
  'test',
  'sleep',
  'env',
  'export',
  'set',
  'type',
]);

const GIT_ALLOWED_VERBS: ReadonlySet<string> = new Set([
  'status',
  'diff',
  'log',
  'show',
  'add',
  'restore',
  'stash',
  'blame',
  'rev-parse',
  'ls-files',
  'branch',
  'merge-base',
  'describe',
  'cat-file',
  'grep',
  'check-ignore',
  'rev-list',
  'shortlog',
  'name-rev',
  'symbolic-ref',
]);

const HARD_DENY: readonly { re: RegExp; why: string }[] = [
  { re: /\bgit\s+push\b/i, why: 'git push is done by the orchestrator' },
  { re: /\bgit\s+(remote|fetch|pull|clone)\b/i, why: 'no network git operations' },
  {
    re: /\bgit\s+(commit|merge|rebase|cherry-pick|reset|checkout|switch|tag)\b/i,
    why: 'the orchestrator commits; do not rewrite history',
  },
  { re: /\bgit\s+config\b/i, why: 'git config is read-only for agents' },
  { re: /\bgit\s+worktree\b/i, why: 'worktrees are managed by the orchestrator' },
  { re: /\bgit\s+clean\b/i, why: 'git clean could delete untracked work' },
  { re: /\bgit\s+filter-(branch|repo)\b/i, why: 'history rewriting' },
  { re: /\bgh\b/i, why: 'GitHub CLI is orchestrator-only' },
  { re: /\b(curl|wget|nc|ncat|netcat|ssh|scp|sftp|ftp|telnet)\b/i, why: 'no network tools' },
  {
    re: /\b(docker|podman|kubectl|helm|terraform|aws|az|gcloud)\b/i,
    why: 'no infrastructure tools',
  },
  {
    re: /\b(sudo|doas|runas|shutdown|reboot|schtasks|netsh|reg(\.exe)?)\b/i,
    why: 'privileged command',
  },
  {
    re: /\b(Invoke-WebRequest|Invoke-RestMethod|iwr|irm|Start-Process)\b/i,
    why: 'PowerShell network/process command',
  },
  { re: /\b(npm|pnpm|yarn)\s+(publish|login|adduser|token|owner)\b/i, why: 'registry write' },
  { re: /\b(npm|pnpm|yarn)\s+config\s+set\b/i, why: 'package manager config write' },
  { re: /\bnode\s+(-e|--eval|-p|--print)\b/i, why: 'inline code bypasses the head allowlist' },
  { re: /\bnpx\s+-y\b/i, why: 'npx -y installs arbitrary packages' },
  {
    re: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\s+(\/|~|\.\.|[A-Za-z]:[\\/]?)(\s|$)/i,
    why: 'recursive delete outside worktree',
  },
  { re: /(^|\s)>\s*\/dev\/(tcp|udp)\//i, why: 'bash network redirect' },
  { re: /\$\(|`/, why: 'command substitution is not allowed' },
  { re: /\beval\b/i, why: 'eval' },
];

/**
 * Split on ; && || | and newlines so every segment gets its head checked.
 * Quote-aware: a `|` or `;` inside "..." or '...' (a grep alternation, a sed
 * script) is data, not a pipe — splitting there made `grep -E "a|Tests"` look
 * like a `Tests"` command and denied harmless greps.
 */
export function segments(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      cur += ch;
      if (ch === '\\' && quote === '"' && i + 1 < command.length) cur += command[++i]!;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      cur += ch + command[++i]!;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '\n' || ch === ';' || ch === '|' || ch === '&') {
      const two = command.slice(i, i + 2);
      if (two === '||' || two === '&&') i++;
      else if (ch === '&') {
        // A lone `&` is a background job or a redirect target (2>&1); not a separator.
        cur += ch;
        continue;
      }
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.replace(/\r$/, '').trim()).filter(Boolean);
}

/**
 * Git Bash (MSYS) spells `D:\aow\x` as `/d/aow/x`. Node resolves that against
 * the current drive, so a `cd` into the agent's own worktree looked foreign.
 */
export function fromMsysPath(p: string): string {
  const m = /^\/([A-Za-z])(\/.*)?$/.exec(p);
  return m ? `${m[1]!.toUpperCase()}:${(m[2] ?? '/').replace(/\//g, '\\')}` : p;
}

function headOf(segment: string): { head: string; tokens: string[] } {
  const tokens = segment.split(/\s+/).filter(Boolean);
  // Skip VAR=value prefixes.
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0] ?? '')) tokens.shift();
  const raw = tokens[0] ?? '';
  const head = raw
    .replace(/^["']|["']$/g, '')
    .replace(/^.*[\\/]/, '')
    .replace(/\.(exe|cmd|bat|ps1)$/i, '')
    .toLowerCase();
  return { head, tokens };
}

export function checkBash(root: string, command: string): GuardResult {
  if (!command.trim()) return { ok: false, reason: 'empty command' };
  if (command.length > 4000) return { ok: false, reason: 'command too long' };

  for (const { re, why } of HARD_DENY) {
    if (re.test(command)) return { ok: false, reason: `blocked: ${why}` };
  }

  for (const seg of segments(command)) {
    const { head, tokens } = headOf(seg);
    if (!head) continue;
    if (!ALLOWED_HEADS.has(head)) return { ok: false, reason: `command not allowed: ${head}` };

    if (head === 'git') {
      const verb = tokens.slice(1).find((t) => !t.startsWith('-'));
      if (!verb || !GIT_ALLOWED_VERBS.has(verb)) {
        return { ok: false, reason: `git ${verb ?? '?'} not allowed` };
      }
    }
    if (head === 'cd') {
      let target = tokens[1]?.replace(/^["']|["']$/g, '');
      if (target && process.platform === 'win32') target = fromMsysPath(target);
      if (target && !isInside(root, resolve(root, target))) {
        return { ok: false, reason: 'cd outside worktree' };
      }
    }
  }
  return { ok: true };
}
