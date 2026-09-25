import { describe, expect, it } from 'vitest';

import { stubFetch, type StubRoute } from '../../testing/fetch.stub.js';

import { TrelloHttp } from './trello.http.js';
import { TrelloRateLimiter } from './trello.rate-limiter.js';
import { TrelloSource } from './trello.source.js';

const CRED = {
  kind: 'trello' as const,
  ref: 'TRELLO_TEST',
  apiKey: 'k',
  token: 't',
  apiSecret: undefined,
};

const source = (routes: StubRoute[]) => {
  const stub = stubFetch(routes);
  const http = new TrelloHttp(CRED, new TrelloRateLimiter(), stub.fetch);
  return { ...stub, src: new TrelloSource('b1', CRED, http) };
};

const raw = {
  id: 'c9',
  idShort: 9,
  name: 'New',
  desc: 'body',
  idList: 'l1',
  url: 'https://trello.com/c/c9',
  closed: false,
  dateLastActivity: '2026-09-24T10:00:00.000Z',
};

describe('TrelloSource — agent writes', () => {
  it('creates a card in the given list', async () => {
    const { src, calls } = source([{ method: 'POST', match: '/cards?', reply: raw }]);
    const card = await src.createCard({
      type: 'story',
      title: 'New',
      description: 'body',
      columnId: 'l1',
    });
    expect(card.shortId).toBe('9');
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get('idList')).toBe('l1');
    expect(url.searchParams.get('name')).toBe('New');
  });

  it('refuses to create a card without a list', async () => {
    const { src } = source([]);
    await expect(
      src.createCard({ type: 'story', title: 'x', description: '' }),
    ).rejects.toMatchObject({ kind: 'permission' });
  });

  it('stores start and due natively and reports priority and points as unsupported', async () => {
    const { src, calls } = source([{ method: 'PUT', match: '/cards/c9', reply: raw }]);
    const missing = await src.setFields('c9', {
      priority: 'high',
      storyPoints: 3,
      startDate: '2026-10-01',
      dueDate: '2026-10-08',
    });
    expect(missing).toEqual(['priority', 'storyPoints']);
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get('start')).toBe('2026-10-01T00:00:00.000Z');
    expect(url.searchParams.get('due')).toBe('2026-10-08T00:00:00.000Z');
    expect(src.capabilities.canCreateSubtask).toBe(false);
  });
});
