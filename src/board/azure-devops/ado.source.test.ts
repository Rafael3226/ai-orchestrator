import { describe, expect, it } from 'vitest';

import { stubFetch, type StubRoute } from '../../testing/fetch.stub.js';

import { mapUpdate } from './ado.mapper.js';
import { AdoSource } from './ado.source.js';

const BOARD = { organization: 'contoso', project: 'Web', workItemTypes: ['User Story', 'Bug'] };
const CRED = { kind: 'azure-devops' as const, ref: 'ADO_TEST', pat: 'pat' };

const states: StubRoute[] = [
  {
    match: '/workitemtypes/User%20Story/states',
    reply: {
      value: [
        { name: 'Closed', category: 'Completed' },
        { name: 'New', category: 'Proposed' },
        { name: 'Active', category: 'InProgress' },
        { name: 'Resolved', category: 'Resolved' },
        { name: 'Removed', category: 'Removed' },
      ],
    },
  },
  {
    match: '/workitemtypes/Bug/states',
    reply: {
      value: [
        { name: 'Active', category: 'InProgress' },
        { name: 'Ready', category: 'Proposed' },
      ],
    },
  },
];

const item = (id: number, fields: Record<string, unknown>, rev = 3) => ({
  id,
  rev,
  fields: {
    'System.Id': id,
    'System.Title': `Item ${id}`,
    'System.State': 'Ready',
    'System.ChangedDate': '2026-09-24T10:00:00Z',
    ...fields,
  },
});

const source = (routes: StubRoute[], watchStates?: string[]) => {
  const stub = stubFetch([...states, ...routes]);
  return {
    ...stub,
    src: new AdoSource('contoso/Web', BOARD, CRED, {
      fetchImpl: stub.fetch,
      ...(watchStates ? { watchStates } : {}),
    }),
  };
};

describe('AdoSource', () => {
  it('describes the union of work item states in process order, and tags as labels', async () => {
    const { src, calls } = source([
      { match: '/wit/tags', reply: { value: [{ id: 't1', name: 'be' }] } },
      { match: '/_apis/projects/Web?', reply: { defaultTeam: { id: 'team1' } } },
      {
        match: '/teams/team1/members',
        reply: {
          value: [{ identity: { id: 'u1', displayName: 'Ana', uniqueName: 'ana@x.test' } }],
        },
      },
    ]);
    const t = await src.describe();
    expect(t.columns.map((c) => c.name)).toEqual([
      'New',
      'Ready',
      'Active',
      'Resolved',
      'Closed',
      'Removed',
    ]);
    expect(t.columns[0]).toEqual({ id: 'New', name: 'New', position: 0 });
    expect(t.labels).toEqual([{ id: 'be', name: 'be', color: null }]);
    expect(t.members).toEqual([{ id: 'u1', username: 'ana@x.test', displayName: 'Ana' }]);
    expect(calls[0]?.headers['authorization']).toBe(
      `Basic ${Buffer.from(':pat').toString('base64')}`,
    );
  });

  it('lists work items in the watched states and maps them to cards', async () => {
    const { src, calls } = source(
      [
        { method: 'POST', match: '/wit/wiql', reply: { workItems: [{ id: 7 }, { id: 3 }] } },
        {
          method: 'POST',
          match: '/wit/workitemsbatch',
          // Out of order on purpose: the batch API does not promise order.
          reply: {
            value: [
              item(3, { 'System.State': 'Removed' }),
              item(7, {
                'System.Description': '<p>Do <b>it</b></p>',
                'System.Tags': 'be; needs-human',
                'System.AssignedTo': { id: 'u1', uniqueName: 'ana@x.test' },
              }),
            ],
          },
        },
      ],
      ['Ready', "Won't Fix"],
    );
    const cards = await src.listCards();
    const wiql = calls.find((c) => c.url.includes('/wiql'));
    expect((wiql?.body as { query: string }).query).toContain(
      "[System.State] IN ('Ready', 'Won''t Fix')",
    );
    expect((wiql?.body as { query: string }).query).toContain(
      "[System.WorkItemType] IN ('User Story', 'Bug')",
    );
    expect(cards.map((c) => c.id)).toEqual(['7', '3']);
    expect(cards[0]).toMatchObject({
      shortId: '7',
      url: 'https://dev.azure.com/contoso/Web/_workitems/edit/7',
      description: 'Do **it**',
      columnId: 'Ready',
      labelNames: ['be', 'needs-human'],
      memberIds: ['u1'],
      closed: false,
    });
    expect(cards[1]?.closed).toBe(true);
  });

  it('seeds the cursor from the newest change on a cold start', async () => {
    const { src } = source([
      { method: 'POST', match: '/wit/wiql', reply: { workItems: [{ id: 9 }] } },
      {
        method: 'POST',
        match: '/wit/workitemsbatch',
        reply: { value: [item(9, { 'System.ChangedDate': '2026-09-24T11:22:33.100Z' })] },
      },
    ]);
    expect(await src.poll(null)).toEqual({ events: [], cursor: '2026-09-24T11:22:33.100Z' });
  });

  it('turns revision updates into events and advances the watermark', async () => {
    const { src, calls } = source([
      { method: 'POST', match: '/wit/wiql', reply: { workItems: [{ id: 5 }] } },
      {
        method: 'POST',
        match: '/wit/workitemsbatch',
        reply: {
          value: [
            item(5, { 'System.ChangedDate': '2026-09-24T10:05:00Z', 'System.State': 'Active' }, 4),
          ],
        },
      },
      {
        match: '/workItems/5/updates',
        reply: {
          value: [
            {
              id: 3,
              rev: 3,
              revisedBy: { id: 'u1' },
              // Older than the overlap window: dropped.
              fields: {
                'System.ChangedDate': { newValue: '2026-09-24T09:00:00Z' },
                'System.State': { oldValue: 'New', newValue: 'Ready' },
              },
            },
            {
              id: 4,
              rev: 4,
              revisedBy: { id: 'u1' },
              fields: {
                'System.ChangedDate': { newValue: '2026-09-24T10:05:00Z' },
                'System.State': { oldValue: 'Ready', newValue: 'Active' },
                'System.Tags': { oldValue: 'be', newValue: 'be; urgent' },
              },
            },
          ],
        },
      },
    ]);
    const r = await src.poll('2026-09-24T10:00:00.000Z');
    expect(r.cursor).toBe('2026-09-24T10:05:00.000Z');
    expect(
      r.events.map((e) => [e.eventId, e.kind, e.fromColumnId, e.toColumnId, e.labelId]),
    ).toEqual([
      ['ado:5:4:moved', 'card.moved', 'Ready', 'Active', null],
      ['ado:5:4:labeled:urgent', 'card.labeled', null, null, 'urgent'],
    ]);
    expect(r.events[0]?.actorMemberId).toBe('u1');
    // The WIQL window reaches back past the cursor by the overlap, in whole seconds.
    const wiql = calls.find((c) => c.url.includes('/wiql'));
    expect((wiql?.body as { query: string }).query).toContain(
      "[System.ChangedDate] > '2026-09-24T09:58:00Z'",
    );
    // Only the tail of the history is read: rev 4 minus the window floors at 0.
    expect(calls.find((c) => c.url.includes('/updates'))?.url).toContain('%24skip=0');
  });

  it('explains an invalid state transition instead of retrying it', async () => {
    const { src } = source([
      {
        method: 'PATCH',
        match: '/wit/workitems/5',
        reply: { status: 400, body: { message: 'TF401320: rule error' } },
      },
    ]);
    await expect(src.moveCard('5', 'Closed')).rejects.toMatchObject({
      kind: 'permission',
      message: expect.stringMatching(/cannot move to state "Closed".*TF401320/s),
    });
  });

  it('adds a tag with a rev test, and is a no-op when it is already there', async () => {
    const { src, calls } = source([
      { match: '/wit/workitems/5?', reply: item(5, { 'System.Tags': 'be' }, 12) },
      { method: 'PATCH', match: '/wit/workitems/5', reply: {} },
    ]);
    await src.addLabel('5', 'be');
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);

    await src.addLabel('5', 'ai-failed');
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.headers['content-type']).toBe('application/json-patch+json');
    expect(patch?.body).toEqual([
      { op: 'test', path: '/rev', value: 12 },
      { op: 'add', path: '/fields/System.Tags', value: 'be; ai-failed' },
    ]);
  });

  it('re-reads and retries once when a concurrent edit fails the rev test', async () => {
    const { src, calls } = source([
      { match: '/wit/workitems/5?', reply: item(5, { 'System.Tags': 'be; ai-failed' }, 2) },
      {
        method: 'PATCH',
        match: '/wit/workitems/5',
        once: true,
        reply: { status: 400, body: 'rev mismatch' },
      },
      { method: 'PATCH', match: '/wit/workitems/5', reply: {} },
    ]);
    await src.removeLabel('5', 'AI-FAILED');
    const patches = calls.filter((c) => c.method === 'PATCH');
    expect(patches).toHaveLength(2);
    expect((patches[1]?.body as { value: unknown }[])[1]?.value).toBe('be');
  });

  it('assigns by resolving an identity id to its unique name', async () => {
    const id = '11111111-2222-3333-4444-555555555555';
    const { src, calls } = source([
      {
        match: 'vssps.dev.azure.com/contoso/_apis/identities',
        reply: { value: [{ properties: { Account: { $value: 'bot@x.test' } } }] },
      },
      { method: 'PATCH', match: '/wit/workitems/5', reply: {} },
    ]);
    await src.assignMember('5', id);
    await src.assignMember('5', id); // cached: one identity lookup
    expect(calls.filter((c) => c.url.includes('identities'))).toHaveLength(1);
    expect((calls.find((c) => c.method === 'PATCH')?.body as { value: string }[])[0]?.value).toBe(
      'bot@x.test',
    );
  });

  it('reports the PAT owner as the bot identity', async () => {
    const { src } = source([
      {
        match: '/_apis/connectionData',
        reply: {
          authenticatedUser: { id: 'bot-id', properties: { Account: { $value: 'bot@x.test' } } },
        },
      },
    ]);
    expect(await src.whoAmI()).toEqual({ id: 'bot-id', username: 'bot@x.test' });
  });

  it('posts comments as markdown and reads them back', async () => {
    const { src, calls } = source([
      { method: 'POST', match: '/workItems/5/comments', reply: {} },
      {
        match: '/workItems/5/comments',
        reply: {
          comments: [
            {
              id: 2,
              text: 'run `T1`',
              format: 'markdown',
              createdBy: { id: 'bot' },
              createdDate: 'd2',
            },
            { id: 1, text: '<p>hi &amp; bye</p>', createdBy: { id: 'u1' }, createdDate: 'd1' },
          ],
        },
      },
    ]);
    await src.comment('5', '## Report');
    expect(calls[calls.length - 1]?.url).toContain('format=markdown');
    const recent = await src.listRecentComments('5', 20);
    expect(recent.map((c) => c.text)).toEqual(['run `T1`', 'hi & bye']);
  });
});

describe('mapUpdate', () => {
  it('reports creation, assignment and comments', () => {
    const events = mapUpdate(
      {
        id: 1,
        rev: 1,
        revisedBy: { id: 'u1' },
        fields: {
          'System.State': { newValue: 'New' },
          'System.AssignedTo': { newValue: { id: 'u2' } },
          'System.History': { newValue: 'first!' },
        },
      },
      8,
      'b',
      null,
    );
    expect(events.map((e) => e.kind)).toEqual(['card.created', 'card.assigned', 'card.commented']);
    expect(events[1]?.memberId).toBe('u2');
    expect(new Set(events.map((e) => e.eventId)).size).toBe(3);
  });

  it('reports an unassignment and a plain edit', () => {
    expect(
      mapUpdate(
        { id: 2, rev: 2, fields: { 'System.AssignedTo': { oldValue: { id: 'u2' } } } },
        8,
        'b',
        null,
      ).map((e) => [e.kind, e.memberId]),
    ).toEqual([['card.unassigned', 'u2']]);
    expect(
      mapUpdate(
        { id: 3, rev: 3, fields: { 'System.Title': { oldValue: 'a', newValue: 'b' } } },
        8,
        'b',
        null,
      ).map((e) => e.kind),
    ).toEqual(['card.updated']);
  });
});
