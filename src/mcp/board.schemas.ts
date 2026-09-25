import { z } from 'zod';

import { PRIORITIES, WORK_ITEM_TYPES } from '../board/board.types.js';
import { HAND_TARGETS } from '../config/config.schema.js';

export const PHASES = [
  'exploring',
  'planning',
  'implementing',
  'testing',
  'reviewing',
  'wrapping-up',
] as const;
export type Phase = (typeof PHASES)[number];

export const reportProgressShape = {
  phase: z.enum(PHASES),
  message: z.string().min(1).max(500),
  percent: z.number().int().min(0).max(100).optional(),
} as const;

export const BLOCKED_CATEGORIES = [
  'missing-info',
  'ambiguous-requirements',
  'external-dependency',
  'permission-denied',
  'broken-baseline',
  'out-of-scope',
] as const;

export const reportBlockedShape = {
  reason: z.string().min(10).max(2000),
  category: z.enum(BLOCKED_CATEGORIES),
  needs: z.array(z.string().min(1).max(200)).min(1).max(10),
} as const;

export const recordDecisionShape = {
  title: z.string().min(3).max(120),
  rationale: z.string().min(10).max(2000),
  alternatives: z.array(z.string().max(300)).max(5).optional(),
} as const;

export const COMMIT_TYPES = [
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
] as const;

export const conventionalCommitSchema = z.object({
  type: z.enum(COMMIT_TYPES),
  scope: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .max(30)
    .optional(),
  subject: z.string().min(5).max(72).regex(/[^.]$/, 'no trailing period'),
  body: z.string().max(4000).optional(),
  breaking: z.string().max(500).optional(),
});

export const FINDING_SEVERITIES = ['blocker', 'major', 'minor', 'nit'] as const;

/** QA's deliverable when it reviews rather than writes. */
export const findingSchema = z.object({
  severity: z.enum(FINDING_SEVERITIES),
  title: z.string().min(5).max(120),
  detail: z.string().min(10).max(2000),
  /** `path:line`, when the finding has one. */
  location: z.string().max(300).optional(),
});

/**
 * Still ONE propose_summary tool, so the board server, the scripted driver and
 * the office log renderer are untouched. What changed is that `commit` is now
 * optional at the schema level: whether a role must supply one is a property of
 * the role (see `ROLE_DELIVERY.requireCommit`), enforced in the task runner,
 * whose rejection path already round-trips back to the agent.
 */
export const proposeSummaryShape = {
  title: z.string().min(5).max(100),
  summary: z.string().min(20).max(4000),
  testPlan: z.string().min(10).max(2000),
  filesTouched: z.array(z.string().max(300)).max(200),
  followUps: z.array(z.string().max(300)).max(10).optional(),
  commit: conventionalCommitSchema.optional(),
  /** QA. */
  findings: z.array(findingSchema).max(30).optional(),
  /** PM / BA. */
  acceptanceCriteria: z.array(z.string().min(5).max(300)).max(20).optional(),
  /**
   * DEV. Required for DEV: whether QA has anything to test. `testable: true`
   * also requires a QA sub-task created with create_work_item.
   */
  testability: z
    .object({
      testable: z.boolean(),
      reason: z.string().min(10).max(1000),
    })
    .optional(),
} as const;

const isoDate = z.string().regex(/^d{4}-d{2}-d{2}$/, 'YYYY-MM-DD');

export const createWorkItemShape = {
  type: z.enum(WORK_ITEM_TYPES),
  title: z.string().min(5).max(200),
  description: z.string().min(20).max(12_000),
  acceptanceCriteria: z.array(z.string().min(5).max(300)).max(20).optional(),
  /** `current` = the card this run works on. Required for `subtask`. */
  parent: z.string().min(1).max(64).optional(),
  /** Who picks it up. Omit to use the project's default for the type. */
  assignTo: z.enum([...HAND_TARGETS, 'none']).optional(),
} as const;

export const reassignShape = {
  to: z.enum(HAND_TARGETS),
  reason: z.string().min(10).max(2000),
} as const;

/** Fibonacci only: points are relative size, and the gaps are the point. */
export const STORY_POINTS = [1, 2, 3, 5, 8, 13, 21] as const;

export const setFieldsShape = {
  priority: z.enum(PRIORITIES).optional(),
  storyPoints: z
    .number()
    .int()
    .refine((n) => (STORY_POINTS as readonly number[]).includes(n), 'use 1, 2, 3, 5, 8, 13 or 21')
    .optional(),
  startDate: isoDate.optional(),
  dueDate: isoDate.optional(),
  rationale: z.string().min(20).max(2000),
} as const;

export const addCommentShape = {
  body: z.string().min(5).max(8000),
} as const;

export type ProgressReport = z.infer<z.ZodObject<typeof reportProgressShape>>;
export type BlockedReport = z.infer<z.ZodObject<typeof reportBlockedShape>>;
export type Decision = z.infer<z.ZodObject<typeof recordDecisionShape>>;
export type ProposedSummary = z.infer<z.ZodObject<typeof proposeSummaryShape>>;
export type ConventionalCommit = z.infer<typeof conventionalCommitSchema>;
export type Finding = z.infer<typeof findingSchema>;
export type CreateWorkItemArgs = z.infer<z.ZodObject<typeof createWorkItemShape>>;
export type ReassignArgs = z.infer<z.ZodObject<typeof reassignShape>>;
export type SetFieldsArgs = z.infer<z.ZodObject<typeof setFieldsShape>>;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];
