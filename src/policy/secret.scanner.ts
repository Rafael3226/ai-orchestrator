export interface SecretHit {
  readonly kind: string;
  readonly line: number;
  readonly preview: string;
}

const PATTERNS: readonly { kind: string; re: RegExp }[] = [
  { kind: 'anthropic-api-key', re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { kind: 'openai-api-key', re: /sk-[A-Za-z0-9]{32,}/ },
  { kind: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: 'github-token', re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/ },
  { kind: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/ },
  { kind: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: 'trello-token', re: /\bATTA[0-9a-f]{60,}\b/ },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  {
    kind: 'generic-secret-assignment',
    re: /\b(password|passwd|secret|api[_-]?key|token)\b\s*[:=]\s*["'][^"'\s]{12,}["']/i,
  },
];

const ALLOWLIST = [/\.example$/i, /example\./i, /placeholder/i, /your[-_]?/i, /xxxx/i, /changeme/i];

/**
 * Scan a unified diff (added lines only) for credential shapes. Cheap, noisy
 * on purpose: a false positive costs a manual look; a false negative pushes a
 * key to GitHub.
 */
export function scanDiffForSecrets(unifiedDiff: string): SecretHit[] {
  const hits: SecretHit[] = [];
  let lineNo = 0;
  for (const line of unifiedDiff.split(/\r?\n/)) {
    lineNo++;
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const body = line.slice(1);
    if (ALLOWLIST.some((re) => re.test(body))) continue;
    for (const { kind, re } of PATTERNS) {
      const m = re.exec(body);
      if (m) {
        const secret = m[0];
        const preview = body
          .replace(secret, secret.slice(0, 6) + '…' + secret.slice(-3))
          .slice(0, 120);
        hits.push({ kind, line: lineNo, preview });
        break;
      }
    }
  }
  return hits;
}

/** Any staged path that was copied in from the include manifest is a leak. */
export function stagedIncludeFiles(
  stagedPaths: readonly string[],
  includeManifest: readonly string[],
): string[] {
  const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
  const copied = new Set(includeManifest.map(norm));
  return stagedPaths.filter((p) => copied.has(norm(p)));
}
