import { z } from 'zod';

export const ROLES = ['DEV-FE', 'DEV-BE', 'QA', 'PM', 'DEVOPS'] as const;
export type Role = (typeof ROLES)[number];
export const roleSchema = z.enum(ROLES);

export const BOARD_PROVIDERS = ['trello', 'azure-devops', 'jira'] as const;
export type BoardProvider = (typeof BOARD_PROVIDERS)[number];

/** A column NAME as it appears on the board; matched case- and space-insensitively. */
const columnName = z.string().trim().min(1);
/** A semantic alias declared under `board.columns` (e.g. `review`). */
const columnAlias = z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/, 'alias must be camelCase');

const labelList = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

export const budgetSchema = z.strictObject({
  maxUsd: z.number().positive().max(100),
  maxTurns: z.number().int().positive().max(500),
  wallClockMinutes: z.number().int().positive().max(240),
});

/** Fully-resolved agent settings after defaults are merged in. */
export const agentSettingsSchema = z.strictObject({
  model: z.string().min(1),
  budget: budgetSchema,
  systemPromptFile: z.string().min(1).optional(),
});

/** What `defaults.agents.<ROLE>` may contain — everything optional. */
const agentDefaultsSchema = z.strictObject({
  model: z.string().min(1).optional(),
  budget: budgetSchema.partial().optional(),
  systemPromptFile: z.string().min(1).optional(),
});

/** What `projects[].agents.<ROLE>` may contain — an enable flag plus overrides. */
const agentOverrideSchema = agentDefaultsSchema.extend({
  enabled: z.boolean().default(false),
});

const prSchema = z.strictObject({
  draft: z.boolean().default(true),
  labels: z.array(z.string().min(1)).default([]),
});

export const routeWhenSchema = z
  .strictObject({
    column: columnName.optional(),
    /** Trello-flavoured alias for `column`. Normalized away at load. */
    list: columnName.optional(),
    /** Any-of. */
    label: labelList.optional(),
    /** All-of. */
    labelsAll: z.array(z.string().min(1)).min(1).optional(),
    member: z.string().min(1).optional(),
    /** JS regex source; compiled once at load so a bad pattern is a config error. */
    titleMatches: z.string().min(1).optional(),
  })
  .superRefine((w, ctx) => {
    if (Object.values(w).every((v) => v === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'a route needs at least one condition' });
    }
    if (w.column !== undefined && w.list !== undefined) {
      ctx.addIssue({ code: 'custom', message: '`column` and `list` are aliases; use one' });
    }
    if (w.titleMatches !== undefined) {
      try {
        new RegExp(w.titleMatches);
      } catch (e) {
        ctx.addIssue({
          code: 'custom',
          message: `titleMatches is not a valid regex: ${String(e)}`,
        });
      }
    }
  });

export const routeSchema = z.strictObject({
  when: routeWhenSchema,
  agent: roleSchema,
  enabled: z.boolean().default(true),
  /** Tie-break only; file order still wins (see docs). */
  priority: z.number().int().default(0),
});

export const writebackStepSchema = z.strictObject({
  move: columnAlias.optional(),
  comment: z.enum(['none', 'started', 'report']).default('none'),
  addLabel: labelList.optional(),
  removeLabel: labelList.optional(),
  assign: z.enum(['bot', 'none']).default('none'),
  /** When true, an unsupported/failed step marks the run partially reported. */
  required: z.boolean().default(false),
});

const writebackSchema = z.strictObject({
  onStart: writebackStepSchema.prefault({}),
  onSuccess: writebackStepSchema.prefault({}),
  onFailure: writebackStepSchema.prefault({}),
  onBlocked: writebackStepSchema.prefault({}),
});

export const projectSchema = z.strictObject({
  /** SQLite key, URL segment and office room id. */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,38}$/, 'kebab-case, 2-39 chars'),
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'hex colour like #3b82f6')
    .default('#64748b'),
  repo: z.strictObject({
    path: z.string().min(1),
    remote: z.string().min(1).default('origin'),
    baseBranch: z.string().min(1).default('main'),
    worktreeRoot: z.string().min(1),
    /** owner/name — used by `gh pr create --repo`. */
    githubRepo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'owner/name'),
    branchTemplate: z.string().min(1).default('ai/{role}/{cardShortId}-{slug}'),
  }),
  checks: z
    .strictObject({
      install: z.string().min(1).optional(),
      lint: z.string().min(1).optional(),
      typecheck: z.string().min(1).optional(),
      test: z.string().min(1).optional(),
      required: z.array(z.enum(['install', 'lint', 'typecheck', 'test'])).default([]),
      timeoutMinutes: z.number().int().positive().max(120).default(15),
    })
    .prefault({}),
  board: z.strictObject({
    provider: z.enum(BOARD_PROVIDERS),
    boardId: z.string().min(1),
    credentials: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'UPPER_SNAKE_CASE credential ref'),
    botMemberId: z.string().min(1).optional(),
    poll: z
      .strictObject({
        intervalSeconds: z.number().int().min(5).max(600).default(15),
        reconcileEveryTicks: z.number().int().min(1).default(40),
        reconcileOnStart: z.boolean().default(true),
      })
      .prefault({}),
    /** semantic alias -> board column name */
    columns: z.record(columnAlias, columnName).default({}),
  }),
  agents: z.partialRecord(roleSchema, agentOverrideSchema).default({}),
  routes: z.array(routeSchema).min(1),
  writeback: writebackSchema.prefault({}),
  pr: prSchema.partial().optional(),
});

export const orchestratorConfigSchema = z
  .strictObject({
    version: z.literal(1),
    defaults: z
      .strictObject({
        concurrency: z
          .strictObject({
            global: z.number().int().min(1).max(16).default(3),
            perProject: z.number().int().min(1).max(8).default(1),
          })
          .prefault({}),
        agents: z.partialRecord(roleSchema, agentDefaultsSchema).default({}),
        pr: prSchema.prefault({}),
      })
      .prefault({}),
    office: z
      .strictObject({
        roomsPerRow: z.number().int().min(1).max(4).default(1),
      })
      .prefault({}),
    projects: z.array(projectSchema).min(1),
  })
  .superRefine((cfg, ctx) => {
    const ids = new Set<string>();
    const boards = new Map<string, string>();
    cfg.projects.forEach((p, i) => {
      if (ids.has(p.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['projects', i, 'id'],
          message: `duplicate id ${p.id}`,
        });
      }
      ids.add(p.id);
      const boardKey = `${p.board.provider}:${p.board.boardId}`;
      const other = boards.get(boardKey);
      if (other) {
        ctx.addIssue({
          code: 'custom',
          path: ['projects', i, 'board', 'boardId'],
          message: `board already used by project ${other}; one board per project`,
        });
      }
      boards.set(boardKey, p.id);
    });
  });

export type OrchestratorConfigInput = z.input<typeof orchestratorConfigSchema>;
export type OrchestratorConfigRaw = z.output<typeof orchestratorConfigSchema>;
export type ProjectConfigRaw = z.output<typeof projectSchema>;
export type RouteConfig = z.output<typeof routeSchema>;
export type WritebackStep = z.output<typeof writebackStepSchema>;
export type AgentSettings = z.output<typeof agentSettingsSchema>;
export type Budget = z.output<typeof budgetSchema>;
