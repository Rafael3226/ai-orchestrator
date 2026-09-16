import { describe, expect, it } from 'vitest';

import { BoardError } from '../board.source.js';

import { classify, redact } from './trello.http.js';
import { mapAction, mapCard, type RawAction } from './trello.mapper.js';

const action = (over: Partial<RawAction> & { data: RawAction['data'] }): RawAction => ({
  id: 'a1',
  type: 'updateCard',
  date: '2026-01-01T00:00:00.000Z',
  idMemberCreator: 'm1',
  ...over,
});

describe('mapAction', () => {
  it('maps a list change to card.moved with both columns and the actor', () => {
    const e = mapAction(
      action({
        data: {
          card: { id: 'c1' },
          listBefore: { id: 'l1', name: 'A' },
          listAfter: { id: 'l2', name: 'B' },
        },
      }),
      'b1',
    );
    expect(e).toMatchObject({
      kind: 'card.moved',
      fromColumnId: 'l1',
      toColumnId: 'l2',
      actorMemberId: 'm1',
      eventId: 'trello:a1',
    });
  });
  it('maps other updateCard actions to card.updated (which never dispatches)', () => {
    expect(
      mapAction(action({ data: { card: { id: 'c1' }, old: { desc: 'x' } } }), 'b1')?.kind,
    ).toBe('card.updated');
  });
  it('maps archive, labels, members and comments', () => {
    expect(
      mapAction(
        action({ data: { card: { id: 'c1', closed: true }, old: { closed: false } } }),
        'b1',
      )?.kind,
    ).toBe('card.archived');
    expect(
      mapAction(
        action({
          type: 'addLabelToCard',
          data: { card: { id: 'c1' }, label: { id: 'lb', name: 'be' } },
        }),
        'b1',
      ),
    ).toMatchObject({ kind: 'card.labeled', labelId: 'lb' });
    expect(
      mapAction(
        action({ type: 'addMemberToCard', data: { card: { id: 'c1' }, idMember: 'm9' } }),
        'b1',
      ),
    ).toMatchObject({ kind: 'card.assigned', memberId: 'm9' });
    expect(
      mapAction(action({ type: 'commentCard', data: { card: { id: 'c1' }, text: 'hi' } }), 'b1')
        ?.kind,
    ).toBe('card.commented');
  });
  it('returns null for actions without a card or with unknown types', () => {
    expect(mapAction(action({ data: {} }), 'b1')).toBeNull();
    expect(
      mapAction(action({ type: 'addAttachmentToCard', data: { card: { id: 'c1' } } }), 'b1'),
    ).toBeNull();
  });
});

describe('mapCard', () => {
  it('resolves label names through the board map and prefers shortUrl', () => {
    const c = mapCard(
      {
        id: 'c1',
        idShort: 42,
        name: 'T',
        desc: 'D',
        idList: 'l1',
        idLabels: ['lb'],
        url: 'u',
        shortUrl: 's',
        closed: false,
        dateLastActivity: 'now',
      },
      new Map([['lb', 'be']]),
    );
    expect(c).toMatchObject({ shortId: '42', url: 's', labelNames: ['be'], columnId: 'l1' });
  });
});

describe('classify', () => {
  it('preserves status and Retry-After', () => {
    const e = classify(429, '', '7', 'GET /x');
    expect(e).toBeInstanceOf(BoardError);
    expect(e.kind).toBe('rate-limited');
    expect(e.retryAfterMs).toBe(7000);
    expect(e.retryable).toBe(true);
    expect(classify(401, '', null, 'GET /x').kind).toBe('auth');
    expect(classify(404, '', null, 'GET /x').retryable).toBe(false);
    expect(classify(503, '', null, 'GET /x').kind).toBe('unavailable');
  });
  it('redacts credentials from messages', () => {
    expect(redact('https://api.trello.com/1/x?key=abc&token=def')).toBe(
      'https://api.trello.com/1/x?key=***&token=***',
    );
  });
});
