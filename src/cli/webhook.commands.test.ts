import { describe, expect, it, vi } from 'vitest';

import type { RegisteredWebhook, WebhookRegistrar } from '../board/board.source.js';
import type { BoardCredential } from '../config/credentials.js';

import {
  assertPublicUrl,
  callbackUrlFor,
  DESCRIPTION_PREFIX,
  ensureWebhook,
  requireApiSecret,
} from './webhook.commands.js';

const BOARD = 'board-abc123';
const PROJECT = 'ai-auto-apply';
const URL_NOW = 'https://new-tunnel.trycloudflare.com/hooks/trello/s3cr3t/ai-auto-apply';
const URL_OLD = 'https://old-tunnel.trycloudflare.com/hooks/trello/s3cr3t/ai-auto-apply';

function hook(over: Partial<RegisteredWebhook> = {}): RegisteredWebhook {
  return {
    id: `wh-${Math.random().toString(36).slice(2, 8)}`,
    idModel: BOARD,
    callbackURL: URL_NOW,
    description: `${DESCRIPTION_PREFIX} ${PROJECT}`,
    active: true,
    ...over,
  };
}

function registrar(existing: RegisteredWebhook[] = []): WebhookRegistrar & {
  created: { callbackURL: string; description: string }[];
  updated: { id: string; callbackURL: string }[];
  deleted: string[];
} {
  const created: { callbackURL: string; description: string }[] = [];
  const updated: { id: string; callbackURL: string }[] = [];
  const deleted: string[] = [];
  return {
    created,
    updated,
    deleted,
    listWebhooks: async () => existing,
    createWebhook: async (callbackURL, description) => {
      created.push({ callbackURL, description });
      return hook({ callbackURL, description });
    },
    updateWebhook: async (id, callbackURL) => {
      updated.push({ id, callbackURL });
      return hook({ id, callbackURL });
    },
    deleteWebhook: async (id) => {
      deleted.push(id);
    },
  };
}

describe('ensureWebhook', () => {
  it('creates one when the board has none', async () => {
    const r = registrar([]);

    const result = await ensureWebhook(r, BOARD, PROJECT, URL_NOW);

    expect(result.action).toBe('created');
    expect(r.created).toEqual([
      { callbackURL: URL_NOW, description: `${DESCRIPTION_PREFIX} ${PROJECT}` },
    ]);
    expect(r.deleted).toEqual([]);
  });

  it('reuses an identical registration without writing anything', async () => {
    const existing = hook();
    const r = registrar([existing]);

    const result = await ensureWebhook(r, BOARD, PROJECT, URL_NOW);

    expect(result).toMatchObject({ action: 'reused', id: existing.id });
    expect(r.created).toEqual([]);
    expect(r.updated).toEqual([]);
    expect(r.deleted).toEqual([]);
  });

  it('updates a stale tunnel URL in place', async () => {
    const existing = hook({ callbackURL: URL_OLD });
    const r = registrar([existing]);

    const result = await ensureWebhook(r, BOARD, PROJECT, URL_NOW);

    expect(result.action).toBe('replaced');
    expect(r.updated).toEqual([{ id: existing.id, callbackURL: URL_NOW }]);
    expect(r.created).toEqual([]);
  });

  it('falls back to delete + create when Trello refuses the update', async () => {
    const existing = hook({ callbackURL: URL_OLD });
    const r = registrar([existing]);
    r.updateWebhook = vi.fn().mockRejectedValue(new Error('400 invalid callbackURL'));

    const result = await ensureWebhook(r, BOARD, PROJECT, URL_NOW);

    expect(result.action).toBe('replaced');
    expect(r.deleted).toContain(existing.id);
    expect(r.created).toEqual([
      { callbackURL: URL_NOW, description: `${DESCRIPTION_PREFIX} ${PROJECT}` },
    ]);
  });

  it('sweeps our own dead registrations for the same board', async () => {
    const live = hook();
    const dead1 = hook({ callbackURL: URL_OLD });
    const dead2 = hook({ callbackURL: 'https://even-older.example.com/h' });
    const r = registrar([live, dead1, dead2]);

    const result = await ensureWebhook(r, BOARD, PROJECT, URL_NOW);

    expect(result.action).toBe('reused');
    expect(r.deleted.sort()).toEqual([dead1.id, dead2.id].sort());
  });

  it('never touches a webhook it does not own or one for another board', async () => {
    const live = hook();
    const foreign = hook({ callbackURL: URL_OLD, description: 'someone else' });
    const otherBoard = hook({ idModel: 'board-other', callbackURL: URL_OLD });
    const r = registrar([live, foreign, otherBoard]);

    await ensureWebhook(r, BOARD, PROJECT, URL_NOW);

    expect(r.deleted).toEqual([]);
  });
});

describe('requireApiSecret', () => {
  const cred = (apiSecret?: string): BoardCredential => ({
    kind: 'trello',
    ref: 'TRELLO_MAIN',
    apiKey: 'k',
    token: 't',
    apiSecret,
  });

  it('returns the secret when present', () => {
    expect(requireApiSecret(cred('s3cr3t'), PROJECT)).toBe('s3cr3t');
  });

  it('names the project and the exact env var when missing', () => {
    expect(() => requireApiSecret(cred(), PROJECT)).toThrowError(
      /project ai-auto-apply.*TRELLO_MAIN_API_SECRET/s,
    );
  });
});

describe('callbackUrlFor / assertPublicUrl', () => {
  it('builds the registered URL and tolerates a trailing slash', () => {
    expect(callbackUrlFor('https://t.example.com/', '/hooks/trello', 's3cr3t', PROJECT)).toBe(
      'https://t.example.com/hooks/trello/s3cr3t/ai-auto-apply',
    );
  });

  it('rejects a missing public URL, naming the projects that need it', () => {
    expect(() => assertPublicUrl(undefined, [PROJECT])).toThrowError(/ai-auto-apply/);
  });

  it('rejects http, which Trello refuses', () => {
    expect(() => assertPublicUrl('http://localhost:7788', [PROJECT])).toThrowError(/https/);
  });

  it('strips a trailing slash from a valid URL', () => {
    expect(assertPublicUrl('https://t.example.com/', [PROJECT])).toBe('https://t.example.com');
  });
});
