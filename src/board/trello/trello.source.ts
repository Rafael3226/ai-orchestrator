import type { TrelloCredential } from '../../config/credentials.js';
import {
  BoardError,
  type BoardCapabilities,
  type BoardPollResult,
  type BoardSource,
  type RegisteredWebhook,
  type WebhookRegistrar,
} from '../board.source.js';
import type { BoardCard, BoardComment, BoardTopology } from '../board.types.js';

import { TrelloHttp } from './trello.http.js';
import {
  ACTION_FILTER,
  CARD_FIELDS,
  mapAction,
  mapCard,
  mapColumn,
  mapComment,
  mapLabel,
  mapMember,
  type RawAction,
  type RawCard,
  type RawLabel,
  type RawList,
  type RawMember,
} from './trello.mapper.js';

/**
 * Trello via the actions feed: one request per poll returns exact transitions
 * (`listBefore`/`listAfter`) plus the actor, which is what the router and the
 * loop guard need. Card snapshots are only fetched lazily for routed events
 * and on the periodic reconcile.
 */
export class TrelloSource implements BoardSource, WebhookRegistrar {
  readonly provider = 'trello' as const;
  readonly capabilities: BoardCapabilities = {
    hasChangeFeed: true,
    canComment: true,
    canMoveCard: true,
    canAssignMember: true,
    canAddLabel: true,
    labelsAreFreeform: false,
    canRegisterWebhook: true,
  };
  private readonly http: TrelloHttp;
  private readonly cred: TrelloCredential;
  private labelsById = new Map<string, string>();

  constructor(
    readonly boardId: string,
    cred: TrelloCredential,
    http?: TrelloHttp,
  ) {
    this.http = http ?? new TrelloHttp(cred);
    this.cred = cred;
  }

  async describe(): Promise<BoardTopology> {
    const [board, lists, labels, members] = await Promise.all([
      this.http.get<{ id: string; name: string }>(`/boards/${this.boardId}`, { fields: 'id,name' }),
      this.http.get<RawList[]>(`/boards/${this.boardId}/lists`, {
        fields: 'id,name,pos,closed',
        filter: 'open',
      }),
      this.http.get<RawLabel[]>(`/boards/${this.boardId}/labels`, {
        fields: 'id,name,color',
        limit: 1000,
      }),
      this.http.get<RawMember[]>(`/boards/${this.boardId}/members`, {
        fields: 'id,username,fullName',
      }),
    ]);
    this.labelsById = new Map(labels.map((l) => [l.id, l.name]));
    return {
      boardId: board.id,
      name: board.name,
      columns: lists.map(mapColumn).sort((a, b) => a.position - b.position),
      labels: labels.map(mapLabel),
      members: members.map(mapMember),
      fetchedAt: new Date().toISOString(),
    };
  }

  async listCards(): Promise<readonly BoardCard[]> {
    const cards = await this.http.get<RawCard[]>(`/boards/${this.boardId}/cards`, {
      fields: CARD_FIELDS,
      filter: 'open',
      limit: 1000,
    });
    return cards.map((c) => mapCard(c, this.labelsById));
  }

  async getCard(cardId: string): Promise<BoardCard> {
    const c = await this.http.get<RawCard>(`/cards/${cardId}`, {
      fields: CARD_FIELDS,
      labels: 'true',
    });
    return mapCard(c, this.labelsById);
  }

  async poll(cursor: string | null): Promise<BoardPollResult> {
    const actions = await this.http.get<RawAction[]>(`/boards/${this.boardId}/actions`, {
      filter: ACTION_FILTER,
      limit: 50,
      fields: 'id,type,date,data,idMemberCreator',
      memberCreator: 'false',
      ...(cursor ? { since: cursor } : {}),
    });
    // Trello returns newest first; the cursor is the newest id and events go out oldest first.
    const newest = actions[0]?.id ?? cursor;
    const events = [...actions]
      .reverse()
      .map((a) => mapAction(a, this.boardId))
      .filter((e): e is NonNullable<typeof e> => e !== null);
    return { events, cursor: newest ?? null };
  }

  async moveCard(cardId: string, columnId: string): Promise<void> {
    await this.http.put(`/cards/${cardId}`, { idList: columnId });
  }
  async comment(cardId: string, body: string): Promise<void> {
    await this.http.post(`/cards/${cardId}/actions/comments`, { text: body.slice(0, 16_000) });
  }
  async listRecentComments(cardId: string, limit: number): Promise<readonly BoardComment[]> {
    const actions = await this.http.get<RawAction[]>(`/cards/${cardId}/actions`, {
      filter: 'commentCard',
      limit,
    });
    return actions.map(mapComment);
  }
  async addLabel(cardId: string, labelId: string): Promise<void> {
    try {
      await this.http.post(`/cards/${cardId}/idLabels`, { value: labelId });
    } catch (e) {
      if (e instanceof BoardError && /already/i.test(e.message)) return; // idempotent
      throw e;
    }
  }
  async removeLabel(cardId: string, labelId: string): Promise<void> {
    try {
      await this.http.delete(`/cards/${cardId}/idLabels/${labelId}`);
    } catch (e) {
      if (e instanceof BoardError && e.kind === 'not-found') return;
      throw e;
    }
  }
  async assignMember(cardId: string, memberId: string): Promise<void> {
    try {
      await this.http.post(`/cards/${cardId}/idMembers`, { value: memberId });
    } catch (e) {
      if (e instanceof BoardError && /already/i.test(e.message)) return;
      throw e;
    }
  }
  async whoAmI(): Promise<{ id: string; username: string }> {
    return this.http.get<{ id: string; username: string }>('/members/me', {
      fields: 'id,username',
    });
  }

  // ── WebhookRegistrar ──────────────────────────────────────────────────
  //
  // All four inherit retries, 429 back-off and URL redaction from TrelloHttp.
  // Note the asymmetry: webhooks are scoped to the TOKEN, not the board, so
  // listing them needs the token in the path as well as the query string.

  async listWebhooks(): Promise<readonly RegisteredWebhook[]> {
    return this.http.get<RegisteredWebhook[]>(`/tokens/${this.cred.token}/webhooks`);
  }

  async createWebhook(callbackURL: string, description: string): Promise<RegisteredWebhook> {
    return this.http.post<RegisteredWebhook>('/webhooks', {
      callbackURL,
      idModel: this.boardId,
      description,
    });
  }

  async updateWebhook(id: string, callbackURL: string): Promise<RegisteredWebhook> {
    return this.http.put<RegisteredWebhook>(`/webhooks/${id}`, { callbackURL });
  }

  async deleteWebhook(id: string): Promise<void> {
    await this.http.delete(`/webhooks/${id}`);
  }

  // ── bootstrap helpers used by the CLI ─────────────────────────────────

  static async listBoards(
    cred: TrelloCredential,
  ): Promise<{ id: string; name: string; url: string }[]> {
    const http = new TrelloHttp(cred);
    const boards = await http.get<{ id: string; name: string; url: string; closed: boolean }[]>(
      '/members/me/boards',
      { fields: 'id,name,url,closed' },
    );
    return boards.filter((b) => !b.closed);
  }

  static async createBoard(
    cred: TrelloCredential,
    name: string,
    columns: readonly string[],
  ): Promise<{ id: string; url: string }> {
    const http = new TrelloHttp(cred);
    const board = await http.post<{ id: string; url: string }>('/boards', {
      name,
      defaultLists: 'false',
      prefs_permissionLevel: 'private',
    });
    for (const [i, col] of columns.entries()) {
      await http.post(`/boards/${board.id}/lists`, { name: col, pos: (i + 1) * 65536 });
    }
    return board;
  }

  static async ensureLabels(
    cred: TrelloCredential,
    boardId: string,
    names: readonly string[],
  ): Promise<void> {
    const http = new TrelloHttp(cred);
    const existing = await http.get<RawLabel[]>(`/boards/${boardId}/labels`, {
      fields: 'id,name',
      limit: 1000,
    });
    const have = new Set(existing.map((l) => l.name.toLocaleLowerCase()));
    const colors = [
      'blue',
      'green',
      'orange',
      'red',
      'purple',
      'yellow',
      'sky',
      'lime',
      'pink',
      'black',
    ];
    let i = 0;
    for (const name of names) {
      if (have.has(name.toLocaleLowerCase())) continue;
      await http.post(`/boards/${boardId}/labels`, { name, color: colors[i++ % colors.length] });
    }
  }
}
