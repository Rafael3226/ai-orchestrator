import type { BoardCard, BoardComment, BoardEvent } from '../board.types.js';
import { adfToMarkdown } from '../format/adf.js';

export const ISSUE_FIELDS = [
  'summary',
  'description',
  'status',
  'labels',
  'assignee',
  'updated',
  'created',
  'issuetype',
] as const;

export interface RawUser {
  readonly accountId: string;
  readonly displayName?: string;
  readonly emailAddress?: string;
}

export interface RawStatus {
  readonly id: string;
  readonly name: string;
  readonly statusCategory?: { readonly key: string };
}

export interface RawHistory {
  readonly id: string;
  readonly author?: RawUser;
  readonly created: string;
  readonly items: readonly {
    readonly field: string;
    readonly fieldId?: string;
    readonly from: string | null;
    readonly fromString: string | null;
    readonly to: string | null;
    readonly toString: string | null;
  }[];
}

export interface RawIssue {
  readonly id: string;
  readonly key: string;
  readonly fields: {
    readonly summary?: string;
    readonly description?: unknown;
    readonly status?: RawStatus;
    readonly labels?: readonly string[];
    readonly assignee?: RawUser | null;
    readonly updated?: string;
    readonly created?: string;
  };
  readonly changelog?: { readonly histories?: readonly RawHistory[] };
}

export interface RawComment {
  readonly id: string;
  readonly author?: RawUser;
  readonly body?: unknown;
  readonly created: string;
}

/** Board order: to do, in progress, done. */
export const STATUS_CATEGORY_ORDER = ['new', 'indeterminate', 'done'];

/** Jira writes `2026-09-24T10:00:00.000+0000`; normalize to ISO UTC. */
export function jiraDate(v: string | undefined | null): string | null {
  if (!v) return null;
  const t = Date.parse(v.replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export function mapIssue(i: RawIssue, site: string): BoardCard {
  const labels = [...(i.fields.labels ?? [])];
  return {
    id: i.id,
    shortId: i.key,
    url: `https://${site}/browse/${i.key}`,
    title: i.fields.summary ?? '',
    description: adfToMarkdown(i.fields.description),
    columnId: i.fields.status?.id ?? '',
    labelIds: labels,
    labelNames: labels,
    memberIds: i.fields.assignee?.accountId ? [i.fields.assignee.accountId] : [],
    closed: false,
    changedAt: jiraDate(i.fields.updated) ?? new Date(0).toISOString(),
  };
}

export function mapComment(c: RawComment): BoardComment {
  return {
    id: c.id,
    authorId: c.author?.accountId ?? '',
    text: adfToMarkdown(c.body),
    at: jiraDate(c.created) ?? c.created,
  };
}

const words = (s: string | null): Set<string> => new Set((s ?? '').split(/\s+/).filter(Boolean));

/** One changelog history entry → the events it implies. */
export function mapHistory(
  h: RawHistory,
  issueId: string,
  boardId: string,
  card: BoardCard | null,
): BoardEvent[] {
  const base = {
    provider: 'jira' as const,
    boardId,
    cardId: issueId,
    occurredAt: jiraDate(h.created) ?? new Date().toISOString(),
    actorMemberId: h.author?.accountId ?? null,
    fromColumnId: null as string | null,
    toColumnId: null as string | null,
    labelId: null as string | null,
    memberId: null as string | null,
    card,
    synthetic: false,
  };
  const id = (suffix: string): string => `jira:${issueId}:${h.id}:${suffix}`;
  const out: BoardEvent[] = [];
  let edited = false;
  for (const item of h.items) {
    const field = item.fieldId ?? item.field;
    if (field === 'status') {
      out.push({
        ...base,
        eventId: id('moved'),
        kind: 'card.moved',
        fromColumnId: item.from,
        toColumnId: item.to,
      });
    } else if (field === 'labels') {
      const before = words(item.fromString);
      const after = words(item.toString);
      for (const l of after) {
        if (!before.has(l))
          out.push({ ...base, eventId: id(`labeled:${l}`), kind: 'card.labeled', labelId: l });
      }
      for (const l of before) {
        if (!after.has(l)) {
          out.push({ ...base, eventId: id(`unlabeled:${l}`), kind: 'card.unlabeled', labelId: l });
        }
      }
    } else if (field === 'assignee') {
      if (item.to)
        out.push({ ...base, eventId: id('assigned'), kind: 'card.assigned', memberId: item.to });
      else if (item.from) {
        out.push({
          ...base,
          eventId: id('unassigned'),
          kind: 'card.unassigned',
          memberId: item.from,
        });
      }
    } else if (field === 'summary' || field === 'description') {
      edited = true;
    }
  }
  if (edited && out.length === 0)
    out.push({ ...base, eventId: id('updated'), kind: 'card.updated' });
  return out;
}

/** A JQL string literal. */
export const jqlString = (s: string): string =>
  `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
