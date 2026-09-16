import type { StateSnapshot } from '@server/state.types';

import { Drawer } from './drawer';
import { openStateStream } from './net';
import { fmtMs, Office } from './office';

const canvas = document.getElementById('office') as HTMLCanvasElement;
const conn = document.getElementById('conn') as HTMLElement;
const stats = document.getElementById('stats') as HTMLElement;
const diag = document.getElementById('diag') as HTMLElement;
const recent = document.getElementById('recent') as HTMLElement;

const drawer = new Drawer();
let latest: StateSnapshot | null = null;

const office = new Office(canvas, (hit) => {
  if (hit) drawer.show(hit.agent);
  else drawer.hide();
});

openStateStream(
  (s) => {
    latest = s;
    office.update(s);
    const busy = s.agents.filter((a) => a.run).length;
    stats.textContent = `${s.projects.length} project(s) · ${busy} agent(s) busy · ${s.cards.filter((c) => c.state === 'queued').length} queued · outbox ${JSON.stringify(s.outbox)} · rev ${s.configRevision}`;
    diag.textContent = s.diagnostics.length
      ? `⚠ ${s.diagnostics.map((d) => d.message).join(' | ')}`
      : '';
    recent.textContent = s.runs.recent
      .slice(0, 6)
      .map(
        (r) =>
          `#${r.cardShortId} ${r.role} ${r.outcome ?? r.state}${r.costUsd != null ? ` $${r.costUsd.toFixed(2)}` : ''}${r.durationMs != null ? ` ${fmtMs(r.durationMs)}` : ''}${r.prUrl ? ' PR' : ''}`,
      )
      .join('   ·   ');
    // keep the drawer's meta fresh for the agent it is showing
    const shown = document.getElementById('drawer') as HTMLElement;
    if (!shown.hidden) {
      const title = (document.getElementById('drawer-title') as HTMLElement).textContent ?? '';
      const key = title.split(' · ').slice(0, 2).join(':');
      const a = s.agents.find((x) => x.key === key);
      if (a) drawer.show(a);
    }
  },
  (c) => {
    conn.textContent = c;
    conn.className = `pill ${c === 'live' ? 'ok' : c === 'reconnecting' ? 'bad' : ''}`;
  },
);

window.addEventListener('keydown', (e) => {
  if (e.key === 'f' && latest) office.fit();
});
