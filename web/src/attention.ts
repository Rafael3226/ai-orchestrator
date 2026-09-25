import type { AttentionItem, AttentionKind } from '@server/state.types';

const GROUPS: readonly { kind: AttentionKind; title: string }[] = [
  { kind: 'needs-human', title: 'Needs a human' },
  { kind: 'stale-card', title: 'Not moving' },
  { kind: 'dead-writeback', title: 'Board out of step' },
];

function ago(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

function safeHref(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Work that stopped moving or needs a person, grouped by why. Read-only. */
export class AttentionPanel {
  private readonly root = document.getElementById('attention') as HTMLElement;
  private readonly list = document.getElementById('attention-list') as HTMLElement;
  private readonly badge = document.getElementById('attention-toggle') as HTMLButtonElement;
  private lastKey = '';

  constructor() {
    (document.getElementById('attention-close') as HTMLElement).onclick = () => this.hide();
  }

  toggle(): void {
    this.root.hidden = !this.root.hidden;
  }

  hide(): void {
    this.root.hidden = true;
  }

  update(items: readonly AttentionItem[]): void {
    this.badge.textContent = `⚑ ${items.length}`;
    this.badge.classList.toggle('alert', items.length > 0);
    this.badge.title = items.length
      ? `${items.length} item(s) need attention`
      : 'Nothing needs attention';
    const key = JSON.stringify(items);
    if (key === this.lastKey) return;
    this.lastKey = key;

    this.list.replaceChildren();
    if (!items.length) {
      this.list.append(
        Object.assign(document.createElement('p'), {
          className: 'muted',
          textContent: 'Everything is moving.',
        }),
      );
      return;
    }
    for (const g of GROUPS) {
      const group = items.filter((i) => i.kind === g.kind);
      if (!group.length) continue;
      const h = document.createElement('h3');
      h.textContent = `${g.title} (${group.length})`;
      const ul = document.createElement('ul');
      for (const i of group) ul.append(this.row(i));
      this.list.append(h, ul);
    }
  }

  private row(i: AttentionItem): HTMLElement {
    const li = document.createElement('li');
    li.className = `att att-${i.kind}`;
    const head = document.createElement('div');
    const href = safeHref(i.cardUrl);
    const label = `${i.cardShortId ? `#${i.cardShortId} ` : ''}${i.title}`;
    if (href) {
      const a = document.createElement('a');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = label;
      head.append(a);
    } else head.textContent = label;
    const meta = document.createElement('div');
    meta.className = 'muted';
    meta.textContent = [i.projectId, i.role, ago(i.since), i.reason].filter(Boolean).join(' · ');
    li.append(head, meta);
    return li;
  }
}
