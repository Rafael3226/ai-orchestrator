import type { JiraBoardConfig } from '../../config/config.schema.js';
import type { JiraCredential } from '../../config/credentials.js';
import {
  BoardError,
  type BoardCapabilities,
  type BoardPollResult,
  type BoardSource,
} from '../board.source.js';
import type {
  BoardCard,
  BoardComment,
  BoardEvent,
  BoardTopology,
  CardFields,
  NewCard,
  Priority,
  WorkItemType,
} from '../board.types.js';
import { markdownToAdf } from '../format/adf.js';
import { RateLimiter } from '../http/rate.limiter.js';
import { basicAuth, RestClient } from '../http/rest.client.js';

import {
  ISSUE_FIELDS,
  jiraDate,
  jqlString,
  mapComment,
  mapHistory,
  mapIssue,
  type RawComment,
  type RawIssue,
  type RawStatus,
  type RawUser,
  STATUS_CATEGORY_ORDER,
} from './jira.mapper.js';

const PAGE = 100;
/** Re-read this far behind the watermark; the event store dedupes the overlap. */
const OVERLAP_MS = 2 * 60_000;
/** Jira bodies are capped at 32k characters. */
const MAX_COMMENT = 32_000;

/**
 * Company-managed defaults. Team-managed projects name the sub-task type
 * `Subtask`; set `board.cardTypes.subtask: Subtask` there.
 */
const DEFAULT_TYPES: Readonly<Record<WorkItemType, string>> = {
  story: 'Story',
  bug: 'Bug',
  task: 'Task',
  subtask: 'Sub-task',
  epic: 'Epic',
};

/** Jira's default priority scheme names. */
const PRIORITY_NAMES: Readonly<Record<Priority, string>> = {
  highest: 'Highest',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  lowest: 'Lowest',
};

/**
 * Story points and start date are custom fields whose ids vary per site;
 * these are the usual Jira Cloud ones. Override with `board.fields`.
 */
const DEFAULT_FIELDS = {
  priority: 'priority',
  storyPoints: 'customfield_10016',
  startDate: 'customfield_10015',
  dueDate: 'duedate',
} as const;

/**
 * Jira Cloud rate-limits by a per-account cost budget and answers 429 with
 * Retry-After. This bucket keeps one daemon well under it.
 */
export const sharedJiraLimiter = new RateLimiter([{ capacity: 30, refillPerSec: 10 }]);

export interface JiraSourceOptions {
  /**
   * Status NAMES worth listing on reconcile: every column a route or a
   * writeback names. Empty means every status not in the done category.
   */
  readonly watchStatuses?: readonly string[];
  readonly fetchImpl?: typeof fetch;
}

/**
 * Jira Cloud. A card is an issue, and its column is the issue status (by id,
 * so a rename does not break routing). Moving a card runs whichever workflow
 * transition leads to the target status.
 *
 * `poll` searches for issues updated since the watermark, with their recent
 * changelog expanded, so one request per page covers every change.
 */
export class JiraSource implements BoardSource {
  readonly provider = 'jira' as const;
  readonly capabilities: BoardCapabilities = {
    hasChangeFeed: true,
    canComment: true,
    canMoveCard: true,
    canAssignMember: true,
    canAddLabel: true,
    labelsAreFreeform: true,
    canRegisterWebhook: false,
    canCreateCard: true,
    canCreateSubtask: true,
    canSetFields: true,
  };
  private readonly http: RestClient;
  private statuses: { id: string; name: string; category: string }[] = [];

  constructor(
    readonly boardId: string,
    private readonly board: Pick<JiraBoardConfig, 'site' | 'projectKey' | 'issueTypes' | 'jql'> &
      Partial<Pick<JiraBoardConfig, 'fields' | 'cardTypes'>>,
    cred: JiraCredential,
    private readonly opts: JiraSourceOptions = {},
  ) {
    this.http = new RestClient({
      baseUrl: `https://${board.site}/rest/api/3`,
      ref: cred.ref,
      limiter: sharedJiraLimiter,
      headers: { Authorization: basicAuth(cred.email, cred.apiToken) },
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
  }

  async describe(): Promise<BoardTopology> {
    const [project, statuses, members] = await Promise.all([
      this.http.get<{ name: string }>(`/project/${this.board.projectKey}`),
      this.loadStatuses(),
      this.http
        .get<RawUser[]>('/user/assignable/search', {
          query: { project: this.board.projectKey, maxResults: 200 },
        })
        .catch(() => [] as RawUser[]),
    ]);
    return {
      boardId: this.boardId,
      name: `${project.name} (${this.board.projectKey})`,
      columns: statuses.map((s, i) => ({ id: s.id, name: s.name, position: i })),
      labels: [],
      members: members.map((u) => ({
        id: u.accountId,
        username: u.emailAddress ?? u.displayName ?? u.accountId,
        displayName: u.displayName ?? u.accountId,
      })),
      fetchedAt: new Date().toISOString(),
    };
  }

  async listCards(): Promise<readonly BoardCard[]> {
    await this.ensureStatuses();
    const watch = new Set((this.opts.watchStatuses ?? []).map((s) => s.trim().toLocaleLowerCase()));
    const ids = this.statuses
      .filter((s) => (watch.size ? watch.has(s.name.toLocaleLowerCase()) : s.category !== 'done'))
      .map((s) => s.id);
    if (ids.length === 0) return [];
    const issues = await this.search(
      `${this.scope()} AND status IN (${ids.join(', ')}) ORDER BY updated DESC`,
      {
        limit: 1000,
      },
    );
    return issues.map((i) => mapIssue(i, this.board.site));
  }

  async getCard(cardId: string): Promise<BoardCard> {
    const i = await this.http.get<RawIssue>(`/issue/${encodeURIComponent(cardId)}`, {
      query: { fields: ISSUE_FIELDS.join(',') },
    });
    return mapIssue(i, this.board.site);
  }

  async poll(cursor: string | null): Promise<BoardPollResult> {
    if (cursor === null) {
      const [latest] = await this.search(`${this.scope()} ORDER BY updated DESC`, { limit: 1 });
      const seed = jiraDate(latest?.fields.updated);
      return { events: [], cursor: seed ?? new Date(Date.now() - OVERLAP_MS).toISOString() };
    }

    // JQL dates are minute-precision and in the account's timezone. A relative
    // window sidesteps both; the overlap and event dedupe absorb the slack.
    const since = Date.parse(cursor) - OVERLAP_MS;
    const minutes = Math.max(1, Math.ceil((Date.now() - since) / 60_000));
    const issues = await this.search(
      `${this.scope()} AND updated >= "-${minutes}m" ORDER BY updated ASC`,
      {
        limit: 500,
        changelog: true,
      },
    );

    const events: BoardEvent[] = [];
    let watermark = Date.parse(cursor);
    for (const issue of issues) {
      const card = mapIssue(issue, this.board.site);
      watermark = Math.max(watermark, Date.parse(card.changedAt));
      const created = jiraDate(issue.fields.created);
      if (created && Date.parse(created) > since) {
        events.push({
          eventId: `jira:${issue.id}:created`,
          kind: 'card.created',
          provider: 'jira',
          boardId: this.boardId,
          cardId: issue.id,
          occurredAt: created,
          actorMemberId: null,
          fromColumnId: null,
          toColumnId: card.columnId,
          labelId: null,
          memberId: null,
          card,
          synthetic: false,
        });
      }
      for (const h of issue.changelog?.histories ?? []) {
        for (const e of mapHistory(h, issue.id, this.boardId, card)) {
          if (Date.parse(e.occurredAt) > since) events.push(e);
        }
      }
    }
    events.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    return { events, cursor: new Date(watermark).toISOString() };
  }

  async moveCard(cardId: string, columnId: string): Promise<void> {
    const path = `/issue/${encodeURIComponent(cardId)}/transitions`;
    const r = await this.http.get<{ transitions: { id: string; name: string; to: RawStatus }[] }>(
      path,
    );
    const t = r.transitions.find((x) => x.to.id === columnId);
    if (!t) {
      const target = this.statuses.find((s) => s.id === columnId)?.name ?? columnId;
      const reachable = r.transitions.map((x) => x.to.name).join(', ') || 'none';
      throw new BoardError(
        'permission',
        `issue ${cardId}: no workflow transition leads to "${target}" from its current status ` +
          `(reachable: ${reachable})`,
      );
    }
    await this.http.post(path, { body: { transition: { id: t.id } } });
  }

  async comment(cardId: string, body: string): Promise<void> {
    await this.http.post(`/issue/${encodeURIComponent(cardId)}/comment`, {
      body: { body: markdownToAdf(body.slice(0, MAX_COMMENT)) },
    });
  }

  async listRecentComments(cardId: string, limit: number): Promise<readonly BoardComment[]> {
    const r = await this.http.get<{ comments: RawComment[] }>(
      `/issue/${encodeURIComponent(cardId)}/comment`,
      { query: { orderBy: '-created', maxResults: limit } },
    );
    return r.comments.map(mapComment);
  }

  // Jira treats adding a present label, or removing an absent one, as a no-op.
  async addLabel(cardId: string, labelId: string): Promise<void> {
    await this.http.put(`/issue/${encodeURIComponent(cardId)}`, {
      body: { update: { labels: [{ add: labelId }] } },
    });
  }

  async removeLabel(cardId: string, labelId: string): Promise<void> {
    await this.http.put(`/issue/${encodeURIComponent(cardId)}`, {
      body: { update: { labels: [{ remove: labelId }] } },
    });
  }

  async assignMember(cardId: string, memberId: string): Promise<void> {
    await this.http.put(`/issue/${encodeURIComponent(cardId)}/assignee`, {
      body: { accountId: memberId },
    });
  }

  async createCard(card: NewCard): Promise<BoardCard> {
    const fields: Record<string, unknown> = {
      project: { key: this.board.projectKey },
      summary: card.title,
      description: markdownToAdf(card.description.slice(0, MAX_COMMENT)),
      issuetype: { name: this.board.cardTypes?.[card.type] ?? DEFAULT_TYPES[card.type] },
    };
    if (card.parentId) fields['parent'] = issueRef(card.parentId);
    const created = await this.http.post<{ id: string; key: string }>('/issue', {
      body: { fields },
    });
    // Jira creates in the workflow's initial status; the writer moves it after.
    return this.getCard(created.id);
  }

  async setFields(cardId: string, fields: CardFields): Promise<readonly (keyof CardFields)[]> {
    const o = this.board.fields ?? {};
    const ids: Record<keyof CardFields, string> = {
      priority: o.priority ?? DEFAULT_FIELDS.priority,
      storyPoints: o.storyPoints ?? DEFAULT_FIELDS.storyPoints,
      startDate: o.startDate ?? DEFAULT_FIELDS.startDate,
      dueDate: o.dueDate ?? DEFAULT_FIELDS.dueDate,
    };
    const body: Record<string, unknown> = {};
    const byFieldId = new Map<string, keyof CardFields>();
    const put = (key: keyof CardFields, value: unknown): void => {
      body[ids[key]] = value;
      byFieldId.set(ids[key], key);
    };
    if (fields.priority) put('priority', { name: PRIORITY_NAMES[fields.priority] });
    if (fields.storyPoints !== undefined) put('storyPoints', fields.storyPoints);
    if (fields.startDate) put('startDate', fields.startDate);
    if (fields.dueDate) put('dueDate', fields.dueDate);
    if (byFieldId.size === 0) return [];

    const path = `/issue/${encodeURIComponent(cardId)}`;
    try {
      await this.http.put(path, { body: { fields: body } });
      return [];
    } catch (e) {
      // A field that is not on this issue type's screen is a 400 naming it.
      // Drop those and keep the rest rather than lose the whole estimate.
      const rejected = e instanceof BoardError && e.status === 400 ? rejectedFields(e.message) : [];
      const unsupported = rejected.filter((id) => byFieldId.has(id));
      if (unsupported.length === 0) throw e;
      for (const id of unsupported) delete body[id];
      if (Object.keys(body).length) await this.http.put(path, { body: { fields: body } });
      return unsupported.map((id) => byFieldId.get(id) as keyof CardFields);
    }
  }

  async listChildren(cardId: string): Promise<readonly BoardCard[]> {
    const issues = await this.search(`parent = ${jqlString(cardId)} ORDER BY created ASC`, {
      limit: 200,
    });
    return issues.map((i) => mapIssue(i, this.board.site));
  }

  async whoAmI(): Promise<{ id: string; username: string }> {
    const me = await this.http.get<RawUser>('/myself');
    return { id: me.accountId, username: me.emailAddress ?? me.displayName ?? me.accountId };
  }

  /** `boards` CLI: the projects this account can see. */
  async listProjects(): Promise<{ id: string; name: string; url: string }[]> {
    const r = await this.http.get<{ values: { id: string; key: string; name: string }[] }>(
      '/project/search',
      { query: { maxResults: 100 } },
    );
    return r.values.map((p) => ({
      id: p.key,
      name: p.name,
      url: `https://${this.board.site}/browse/${p.key}`,
    }));
  }

  // ── internals ────────────────────────────────────────────────────────

  private scope(): string {
    const parts = [`project = ${jqlString(this.board.projectKey)}`];
    if (this.board.issueTypes?.length) {
      parts.push(`issuetype IN (${this.board.issueTypes.map(jqlString).join(', ')})`);
    }
    if (this.board.jql) parts.push(`(${this.board.jql})`);
    return parts.join(' AND ');
  }

  /** Enhanced search (`/search/jql`), paged by token. */
  private async search(
    jql: string,
    opts: { limit: number; changelog?: boolean },
  ): Promise<RawIssue[]> {
    const out: RawIssue[] = [];
    let nextPageToken: string | undefined;
    do {
      const r = await this.http.post<{
        issues: RawIssue[];
        nextPageToken?: string;
        isLast?: boolean;
      }>('/search/jql', {
        body: {
          jql,
          fields: ISSUE_FIELDS,
          maxResults: Math.min(PAGE, opts.limit - out.length),
          ...(opts.changelog ? { expand: 'changelog' } : {}),
          ...(nextPageToken ? { nextPageToken } : {}),
        },
      });
      out.push(...r.issues);
      nextPageToken = r.isLast ? undefined : r.nextPageToken;
    } while (nextPageToken && out.length < opts.limit);
    return out;
  }

  /** Statuses used by the project's issue types, de-duplicated, in category order. */
  private async loadStatuses(): Promise<{ id: string; name: string; category: string }[]> {
    const types = await this.http.get<{ name: string; statuses: RawStatus[] }[]>(
      `/project/${this.board.projectKey}/statuses`,
    );
    const wanted = this.board.issueTypes?.map((t) => t.toLocaleLowerCase());
    const byId = new Map<string, { id: string; name: string; category: string }>();
    for (const t of types) {
      if (wanted && !wanted.includes(t.name.toLocaleLowerCase())) continue;
      for (const s of t.statuses) {
        if (!byId.has(s.id))
          byId.set(s.id, { id: s.id, name: s.name, category: s.statusCategory?.key ?? '' });
      }
    }
    const rank = (c: string): number => {
      const i = STATUS_CATEGORY_ORDER.indexOf(c);
      return i < 0 ? STATUS_CATEGORY_ORDER.length : i;
    };
    this.statuses = [...byId.values()].sort((a, b) => rank(a.category) - rank(b.category));
    return this.statuses;
  }

  private async ensureStatuses(): Promise<void> {
    if (this.statuses.length === 0) await this.loadStatuses();
  }
}

/** A numeric id or an issue key — Jira accepts either, but in different properties. */
function issueRef(ref: string): { id: string } | { key: string } {
  return /^\d+$/.test(ref) ? { id: ref } : { key: ref };
}

/** Field ids named in a Jira 400 body: `{"errors":{"customfield_10016":"..."}}`. */
export function rejectedFields(message: string): string[] {
  const m = /"errors"\s*:\s*\{([^}]*)/.exec(message);
  if (!m?.[1]) return [];
  return [...m[1].matchAll(/"([^"]+)"\s*:/g)].map((x) => x[1] as string);
}
