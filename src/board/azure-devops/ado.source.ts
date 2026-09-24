import type { AdoBoardConfig } from '../../config/config.schema.js';
import type { AzureDevOpsCredential } from '../../config/credentials.js';
import {
  BoardError,
  type BoardCapabilities,
  type BoardPollResult,
  type BoardSource,
} from '../board.source.js';
import type { BoardCard, BoardComment, BoardEvent, BoardTopology } from '../board.types.js';
import { RateLimiter } from '../http/rate.limiter.js';
import { basicAuth, RestClient } from '../http/rest.client.js';

import {
  CARD_FIELDS,
  mapComment,
  mapUpdate,
  mapWorkItem,
  type MapContext,
  type RawComment,
  type RawIdentity,
  type RawState,
  type RawUpdate,
  type RawWorkItem,
  splitTags,
  STATE_CATEGORY_ORDER,
  toIso,
  wiqlString,
} from './ado.mapper.js';

const API = '7.1';
const COMMENTS_API = '7.1-preview.4';
const BATCH = 200;
/** Re-read this far behind the watermark; the event store dedupes the overlap. */
const OVERLAP_MS = 2 * 60_000;
/** Most updates we read back per changed work item on one poll. */
const UPDATES_WINDOW = 30;

/**
 * Azure DevOps throttles by a sliding usage budget rather than a fixed request
 * count, and answers 429 with Retry-After once it is spent. This bucket just
 * keeps one daemon polite.
 */
export const sharedAdoLimiter = new RateLimiter([{ capacity: 60, refillPerSec: 20 }]);

export interface AdoSourceOptions {
  /**
   * The states worth listing on reconcile: every column a route or a writeback
   * names. Empty means every state that is not Completed or Removed.
   */
  readonly watchStates?: readonly string[];
  /** CLI discovery: skip work item types the process template does not have. */
  readonly lenientTypes?: boolean;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Azure DevOps Boards. A card is a work item, and its column is the work item
 * State. Board columns are team-scoped and optional; State is on every process
 * template.
 *
 * ADO has no board-wide action feed, so `poll` asks WIQL for the items that
 * changed since the watermark and turns each one's revision updates into
 * events.
 */
export class AdoSource implements BoardSource {
  readonly provider = 'azure-devops' as const;
  readonly capabilities: BoardCapabilities = {
    hasChangeFeed: true,
    canComment: true,
    canMoveCard: true,
    canAssignMember: true,
    canAddLabel: true,
    labelsAreFreeform: true,
    canRegisterWebhook: false,
  };
  private readonly http: RestClient;
  private readonly root: string;
  private readonly ctx: {
    organization: string;
    project: string;
    stateCategories: Map<string, string>;
  };
  private readonly identities = new Map<string, string>();

  constructor(
    readonly boardId: string,
    private readonly board: Pick<
      AdoBoardConfig,
      'organization' | 'project' | 'workItemTypes' | 'areaPath'
    >,
    cred: AzureDevOpsCredential,
    private readonly opts: AdoSourceOptions = {},
  ) {
    this.http = new RestClient({
      baseUrl: `https://dev.azure.com/${encodeURIComponent(board.organization)}`,
      ref: cred.ref,
      limiter: sharedAdoLimiter,
      headers: { Authorization: basicAuth('', cred.pat) },
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
    this.root = `/${encodeURIComponent(board.project)}/_apis`;
    this.ctx = {
      organization: board.organization,
      project: board.project,
      stateCategories: new Map(),
    };
  }

  async describe(): Promise<BoardTopology> {
    const states = await this.loadStates();
    const [tags, members] = await Promise.all([
      this.http
        .get<{ value: { id: string; name: string }[] }>(`${this.root}/wit/tags`, {
          query: { 'api-version': `${API}-preview.1` },
        })
        .then((r) => r.value)
        .catch(() => []),
      this.teamMembers().catch(() => []),
    ]);
    return {
      boardId: this.boardId,
      name: `${this.board.organization}/${this.board.project}`,
      columns: states.map((s, i) => ({ id: s.name, name: s.name, position: i })),
      labels: tags.map((t) => ({ id: t.name, name: t.name, color: null })),
      members,
      fetchedAt: new Date().toISOString(),
    };
  }

  async listCards(): Promise<readonly BoardCard[]> {
    await this.ensureStates();
    const watch = this.opts.watchStates?.length
      ? [...this.opts.watchStates]
      : [...this.ctx.stateCategories]
          .filter(([, cat]) => cat !== 'Completed' && cat !== 'Removed')
          .map(([name]) => name);
    if (watch.length === 0) return [];
    const ids = await this.wiql(
      `${this.scope()} AND [System.State] IN (${watch.map(wiqlString).join(', ')}) ` +
        'ORDER BY [System.ChangedDate] DESC',
      1000,
    );
    return (await this.batch(ids)).map((w) => mapWorkItem(w, this.mapContext()));
  }

  async getCard(cardId: string): Promise<BoardCard> {
    await this.ensureStates();
    const w = await this.http.get<RawWorkItem>(`${this.root}/wit/workitems/${Number(cardId)}`, {
      query: { fields: CARD_FIELDS.join(','), 'api-version': API },
    });
    return mapWorkItem(w, this.mapContext());
  }

  async poll(cursor: string | null): Promise<BoardPollResult> {
    await this.ensureStates();
    if (cursor === null) {
      // Seed from the server's own clock, not ours: a skewed local clock would
      // otherwise open a gap the first real poll never looks into.
      const [latest] = await this.batch(
        await this.wiql(`${this.scope()} ORDER BY [System.ChangedDate] DESC`, 1),
      );
      const seed = toIso(latest?.fields['System.ChangedDate']);
      return { events: [], cursor: seed ?? new Date(Date.now() - OVERLAP_MS).toISOString() };
    }

    const since = new Date(Date.parse(cursor) - OVERLAP_MS);
    const ids = await this.wiql(
      // WIQL date literals take whole seconds.
      `${this.scope()} AND [System.ChangedDate] > ${wiqlString(since.toISOString().replace(/\.\d{3}Z$/, 'Z'))} ` +
        'ORDER BY [System.ChangedDate] ASC',
      500,
    );
    const items = await this.batch(ids);
    const events: BoardEvent[] = [];
    let watermark = Date.parse(cursor);
    for (const w of items) {
      const card = mapWorkItem(w, this.mapContext());
      watermark = Math.max(watermark, Date.parse(card.changedAt));
      for (const u of await this.recentUpdates(w.id, w.rev)) {
        for (const e of mapUpdate(u, w.id, this.boardId, card)) {
          if (Date.parse(e.occurredAt) > since.getTime()) events.push(e);
        }
      }
    }
    events.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    return { events, cursor: new Date(watermark).toISOString() };
  }

  async moveCard(cardId: string, columnId: string): Promise<void> {
    try {
      await this.patch(cardId, [{ op: 'add', path: '/fields/System.State', value: columnId }]);
    } catch (e) {
      if (e instanceof BoardError && e.status === 400) {
        throw new BoardError(
          'permission',
          `work item ${cardId} cannot move to state "${columnId}" — check the process ` +
            `template's allowed transitions and required fields (${e.message})`,
          400,
        );
      }
      throw e;
    }
  }

  async comment(cardId: string, body: string): Promise<void> {
    await this.http.post(`${this.root}/wit/workItems/${Number(cardId)}/comments`, {
      query: { format: 'markdown', 'api-version': COMMENTS_API },
      body: { text: body },
    });
  }

  async listRecentComments(cardId: string, limit: number): Promise<readonly BoardComment[]> {
    const r = await this.http.get<{ comments?: RawComment[] }>(
      `${this.root}/wit/workItems/${Number(cardId)}/comments`,
      { query: { $top: limit, order: 'desc', 'api-version': COMMENTS_API } },
    );
    return (r.comments ?? []).map(mapComment);
  }

  addLabel(cardId: string, labelId: string): Promise<void> {
    return this.editTags(cardId, (tags) => (tags.includes(labelId) ? null : [...tags, labelId]));
  }

  removeLabel(cardId: string, labelId: string): Promise<void> {
    const drop = labelId.toLocaleLowerCase();
    return this.editTags(cardId, (tags) =>
      tags.some((t) => t.toLocaleLowerCase() === drop)
        ? tags.filter((t) => t.toLocaleLowerCase() !== drop)
        : null,
    );
  }

  async assignMember(cardId: string, memberId: string): Promise<void> {
    await this.patch(cardId, [
      { op: 'add', path: '/fields/System.AssignedTo', value: await this.uniqueName(memberId) },
    ]);
  }

  async whoAmI(): Promise<{ id: string; username: string }> {
    const r = await this.http.get<{
      authenticatedUser: {
        id: string;
        providerDisplayName?: string;
        properties?: { Account?: { $value?: string } };
      };
    }>('/_apis/connectionData');
    const u = r.authenticatedUser;
    const username = u.properties?.Account?.$value ?? u.providerDisplayName ?? u.id;
    this.identities.set(u.id, username);
    return { id: u.id, username };
  }

  /** `boards` CLI: the projects this PAT can see. */
  async listProjects(): Promise<{ id: string; name: string; url: string }[]> {
    const r = await this.http.get<{ value: { id: string; name: string }[] }>('/_apis/projects', {
      query: { $top: 500, 'api-version': API },
    });
    return r.value.map((p) => ({
      id: p.id,
      name: p.name,
      url: `https://dev.azure.com/${this.board.organization}/${encodeURIComponent(p.name)}`,
    }));
  }

  // ── internals ────────────────────────────────────────────────────────

  private scope(): string {
    const types = this.board.workItemTypes.map(wiqlString).join(', ');
    const area = this.board.areaPath
      ? ` AND [System.AreaPath] UNDER ${wiqlString(this.board.areaPath)}`
      : '';
    return (
      'SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project ' +
      `AND [System.WorkItemType] IN (${types})${area}`
    );
  }

  private async wiql(query: string, top: number): Promise<number[]> {
    const r = await this.http.post<{ workItems: { id: number }[] }>(`${this.root}/wit/wiql`, {
      query: { $top: top, timePrecision: true, 'api-version': API },
      body: { query },
    });
    return r.workItems.map((w) => w.id);
  }

  private async batch(ids: readonly number[]): Promise<RawWorkItem[]> {
    const out: RawWorkItem[] = [];
    for (let i = 0; i < ids.length; i += BATCH) {
      const r = await this.http.post<{ value: RawWorkItem[] }>(`${this.root}/wit/workitemsbatch`, {
        query: { 'api-version': API },
        body: { ids: ids.slice(i, i + BATCH), fields: CARD_FIELDS },
      });
      out.push(...r.value);
    }
    // The batch API does not promise input order.
    const order = new Map(ids.map((id, i) => [id, i]));
    return out.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  }

  /**
   * The newest updates only: one update per revision in practice, so skipping
   * to `rev - window` avoids re-reading a long history on every poll. If that
   * guess overshoots, fall back to the start.
   */
  private async recentUpdates(id: number, rev: number): Promise<RawUpdate[]> {
    const get = (skip: number) =>
      this.http
        .get<{ value: RawUpdate[] }>(`${this.root}/wit/workItems/${id}/updates`, {
          query: { $skip: skip, $top: 200, 'api-version': API },
        })
        .then((r) => r.value);
    const skip = Math.max(0, rev - UPDATES_WINDOW);
    const page = await get(skip);
    return page.length === 0 && skip > 0 ? get(0) : page;
  }

  private patch(cardId: string, ops: unknown[]): Promise<unknown> {
    return this.http.patch(`${this.root}/wit/workitems/${Number(cardId)}`, {
      query: { 'api-version': API },
      body: ops,
      contentType: 'application/json-patch+json',
    });
  }

  /**
   * Tags are one `;`-joined field, so an edit is read-modify-write guarded by a
   * `test /rev` op. A concurrent edit fails the test; re-read and retry once.
   * `next` returns null when there is nothing to change — idempotent.
   */
  private async editTags(cardId: string, next: (tags: string[]) => string[] | null): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const w = await this.http.get<RawWorkItem>(`${this.root}/wit/workitems/${Number(cardId)}`, {
        query: { fields: 'System.Tags', 'api-version': API },
      });
      const tags = next(splitTags(w.fields['System.Tags']));
      if (!tags) return;
      try {
        await this.patch(cardId, [
          { op: 'test', path: '/rev', value: w.rev },
          { op: 'add', path: '/fields/System.Tags', value: tags.join('; ') },
        ]);
        return;
      } catch (e) {
        const conflict = e instanceof BoardError && [400, 409, 412].includes(e.status ?? 0);
        if (!conflict || attempt >= 1) throw e;
      }
    }
  }

  /** `System.AssignedTo` takes a unique name (usually the email), not an identity id. */
  private async uniqueName(memberId: string): Promise<string> {
    if (memberId.includes('@') || !/^[0-9a-f-]{36}$/i.test(memberId)) return memberId;
    const known = this.identities.get(memberId);
    if (known) return known;
    const r = await this.http.get<{
      value: { properties?: { Account?: { $value?: string } }; providerDisplayName?: string }[];
    }>(
      `https://vssps.dev.azure.com/${encodeURIComponent(this.board.organization)}/_apis/identities`,
      {
        query: { identityIds: memberId, 'api-version': API },
      },
    );
    const name = r.value[0]?.properties?.Account?.$value;
    if (!name)
      throw new BoardError('not-found', `identity ${memberId} not found in the organization`);
    this.identities.set(memberId, name);
    return name;
  }

  private async teamMembers(): Promise<BoardTopology['members']> {
    const project = await this.http.get<{ defaultTeam?: { id: string } }>(
      `/_apis/projects/${encodeURIComponent(this.board.project)}`,
      { query: { 'api-version': API } },
    );
    if (!project.defaultTeam) return [];
    const r = await this.http.get<{ value: { identity: RawIdentity }[] }>(
      `/_apis/projects/${encodeURIComponent(this.board.project)}/teams/${project.defaultTeam.id}/members`,
      { query: { $top: 500, 'api-version': API } },
    );
    return r.value.map(({ identity: i }) => ({
      id: i.id,
      username: i.uniqueName ?? i.id,
      displayName: i.displayName ?? i.uniqueName ?? i.id,
    }));
  }

  /** States of every configured work item type, de-duplicated by name, in process order. */
  private async loadStates(): Promise<RawState[]> {
    const lists = await Promise.all(
      this.board.workItemTypes.map((t) =>
        this.http
          .get<{ value: RawState[] }>(
            `${this.root}/wit/workitemtypes/${encodeURIComponent(t)}/states`,
            {
              query: { 'api-version': API },
            },
          )
          .then((r) => r.value)
          .catch((e: unknown) => {
            if (this.opts.lenientTypes && e instanceof BoardError && e.kind === 'not-found')
              return [];
            throw e;
          }),
      ),
    );
    const byName = new Map<string, RawState>();
    for (const s of lists.flat()) if (!byName.has(s.name)) byName.set(s.name, s);
    const rank = (c: string): number => {
      const i = STATE_CATEGORY_ORDER.indexOf(c);
      return i < 0 ? STATE_CATEGORY_ORDER.length : i;
    };
    const states = [...byName.values()].sort((a, b) => rank(a.category) - rank(b.category));
    this.ctx.stateCategories = new Map(states.map((s) => [s.name, s.category]));
    return states;
  }

  private async ensureStates(): Promise<void> {
    if (this.ctx.stateCategories.size === 0) await this.loadStates();
  }

  private mapContext(): MapContext {
    return this.ctx;
  }
}
