import { describe, expect, it } from 'vitest';

import { stubFetch, type StubRoute } from '../../testing/fetch.stub.js';

import { jiraDate, jqlString, mapHistory } from './jira.mapper.js';
import { JiraSource } from './jira.source.js';

const BOARD = { site: 'acme.atlassian.net', projectKey: 'SHOP' };
const CRED = { kind: 'jira' as const, ref: 'JIRA_TEST', email: 'bot@acme.test', apiToken: 'tok' };

const statuses: StubRoute = {
  match: '/project/SHOP/statuses',
  reply: [
    {
      name: 'Story',
      statuses: [
        { id: '3', name: 'In Progress', statusCategory: { key: 'indeterminate' } },
        { id: '1', name: 'To Do', statusCategory: { key: 'new' } },
        { id: '10', name: 'Done', statusCategory: { key: 'done' } },
      ],
    },
    {
      name: 'Bug',
      statuses: [
        { id: '1', name: 'To Do', statusCategory: { key: 'new' } },
        { id: '4', name: 'In Review', statusCategory: { key: 'indeterminate' } },
      ],
    },
  ],
};

const issue = (
  id: string,
  key: string,
  fields: Record<string, unknown> = {},
  histories?: unknown[],
) => ({
  id,
  key,
  fields: {
    summary: `Issue ${key}`,
    status: { id: '1', name: 'To Do' },
    labels: [],
    updated: '2026-09-24T10:00:00.000+0000',
    created: '2026-09-01T10:00:00.000+0000',
    ...fields,
  },
  ...(histories ? { changelog: { histories } } : {}),
});

const source = (routes: StubRoute[], opts: { watchStatuses?: string[] } = {}) => {
  const stub = stubFetch([statuses, ...routes]);
  return {
    ...stub,
    src: new JiraSource('acme/SHOP', BOARD, CRED, { fetchImpl: stub.fetch, ...opts }),
  };
};

describe('JiraSource', () => {
  it('describes statuses as columns, by id, in category order', async () => {
    const { src, calls } = source([
      { match: '/project/SHOP', reply: { name: 'Shop' } },
      {
        match: '/user/assignable/search',
        reply: [{ accountId: 'a1', displayName: 'Ana', emailAddress: 'ana@acme.test' }],
      },
    ]);
    const t = await src.describe();
    expect(t.name).toBe('Shop (SHOP)');
    expect(t.columns.map((c) => [c.id, c.name])).toEqual([
      ['1', 'To Do'],
      ['3', 'In Progress'],
      ['4', 'In Review'],
      ['10', 'Done'],
    ]);
    expect(t.labels).toEqual([]);
    expect(t.members[0]).toEqual({ id: 'a1', username: 'ana@acme.test', displayName: 'Ana' });
    expect(calls[0]?.headers['authorization']).toBe(
      `Basic ${Buffer.from('bot@acme.test:tok').toString('base64')}`,
    );
  });

  it('lists issues in the watched statuses and maps them', async () => {
    const { src, calls } = source(
      [
        {
          method: 'POST',
          match: '/search/jql',
          reply: {
            issues: [
              issue('100', 'SHOP-7', {
                labels: ['be'],
                assignee: { accountId: 'a1' },
                description: {
                  type: 'doc',
                  version: 1,
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Spec' }] }],
                },
              }),
            ],
            isLast: true,
          },
        },
      ],
      { watchStatuses: ['to do', 'In Review'] },
    );
    const [card] = await src.listCards();
    const search = calls.find((c) => c.url.includes('/search/jql'))?.body as { jql: string };
    expect(search.jql).toBe('project = "SHOP" AND status IN (1, 4) ORDER BY updated DESC');
    expect(card).toMatchObject({
      id: '100',
      shortId: 'SHOP-7',
      url: 'https://acme.atlassian.net/browse/SHOP-7',
      description: 'Spec',
      columnId: '1',
      labelIds: ['be'],
      memberIds: ['a1'],
      changedAt: '2026-09-24T10:00:00.000Z',
    });
  });

  it('pages the enhanced search by token', async () => {
    const { src, calls } = source([
      {
        method: 'POST',
        match: '/search/jql',
        once: true,
        reply: { issues: [issue('1', 'SHOP-1')], nextPageToken: 'p2', isLast: false },
      },
      {
        method: 'POST',
        match: '/search/jql',
        reply: { issues: [issue('2', 'SHOP-2')], isLast: true },
      },
    ]);
    expect((await src.listCards()).map((c) => c.shortId)).toEqual(['SHOP-1', 'SHOP-2']);
    const bodies = calls
      .filter((c) => c.url.includes('/search/jql'))
      .map((c) => c.body as { nextPageToken?: string });
    expect(bodies[1]?.nextPageToken).toBe('p2');
  });

  it('seeds the cursor from the newest update on a cold start', async () => {
    const { src } = source([
      {
        method: 'POST',
        match: '/search/jql',
        reply: {
          issues: [issue('1', 'SHOP-1', { updated: '2026-09-24T12:30:00.000+0200' })],
          isLast: true,
        },
      },
    ]);
    expect(await src.poll(null)).toEqual({ events: [], cursor: '2026-09-24T10:30:00.000Z' });
  });

  it('turns changelog histories into events inside a relative JQL window', async () => {
    const cursor = new Date(Date.now() - 10 * 60_000).toISOString();
    const recent = new Date(Date.now() - 60_000).toISOString().replace('Z', '+0000');
    const { src, calls } = source([
      {
        method: 'POST',
        match: '/search/jql',
        reply: {
          issues: [
            issue('100', 'SHOP-7', { status: { id: '3' }, updated: recent }, [
              {
                id: '9001',
                author: { accountId: 'a1' },
                created: recent,
                items: [
                  {
                    field: 'status',
                    fieldId: 'status',
                    from: '1',
                    fromString: 'To Do',
                    to: '3',
                    toString: 'In Progress',
                  },
                  {
                    field: 'labels',
                    fieldId: 'labels',
                    from: null,
                    fromString: 'be',
                    to: null,
                    toString: 'be urgent',
                  },
                ],
              },
              // Long before the window: ignored.
              {
                id: '10',
                created: '2026-01-01T00:00:00.000+0000',
                items: [
                  { field: 'status', from: '10', fromString: 'Done', to: '1', toString: 'To Do' },
                ],
              },
            ]),
          ],
          isLast: true,
        },
      },
    ]);
    const r = await src.poll(cursor);
    const body = calls.find((c) => c.url.includes('/search/jql'))?.body as {
      jql: string;
      expand: string;
    };
    expect(body.expand).toBe('changelog');
    expect(body.jql).toMatch(/^project = "SHOP" AND updated >= "-1[23]m" ORDER BY updated ASC$/);
    expect(
      r.events.map((e) => [
        e.eventId,
        e.kind,
        e.fromColumnId,
        e.toColumnId,
        e.labelId,
        e.actorMemberId,
      ]),
    ).toEqual([
      ['jira:100:9001:moved', 'card.moved', '1', '3', null, 'a1'],
      ['jira:100:9001:labeled:urgent', 'card.labeled', null, null, 'urgent', 'a1'],
    ]);
    expect(Date.parse(r.cursor ?? '')).toBe(Date.parse(jiraDate(recent) ?? ''));
  });

  it('moves by running the transition that reaches the target status', async () => {
    const { src, calls } = source([
      {
        match: '/issue/100/transitions',
        reply: { transitions: [{ id: '31', name: 'Start', to: { id: '3', name: 'In Progress' } }] },
      },
      { method: 'POST', match: '/issue/100/transitions', reply: { status: 204 } },
    ]);
    await src.moveCard('100', '3');
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ transition: { id: '31' } });
  });

  it('explains when no transition leads to the target status', async () => {
    const { src } = source([
      {
        match: '/issue/100/transitions',
        reply: { transitions: [{ id: '31', name: 'Start', to: { id: '3', name: 'In Progress' } }] },
      },
    ]);
    await expect(src.moveCard('100', '10')).rejects.toMatchObject({
      kind: 'permission',
      message: expect.stringMatching(/no workflow transition.*reachable: In Progress/),
    });
  });

  it('writes labels, assignee and ADF comments; reads comments back as markdown', async () => {
    const { src, calls } = source([
      { method: 'PUT', match: '/issue/100/assignee', reply: { status: 204 } },
      { method: 'PUT', match: '/issue/100', reply: { status: 204 } },
      { method: 'POST', match: '/issue/100/comment', reply: {} },
      {
        match: '/issue/100/comment',
        reply: {
          comments: [
            {
              id: 'c1',
              author: { accountId: 'bot' },
              created: '2026-09-24T10:00:00.000+0000',
              body: {
                type: 'doc',
                version: 1,
                content: [
                  {
                    type: 'paragraph',
                    content: [
                      { type: 'text', text: 'run ' },
                      { type: 'text', text: 'T1', marks: [{ type: 'code' }] },
                    ],
                  },
                ],
              },
            },
          ],
        },
      },
    ]);
    await src.addLabel('100', 'ai-failed');
    await src.removeLabel('100', 'ai-failed');
    await src.assignMember('100', 'a1');
    await src.comment('100', 'Done **well**');
    const puts = calls.filter((c) => c.method === 'PUT').map((c) => c.body);
    expect(puts).toEqual([
      { update: { labels: [{ add: 'ai-failed' }] } },
      { update: { labels: [{ remove: 'ai-failed' }] } },
      { accountId: 'a1' },
    ]);
    const comment = calls.find((c) => c.method === 'POST')?.body as { body: { type: string } };
    expect(comment.body.type).toBe('doc');
    const [c] = await src.listRecentComments('100', 20);
    expect(c?.text).toBe('run `T1`');
    expect(c?.authorId).toBe('bot');
  });

  it('reports the API token owner as the bot identity', async () => {
    const { src } = source([
      { match: '/myself', reply: { accountId: 'bot-acc', emailAddress: 'bot@acme.test' } },
    ]);
    expect(await src.whoAmI()).toEqual({ id: 'bot-acc', username: 'bot@acme.test' });
  });

  it('adds the configured issue types and JQL to every query', async () => {
    const stub = stubFetch([
      statuses,
      { method: 'POST', match: '/search/jql', reply: { issues: [], isLast: true } },
    ]);
    const src = new JiraSource(
      'k',
      { ...BOARD, issueTypes: ['Bug'], jql: 'component = "API"' },
      CRED,
      { fetchImpl: stub.fetch },
    );
    await src.listCards();
    const jql = (stub.calls.find((c) => c.url.includes('/search/jql'))?.body as { jql: string })
      .jql;
    // Only Bug's statuses, minus Done: To Do and In Review.
    expect(jql).toBe(
      'project = "SHOP" AND issuetype IN ("Bug") AND (component = "API") AND status IN (1, 4) ORDER BY updated DESC',
    );
  });
});

describe('jira mapper', () => {
  it('normalizes Jira timestamps', () => {
    expect(jiraDate('2026-09-24T10:00:00.000+0530')).toBe('2026-09-24T04:30:00.000Z');
    expect(jiraDate(undefined)).toBeNull();
  });

  it('maps assignee changes and plain edits', () => {
    const h = (items: unknown[]) =>
      ({ id: 'h', created: '2026-09-24T10:00:00.000+0000', items }) as never;
    expect(
      mapHistory(h([{ field: 'assignee', from: null, to: 'a2' }]), '1', 'b', null)[0],
    ).toMatchObject({
      kind: 'card.assigned',
      memberId: 'a2',
    });
    expect(
      mapHistory(h([{ field: 'assignee', from: 'a2', to: null }]), '1', 'b', null)[0]?.kind,
    ).toBe('card.unassigned');
    expect(
      mapHistory(h([{ field: 'summary', from: null, to: null }]), '1', 'b', null)[0]?.kind,
    ).toBe('card.updated');
  });

  it('quotes JQL strings', () => {
    expect(jqlString('say "hi"')).toBe('"say \\"hi\\""');
  });
});

describe('JiraSource — agent writes', () => {
  it('creates a sub-task under its parent with an ADF description, then reads it back', async () => {
    const { src, calls } = source([
      { method: 'POST', match: /\/issue$/, reply: { id: '2001', key: 'SHOP-9' } },
      { match: '/issue/2001', reply: issue('2001', 'SHOP-9', { summary: 'How to test' }) },
    ]);
    const card = await src.createCard({
      type: 'subtask',
      title: 'How to test',
      description: 'Run **it**',
      parentId: 'SHOP-1',
    });
    expect(card.shortId).toBe('SHOP-9');
    const body = calls.find((c) => c.method === 'POST')?.body as {
      fields: Record<string, unknown>;
    };
    expect(body.fields['project']).toEqual({ key: 'SHOP' });
    expect(body.fields['issuetype']).toEqual({ name: 'Sub-task' });
    expect(body.fields['parent']).toEqual({ key: 'SHOP-1' });
    expect((body.fields['description'] as { type: string }).type).toBe('doc');
  });

  it('honours cardTypes and a numeric parent id', async () => {
    const stub = stubFetch([
      statuses,
      { method: 'POST', match: /\/issue$/, reply: { id: '2002', key: 'SHOP-10' } },
      { match: '/issue/2002', reply: issue('2002', 'SHOP-10') },
    ]);
    const src = new JiraSource('acme/SHOP', { ...BOARD, cardTypes: { subtask: 'Subtask' } }, CRED, {
      fetchImpl: stub.fetch,
    });
    await src.createCard({ type: 'subtask', title: 'x', description: '', parentId: '1001' });
    const body = stub.calls.find((c) => c.method === 'POST')?.body as {
      fields: Record<string, unknown>;
    };
    expect(body.fields['issuetype']).toEqual({ name: 'Subtask' });
    expect(body.fields['parent']).toEqual({ id: '1001' });
  });

  it('sets planning fields with the default ids in one PUT', async () => {
    const { src, calls } = source([
      { method: 'PUT', match: '/issue/SHOP-1', reply: { status: 204 } },
    ]);
    const missing = await src.setFields('SHOP-1', {
      priority: 'high',
      storyPoints: 5,
      startDate: '2026-10-01',
      dueDate: '2026-10-08',
    });
    expect(missing).toEqual([]);
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      fields: {
        priority: { name: 'High' },
        customfield_10016: 5,
        customfield_10015: '2026-10-01',
        duedate: '2026-10-08',
      },
    });
  });

  it('drops a field Jira rejects and keeps the rest', async () => {
    const { src, calls } = source([
      {
        method: 'PUT',
        match: '/issue/SHOP-1',
        once: true,
        reply: {
          status: 400,
          body: { errorMessages: [], errors: { customfield_10015: 'Field cannot be set.' } },
        },
      },
      { method: 'PUT', match: '/issue/SHOP-1', reply: { status: 204 } },
    ]);
    const missing = await src.setFields('SHOP-1', { storyPoints: 3, startDate: '2026-10-01' });
    expect(missing).toEqual(['startDate']);
    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(2);
    expect(puts[1]?.body).toEqual({ fields: { customfield_10016: 3 } });
  });

  it('lists children with a parent JQL', async () => {
    const { src, calls } = source([
      {
        method: 'POST',
        match: '/search/jql',
        reply: { issues: [issue('3001', 'SHOP-11')], isLast: true },
      },
    ]);
    const kids = await src.listChildren('SHOP-1');
    expect(kids.map((k) => k.shortId)).toEqual(['SHOP-11']);
    expect((calls.at(-1)?.body as { jql: string }).jql).toContain('parent = "SHOP-1"');
  });
});
