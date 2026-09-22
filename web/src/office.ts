import type { AgentState, AgentStatus, StateSnapshot } from '@server/state.types';

/**
 * Plain-canvas office. Rooms are laid out by the server (project.room); desks
 * by the server too (agent.desk, room-local). The client only draws.
 *
 * Sprites are procedural for now (no asset pipeline yet): a tinted body, a
 * head, and a per-status animation. Swapping in a pixel-art sheet later only
 * touches drawAgent().
 */

const PAD = 24;
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 2.5;

const STATUS: Record<
  AgentStatus,
  { color: string; label: string; anim: 'none' | 'blink' | 'type' | 'pulse' | 'bob' }
> = {
  offline: { color: '#4b5563', label: 'off', anim: 'none' },
  idle: { color: '#9ca3af', label: 'idle', anim: 'blink' },
  preparing: { color: '#60a5fa', label: 'preparing', anim: 'pulse' },
  thinking: { color: '#a78bfa', label: 'thinking', anim: 'pulse' },
  typing: { color: '#34d399', label: 'typing', anim: 'type' },
  verifying: { color: '#fbbf24', label: 'testing', anim: 'pulse' },
  publishing: { color: '#38bdf8', label: 'publishing', anim: 'bob' },
  done: { color: '#22c55e', label: 'done ✓', anim: 'bob' },
  blocked: { color: '#f97316', label: 'blocked', anim: 'none' },
  failed: { color: '#ef4444', label: 'failed', anim: 'none' },
};

export interface Hit {
  agent: AgentState;
}

export class Office {
  private snap: StateSnapshot | null = null;
  private readonly ctx: CanvasRenderingContext2D;
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  private dragging: { x: number; y: number; px: number; py: number } | null = null;
  private raf = 0;
  private dirty = true;
  private fitted = false;
  private hitboxes: { x: number; y: number; w: number; h: number; agent: AgentState }[] = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onClick: (hit: Hit | null) => void,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    this.ctx = ctx;
    this.bind();
    this.resize();
    this.loop();
  }

  update(s: StateSnapshot): void {
    this.snap = s;
    this.dirty = true;
    if (!this.fitted) {
      this.fit();
      this.fitted = true;
    }
  }

  private bind(): void {
    // Observe the canvas itself: opening the drawer resizes the canvas but not its parent.
    new ResizeObserver(() => this.resize()).observe(this.canvas);
    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const f = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        const { x, y } = this.toWorld(e.offsetX, e.offsetY);
        this.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, this.zoom * f));
        this.panX = e.offsetX - x * this.zoom;
        this.panY = e.offsetY - y * this.zoom;
        this.dirty = true;
      },
      { passive: false },
    );
    this.canvas.addEventListener('mousedown', (e) => {
      this.dragging = { x: e.clientX, y: e.clientY, px: this.panX, py: this.panY };
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.dragging) return;
      this.panX = this.dragging.px + (e.clientX - this.dragging.x);
      this.panY = this.dragging.py + (e.clientY - this.dragging.y);
      this.dirty = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (!this.dragging) return;
      const moved = Math.hypot(e.clientX - this.dragging.x, e.clientY - this.dragging.y);
      this.dragging = null;
      if (moved < 4) {
        const rect = this.canvas.getBoundingClientRect();
        const { x, y } = this.toWorld(e.clientX - rect.left, e.clientY - rect.top);
        const hit = this.hitboxes.find(
          (h) => x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h,
        );
        this.onClick(hit ? { agent: hit.agent } : null);
      }
    });
  }

  private toWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: (sx - this.panX) / this.zoom, y: (sy - this.panY) / this.zoom };
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.dirty = true;
  }

  fit(): void {
    if (!this.snap) return;
    const rooms = this.snap.projects.map((p) => p.room);
    const W = Math.max(...rooms.map((r) => r.x + r.w)) + PAD * 2;
    const H = Math.max(...rooms.map((r) => r.y + r.h)) + PAD * 2;
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    this.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.min(cw / W, ch / H)));
    this.panX = (cw - W * this.zoom) / 2 + PAD * this.zoom;
    this.panY = (ch - H * this.zoom) / 2 + PAD * this.zoom;
    this.dirty = true;
  }

  private loop(): void {
    const animating = this.snap?.agents.some((a) => STATUS[a.status].anim !== 'none') ?? false;
    if ((this.dirty || animating) && !document.hidden) {
      this.draw(performance.now());
      this.dirty = false;
    }
    this.raf = requestAnimationFrame(() => this.loop());
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
  }

  private draw(now: number): void {
    const { ctx, canvas } = this;
    const s = this.snap;
    ctx.save();
    ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
    ctx.fillStyle = '#0f1216';
    ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    if (!s) {
      ctx.fillStyle = '#8b95a5';
      ctx.font = '14px ui-monospace, monospace';
      ctx.fillText('waiting for state…', 24, 40);
      ctx.restore();
      return;
    }
    ctx.translate(this.panX, this.panY);
    ctx.scale(this.zoom, this.zoom);
    this.hitboxes = [];

    for (const p of s.projects) {
      const r = p.room;
      // floor
      ctx.fillStyle = '#1b2028';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 3;
      ctx.strokeRect(r.x + 1.5, r.y + 1.5, r.w - 3, r.h - 3);
      // carpet grid
      ctx.strokeStyle = 'rgba(255,255,255,0.03)';
      ctx.lineWidth = 1;
      for (let gx = r.x + 32; gx < r.x + r.w; gx += 32) {
        ctx.beginPath();
        ctx.moveTo(gx, r.y);
        ctx.lineTo(gx, r.y + r.h);
        ctx.stroke();
      }
      for (let gy = r.y + 32; gy < r.y + r.h; gy += 32) {
        ctx.beginPath();
        ctx.moveTo(r.x, gy);
        ctx.lineTo(r.x + r.w, gy);
        ctx.stroke();
      }
      // name plate
      ctx.fillStyle = p.color;
      ctx.fillRect(r.x, r.y, r.w, 26);
      ctx.fillStyle = '#0f1216';
      ctx.font = 'bold 14px ui-monospace, monospace';
      ctx.fillText(`${p.name}${p.enabled ? '' : ' (disabled)'}`, r.x + 12, r.y + 18);
      ctx.font = '12px ui-monospace, monospace';
      const q = `queued ${p.queue.queued} · running ${p.queue.running} · ${p.board.provider}${p.board.tick ? ` · tick ${p.board.tick}` : ' · not polled'}`;
      ctx.fillText(q, r.x + r.w - ctx.measureText(q).width - 12, r.y + 18);

      for (const a of s.agents.filter((x) => x.projectId === p.id)) {
        this.drawAgent(a, r.x + a.desk.x, r.y + a.desk.y, now);
      }
    }
    ctx.restore();
  }

  private drawAgent(a: AgentState, x: number, y: number, now: number): void {
    const { ctx } = this;
    const st = STATUS[a.status];
    const t = now / 1000;

    // desk
    ctx.fillStyle = a.enabled ? '#3b2f22' : '#262a30';
    ctx.fillRect(x - 40, y + 10, 80, 30);
    ctx.fillStyle = a.enabled ? '#5a4632' : '#2f343b';
    ctx.fillRect(x - 40, y + 10, 80, 6);
    // monitor
    ctx.fillStyle = a.enabled
      ? a.status === 'typing' || a.status === 'thinking'
        ? '#0ea5e9'
        : '#111827'
      : '#1f2937';
    ctx.fillRect(x - 12, y - 6, 24, 16);
    if (a.status === 'typing') {
      ctx.fillStyle = '#e0f2fe';
      for (let i = 0; i < 3; i++) {
        const on = Math.floor(t * 8 + i) % 3 !== 0;
        if (on) ctx.fillRect(x - 9 + i * 7, y - 2 + (i % 2) * 4, 5, 2);
      }
    }
    ctx.fillStyle = '#374151';
    ctx.fillRect(x - 2, y + 10, 4, 4);

    // person (in front of the desk)
    if (a.enabled) {
      const bob =
        st.anim === 'bob' ? Math.sin(t * 6) * 2 : st.anim === 'pulse' ? Math.sin(t * 2) * 1 : 0;
      const py = y + 52 + bob;
      // shadow
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath();
      ctx.ellipse(x, py + 18, 14, 4, 0, 0, Math.PI * 2);
      ctx.fill();
      // body
      ctx.fillStyle = st.color;
      ctx.fillRect(x - 10, py - 4, 20, 22);
      // head
      ctx.fillStyle = '#f5d0b0';
      ctx.fillRect(x - 8, py - 22, 16, 16);
      // eyes (blink when idle)
      const blink = st.anim === 'blink' && Math.floor(t) % 4 === 0 && t % 1 < 0.15;
      ctx.fillStyle = '#111';
      if (!blink) {
        ctx.fillRect(x - 5, py - 16, 3, 3);
        ctx.fillRect(x + 2, py - 16, 3, 3);
      } else {
        ctx.fillRect(x - 5, py - 15, 10, 1);
      }
      // arms typing
      if (st.anim === 'type') {
        const up = Math.floor(t * 10) % 2 === 0;
        ctx.fillStyle = '#f5d0b0';
        ctx.fillRect(x - 14, py + (up ? 0 : 3), 4, 6);
        ctx.fillRect(x + 10, py + (up ? 3 : 0), 4, 6);
      }
      // status bubble
      if (
        a.status === 'blocked' ||
        a.status === 'failed' ||
        a.status === 'done' ||
        a.status === 'thinking'
      ) {
        const icon =
          a.status === 'blocked'
            ? '?'
            : a.status === 'failed'
              ? '!'
              : a.status === 'done'
                ? '✓'
                : '…';
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(x + 18, py - 26, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = st.color;
        ctx.font = 'bold 12px ui-monospace, monospace';
        ctx.fillText(icon, x + 18 - ctx.measureText(icon).width / 2, py - 22);
      }
    } else {
      // empty chair
      ctx.fillStyle = '#2f343b';
      ctx.fillRect(x - 9, y + 46, 18, 16);
    }

    // nameplate
    ctx.fillStyle = a.enabled ? '#e6e9ee' : '#6b7280';
    ctx.font = 'bold 11px ui-monospace, monospace';
    const name = a.role;
    ctx.fillText(name, x - ctx.measureText(name).width / 2, y + 88);
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillStyle = st.color;
    ctx.fillText(st.label, x - ctx.measureText(st.label).width / 2, y + 100);

    // pill: turns · $cost/$budget · card
    if (a.run) {
      const over = a.run.costUsd > a.run.budgetUsd * 0.8;
      const text = `#${a.run.cardShortId} · ${a.run.turns}t · $${a.run.costUsd.toFixed(2)}/${a.run.budgetUsd.toFixed(0)} · ${fmtMs(a.run.elapsedMs)}`;
      ctx.font = '10px ui-monospace, monospace';
      const w = ctx.measureText(text).width + 12;
      ctx.fillStyle = over ? '#7c2d12' : '#111827';
      roundRect(ctx, x - w / 2, y - 34, w, 16, 8);
      ctx.fill();
      ctx.fillStyle = over ? '#fdba74' : '#e5e7eb';
      ctx.fillText(text, x - w / 2 + 6, y - 22);
      if (a.run.phase) {
        ctx.fillStyle = '#9ca3af';
        const ph = a.run.phase;
        ctx.fillText(ph, x - ctx.measureText(ph).width / 2, y - 40);
      }
    }

    this.hitboxes.push({ x: x - 44, y: y - 44, w: 88, h: 150, agent: a });
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function fmtMs(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}`;
}
