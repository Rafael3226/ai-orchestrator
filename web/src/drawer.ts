import type { AgentState, LogLine } from '@server/state.types';

import { openLogStream } from './net';

/** DOM log panel: text selection, scrolling and accessibility for free. Read-only. */
export class Drawer {
  private close: (() => void) | null = null;
  private currentRun: string | null = null;
  private readonly el = document.getElementById('drawer') as HTMLElement;
  private readonly title = document.getElementById('drawer-title') as HTMLElement;
  private readonly meta = document.getElementById('drawer-meta') as HTMLElement;
  private readonly log = document.getElementById('drawer-log') as HTMLElement;

  constructor() {
    (document.getElementById('drawer-close') as HTMLElement).onclick = () => this.hide();
    window.addEventListener('keydown', (e) => e.key === 'Escape' && this.hide());
  }

  show(agent: AgentState): void {
    this.el.hidden = false;
    this.title.textContent = `${agent.projectId} · ${agent.role} · ${agent.status}`;
    if (!agent.run) {
      this.meta.textContent = agent.enabled
        ? 'No active run.'
        : 'Role not enabled for this project.';
      this.log.textContent = '';
      this.stop();
      return;
    }
    const r = agent.run;
    this.meta.textContent = [
      `#${r.cardShortId} ${r.cardTitle}`,
      r.cardUrl ? r.cardUrl : '',
      `branch ${r.branch ?? '-'} · ${r.turns} turns · $${r.costUsd.toFixed(3)} of $${r.budgetUsd}`,
      r.phase ? `phase ${r.phase}` : '',
      r.lastMessage ?? '',
    ]
      .filter(Boolean)
      .join('\n');
    if (r.id && r.id !== this.currentRun) {
      this.stop();
      this.currentRun = r.id;
      this.log.textContent = '';
      this.close = openLogStream(r.id, {
        onTail: (lines) => this.append(lines),
        onLines: (lines) => this.append(lines),
        onTruncated: (n) =>
          this.append([{ seq: 0, ts: '', kind: 'meta', text: `… ${n} lines dropped …` }]),
        onEnd: () => this.append([{ seq: 0, ts: '', kind: 'meta', text: '— run finished —' }]),
      });
    }
  }

  hide(): void {
    this.el.hidden = true;
    this.stop();
  }

  private stop(): void {
    this.close?.();
    this.close = null;
    this.currentRun = null;
  }

  private append(lines: LogLine[]): void {
    const atBottom = this.log.scrollTop + this.log.clientHeight >= this.log.scrollHeight - 20;
    for (const l of lines) {
      const span = document.createElement('span');
      span.className = `k-${l.kind}`;
      span.textContent = `${l.ts ? l.ts.slice(11, 19) + ' ' : ''}${l.text}\n`;
      this.log.appendChild(span);
    }
    while (this.log.childNodes.length > 3000) this.log.removeChild(this.log.firstChild as Node);
    if (atBottom) this.log.scrollTop = this.log.scrollHeight;
  }
}
