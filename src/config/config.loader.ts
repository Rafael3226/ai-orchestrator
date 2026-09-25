import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import type { DriverKind } from '../exec/exec.driver.js';

import {
  type AgentSettings,
  type Budget,
  type Capability,
  type DockerConfig,
  type FlowConfigRaw,
  type HandTarget,
  orchestratorConfigSchema,
  type OrchestratorConfigRaw,
  type ProjectConfigRaw,
  type Role,
  ROLES,
  type RouteConfig,
  type WritebackStep,
} from './config.schema.js';
import type { CredentialKind, CredentialUse } from './credentials.js';

const EVERYONE: Capability[] = ['create-work-item', 'reassign', 'comment'];

/** Hard-coded floor so a project can omit `defaults.agents` entirely. */
const BUILTIN_AGENT_DEFAULTS: Record<Role, AgentSettings> = {
  BA: {
    model: 'sonnet',
    budget: { maxUsd: 1.5, maxTurns: 40, wallClockMinutes: 15 },
    capabilities: EVERYONE,
  },
  PM: {
    model: 'sonnet',
    budget: { maxUsd: 1, maxTurns: 30, wallClockMinutes: 10 },
    capabilities: [...EVERYONE, 'set-fields'],
  },
  DEV: {
    model: 'opus',
    budget: { maxUsd: 8, maxTurns: 150, wallClockMinutes: 45 },
    capabilities: EVERYONE,
    workflowCommand: '/acts-workflow-managed',
  },
  QA: {
    model: 'sonnet',
    budget: { maxUsd: 3, maxTurns: 100, wallClockMinutes: 30 },
    capabilities: EVERYONE,
  },
  DEVOPS: {
    model: 'sonnet',
    budget: { maxUsd: 2, maxTurns: 60, wallClockMinutes: 20 },
    capabilities: EVERYONE,
  },
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

/** Where a role picks work up: the column (and label, if any) of its first enabled column route. */
export interface HomeColumn {
  readonly column: string;
  readonly label: string | null;
}

export interface ResolvedFlow extends FlowConfigRaw {
  /** null when the role has no column route, or is disabled. */
  readonly homes: Readonly<Record<Role, HomeColumn | null>>;
}

export interface ProjectConfig extends Omit<ProjectConfigRaw, 'agents' | 'routes' | 'pr' | 'flow'> {
  readonly agents: Readonly<Record<Role, ResolvedAgent>>;
  readonly routes: readonly ResolvedRoute[];
  readonly pr: OrchestratorConfigRaw['defaults']['pr'];
  readonly flow: ResolvedFlow;
}

export interface OrchestratorConfig extends Omit<OrchestratorConfigRaw, 'projects'> {
  readonly projects: readonly ProjectConfig[];
}

export interface ConfigDiagnostic {
  readonly level: 'warn';
  readonly code:
    | 'route-to-disabled-agent'
    | 'route-shadowed'
    | 'webhook-redundant-polling'
    | 'flow-no-closed-column';
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
  /** credential ref -> its provider and the ids of the projects that use it */
  readonly credentialRefs: ReadonlyMap<string, CredentialUse>;
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

  const credentialRefs = collectCredentialRefs(projects, errors);
  if (errors.length) {
    console.error(`❌ Invalid config ${sourcePath}:\n` + errors.map((e) => `  ✖ ${e}`).join('\n'));
    throw new Error(`Invalid config ${sourcePath}. See the errors above.`);
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
    steps: Record<string, { move?: string | undefined; handTo?: string | undefined } | undefined>,
  ): void => {
    for (const [stepName, step] of Object.entries(steps)) {
      if (step?.handTo !== undefined && step.move !== undefined) {
        errors.push(`projects.${p.id}.${where}.${stepName}: set \`move\` or \`handTo\`, not both`);
      }
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

  // handTo resolves through the flow, so it is checked after the homes exist.
  const flow: ResolvedFlow = { ...p.flow, homes: resolveHomes(agents, routes) };
  const ctx: FlowCheck = { p, flow, agents, errors };
  checkFlowAliases(p, errors);
  checkFlowTargets(ctx);
  if (checkHandSteps(ctx)) moves = true;
  if (Object.keys(p.flow.newItems).length) moves = true;
  if (Object.keys(p.flow.escalation).length && p.flow.stale.enabled && !p.flow.closed) {
    diagnostics.push({
      level: 'warn',
      code: 'flow-no-closed-column',
      projectId: p.id,
      message: 'flow.closed is not set, so the stale watch also flags finished cards',
    });
  }

  checkLabelNames(p, errors);

  if (moves && !p.board.botMemberId) {
    errors.push(
      `projects.${p.id}.board.botMemberId is required when writeback moves cards (loop guard)`,
    );
  }

  // Per-project `pr` is a partial overlay; drop undefined so it cannot erase a default.
  const pr = { ...root.defaults.pr, ...stripUndefined(p.pr ?? {}) };
  return { ...p, agents, routes, pr, flow };
}

/** What the flow checks share. */
interface FlowCheck {
  readonly p: ProjectConfigRaw;
  readonly flow: ResolvedFlow;
  readonly agents: Record<Role, ResolvedAgent>;
  readonly errors: string[];
}

/**
 * A role's home column is derived from its routes, so a handoff lands exactly
 * where the router will pick the card up again — no second table to drift.
 */
function resolveHomes(
  agents: Record<Role, ResolvedAgent>,
  routes: readonly ResolvedRoute[],
): Record<Role, HomeColumn | null> {
  const homeOf = (role: Role): HomeColumn | null => {
    if (!agents[role].enabled) return null;
    const r = routes.find((x) => x.agent === role && x.enabled && x.when.column !== undefined);
    if (!r?.when.column) return null;
    return {
      column: r.when.column,
      label: firstLabel(r.when.label) ?? r.when.labelsAll?.[0] ?? null,
    };
  };
  return Object.fromEntries(ROLES.map((role) => [role, homeOf(role)])) as Record<
    Role,
    HomeColumn | null
  >;
}

function checkFlowAliases(p: ProjectConfigRaw, errors: string[]): void {
  const aliases = new Set(Object.keys(p.board.columns));
  const named = [
    ...(['intake', 'closed', 'humanColumn', 'untestableTo'] as const).map(
      (key) => [`flow.${key}`, p.flow[key]] as const,
    ),
    ...Object.keys(p.flow.stale.columns).map((a) => [`flow.stale.columns.${a}`, a] as const),
  ];
  for (const [where, alias] of named) {
    if (alias !== undefined && !aliases.has(alias)) {
      errors.push(`projects.${p.id}.${where}: "${alias}" is not declared under board.columns`);
    }
  }
}

function checkFlowTargets(ctx: FlowCheck): void {
  for (const [type, target] of Object.entries(ctx.p.flow.newItems)) {
    if (target !== undefined && target !== 'none') {
      checkHandTarget(ctx, target, `flow.newItems.${type}`);
    }
  }
  for (const [role, esc] of Object.entries(ctx.p.flow.escalation)) {
    for (const [when, target] of Object.entries(esc ?? {})) {
      if (target !== undefined) checkHandTarget(ctx, target, `flow.escalation.${role}.${when}`);
    }
  }
}

/** Every resolved writeback `handTo`. Returns whether any step hands a card on. */
function checkHandSteps(ctx: FlowCheck): boolean {
  let any = false;
  for (const role of ROLES) {
    if (!ctx.agents[role].enabled) continue;
    for (const [stepName, step] of Object.entries(ctx.agents[role].writeback)) {
      if (step.handTo === undefined) continue;
      any = true;
      const where = `agents.${role}.writeback.${stepName}.handTo`;
      checkHandTarget(ctx, step.handTo, where);
      if (step.handTo === role) {
        ctx.errors.push(
          `projects.${ctx.p.id}.${where}: ${role} hands the card back to itself — that is a dispatch loop`,
        );
      }
    }
  }
  return any;
}

function checkHandTarget(ctx: FlowCheck, target: HandTarget, where: string): void {
  const problem = handTargetProblem(ctx, target);
  if (problem) ctx.errors.push(`projects.${ctx.p.id}.${where}: ${problem}`);
}

function handTargetProblem(ctx: FlowCheck, target: HandTarget): string | null {
  if (target === 'human') {
    return ctx.p.flow.humanColumn === undefined ? '"human" needs flow.humanColumn' : null;
  }
  if (!ctx.agents[target].enabled) return `${target} is not enabled for this project`;
  return ctx.flow.homes[target]
    ? null
    : `${target} has no column route, so there is nowhere to hand the card`;
}

function firstLabel(v: string | string[] | undefined): string | null {
  if (v === undefined) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

/**
 * Board and repo-host refs share one namespace: an Azure DevOps project can use
 * a single PAT for its work items and its repository. A ref that two providers
 * both claim would resolve to the wrong env vars, so it is an error.
 */
function collectCredentialRefs(
  projects: readonly ProjectConfig[],
  errors: string[],
): Map<string, CredentialUse> {
  const out = new Map<string, { kind: CredentialKind; projects: string[] }>();
  const use = (ref: string, kind: CredentialKind, projectId: string, where: string): void => {
    const cur = out.get(ref);
    if (!cur) {
      out.set(ref, { kind, projects: [projectId] });
      return;
    }
    if (cur.kind !== kind) {
      errors.push(
        `projects.${projectId}.${where}: credential ref ${ref} is already a ${cur.kind} ` +
          `credential (${cur.projects.join(', ')}); use a separate ref for ${kind}`,
      );
      return;
    }
    if (!cur.projects.includes(projectId)) cur.projects.push(projectId);
  };
  for (const p of projects) {
    use(p.board.credentials, p.board.provider, p.id, 'board.credentials');
    if (p.repo.host.provider === 'azure-devops') {
      use(p.repo.host.credentials, 'azure-devops', p.id, 'repo.host.credentials');
    }
  }
  return out;
}

/**
 * Freeform labels are created on first use, so a name the provider cannot
 * store must fail at load rather than in the outbox. Jira labels cannot hold
 * spaces; Azure DevOps tags are separated by `;`.
 */
function checkLabelNames(p: ProjectConfigRaw, errors: string[]): void {
  const bad =
    p.board.provider === 'jira'
      ? { re: /\s/, why: 'Jira labels cannot contain spaces' }
      : p.board.provider === 'azure-devops'
        ? { re: /[;,]/, why: 'Azure DevOps tags cannot contain ";" or ","' }
        : null;
  if (!bad) return;
  const steps: [string, WritebackStep | undefined][] = [];
  for (const [name, step] of Object.entries(p.writeback)) steps.push([`writeback.${name}`, step]);
  for (const role of ROLES) {
    for (const [name, step] of Object.entries(p.agents[role]?.writeback ?? {})) {
      steps.push([`agents.${role}.writeback.${name}`, step]);
    }
  }
  const names = (v: string | string[] | undefined): string[] =>
    v === undefined ? [] : Array.isArray(v) ? v : [v];
  for (const [where, step] of steps) {
    for (const label of [...names(step?.addLabel), ...names(step?.removeLabel)]) {
      if (bad.re.test(label)) errors.push(`projects.${p.id}.${where}: "${label}" — ${bad.why}`);
    }
  }
  for (const label of [...names(p.pr?.labels)]) {
    if (p.repo.host.provider === 'azure-devops' && /[;,]/.test(label)) {
      errors.push(
        `projects.${p.id}.pr.labels: "${label}" — Azure DevOps labels cannot contain ";"`,
      );
    }
  }
}

type AgentDefaults = NonNullable<OrchestratorConfigRaw['defaults']['agents'][Role]>;
type AgentOverride = NonNullable<ProjectConfigRaw['agents'][Role]>;

function resolveAgent(role: Role, root: OrchestratorConfigRaw, p: ProjectConfigRaw): ResolvedAgent {
  const builtin = BUILTIN_AGENT_DEFAULTS[role];
  const global: Partial<AgentDefaults> = root.defaults.agents[role] ?? {};
  const local: Partial<AgentOverride> = p.agents[role] ?? {};
  const exec = resolveExec(root, p, local);
  const overlay = local.writeback ?? {};
  // `flow.escalation` decides where a failed/blocked card goes. It beats the
  // project-wide default step's destination (that is the point of it), but a
  // role's own writeback overlay that names a destination beats escalation.
  const escalation = p.flow.escalation[role] ?? {};
  const escalate = (
    own: WritebackStep | undefined,
    fallback: WritebackStep,
    to: HandTarget | undefined,
  ): WritebackStep => {
    if (own && (own.move !== undefined || own.handTo !== undefined)) return own;
    const step = own ?? fallback;
    if (to === undefined) return step;
    const { move: _move, ...rest } = step;
    return { ...rest, handTo: to };
  };
  const writeback = {
    onStart: overlay.onStart ?? p.writeback.onStart,
    onSuccess: overlay.onSuccess ?? p.writeback.onSuccess,
    onFailure: escalate(overlay.onFailure, p.writeback.onFailure, escalation.onFailure),
    onBlocked: escalate(overlay.onBlocked, p.writeback.onBlocked, escalation.onBlocked),
  };
  const budget: Budget = {
    ...builtin.budget,
    ...stripUndefined(global.budget ?? {}),
    ...stripUndefined(local.budget ?? {}),
  };
  const systemPromptFile =
    local.systemPromptFile ?? global.systemPromptFile ?? builtin.systemPromptFile;
  // `false` at any level switches the builtin workflow command off.
  const workflow = local.workflowCommand ?? global.workflowCommand ?? builtin.workflowCommand;
  return {
    enabled: local.enabled ?? false,
    model: local.model ?? global.model ?? builtin.model,
    budget,
    writeback,
    exec,
    capabilities: [...(local.capabilities ?? global.capabilities ?? builtin.capabilities)],
    ...(systemPromptFile !== undefined ? { systemPromptFile } : {}),
    ...(typeof workflow === 'string' ? { workflowCommand: workflow } : {}),
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
