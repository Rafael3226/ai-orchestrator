/**
 * commitlint — Conventional Commits 1.0.0. This is the executable form of
 * docs/conventions/commits.md; keep the two in sync.
 */
const types = [
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
];

/** Allowed scopes: one per module under src/, plus infra buckets. Empty is allowed. */
const scopes = [
  'config',
  'board',
  'trello',
  'router',
  'queue',
  'exec',
  'policy',
  'mcp',
  'workspace',
  'pipeline',
  'prompt',
  'server',
  'web',
  'cli',
  'docs',
  'infra',
  'ci',
  'deps',
  'repo',
];

const softHeaderLimit = 72;
const softHeaderLengthPlugin = {
  rules: {
    'header-max-length-soft': (parsed) => [
      parsed.header.length <= softHeaderLimit,
      'header should be <= ' + softHeaderLimit + ' characters (hard limit 100)',
    ],
  },
};

export default {
  extends: ['@commitlint/config-conventional'],
  plugins: [softHeaderLengthPlugin],
  rules: {
    'type-enum': [2, 'always', types],
    'scope-enum': [2, 'always', scopes],
    'scope-case': [2, 'always', 'kebab-case'],
    'subject-case': [2, 'never', ['sentence-case', 'start-case', 'pascal-case', 'upper-case']],
    'subject-empty': [2, 'never'],
    'subject-full-stop': [2, 'never', '.'],
    'header-max-length': [2, 'always', 100],
    'header-max-length-soft': [1, 'always'],
    'body-max-line-length': [1, 'always', 100],
  },
};
