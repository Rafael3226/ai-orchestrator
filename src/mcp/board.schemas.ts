import { z } from 'zod';

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

export const proposeSummaryShape = {
  title: z.string().min(5).max(100),
  summary: z.string().min(20).max(4000),
  testPlan: z.string().min(10).max(2000),
  filesTouched: z.array(z.string().max(300)).max(200),
  followUps: z.array(z.string().max(300)).max(10).optional(),
  commit: conventionalCommitSchema,
} as const;

export type ProgressReport = z.infer<z.ZodObject<typeof reportProgressShape>>;
export type BlockedReport = z.infer<z.ZodObject<typeof reportBlockedShape>>;
export type Decision = z.infer<z.ZodObject<typeof recordDecisionShape>>;
export type ProposedSummary = z.infer<z.ZodObject<typeof proposeSummaryShape>>;
export type ConventionalCommit = z.infer<typeof conventionalCommitSchema>;
