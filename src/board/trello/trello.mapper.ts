import type {
  BoardCard,
  BoardColumn,
  BoardComment,
  BoardEvent,
  BoardLabel,
  BoardMember,
} from '../board.types.js';

// Narrow hand-written shapes for the fields we request — not the whole Trello API.
export interface RawList {
  id: string;
  name: string;
  pos: number;
  closed?: boolean;
}
export interface RawLabel {
  id: string;
  name: string;
  color: string | null;
}
export interface RawMember {
  id: string;
  username: string;
  fullName: string;
}
export interface RawCard {
  id: string;
  idShort: number;
  name: string;
  desc: string;
  idList: string;
  idLabels?: string[];
  labels?: RawLabel[];
  idMembers?: string[];
  url: string;
  shortUrl?: string;
  closed: boolean;
  dateLastActivity: string;
}
export interface RawAction {
  id: string;
  type: string;
  date: string;
  idMemberCreator: string;
  data: {
    card?: { id: string; idShort?: number; name?: string; closed?: boolean };
    listBefore?: { id: string; name: string };
    listAfter?: { id: string; name: string };
    list?: { id: string; name: string };
    label?: { id: string; name: string };
    member?: { id: string };
    idMember?: string;
    old?: Record<string, unknown>;
    text?: string;
  };
}

export const ACTION_FILTER = [
  'createCard',
  'updateCard',
  'commentCard',
  'addMemberToCard',
  'removeMemberFromCard',
  'addLabelToCard',
  'removeLabelFromCard',
].join(',');

export const CARD_FIELDS =
  'id,idShort,name,desc,idList,idLabels,idMembers,url,shortUrl,closed,dateLastActivity';

export const mapColumn = (l: RawList): BoardColumn => ({ id: l.id, name: l.name, position: l.pos });
export const mapLabel = (l: RawLabel): BoardLabel => ({ id: l.id, name: l.name, color: l.color });
export const mapMember = (m: RawMember): BoardMember => ({
  id: m.id,
  username: m.username,
  displayName: m.fullName,
});

export function mapCard(c: RawCard, labelsById: ReadonlyMap<string, string>): BoardCard {
  const labelIds = c.idLabels ?? c.labels?.map((l) => l.id) ?? [];
  return {
    id: c.id,
    shortId: String(c.idShort),
    url: c.shortUrl ?? c.url,
    title: c.name,
    description: c.desc ?? '',
    columnId: c.idList,
    labelIds,
    labelNames: labelIds.map(
      (id) => labelsById.get(id) ?? c.labels?.find((l) => l.id === id)?.name ?? id,
    ),
    memberIds: c.idMembers ?? [],
    closed: c.closed,
    changedAt: c.dateLastActivity,
  };
}

export function mapComment(a: RawAction): BoardComment {
  return { id: a.id, authorId: a.idMemberCreator, text: a.data.text ?? '', at: a.date };
}

/** Trello action → BoardEvent. Returns null for action types we don't route on. */
export function mapAction(a: RawAction, boardId: string): BoardEvent | null {
  const cardId = a.data.card?.id;
  if (!cardId) return null;
  const base = {
    eventId: `trello:${a.id}`,
    provider: 'trello' as const,
    boardId,
    cardId,
    occurredAt: a.date,
    actorMemberId: a.idMemberCreator ?? null,
    fromColumnId: null as string | null,
    toColumnId: null as string | null,
    labelId: null as string | null,
    memberId: null as string | null,
    card: null,
    synthetic: false,
  };
  switch (a.type) {
    case 'createCard':
      return { ...base, kind: 'card.created', toColumnId: a.data.list?.id ?? null };
    case 'updateCard':
      if (a.data.listBefore && a.data.listAfter) {
        return {
          ...base,
          kind: 'card.moved',
          fromColumnId: a.data.listBefore.id,
          toColumnId: a.data.listAfter.id,
        };
      }
      if (a.data.old && 'closed' in a.data.old && a.data.card?.closed)
        return { ...base, kind: 'card.archived' };
      return { ...base, kind: 'card.updated' };
    case 'commentCard':
      return { ...base, kind: 'card.commented' };
    case 'addLabelToCard':
      return { ...base, kind: 'card.labeled', labelId: a.data.label?.id ?? null };
    case 'removeLabelFromCard':
      return { ...base, kind: 'card.unlabeled', labelId: a.data.label?.id ?? null };
    case 'addMemberToCard':
      return {
        ...base,
        kind: 'card.assigned',
        memberId: a.data.idMember ?? a.data.member?.id ?? null,
      };
    case 'removeMemberFromCard':
      return {
        ...base,
        kind: 'card.unassigned',
        memberId: a.data.idMember ?? a.data.member?.id ?? null,
      };
    default:
      return null;
  }
}
