import { describe, expect, it } from 'vitest';

import { scanDiffForSecrets, stagedIncludeFiles } from './secret.scanner.js';

const diff = (added: string[]) => ['--- a/x', '+++ b/x', ...added.map((l) => `+${l}`)].join('\n');

describe('scanDiffForSecrets', () => {
  it('flags credential shapes on added lines only', () => {
    const hits = scanDiffForSecrets(
      diff([
        'const k = "sk-ant-api03-' + 'a'.repeat(40) + '"',
        'AKIAABCDEFGHIJKLMNOP',
        '-----BEGIN RSA PRIVATE KEY-----',
      ]),
    );
    expect(hits.map((h) => h.kind)).toEqual(['anthropic-api-key', 'aws-access-key', 'private-key']);
    expect(hits[0]?.preview).not.toContain('a'.repeat(40));
  });

  it('ignores removed lines and placeholders', () => {
    const text = [
      '--- a/x',
      '+++ b/x',
      '-AKIAABCDEFGHIJKLMNOP',
      '+ANTHROPIC_API_KEY=your-key-here',
      '+token: "xxxxxxxxxxxxxxxx"',
    ].join('\n');
    expect(scanDiffForSecrets(text)).toEqual([]);
  });
});

describe('stagedIncludeFiles', () => {
  it('matches copied env files case- and separator-insensitively', () => {
    expect(stagedIncludeFiles(['apps/api/.env', 'src/a.ts'], ['apps\\api\\.ENV'])).toEqual([
      'apps/api/.env',
    ]);
  });
});
