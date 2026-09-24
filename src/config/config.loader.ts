import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import type { DriverKind } from '../exec/exec.driver.js';

import {
  type AgentSettings,
  type Budget,
  type DockerConfig,
  orchestratorConfigSchema,
  type OrchestratorConfigRaw,
  type ProjectConfigRaw,
  type Role,
  ROLES,
  type RouteConfig,
} from './config.schema.js';

/** Hard-coded floor so a project can omit `defaults.agents` entirely. */
const BUILTIN_AGENT_DEFAULTS: Record<Role, AgentSettings> = {
  'DEV-BE': { model: 'opus', budget: { maxUsd: 6, maxTurns: 120, wallClockMinutes: 30 } },
  'DEV-FE': { model: 'opus', budget: { maxUsd: 6, maxTurns: 120, wallClockMinutes: 30 } },
  QA: { model: 'sonnet', budget: { maxUsd: 1.5, maxTurns: 60, wallClockMinutes: 20 } },
  PM: { model: 'haiku', budget: { maxUsd: 0.5, maxTurns: 20, wallClockMinutes: 10 } },
  DEVOPS: { model: 'sonnet', budget: { maxUsd: 2, maxTurns: 60, wallClockMinutes: 20 } },
};

export interface ResolvedAgent extends AgentSettings {
  readonly enabled: boolean;
  /** The project's writeback with this role's overlay applied, per step. */
  readonly writeback: ProjectConfigRaw['writeback'];
  /** Fully resolved: builtin -> defaults.exec -> projects[].exec -> agents.<ROLE>.docker. */
  readonly exec: ResolvedExec;
}

export interface ResolvedExec {
  readonly driver: DriverKind;
  readonly docker: DockerConfig;
}

export interface ResolvedRoute extends Omit<RouteConfig, 'when'> {
  /** `<projectId>/route-<index>` — stable across reloads while file order holds. */
  readonly id: string;
  /** Position in the YAML `routes:` list, before priority reordering. */
  readonly index: number;
  readonly when: Omit<RouteConfig['when'], 'list'>;
}

export interface ProjectConfig extends Omit<ProjectConfigRaw, 'agents' | 'routes' | 'pr'> {
  readonly agents: Readonly<Record<Role, ResolvedAgent>>;
  readonly routes: readonly ResolvedRoute[];
  readonly pr: OrchestratorConfigRaw['defaults']['pr'];
}

export interface OrchestratorConfig extends Omit<OrchestratorConfigRaw, 'projects'> {
  readonly projects: readonly ProjectConfig[];
}

export interface ConfigDiagnostic {
  readonly level: 'warn';
  readonly code: 'route-to-disabled-agent' | 'route-shadowed' | 'webhook-redundant-polling';
  readonly projectId?: string;
  readonly message: string;
}

export interface LoadedConfig {
  readonly revision: number;
  readonly loadedAt: string;
  readonly sourcePath: string;
  readonly hash: string;
  readonly config: OrchestratorConfig;
  readonly diagnostics: readonly ConfigDiagnostic[];
  /** credential ref -> ids of the projects that use it */
  readonly credentialRefs: ReadonlyMap<string, readonly string[]>;
  project(id: string): ProjectConfig;
}

export class UnknownProjectError extends Error {
  constructor(id: string) {
    super(`Unknown project "${id}"`);
    this.name = 'UnknownProjectError';
  }
}

let revisionCounter = 0;

export function loadConfig(path: string): LoadedConfig {
  const abs = resolve(path);
  return loadConfigFromString(readFileSync(abs, 'utf8'), abs);
}

export function loadConfigFromString(yamlText: string, sourcePath: string): LoadedConfig {
  const raw: unknown = parseYaml(yamlText);
  const parsed = orchestratorConfigSchema.safeParse(raw);
  if (!parsed.success) {
    console.error(`❌ Invalid config ${sourcePath}:\n` + z.prettifyError(parsed.error));
    throw new Error(`Invalid config ${sourcePath}. See the errors above.`);
  }

  const diagnostics: ConfigDiagnostic[] = [];
  const errors: string[] = [];
  const projects = parsed.data.projects.map((p) =>
    normalizeProject(p, parsed.data, diagnostics, errors),
  );
  if (errors.length) {
    console.error(`❌ Invalid config ${sourcePath}:\n` + errors.map((e) => `  ✖ ${e}`).join('\n'));
    throw new Error(`Invalid config ${sourcePath}. See the errors above.`);
  }

  const credentialRefs = new Map<string, string[]>();
  for (const p of projects) {
    const list = credentialRefs.get(p.board.credentials) ?? [];
    list.push(p.id);
    credentialRefs.set(p.board.credentials, list);
  }

  const config = deepFreeze<OrchestratorConfig>({ ...parsed.data, projects });
  const byId = new Map(projects.map((p) => [p.id, p] as const));

  return {
    revision: ++revisionCounter,
    loadedAt: new Date().toISOString(),
    sourcePath,
    hash: createHash('sha256').update(yamlText).digest('hex'),
    config,
    diagnostics,
    credentialRefs,
    project(id) {
      const p = byId.get(id);
      if (!p) throw new UnknownProjectError(id);
      return p;
    },
  };
}

function normalizeProject(
  p: ProjectConfigRaw,
  root: OrchestratorConfigRaw,
  diagnostics: ConfigDiagnostic[],
  errors: string[],
): ProjectConfig {
  const agents = Object.fromEntries(
    ROLES.map((role) => [role, resolveAgent(role, root, p)]),
  ) as Record<Role, ResolvedAgent>;

  // Fold the `list` alias, remember file order, then apply priority as a stable reorder.
  const routes: ResolvedRoute[] = p.routes
    .map((r, index) => {
      const { list, column, ...rest } = r.when;
      const resolvedColumn = column ?? list;
      const when = resolvedColumn !== undefined ? { ...rest, column: resolvedColumn } : rest;
      return { ...r, id: `${p.id}/route-${index}`, index, when };
    })
    .sort((a, b) => b.priority - a.priority);

  for (const r of routes) {
    if (r.enabled && !agents[r.agent].enabled) {
      diagnostics.push({
        level: 'warn',
        code: 'route-to-disabled-agent',
        projectId: p.id,
        message: `${r.id} targets ${r.agent}, which is not enabled for this project`,
      });
    }
  }
  for (let i = 0; i < routes.length; i++) {
    const a = routes[i];
    if (!a || !a.enabled || !isColumnOnly(a)) continue;
    for (let j = i + 1; j < routes.length; j++) {
      const b = routes[j];
      if (b && b.enabled && sameColumn(a, b) && !isColumnOnly(b)) {
        diagnostics.push({
          level: 'warn',
          code: 'route-shadowed',
          projectId: p.id,
          message: `${b.id} can never match: ${a.id} matches every card in "${a.when.column}" first`,
        });
      }
    }
  }

  // With push delivery the poller is a reconcile safety net, not the hot path.
  // Polling every few seconds on top of it just burns the shared token budget.
  if (p.board.webhook.enabled && p.board.poll.intervalSeconds < 60) {
    diagnostics.push({
      level: 'warn',
      code: 'webhook-redundant-polling',
      projectId: p.id,
      message:
        `webhooks are enabled but poll.intervalSeconds is ${p.board.poll.intervalSeconds} — ` +
        'the webhook carries the latency, so raise it (120s is the recommended profile) ' +
        'and keep reconcileEveryTicks around 5',
    });
  }

  // Writeback: every `move:` alias must be declared, and moving cards needs the
  // loop guard. Role overlays are walked too, or an undeclared alias or a
  // missing botMemberId could hide inside one.
  const aliases = new Set(Object.keys(p.board.columns));
  let moves = false;
  const checkSteps = (
    where: string,
    steps: Record<string, { move?: string | undefined } | undefined>,
  ): void => {
    for (const [stepName, step] of Object.entries(steps)) {
      if (step?.move === undefined) continue;
      moves = true;
      if (!aliases.has(step.move)) {
        errors.push(
          `projects.${p.id}.${where}.${stepName}.move: "${step.move}" is not declared under board.columns`,
        );
      }
    }
  };
  checkSteps('writeback', p.writeback);
  for (const role of ROLES) {
    const overlay = p.agents[role]?.writeback;
    if (overlay) checkSteps(`agents.${role}.writeback`, overlay);
  }

  // A role whose writeback lands the card back in a column routed to itself
  // would run forever. This is the guard for the handoff bypass below.
  for (const role of ROLES) {
    if (!agents[role].enabled) continue;
    for (const [stepName, step] of Object.entries(agents[role].writeback)) {
      if (step.move === undefined) continue;
      const column = p.board.columns[step.move];
      if (!column) continue;
      const selfRoute = routes.find(
        (r) => r.agent === role && r.enabled && normColumn(r.when.column) === normColumn(column),
      );
      if (selfRoute) {
        errors.push(
          `projects.${p.id}.agents.${role}.writeback.${stepName}.move: "${step.move}" resolves to ` +
            `"${column}", which ${selfRoute.id} routes back to ${role} — that is a dispatch loop`,
        );
      }
    }
  }

  if (moves && !p.board.botMemberId) {
    errors.push(
      `projects.${p.id}.board.botMemberId is required when writeback moves cards (loop guard)`,
    );
  }

  // Per-project `pr` is a partial overlay; drop undefined so it cannot erase a default.
  const pr = { ...root.defaults.pr, ...stripUndefined(p.pr ?? {}) };
  return { ...p, agents, routes, pr };
}

type AgentDefaults = NonNullable<OrchestratorConfigRaw['defaults']['agents'][Role]>;
type AgentOverride = NonNullable<ProjectConfigRaw['agents'][Role]>;

function resolveAgent(role: Role, root: OrchestratorConfigRaw, p: ProjectConfigRaw): ResolvedAgent {
  const builtin = BUILTIN_AGENT_DEFAULTS[role];
  const global: Partial<AgentDefaults> = root.defaults.agents[role] ?? {};
  const local: Partial<AgentOverride> = p.agents[role] ?? {};
  const exec = resolveExec(root, p, local);
  const overlay = local.writeback ?? {};
  const writeback = {
    onStart: overlay.onStart ?? p.writeback.onStart,
    onSuccess: overlay.onSuccess ?? p.writeback.onSuccess,
    onFailure: overlay.onFailure ?? p.writeback.onFailure,
    onBlocked: overlay.onBlocked ?? p.writeback.onBlocked,
  };
  const budget: Budget = {
    ...builtin.budget,
    ...stripUndefined(global.budget ?? {}),
    ...stripUndefined(local.budget ?? {}),
  };
  const systemPromptFile =
    local.systemPromptFile ?? global.systemPromptFile ?? builtin.systemPromptFile;
  return {
    enabled: local.enabled ?? false,
    model: local.model ?? global.model ?? builtin.model,
    budget,
    writeback,
    exec,
    ...(systemPromptFile !== undefined ? { systemPromptFile } : {}),
  };
}

/**
 * Four levels, narrowest last, mirroring `resolveAgent`: schema defaults, then
 * `defaults.exec`, then the project's `exec`, then the role's `docker` overlay.
 * `stripUndefined` throughout so a partial overlay can never erase a default.
 */
function resolveExec(
  root: OrchestratorConfigRaw,
  p: ProjectConfigRaw,
  local: Partial<AgentOverride>,
): ResolvedExec {
  const docker = {
    ...root.defaults.exec.docker,
    ...stripUndefined(p.exec?.docker ?? {}),
    ...stripUndefined(local.docker ?? {}),
  } as DockerConfig;
  return {
    driver: p.exec?.driver ?? root.defaults.exec.driver,
    docker,
  };
}

function isColumnOnly(r: ResolvedRoute): boolean {
  const { column, ...rest } = r.when;
  return column !== undefined && Object.values(rest).every((v) => v === undefined);
}

function sameColumn(a: ResolvedRoute, b: ResolvedRoute): boolean {
  return normColumn(a.when.column) === normColumn(b.when.column);
}

function normColumn(name: string | undefined): string {
  return (name ?? '').trim().toLocaleLowerCase();
}

function stripUndefined<T extends object>(obj: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}
