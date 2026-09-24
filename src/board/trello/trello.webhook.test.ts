import { describe, expect, it } from 'vitest';

import { mapAction, type RawAction } from './trello.mapper.js';
import {
  mapWebhookPayload,
  parseTrelloWebhook,
  trelloSignature,
  verifyTrelloSignature,
} from './trello.webhook.js';

/**
 * A frozen delivery, signed once by hand. If any of these four constants drift
 * apart the signature breaks, which is exactly what this fixture is for — the
 * HMAC covers the body bytes AND the registered callback URL.
 */
const RAW_BODY =
  '{"action":{"id":"66f1a2b3c4d5e6f708192a3b","idMemberCreator":"5e1f0c9a8b7d6e5f4a3b2c1d","type":"updateCard","date":"2026-09-22T09:14:07.412Z","data":{"card":{"id":"651a2b3c4d5e6f7081920304","idShort":42,"name":"Add a slugify utility"},"listBefore":{"id":"list-backlog","name":"Backlog"},"listAfter":{"id":"list-ready","name":"Ready for Dev"},"board":{"id":"board-abc123"}}},"model":{"id":"board-abc123"}}';
const CALLBACK_URL = 'https://tunnel.example.com/hooks/trello/s3cr3tpath/ai-auto-apply';
const API_SECRET = 'trello-api-secret-0123456789abcdef';
const GOLDEN = 'GhuUaLomfWFY4MfAvX38iiLKNEw=';

const BOARD_ID = 'board-abc123';

describe('trelloSignature', () => {
  it('reproduces the golden vector', () => {
    expect(trelloSignature(RAW_BODY, CALLBACK_URL, API_SECRET)).toBe(GOLDEN);
  });

  it('verifies the golden vector', () => {
    expect(verifyTrelloSignature(RAW_BODY, CALLBACK_URL, API_SECRET, GOLDEN)).toBe(true);
  });

  it('rejects a body with a single byte flipped', () => {
    const tampered = RAW_BODY.replace('idShort":42', 'idShort":43');
    expect(tampered).not.toBe(RAW_BODY);
    expect(verifyTrelloSignature(tampered, CALLBACK_URL, API_SECRET, GOLDEN)).toBe(false);
  });

  it('rejects the same body signed for a different callback URL', () => {
    const other = 'https://tunnel.example.com/hooks/trello/s3cr3tpath/other-project';
    expect(verifyTrelloSignature(RAW_BODY, other, API_SECRET, GOLDEN)).toBe(false);
  });

  it('rejects a wrong secret', () => {
    expect(verifyTrelloSignature(RAW_BODY, CALLBACK_URL, 'not-the-secret', GOLDEN)).toBe(false);
  });

  // The three shapes that would otherwise throw and turn a bad signature into a 500.
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['a different length', 'c2hvcnQ='],
    ['not valid base64', '!!!! not base64 !!!!'],
  ])('returns false, without throwing, for a header that is %s', (_label, header) => {
    expect(() =>
      verifyTrelloSignature(RAW_BODY, CALLBACK_URL, API_SECRET, header as string | undefined),
    ).not.toThrow();
    expect(
      verifyTrelloSignature(RAW_BODY, CALLBACK_URL, API_SECRET, header as string | undefined),
    ).toBe(false);
  });
});

describe('mapWebhookPayload', () => {
  it('maps a card move and agrees with the poller on the event id', () => {
    const body = JSON.parse(RAW_BODY) as { action: RawAction };
    const event = mapWebhookPayload(body, BOARD_ID);

    expect(event).not.toBeNull();
    expect(event).toMatchObject({
      kind: 'card.moved',
      cardId: '651a2b3c4d5e6f7081920304',
      fromColumnId: 'list-backlog',
      toColumnId: 'list-ready',
      actorMemberId: '5e1f0c9a8b7d6e5f4a3b2c1d',
      synthetic: false,
    });

    // The collision that gives us webhook/poll dedupe for free.
    expect(event?.eventId).toBe('trello:66f1a2b3c4d5e6f708192a3b');
    expect(event).toEqual(mapAction(body.action, BOARD_ID));
  });

  it.each(['updateBoard', 'createList', 'addMemberToBoard', 'updateCheckItemStateOnCard'])(
    'ignores the board-level action type %s',
    (type) => {
      const body = JSON.parse(RAW_BODY) as { action: RawAction };
      body.action.type = type;
      expect(mapWebhookPayload(body, BOARD_ID)).toBeNull();
    },
  );

  it.each([
    ['garbage', 'not an object'],
    ['null', null],
    ['an empty object', {}],
    ['an action with no fields', { action: {} }],
    [
      'an action with no card',
      { action: { id: 'a', type: 'updateCard', date: 'd', idMemberCreator: 'm', data: {} } },
    ],
  ])('returns null, without throwing, for %s', (_label, body) => {
    expect(() => mapWebhookPayload(body, BOARD_ID)).not.toThrow();
    expect(mapWebhookPayload(body, BOARD_ID)).toBeNull();
  });
});

describe('parseTrelloWebhook', () => {
  it('keeps the model id so the receiver can verify the board', () => {
    expect(parseTrelloWebhook(JSON.parse(RAW_BODY))?.modelId).toBe(BOARD_ID);
  });

  it('tolerates a delivery with no model block', () => {
    const body = JSON.parse(RAW_BODY) as Record<string, unknown>;
    delete body.model;
    expect(parseTrelloWebhook(body)?.modelId).toBeNull();
  });

  it('tolerates unknown extra fields Trello may add later', () => {
    const body = JSON.parse(RAW_BODY) as { action: Record<string, unknown> };
    body.action.somethingNew = { nested: true };
    expect(parseTrelloWebhook(body)).not.toBeNull();
  });
});
