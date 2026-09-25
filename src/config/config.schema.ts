import { z } from 'zod';

import { WORK_ITEM_TYPES } from '../board/board.types.js';

/** In flow order: User → BA → PM → DEV → QA → Closed. DEVOPS sits beside DEV. */
export const ROLES = ['BA', 'PM', 'DEV', 'QA', 'DEVOPS'] as const;
export type Role = (typeof ROLES)[number];
export const roleSchema = z.enum(ROLES);

/** Who a card can be handed to: a role (its home column) or a human (`flow.humanColumn`). */
export const HAND_TARGETS = [...ROLES, 'human'] as const;
export type HandTarget = (typeof HAND_TARGETS)[number];
export const handTargetSchema = z.enum(HAND_TARGETS);

/**
 * Board tools an agent may be granted. Reading (get_task, list_work_items) and
 * reporting are always on; these are the ones that change the board.
 */
export const CAPABILITIES = ['create-work-item', 'reassign', 'set-fields', 'comment'] as const;
export type Capability = (typeof CAPABILITIES)[number];

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
  capabilities: z.array(z.enum(CAPABILITIES)),
  workflowCommand: z.string().min(2).optional(),
});

/** A slash command in the target repo, e.g. `/acts-workflow-managed` or `/openspec:apply`. */
const slashCommand = z.string().regex(/^\/[A-Za-z0-9][\w.-]*(:[\w.-]+)*$/, 'like /my-command');

/** What `defaults.agents.<ROLE>` may contain — everything optional. */
export const writebackStepSchema = z.strictObject({
  move: columnAlias.optional(),
  /**
   * Hand the card to a role (its home column, derived from routes) or to a
   * human (`flow.humanColumn`). An alternative to `move`; set one or the other.
   */
  handTo: handTargetSchema.optional(),
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

export const DRIVER_KINDS = ['local', 'docker'] as const;

/**
 * The docker block's fields, without defaults. Both the base schema and the
 * overlay schema are derived from this so they cannot drift apart.
 */
const dockerFields = {
  image: z.string().min(1),
  pullPolicy: z.enum(['missing', 'always', 'never']),
  /**
   * `none` is offered for read-only roles, but cannot be the default: the CLI
   * must reach api.anthropic.com and installs must reach the registry.
   */
  network: z.string().min(1),
  cpus: z.number().positive().max(64),
  memoryMb: z.number().int().min(512).max(131_072),
  pidsLimit: z.number().int().min(64).max(16_384),
  tmpfsMb: z.number().int().min(16).max(8192),
  user: z.string().min(1),
  /** Mount the parent repo's .git so a worktree's gitdir link resolves. */
  mountGitDir: z.boolean(),
  /** Off for pnpm-workspace monorepos, whose node_modules is not one directory. */
  nodeModulesVolume: z.boolean(),
  sharedStoreVolume: z.boolean(),
  extraMounts: z.array(z.string().min(1)),
  dockerHost: z.string(),
  startTimeoutSeconds: z.number().int().min(10).max(600),
} as const;

export const dockerConfigSchema = z.strictObject({
  image: dockerFields.image.default('ai-orchestrator/agent:latest'),
  pullPolicy: dockerFields.pullPolicy.default('missing'),
  network: dockerFields.network.default('bridge'),
  cpus: dockerFields.cpus.default(2),
  memoryMb: dockerFields.memoryMb.default(4096),
  pidsLimit: dockerFields.pidsLimit.default(512),
  tmpfsMb: dockerFields.tmpfsMb.default(512),
  user: dockerFields.user.default('1000:1000'),
  mountGitDir: dockerFields.mountGitDir.default(true),
  nodeModulesVolume: dockerFields.nodeModulesVolume.default(true),
  sharedStoreVolume: dockerFields.sharedStoreVolume.default(true),
  extraMounts: dockerFields.extraMounts.default([]),
  dockerHost: dockerFields.dockerHost.default(''),
  startTimeoutSeconds: dockerFields.startTimeoutSeconds.default(120),
});

export const dockerOverlaySchema = z.strictObject(
  Object.fromEntries(Object.entries(dockerFields).map(([k, v]) => [k, v.optional()])) as {
    [K in keyof typeof dockerFields]: z.ZodOptional<(typeof dockerFields)[K]>;
  },
);

/** The base, with every default filled in. Only `defaults.exec` uses this. */
export const execConfigSchema = z.strictObject({
  driver: z.enum(DRIVER_KINDS).default('local'),
  docker: dockerConfigSchema.prefault({}),
});

export const execOverlaySchema = z.strictObject({
  driver: z.enum(DRIVER_KINDS).optional(),
  docker: dockerOverlaySchema.optional(),
});

const agentDefaultsSchema = z.strictObject({
  model: z.string().min(1).optional(),
  budget: budgetSchema.partial().optional(),
  systemPromptFile: z.string().min(1).optional(),
  /** Replaces the role's default board tools. See `CAPABILITIES`. */
  capabilities: z.array(z.enum(CAPABILITIES)).optional(),
  /**
   * DEV: a slash command in the target repo whose steps the agent follows,
   * expanded by the orchestrator. `false` turns the builtin default off.
   */
  workflowCommand: z.union([slashCommand, z.literal(false)]).optional(),
});

/**
 * What `projects[].agents.<ROLE>` may contain — an enable flag plus overrides.
 *
 * `writeback` overlays the project's, per step, and is not optional polish: a
 * successful QA run under a single project-level `onSuccess: { move: review }`
 * would move the card straight back into QA's own trigger column.
 */
const agentOverrideSchema = agentDefaultsSchema.extend({
  enabled: z.boolean().default(false),
  /** Per-role docker overlay, e.g. a different image for the frontend role. */
  docker: dockerOverlaySchema.optional(),
  writeback: z
    .strictObject({
      onStart: writebackStepSchema.optional(),
      onSuccess: writebackStepSchema.optional(),
      onFailure: writebackStepSchema.optional(),
      onBlocked: writebackStepSchema.optional(),
    })
    .optional(),
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

const credentialRef = z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'UPPER_SNAKE_CASE credential ref');
const adoOrganization = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/, 'the organization name from dev.azure.com/{organization}');

export const REPO_HOSTS = ['github', 'azure-devops'] as const;
export type RepoHostProvider = (typeof REPO_HOSTS)[number];

const githubHostSchema = z.strictObject({
  provider: z.literal('github'),
  /** owner/name — used by `gh pr create --repo`. */
  githubRepo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'owner/name'),
});

const azureReposHostSchema = z.strictObject({
  provider: z.literal('azure-devops'),
  organization: adoOrganization,
  project: z.string().trim().min(1),
  repository: z.string().trim().min(1),
  /** `<REF>_PAT` needs Code (read & write) for push and pull requests. */
  credentials: credentialRef,
});

export const repoHostSchema = z.discriminatedUnion('provider', [
  githubHostSchema,
  azureReposHostSchema,
]);

const repoSchema = z
  .strictObject({
    path: z.string().min(1),
    remote: z.string().min(1).default('origin'),
    baseBranch: z.string().min(1).default('main'),
    worktreeRoot: z.string().min(1),
    /** Shorthand for `host: { provider: github, githubRepo }`. Normalized away at parse. */
    githubRepo: githubHostSchema.shape.githubRepo.optional(),
    host: repoHostSchema.optional(),
    branchTemplate: z.string().min(1).default('ai/{role}/{cardShortId}-{slug}'),
  })
  .superRefine((r, ctx) => {
    if (r.githubRepo === undefined && r.host === undefined) {
      ctx.addIssue({ code: 'custom', message: 'set `host` (or the `githubRepo` shorthand)' });
    }
    if (r.githubRepo !== undefined && r.host !== undefined) {
      ctx.addIssue({ code: 'custom', message: '`githubRepo` is shorthand for `host`; use one' });
    }
  })
  .transform(({ githubRepo, host, ...rest }) => ({
    ...rest,
    host: host ?? { provider: 'github' as const, githubRepo: githubRepo as string },
  }));

/** Fields every board provider shares. */
const boardBase = {
  credentials: credentialRef,
  /**
   * The identity the orchestrator writes as — the loop guard ignores its own
   * events. Trello member id, Azure DevOps identity id, Jira accountId. Print
   * it with `board whoami`.
   */
  botMemberId: z.string().min(1).optional(),
  poll: z
    .strictObject({
      intervalSeconds: z.number().int().min(5).max(600).default(15),
      reconcileEveryTicks: z.number().int().min(1).default(40),
      reconcileOnStart: z.boolean().default(true),
    })
    .prefault({}),
  webhook: z
    .strictObject({
      enabled: z.boolean().default(false),
      /** Reconcile the provider-side registration at every boot. */
      manageRegistration: z.boolean().default(true),
      /** Dev tunnels: the URL dies with the process, so drop the registration. */
      deleteOnShutdown: z.boolean().default(false),
      maxBufferedEvents: z.number().int().min(10).max(10_000).default(500),
      maxEventAgeSeconds: z.number().int().min(30).max(86_400).default(600),
    })
    .prefault({}),
  /** semantic alias -> board column name (Trello list, ADO state, Jira status) */
  columns: z.record(columnAlias, columnName).default({}),
  /**
   * Provider field ids for the planning fields PM sets. Each provider has a
   * default (see its source); Jira story points in particular vary per site.
   */
  fields: z
    .strictObject({
      priority: z.string().trim().min(1).optional(),
      storyPoints: z.string().trim().min(1).optional(),
      startDate: z.string().trim().min(1).optional(),
      dueDate: z.string().trim().min(1).optional(),
    })
    .prefault({}),
  /** Work item type -> the provider's type name, e.g. `subtask: Subtask` on team-managed Jira. */
  cardTypes: z.partialRecord(z.enum(WORK_ITEM_TYPES), z.string().trim().min(1)).default({}),
} as const;

const trelloBoardSchema = z.strictObject({
  provider: z.literal('trello'),
  boardId: z.string().min(1),
  ...boardBase,
});

const adoBoardSchema = z.strictObject({
  provider: z.literal('azure-devops'),
  organization: adoOrganization,
  project: z.string().trim().min(1),
  /** Only these work item types are picked up. Their states are the columns. */
  workItemTypes: z.array(z.string().trim().min(1)).min(1).default(['User Story', 'Bug', 'Task']),
  /** Optional `UNDER` filter, e.g. `MyProject\Team A`. */
  areaPath: z.string().trim().min(1).optional(),
  ...boardBase,
});

const jiraBoardSchema = z.strictObject({
  provider: z.literal('jira'),
  /** `acme` or `acme.atlassian.net`. */
  site: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]*(\.atlassian\.net)?$/, 'acme or acme.atlassian.net')
    .transform((s) => (s.endsWith('.atlassian.net') ? s : `${s}.atlassian.net`)),
  projectKey: z.string().regex(/^[A-Z][A-Z0-9_]+$/, 'a Jira project key like PROJ'),
  issueTypes: z.array(z.string().trim().min(1)).min(1).optional(),
  /** Extra JQL ANDed onto the project filter, e.g. `component = Backend`. */
  jql: z.string().trim().min(1).optional(),
  ...boardBase,
});

/**
 * `boardId` is filled in for every provider: it is the key the sync state,
 * the one-board-per-project check and the logs use.
 */
export const boardSchema = z
  .discriminatedUnion('provider', [trelloBoardSchema, adoBoardSchema, jiraBoardSchema])
  .transform((b) => ({ ...b, boardId: boardKey(b) }));

type BoardInput =
  | z.output<typeof trelloBoardSchema>
  | z.output<typeof adoBoardSchema>
  | z.output<typeof jiraBoardSchema>;

function boardKey(b: BoardInput): string {
  switch (b.provider) {
    case 'trello':
      return b.boardId;
    case 'azure-devops':
      return `${b.organization}/${b.project}${b.areaPath ? `:${b.areaPath}` : ''}`;
    case 'jira':
      return `${b.site}/${b.projectKey}${b.jql ? `?${b.jql}` : ''}`;
  }
}

/** Who picks up a work item an agent (or the chat) creates. */
const newItemTarget = z.enum([...HAND_TARGETS, 'none']);

/**
 * How work moves between roles, how it escalates, and what counts as stuck.
 * Nothing here names a column directly except through `board.columns`
 * aliases: a role's *home column* is derived from its routes, so the routes
 * stay the single source of truth for who works where. See docs/flow.md.
 */
export const flowSchema = z.strictObject({
  /** Where raw requirements land — BA's column. The chat hands to `newItems.story` instead. */
  intake: columnAlias.optional(),
  /** The terminal column. Stale detection ignores it. */
  closed: columnAlias.optional(),
  /** What `handTo: human` and a tripped bounce cap move the card to. */
  humanColumn: columnAlias.optional(),
  /**
   * Who picks up a created item, by type. Unlisted types stay wherever the
   * provider creates them (Jira/ADO: the initial state); `subtask` stays on its parent.
   */
  newItems: z.partialRecord(z.enum(WORK_ITEM_TYPES), newItemTarget).default({}),
  /**
   * Who takes the card when a role fails or blocks. Sugar for
   * `agents.<ROLE>.writeback.onFailure/onBlocked.handTo`. It replaces the destination
   * of the project-wide default step; a role's own overlay naming one still wins.
   */
  escalation: z
    .partialRecord(
      roleSchema,
      z.strictObject({
        onFailure: handTargetSchema.optional(),
        onBlocked: handTargetSchema.optional(),
      }),
    )
    .default({}),
  /**
   * How many times one role may be handed the same card (e.g. QA sending it
   * back to DEV) before it goes to a human with the `ai-loop` label instead.
   */
  maxBounces: z.number().int().min(1).max(20).default(3),
  /** DEV reported the change is not testable: skip QA and move here on success. */
  untestableTo: columnAlias.optional(),
  stale: z
    .strictObject({
      enabled: z.boolean().default(true),
      /** A card sitting this long in one column, with nothing running, needs attention. */
      defaultHours: z
        .number()
        .positive()
        .max(24 * 90)
        .default(48),
      /** Per column alias. */
      columns: z
        .record(
          columnAlias,
          z
            .number()
            .positive()
            .max(24 * 90),
        )
        .default({}),
      label: z.string().min(1).default('stale'),
    })
    .prefault({}),
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
  repo: repoSchema,
  checks: z
    .strictObject({
      install: z.string().min(1).optional(),
      lint: z.string().min(1).optional(),
      typecheck: z.string().min(1).optional(),
      test: z.string().min(1).optional(),
      /** DEVOPS verifies with this when present, else falls back to `test`. */
      infra: z.string().min(1).optional(),
      required: z.array(z.enum(['install', 'lint', 'typecheck', 'test', 'infra'])).default([]),
      timeoutMinutes: z.number().int().positive().max(120).default(15),
    })
    .prefault({}),
  board: boardSchema,
  exec: execOverlaySchema.optional(),
  agents: z.partialRecord(roleSchema, agentOverrideSchema).default({}),
  routes: z.array(routeSchema).min(1),
  writeback: writebackSchema.prefault({}),
  flow: flowSchema.prefault({}),
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
        exec: execConfigSchema.prefault({}),
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
      if (p.board.webhook.enabled && p.board.provider !== 'trello') {
        ctx.addIssue({
          code: 'custom',
          path: ['projects', i, 'board', 'webhook', 'enabled'],
          message: `webhooks are only implemented for trello, not ${p.board.provider}`,
        });
      }
    });
  });

export type OrchestratorConfigInput = z.input<typeof orchestratorConfigSchema>;
export type OrchestratorConfigRaw = z.output<typeof orchestratorConfigSchema>;
export type ProjectConfigRaw = z.output<typeof projectSchema>;
export type RouteConfig = z.output<typeof routeSchema>;
export type WritebackStep = z.output<typeof writebackStepSchema>;
export type DockerConfig = z.output<typeof dockerConfigSchema>;
export type ExecConfig = z.output<typeof execConfigSchema>;
export type BoardConfig = z.output<typeof boardSchema>;
export type AdoBoardConfig = Extract<BoardConfig, { provider: 'azure-devops' }>;
export type JiraBoardConfig = Extract<BoardConfig, { provider: 'jira' }>;
export type RepoHostConfig = z.output<typeof repoHostSchema>;
export type AgentSettings = z.output<typeof agentSettingsSchema>;
export type Budget = z.output<typeof budgetSchema>;
export type FlowConfigRaw = z.output<typeof flowSchema>;
export type TrelloBoardConfig = Extract<BoardConfig, { provider: 'trello' }>;
