import { afterEach, describe, expect, it } from 'vitest';

import type { StoryDraft } from '../server/chat.types.js';

import { ChatStore } from './chat.store.js';
import { SqliteStore } from './sqlite.store.js';

const draft: StoryDraft = {
  type: 'story',
  title: 'Export arrivals as CSV',
  userStory: 'As an officer, I want a CSV export, so that I can report monthly.',
  description: '',
  acceptanceCriteria: ['Given arrivals, when I export, then I get a CSV'],
  businessDecisions: [{ title: 'Monthly only', rationale: 'Reporting cadence is monthly' }],
  openQuestions: [],
};

const open: SqliteStore[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

function chatStore(): ChatStore {
  const db = new SqliteStore(':memory:');
  open.push(db);
  return new ChatStore(db);
}

describe('ChatStore', () => {
  it('creates a session and keeps messages in order', () => {
    const store = chatStore();
    const s = store.create('chat_1', 'pa');
    expect(s).toMatchObject({ id: 'chat_1', projectId: 'pa', status: 'open', costUsd: 0 });
    store.addMessage('chat_1', 'user', 'hello');
    store.addMessage('chat_1', 'assistant', 'hi — what do you need?');
    expect(store.messages('chat_1').map((m) => [m.role, m.text])).toEqual([
      ['user', 'hello'],
      ['assistant', 'hi — what do you need?'],
    ]);
  });

  it('accumulates cost and keeps the last known SDK session', () => {
    const store = chatStore();
    store.create('chat_1', 'pa');
    store.finishTurn('chat_1', 'sdk-a', 0.25);
    store.finishTurn('chat_1', null, 0.5);
    expect(store.get('chat_1')).toMatchObject({ sdkSessionId: 'sdk-a', costUsd: 0.75 });
  });

  it('round-trips the draft and the created card', () => {
    const store = chatStore();
    store.create('chat_1', 'pa');
    store.setDraft('chat_1', draft);
    store.setStatus('chat_1', 'submitted');
    expect(store.get('chat_1')).toMatchObject({ status: 'submitted', draft });
    store.setCreated('chat_1', { id: '10001', shortId: 'EDCARD-9', url: 'https://x/9' });
    expect(store.get('chat_1')).toMatchObject({
      status: 'created',
      createdCard: { shortId: 'EDCARD-9' },
    });
  });

  it('returns null for an unknown session', () => {
    expect(chatStore().get('nope')).toBeNull();
  });
});
