import type { ChatSessionView, ChatStreamEvent, StoryDraft } from '@server/chat.types';
import type { ProjectState } from '@server/state.types';

import { api, postJson, postStream } from './net';

const POLL_CREATED_MS = 3000;
const storageKey = (projectId: string) => `ba-chat:${projectId}`;

function remember(projectId: string, sessionId: string | null): void {
  try {
    if (sessionId) localStorage.setItem(storageKey(projectId), sessionId);
    else localStorage.removeItem(storageKey(projectId));
  } catch {
    /* private window — the chat just does not survive a reload */
  }
}

function recall(projectId: string): string | null {
  try {
    return localStorage.getItem(storageKey(projectId));
  } catch {
    return null;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Only ever link to the board over http(s): the URL comes from the provider. */
function safeHref(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

/** The draft as the stakeholder reads it. Everything through textContent. */
function draftBody(d: StoryDraft): HTMLElement[] {
  const head = el('div', 'draft-head');
  head.append(el('span', 'pill', d.type), el('strong', undefined, d.title));
  const out: HTMLElement[] = [head, el('p', 'draft-story', d.userStory)];
  if (d.description) out.push(el('p', 'muted', d.description));
  const section = (title: string, items: readonly string[]) => {
    if (!items.length) return;
    const ul = el('ul');
    for (const i of items) ul.append(el('li', undefined, i));
    out.push(el('div', 'draft-label', title), ul);
  };
  section('Acceptance criteria', d.acceptanceCriteria);
  section(
    'Business decisions',
    d.businessDecisions.map((b) => `${b.title} — ${b.rationale}`),
  );
  section('Open questions', d.openQuestions);
  return out;
}

function createdLink(c: NonNullable<ChatSessionView['createdCard']>): HTMLElement {
  const href = safeHref(c.url);
  if (!href) return el('span', undefined, `Created ${c.shortId}`);
  const a = el('a', undefined, `Created ${c.shortId} ↗`);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

/**
 * The User → BA step: talk to the business analyst, watch the story draft
 * take shape, then hand it to the board. Everything is rendered with
 * textContent — chat text and drafts are untrusted.
 */
export class ChatPanel {
  private readonly root = document.getElementById('chat') as HTMLElement;
  private readonly project = document.getElementById('chat-project') as HTMLSelectElement;
  private readonly log = document.getElementById('chat-log') as HTMLElement;
  private readonly draftBox = document.getElementById('chat-draft') as HTMLElement;
  private readonly form = document.getElementById('chat-form') as HTMLFormElement;
  private readonly input = document.getElementById('chat-input') as HTMLTextAreaElement;
  private readonly send = document.getElementById('chat-send') as HTMLButtonElement;
  private readonly meta = document.getElementById('chat-meta') as HTMLElement;

  private session: ChatSessionView | null = null;
  private busy = false;
  private pollTimer: number | null = null;
  private projectsKey = '';

  constructor() {
    (document.getElementById('chat-close') as HTMLElement).onclick = () => this.hide();
    (document.getElementById('chat-new') as HTMLElement).onclick = () => void this.newChat();
    this.project.onchange = () => void this.open(this.project.value);
    this.form.onsubmit = (e) => {
      e.preventDefault();
      void this.submitMessage();
    };
    this.input.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void this.submitMessage();
      }
    };
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }

  show(): void {
    this.root.hidden = false;
    if (!this.session && this.project.value) void this.open(this.project.value);
    this.input.focus();
  }

  hide(): void {
    this.root.hidden = true;
  }

  /** Keep the project picker in step with the snapshot. */
  setProjects(projects: readonly ProjectState[]): void {
    const enabled = projects.filter((p) => p.enabled);
    const key = enabled.map((p) => `${p.id}:${p.name}`).join('|');
    if (key === this.projectsKey) return;
    this.projectsKey = key;
    const current = this.project.value;
    this.project.replaceChildren(
      ...enabled.map((p) => {
        const o = el('option', undefined, p.name);
        o.value = p.id;
        return o;
      }),
    );
    if (enabled.some((p) => p.id === current)) this.project.value = current;
    if (this.visible && this.project.value && this.session?.projectId !== this.project.value) {
      void this.open(this.project.value);
    }
  }

  private async open(projectId: string): Promise<void> {
    this.stopPolling();
    const saved = recall(projectId);
    if (saved) {
      try {
        this.render(await api<ChatSessionView>(`/api/chat/${encodeURIComponent(saved)}`));
        return;
      } catch {
        remember(projectId, null); // gone (fresh database) — start over
      }
    }
    await this.newChat(projectId);
  }

  private async newChat(projectId = this.project.value): Promise<void> {
    if (!projectId) return;
    this.stopPolling();
    try {
      const s = await postJson<ChatSessionView>(
        `/api/projects/${encodeURIComponent(projectId)}/chat`,
      );
      remember(projectId, s.id);
      this.render(s);
      this.note('Describe what you need. BA will ask what is missing and draft the story.');
    } catch (e) {
      this.session = null;
      this.log.replaceChildren();
      this.note(`Could not start a chat: ${(e as Error).message}`, 'error');
    }
  }

  private async submitMessage(): Promise<void> {
    const text = this.input.value.trim();
    const s = this.session;
    if (!text || !s || this.busy || s.status !== 'open') return;
    this.input.value = '';
    this.bubble('user', text);
    const reply = this.bubble('assistant', '');
    reply.classList.add('streaming');
    this.setBusy(true);
    try {
      await postStream<ChatStreamEvent>(
        `/api/chat/${encodeURIComponent(s.id)}/messages`,
        { text },
        (e) => this.onEvent(e, reply),
      );
    } catch (e) {
      this.note((e as Error).message, 'error');
    } finally {
      reply.classList.remove('streaming');
      if (!reply.textContent) reply.remove();
      this.setBusy(false);
      await this.refresh();
    }
  }

  private onEvent(e: ChatStreamEvent, reply: HTMLElement): void {
    switch (e.type) {
      case 'text':
        reply.textContent = reply.textContent ? `${reply.textContent}\n\n${e.text}` : e.text;
        break;
      case 'tool':
        this.log.insertBefore(el('div', 'chat-tool muted', `↳ ${e.name}`), reply);
        break;
      case 'draft':
        this.renderDraft(e.draft, 'open');
        break;
      case 'done':
        this.meta.textContent = `$${e.totalCostUsd.toFixed(3)} spent`;
        break;
      case 'error':
        this.note(e.message, 'error');
        break;
    }
    this.scroll();
  }

  private async createStory(): Promise<void> {
    const s = this.session;
    if (!s) return;
    try {
      const r = await postJson<{ assignTo: string; session: ChatSessionView }>(
        `/api/chat/${encodeURIComponent(s.id)}/submit`,
      );
      this.render(r.session);
      this.note(
        r.assignTo === 'none'
          ? 'Story queued. It will be created in the board’s default column.'
          : `Story queued. It will be created and handed to ${r.assignTo}.`,
      );
    } catch (e) {
      this.note((e as Error).message, 'error');
    }
  }

  private async refresh(): Promise<void> {
    if (!this.session) return;
    try {
      this.render(await api<ChatSessionView>(`/api/chat/${encodeURIComponent(this.session.id)}`), {
        keepLog: true,
      });
    } catch {
      /* transient; the next poll or turn catches up */
    }
  }

  private render(s: ChatSessionView, opts: { keepLog?: boolean } = {}): void {
    this.session = s;
    if (this.project.value !== s.projectId) this.project.value = s.projectId;
    if (!opts.keepLog) {
      this.log.replaceChildren();
      for (const m of s.messages) this.bubble(m.role, m.text);
    }
    this.renderDraft(s.draft, s.status);
    this.meta.textContent = `$${s.costUsd.toFixed(3)} of $${s.budgetUsd.toFixed(2)}`;
    this.setBusy(s.busy);
    if (s.status === 'submitted') this.startPolling();
    else this.stopPolling();
  }

  private renderDraft(d: StoryDraft | null, status: ChatSessionView['status']): void {
    this.draftBox.replaceChildren();
    this.draftBox.hidden = !d;
    if (!d) return;
    this.draftBox.append(...draftBody(d), this.draftActions(status));
  }

  /** What the stakeholder can do with the draft now. */
  private draftActions(status: ChatSessionView['status']): HTMLElement {
    const actions = el('div', 'draft-actions');
    if (status === 'open') {
      const create = el('button', 'primary', 'Create story');
      create.type = 'button';
      create.disabled = this.busy;
      create.onclick = () => void this.createStory();
      const refine = el('button', undefined, 'Keep refining');
      refine.type = 'button';
      refine.onclick = () => this.input.focus();
      actions.append(create, refine);
    } else if (status === 'submitted') {
      actions.append(el('span', 'muted', 'Queued — waiting for the board…'));
    } else if (this.session?.createdCard) {
      actions.append(createdLink(this.session.createdCard));
    }
    return actions;
  }

  private bubble(role: 'user' | 'assistant', text: string): HTMLElement {
    const b = el('div', `chat-msg ${role}`, text);
    this.log.append(b);
    this.scroll();
    return b;
  }

  private note(text: string, kind: 'info' | 'error' = 'info'): void {
    this.log.append(el('div', `chat-note ${kind}`, text));
    this.scroll();
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    const closed = this.session?.status !== 'open';
    this.send.disabled = busy || closed;
    this.input.disabled = busy || closed;
    this.send.textContent = busy ? 'BA is typing…' : 'Send';
    for (const b of this.draftBox.querySelectorAll('button.primary')) {
      (b as HTMLButtonElement).disabled = busy;
    }
  }

  private scroll(): void {
    this.log.scrollTop = this.log.scrollHeight;
  }

  private startPolling(): void {
    if (this.pollTimer !== null) return;
    this.pollTimer = window.setInterval(() => void this.refresh(), POLL_CREATED_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
    this.pollTimer = null;
  }
}
