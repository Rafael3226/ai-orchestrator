import type { BoardCard, BoardComment, BoardEvent } from '../board.types.js';
import { htmlToMarkdown } from '../format/html.to.markdown.js';

/** The fields every card read asks for. */
export const CARD_FIELDS = [
  'System.Id',
  'System.Rev',
  'System.Title',
  'System.Description',
  'System.State',
  'System.Tags',
  'System.AssignedTo',
  'System.ChangedDate',
  'System.WorkItemType',
] as const;

export interface RawIdentity {
  readonly id: string;
  readonly displayName?: string;
  readonly uniqueName?: string;
}

export interface RawWorkItem {
  readonly id: number;
  readonly rev: number;
  readonly fields: Readonly<Record<string, unknown>>;
}

export interface RawFieldChange {
  readonly oldValue?: unknown;
  readonly newValue?: unknown;
}

export interface RawUpdate {
  readonly id: number;
  readonly rev: number;
  readonly revisedBy?: RawIdentity;
  readonly revisedDate?: string;
  readonly fields?: Readonly<Record<string, RawFieldChange>>;
}

export interface RawState {
  readonly name: string;
  readonly category: string;
  readonly color?: string;
}

export interface RawComment {
  readonly id: number;
  readonly text?: string;
  readonly format?: string;
  readonly createdBy?: RawIdentity;
  readonly createdDate: string;
}

/** Board order: the order work moves through the process categories. */
export const STATE_CATEGORY_ORDER = ['Proposed', 'InProgress', 'Resolved', 'Completed', 'Removed'];

export const splitTags = (v: unknown): string[] =>
  typeof v === 'string'
    ? v
        .split(';')
        .map((t) => t.trim())
        .filter(Boolean)
    : [];

const identityId = (v: unknown): string | null =>
  v && typeof v === 'object' && typeof (v as RawIdentity).id === 'string'
    ? (v as RawIdentity).id
    : null;

export const workItemUrl = (org: string, project: string, id: number | string): string =>
  `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_workitems/edit/${id}`;

export interface MapContext {
  readonly organization: string;
  readonly project: string;
  /** state name -> process category, from `describe()`. */
  readonly stateCategories: ReadonlyMap<string, string>;
}

export function mapWorkItem(w: RawWorkItem, ctx: MapContext): BoardCard {
  const f = w.fields;
  const state = String(f['System.State'] ?? '');
  const tags = splitTags(f['System.Tags']);
  const assignee = identityId(f['System.AssignedTo']);
  return {
    id: String(w.id),
    shortId: String(w.id),
    url: workItemUrl(ctx.organization, ctx.project, w.id),
    title: String(f['System.Title'] ?? ''),
    description: htmlToMarkdown(f['System.Description'] as string | undefined),
    columnId: state,
    labelIds: tags,
    labelNames: tags,
    memberIds: assignee ? [assignee] : [],
    closed: ctx.stateCategories.get(state) === 'Removed',
    changedAt: toIso(f['System.ChangedDate']) ?? new Date(0).toISOString(),
  };
}

export function mapComment(c: RawComment): BoardComment {
  const text = c.format?.toLowerCase() === 'markdown' ? (c.text ?? '') : htmlToMarkdown(c.text);
  return { id: String(c.id), authorId: c.createdBy?.id ?? '', text, at: c.createdDate };
}

/**
 * One work item update → the events it implies. A single save can change the
 * state, the tags and the assignee at once, so ids carry the kind (and the
 * tag or member) as well as the revision.
 */
export function mapUpdate(
  u: RawUpdate,
  workItemId: number,
  boardId: string,
  card: BoardCard | null,
): BoardEvent[] {
  const fields = u.fields ?? {};
  const occurredAt =
    toIso(fields['System.ChangedDate']?.newValue) ??
    toIso(u.revisedDate) ??
    new Date().toISOString();
  const base = {
    provider: 'azure-devops' as const,
    boardId,
    cardId: String(workItemId),
    occurredAt,
    actorMemberId: u.revisedBy?.id ?? null,
    fromColumnId: null as string | null,
    toColumnId: null as string | null,
    labelId: null as string | null,
    memberId: null as string | null,
    card,
    synthetic: false,
  };
  const id = (suffix: string): string => `ado:${workItemId}:${u.rev}:${suffix}`;
  const out: BoardEvent[] = [];

  const state = fields['System.State'];
  if (state && state.newValue !== undefined) {
    if (u.rev === 1 || state.oldValue === undefined) {
      out.push({
        ...base,
        eventId: id('created'),
        kind: 'card.created',
        toColumnId: String(state.newValue),
      });
    } else if (state.oldValue !== state.newValue) {
      out.push({
        ...base,
        eventId: id('moved'),
        kind: 'card.moved',
        fromColumnId: String(state.oldValue),
        toColumnId: String(state.newValue),
      });
    }
  }

  const tags = fields['System.Tags'];
  if (tags) {
    const before = new Set(splitTags(tags.oldValue));
    const after = new Set(splitTags(tags.newValue));
    for (const t of after) {
      if (!before.has(t))
        out.push({ ...base, eventId: id(`labeled:${t}`), kind: 'card.labeled', labelId: t });
    }
    for (const t of before) {
      if (!after.has(t)) {
        out.push({ ...base, eventId: id(`unlabeled:${t}`), kind: 'card.unlabeled', labelId: t });
      }
    }
  }

  const assigned = fields['System.AssignedTo'];
  if (assigned) {
    const to = identityId(assigned.newValue);
    const from = identityId(assigned.oldValue);
    if (to && to !== from)
      out.push({ ...base, eventId: id('assigned'), kind: 'card.assigned', memberId: to });
    else if (!to && from) {
      out.push({ ...base, eventId: id('unassigned'), kind: 'card.unassigned', memberId: from });
    }
  }

  if (fields['System.History']?.newValue) {
    out.push({ ...base, eventId: id('commented'), kind: 'card.commented' });
  }
  if (out.length === 0 && (fields['System.Title'] || fields['System.Description'])) {
    out.push({ ...base, eventId: id('updated'), kind: 'card.updated' });
  }
  return out;
}

export function toIso(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** WIQL string literal. */
export const wiqlString = (s: string): string => `'${s.replace(/'/g, "''")}'`;
