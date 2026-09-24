import { describe, expect, it, vi } from 'vitest';

import { FakeBoardSource } from '../testing/fake.board.source.js';

import type { BoardSource } from './board.source.js';
import type { BoardEvent } from './board.types.js';
import { WebhookBufferedSource } from './board.webhook-buffer.js';

function board(): FakeBoardSource {
  return new FakeBoardSource('b1', ['Backlog', 'Ready for Dev'], ['be']);
}

function buffered(
  inner: BoardSource,
  opts: Partial<{ maxBuffered: number; onWake: () => void }> = {},
): WebhookBufferedSource {
  return new WebhookBufferedSource(inner, { maxBuffered: opts.maxBuffered ?? 500, ...opts });
}

function event(id: string): BoardEvent {
  return {
    eventId: id,
    kind: 'card.moved',
    provider: 'trello',
    boardId: 'b1',
    cardId: 'card-1',
    occurredAt: new Date().toISOString(),
    actorMemberId: 'human',
    fromColumnId: 'list-0',
    toColumnId: 'list-1',
    labelId: null,
    memberId: null,
    card: null,
    synthetic: false,
  };
}

describe('WebhookBufferedSource', () => {
  it('drains buffered events before polled ones, oldest first', async () => {
    const inner = board();
    const card = inner.addCard('1', 'A card', 'Backlog');
    const src = buffered(inner);
    src.push([event('wh:a'), event('wh:b')], { wake: false });

    const result = await src.poll(null);

    expect(result.events.slice(0, 2).map((e) => e.eventId)).toEqual(['wh:a', 'wh:b']);
    // The inner source's own creation event follows the buffered ones.
    expect(result.events.map((e) => e.cardId)).toContain(card.id);
  });

  it('never takes the cursor from the buffer', async () => {
    const inner = board();
    inner.addCard('1', 'A card', 'Backlog');
    const src = buffered(inner);
    const expected = (await inner.poll(null)).cursor;

    src.push([event('wh:zzz')], { wake: false });
    const result = await src.poll(null);

    expect(result.cursor).toBe(expected);
  });

  it('always polls the inner source, even when the buffer is full', async () => {
    const inner = board();
    const spy = vi.spyOn(inner, 'poll');
    const src = buffered(inner, { maxBuffered: 1 });
    src.push([event('wh:a'), event('wh:b')], { wake: false });

    await src.poll('0');

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('0');
  });

  it('drops the oldest events on overflow and reports it once', async () => {
    const src = buffered(board(), { maxBuffered: 3 });
    src.push([event('1'), event('2'), event('3'), event('4'), event('5')], { wake: false });

    expect(src.stats()).toMatchObject({ buffered: 3, deliveredTotal: 5, droppedTotal: 2 });
    const drained = await src.poll(null);
    expect(drained.events.slice(0, 3).map((e) => e.eventId)).toEqual(['3', '4', '5']);

    expect(src.consumeOverflow()).toBe(true);
    expect(src.consumeOverflow()).toBe(false);
  });

  it('wakes only when the delivery asks for it', () => {
    const onWake = vi.fn();
    const src = buffered(board(), { onWake });

    src.push([event('a')], { wake: false });
    expect(onWake).not.toHaveBeenCalled();

    src.push([event('b')], { wake: true });
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it('does not wake or count an empty delivery', () => {
    const onWake = vi.fn();
    const src = buffered(board(), { onWake });

    src.push([], { wake: true });

    expect(onWake).not.toHaveBeenCalled();
    expect(src.stats()).toMatchObject({ deliveredTotal: 0, lastDeliveryAt: null });
  });

  it('forwards every other BoardSource member to the inner source', async () => {
    // Table-driven on purpose: a new BoardSource member that this decorator
    // forgets to delegate fails here rather than in production.
    const inner = board();
    const card = inner.addCard('1', 'A card', 'Backlog');
    const src = buffered(inner);

    type Method = Extract<
      keyof BoardSource,
      | 'describe'
      | 'listCards'
      | 'getCard'
      | 'moveCard'
      | 'comment'
      | 'listRecentComments'
      | 'addLabel'
      | 'removeLabel'
      | 'assignMember'
      | 'whoAmI'
    >;
    const calls: [Method, unknown[]][] = [
      ['describe', []],
      ['listCards', []],
      ['getCard', [card.id]],
      ['moveCard', [card.id, inner.columnId('Ready for Dev')]],
      ['comment', [card.id, 'hi']],
      ['listRecentComments', [card.id, 5]],
      ['addLabel', [card.id, inner.labelId('be')]],
      ['removeLabel', [card.id, inner.labelId('be')]],
      ['assignMember', [card.id, 'bot']],
      ['whoAmI', []],
    ];

    for (const [name, args] of calls) {
      const spy = vi.spyOn(inner, name);
      await (src[name] as (...a: unknown[]) => Promise<unknown>)(...args);
      expect(spy, `${name} was not delegated`).toHaveBeenCalledWith(...args);
      spy.mockRestore();
    }

    expect(src.provider).toBe(inner.provider);
    expect(src.boardId).toBe(inner.boardId);
    expect(src.capabilities).toBe(inner.capabilities);
  });
});
