import type { Role } from '../config/config.schema.js';

/** Where a role's work lands. `board-only` never touches git. */
export type DeliveryKind = 'pull-request' | 'board-only';

export interface DeliveryPolicy {
  readonly kind: DeliveryKind;
  /**
   * `required`  — an empty diff is a failure (the original DEV behaviour).
   * `optional`  — an empty diff finishes clean, reporting to the board instead.
   * `forbidden` — never stage, never commit.
   */
  readonly diff: 'required' | 'optional' | 'forbidden';
  /** Which project check runs after the agent. `null` means none. */
  readonly verifyWith: 'test' | 'infra' | null;
  /** Run `checks.install` when preparing the worktree. */
  readonly install: boolean;
  /** `propose_summary` must carry a `commit` object. */
  readonly requireCommit: boolean;
  /** Repo-relative globs the agent may write. Empty means the whole worktree. */
  readonly writeGlobs: readonly string[];
}

/** A role whose deliverable is the board itself: a story, an estimate. */
const BOARD_ONLY: DeliveryPolicy = {
  kind: 'board-only',
  diff: 'forbidden',
  verifyWith: null,
  install: false,
  requireCommit: false,
  writeGlobs: [],
};

/**
 * What each role actually *does differently*, in one table.
 *
 * Before this existed the pipeline hardcoded a code-producing outcome in four
 * places, so a PM that wrote a perfect spec and a QA that found nothing to fix
 * both ended as `failed` with `nothing-to-commit`. The interesting rows:
 *
 * - **BA** and **PM** are `board-only`: no install, no verify, no branch, no PR.
 *   What they produce lands on the board — stories, estimates, decisions.
 * - **QA** is `diff: 'optional'`: wrote tests → an ordinary draft PR; found only
 *   issues → no commit and no PR, with the findings posted to the card. That one
 *   field is the whole mechanism.
 */
export const ROLE_DELIVERY: Readonly<Record<Role, DeliveryPolicy>> = {
  BA: BOARD_ONLY,
  PM: BOARD_ONLY,
  DEV: {
    kind: 'pull-request',
    diff: 'required',
    verifyWith: 'test',
    install: true,
    requireCommit: true,
    writeGlobs: [],
  },
  DEVOPS: {
    kind: 'pull-request',
    diff: 'required',
    // Falls back to `checks.test` when the project declares no `infra` check.
    verifyWith: 'infra',
    install: true,
    requireCommit: true,
    writeGlobs: [
      '.github/**',
      '.azuredevops/**',
      'azure-pipelines*.yml',
      'azure-pipelines*.yaml',
      'Dockerfile*',
      'docker/**',
      'docker-compose*',
      'compose*.yml',
      'compose*.yaml',
      '.dockerignore',
      'infra/**',
      'deploy/**',
      'scripts/**',
      'Makefile',
      '*.config.*',
      'docs/ops/**',
    ],
  },
  QA: {
    kind: 'pull-request',
    diff: 'optional',
    verifyWith: 'test',
    install: true,
    requireCommit: true,
    writeGlobs: [
      '**/*.test.*',
      '**/*.spec.*',
      '**/*.e2e.*',
      '**/*Tests/**',
      '**/*.Tests/**',
      'test/**',
      'tests/**',
      'e2e/**',
      '__tests__/**',
      'playwright.config.*',
      'docs/qa/**',
    ],
  },
};
