import { TrelloSource } from '../board/trello/trello.source.js';
import type { ProjectConfig } from '../config/config.loader.js';
import { loadConfig } from '../config/config.loader.js';
import {
  type BoardCredential,
  credentialOf,
  resolveBoardCredentials,
} from '../config/credentials.js';
import { loadOrchestratorEnv } from '../config/env.js';

import {
  assertPublicUrl,
  callbackUrlFor,
  DESCRIPTION_PREFIX,
  ensureWebhook,
  requireApiSecret,
} from './webhook.commands.js';

interface Target {
  readonly project: ProjectConfig;
  readonly cred: BoardCredential;
  readonly source: TrelloSource;
}

function targets(projectId?: string): {
  targets: Target[];
  env: ReturnType<typeof loadOrchestratorEnv>;
} {
  const env = loadOrchestratorEnv();
  const loaded = loadConfig(env.ORCHESTRATOR_CONFIG);
  const creds = resolveBoardCredentials(loaded.credentialRefs);
  const out: Target[] = [];
  for (const project of loaded.config.projects) {
    if (projectId && project.id !== projectId) continue;
    if (!projectId && (!project.enabled || !project.board.webhook.enabled)) continue;
    // Webhooks are Trello-only for now; the other providers poll.
    if (project.board.provider !== 'trello') continue;
    const cred = creds.get(project.board.credentials);
    if (!cred) continue;
    const trello = credentialOf(cred, 'trello', project.board.credentials);
    out.push({ project, cred, source: new TrelloSource(project.board.boardId, trello) });
  }
  return { targets: out, env };
}

function noTargets(projectId?: string): number {
  console.error(
    projectId
      ? `no trello project "${projectId}" in the config`
      : 'no enabled project has board.webhook.enabled: true',
  );
  return 1;
}

export async function listWebhooks(projectId?: string): Promise<number> {
  const { targets: list } = targets(projectId);
  if (list.length === 0) return noTargets(projectId);

  for (const { project, source } of list) {
    const all = await source.listWebhooks();
    const mine = all.filter((w) => w.idModel === project.board.boardId);
    console.log(
      `\n${project.id} (board ${project.board.boardId}) — ${mine.length} registration(s)`,
    );
    for (const w of mine) {
      const ours = w.description.startsWith(DESCRIPTION_PREFIX) ? 'ours' : 'foreign';
      console.log(`  ${w.id}  ${w.active ? 'active ' : 'INACTIVE'}  [${ours}]  ${w.callbackURL}`);
    }
    if (all.length > mine.length) {
      console.log(`  (${all.length - mine.length} more on this token for other boards)`);
    }
  }
  return 0;
}

export async function registerWebhooks(projectId?: string, urlOverride?: string): Promise<number> {
  const { targets: list, env } = targets(projectId);
  if (list.length === 0) return noTargets(projectId);

  const secretPath = env.ORCHESTRATOR_WEBHOOK_PATH_SECRET;
  if (!secretPath) {
    console.error('ORCHESTRATOR_WEBHOOK_PATH_SECRET is not set — see docs/webhooks.md');
    return 1;
  }
  const publicUrl = assertPublicUrl(
    urlOverride ?? env.ORCHESTRATOR_WEBHOOK_PUBLIC_URL,
    list.map((t) => t.project.id),
  );

  let failed = 0;
  for (const { project, cred, source } of list) {
    const callbackURL = callbackUrlFor(
      publicUrl,
      env.ORCHESTRATOR_WEBHOOK_PATH_PREFIX,
      secretPath,
      project.id,
    );
    try {
      requireApiSecret(cred, project.id);
      const r = await ensureWebhook(source, project.board.boardId, project.id, callbackURL);
      console.log(
        `${project.id}: ${r.action} ${r.id}` +
          (r.removed.length ? ` (swept ${r.removed.length} stale)` : ''),
      );
      console.log(`  → ${callbackURL}`);
    } catch (err) {
      failed++;
      console.error(`${project.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return failed === 0 ? 0 : 1;
}

export async function deleteWebhooks(projectId?: string): Promise<number> {
  const { targets: list } = targets(projectId);
  if (list.length === 0) return noTargets(projectId);

  for (const { project, source } of list) {
    const all = await source.listWebhooks();
    const mine = all.filter(
      (w) => w.idModel === project.board.boardId && w.description.startsWith(DESCRIPTION_PREFIX),
    );
    for (const w of mine) {
      await source.deleteWebhook(w.id);
      console.log(`${project.id}: deleted ${w.id} (${w.callbackURL})`);
    }
    if (mine.length === 0) console.log(`${project.id}: nothing of ours to delete`);
  }
  return 0;
}
