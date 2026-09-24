import type { RegisteredWebhook, WebhookRegistrar } from '../board/board.source.js';
import type { BoardCredential } from '../config/credentials.js';

/** Marks the webhooks this daemon owns, so a sweep never touches someone else's. */
export const DESCRIPTION_PREFIX = 'ai-orchestrator';

export const describeWebhook = (projectId: string): string => `${DESCRIPTION_PREFIX} ${projectId}`;

export interface EnsureResult {
  readonly id: string;
  readonly action: 'created' | 'reused' | 'replaced';
  /** Dead registrations for this board that were swept away. */
  readonly removed: readonly string[];
}

/**
 * Three Trello credentials now, and they are easy to confuse — so say exactly
 * which one is missing and where to find it.
 */
export function requireApiSecret(cred: BoardCredential, projectId: string): string {
  if (cred.kind !== 'trello') {
    throw new Error(
      `project ${projectId}: webhooks are only implemented for trello, not ${cred.kind}`,
    );
  }
  if (!cred.apiSecret) {
    throw new Error(
      `project ${projectId}: webhooks need the API secret — set ${cred.ref}_API_SECRET ` +
        '(the OAuth secret shown next to your Trello API key at ' +
        'https://trello.com/power-ups/admin). It is neither the API key nor the token.',
    );
  }
  return cred.apiSecret;
}

/**
 * Idempotent, and safe to run on every boot — which it must be, because Trello
 * deletes a webhook that fails persistently, so a daemon that was down for a
 * while may come back to find its registration simply gone.
 *
 * Also sweeps our own dead registrations for this board. Dev tunnel URLs change
 * on every restart, and Trello caps webhooks per token, so without the sweep
 * you eventually cannot register at all.
 */
export async function ensureWebhook(
  registrar: WebhookRegistrar,
  boardId: string,
  projectId: string,
  callbackURL: string,
): Promise<EnsureResult> {
  const description = describeWebhook(projectId);
  const all = await registrar.listWebhooks();
  const mine = all.filter((w) => w.idModel === boardId);

  const exact = mine.find((w) => w.callbackURL === callbackURL);
  const removed: string[] = [];

  const sweep = async (keep: string): Promise<void> => {
    for (const w of mine) {
      if (w.id === keep) continue;
      if (!w.description.startsWith(DESCRIPTION_PREFIX)) continue;
      if (w.callbackURL === callbackURL) continue;
      await registrar.deleteWebhook(w.id);
      removed.push(w.id);
    }
  };

  if (exact) {
    await sweep(exact.id);
    return { id: exact.id, action: 'reused', removed };
  }

  const stale = mine.find((w) => w.description.startsWith(DESCRIPTION_PREFIX));
  if (stale) {
    // The normal dev-tunnel case. Trello re-runs its callback verification on
    // an update, so fall back to delete + create when the PUT is refused.
    let updated: RegisteredWebhook;
    try {
      updated = await registrar.updateWebhook(stale.id, callbackURL);
    } catch {
      await registrar.deleteWebhook(stale.id);
      updated = await registrar.createWebhook(callbackURL, description);
    }
    await sweep(updated.id);
    return { id: updated.id, action: 'replaced', removed };
  }

  const created = await registrar.createWebhook(callbackURL, description);
  await sweep(created.id);
  return { id: created.id, action: 'created', removed };
}

export async function removeWebhook(registrar: WebhookRegistrar, id: string): Promise<void> {
  await registrar.deleteWebhook(id);
}

/** The exact string that gets registered, and that the HMAC is computed over. */
export function callbackUrlFor(
  publicUrl: string,
  pathPrefix: string,
  pathSecret: string,
  projectId: string,
): string {
  return `${publicUrl.replace(/\/+$/, '')}${pathPrefix}/${pathSecret}/${projectId}`;
}

export function assertPublicUrl(
  publicUrl: string | undefined,
  projectIds: readonly string[],
): string {
  if (!publicUrl) {
    throw new Error(
      `webhooks are enabled for ${projectIds.join(', ')} but ORCHESTRATOR_WEBHOOK_PUBLIC_URL is not set — ` +
        'point it at your tunnel, e.g. https://<name>.trycloudflare.com (see docs/webhooks.md)',
    );
  }
  if (!publicUrl.startsWith('https://')) {
    throw new Error(
      `ORCHESTRATOR_WEBHOOK_PUBLIC_URL must be https (Trello refuses http and localhost); got ${publicUrl}`,
    );
  }
  return publicUrl.replace(/\/+$/, '');
}
