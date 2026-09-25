import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { BoardStore } from '../board/board.store.js';
import { loadConfigFromString } from '../config/config.loader.js';
import { ChatStore } from '../db/chat.store.js';
import { SqliteStore } from '../db/sqlite.store.js';
import { newRunId, newTaskId } from '../domain/ids.js';

import { ChatService, type RunTurn } from './chat.service.js';
import type { StoryDraft } from './chat.types.js';
import { OfficeServer, originAllowed } from './http.server.js';

const yaml = `
version: 1
projects:
  - id: pa
    name: A
    repo: { path: /a, worktreeRoot: /w, githubRepo: x/a }
    board: { provider: trello, boardId: b1, credentials: T, columns: {} }
    agents: { DEV: { enabled: true } }
    routes: [{ when: { list: Ready }, agent: DEV }]
`;

/** Port 0 so the suite never collides with a running daemon. */
async function serve(webDist?: string): Promise<{
  url: string;
  store: SqliteStore;
  server: OfficeServer;
}> {
  const store = new SqliteStore(':memory:');
  const server = new OfficeServer(loadConfigFromString(yaml, 'x'), store, new BoardStore(store), {
    host: '127.0.0.1',
    port: 0,
    log: () => {},
    ...(webDist ? { webDist } : {}),
  });
  const url = await server.start();
  return { url, store, server };
}

const open: { store: SqliteStore; server: OfficeServer }[] = [];
const start = async (webDist?: string) => {
  const s = await serve(webDist);
  open.push(s);
  return s;
};

afterEach(async () => {
  for (const s of open.splice(0)) {
    await s.server.stop();
    s.store.close();
  }
});

describe('OfficeServer API', () => {
  it('serves healthz and a state snapshot', async () => {
    const { url } = await start();

    const health = await (await fetch(`${url}/api/healthz`)).json();
    expect(health).toMatchObject({ ok: true, clients: 0 });

    const snap = (await (await fetch(`${url}/api/state`)).json()) as {
      projects: { id: string }[];
      agents: { key: string }[];
    };
    expect(snap.projects.map((p) => p.id)).toEqual(['pa']);
    expect(snap.agents.some((a) => a.key === 'pa:DEV')).toBe(true);
  });

  it('returns log lines for a known run, and an empty log for an unknown one', async () => {
    const { url, store } = await start();
    const task = store.insertTask({
      id: newTaskId(),
      projectId: 'pa',
      role: 'DEV',
      cardId: 'c',
      cardShortId: '1',
      title: 'T',
      spec: '',
    });
    const runId = newRunId();
    store.insertRun({
      id: runId,
      taskId: task.id,
      projectId: 'pa',
      workspaceId: null,
      attempt: 1,
      role: 'DEV',
      driver: 'local',
      model: 'opus',
      resumedFrom: null,
    });
    store.appendEvent(runId, task.id, 'assistant-text', { text: 'hello from the agent' });

    const body = (await (await fetch(`${url}/api/runs/${runId}`)).json()) as {
      runId: string;
      live: boolean;
      lines: { text: string }[];
    };
    expect(body.runId).toBe(runId);
    expect(body.lines.some((l) => l.text.includes('hello from the agent'))).toBe(true);

    // Documents current behaviour, not the intent: neither `logLines` nor `runIsLive`
    // throws for an unknown id, so the route's 404 branch never fires.
    const missing = await fetch(`${url}/api/runs/run_does_not_exist`);
    expect(missing.status).toBe(200);
    expect(((await missing.json()) as { lines: unknown[] }).lines).toEqual([]);
  });

  it('pushes a snapshot to a new SSE subscriber and drops it on disconnect', async () => {
    const { url } = await start();
    const ac = new AbortController();
    const res = await fetch(`${url}/api/events`, { signal: ac.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reader = res.body!.getReader();
    let buf = '';
    while (!buf.includes('event: state.snapshot')) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
    }
    expect(buf).toContain('retry: 3000');
    expect(buf).toContain('"projects"');

    const during = (await (await fetch(`${url}/api/healthz`)).json()) as { clients: number };
    expect(during.clients).toBe(1);

    ac.abort();
    await reader.cancel().catch(() => {});
    // The close handler runs on the server's next tick, not ours.
    for (let i = 0; i < 40; i++) {
      const h = (await (await fetch(`${url}/api/healthz`)).json()) as { clients: number };
      if (h.clients === 0) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('client was never dropped');
  });

  it('broadcasts a fresh snapshot to subscribers when the state actually changes', async () => {
    const { url, store, server } = await start();
    const ac = new AbortController();
    const res = await fetch(`${url}/api/events`, { signal: ac.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    const readUntil = async (pred: (s: string) => boolean): Promise<string> => {
      let buf = '';
      while (!pred(buf)) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`stream ended early: ${buf}`);
        buf += decoder.decode(value);
      }
      return buf;
    };
    await readUntil((s) => s.includes('event: state.snapshot'));

    store.insertTask({
      id: newTaskId(),
      projectId: 'pa',
      role: 'DEV',
      cardId: 'c',
      cardShortId: '7',
      title: 'Queue me',
      spec: '',
    });

    // The snapshot timer ticks once a second and only emits on a real change.
    const pushed = await readUntil((s) => s.includes('Queue me'));
    expect(pushed).toContain('event: state.snapshot');
    expect(server.lastJson).toContain('Queue me');

    ac.abort();
    await reader.cancel().catch(() => {});
  }, 20_000);

  it('ends the log stream once the run is no longer live', async () => {
    const { url, store } = await start();
    const task = store.insertTask({
      id: newTaskId(),
      projectId: 'pa',
      role: 'DEV',
      cardId: 'c',
      cardShortId: '1',
      title: 'T',
      spec: '',
    });
    const runId = newRunId();
    store.insertRun({
      id: runId,
      taskId: task.id,
      projectId: 'pa',
      workspaceId: null,
      attempt: 1,
      role: 'DEV',
      driver: 'local',
      model: 'opus',
      resumedFrom: null,
    });
    store.appendEvent(runId, task.id, 'assistant-text', { text: 'tail me' });
    store.updateRun(runId, { state: 'finished', ended_at: new Date().toISOString() });

    const res = await fetch(`${url}/api/runs/${runId}/log`);
    const text = await res.text(); // the server closes it: a finished run gets log.end
    expect(text).toContain('event: log.tail');
    expect(text).toContain('tail me');
    expect(text).toContain('event: log.end');
  });

  it('hints at the missing client build when no webDist is configured', async () => {
    const { url } = await start();
    const body = (await (await fetch(`${url}/`)).json()) as { hint: string };
    expect(body.hint).toContain('pnpm web:build');
  });
});

describe('OfficeServer static serving', () => {
  const dist = mkdtempSync(join(tmpdir(), 'office-dist-'));
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>office</title>');
  writeFileSync(join(dist, 'assets', 'app-abc123.js'), 'export const x = 1;\n');

  it('serves the built client and falls back to index.html for routes', async () => {
    const { url } = await start(dist);

    const index = await fetch(`${url}/`);
    expect(await index.text()).toContain('<title>office</title>');

    const asset = await fetch(`${url}/assets/app-abc123.js`);
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain('export const x = 1');

    const route = await fetch(`${url}/run/anything`);
    expect(route.status).toBe(200);
    expect(await route.text()).toContain('<title>office</title>');
  });

  it('404s a missing asset instead of answering it with index.html', async () => {
    const { url } = await start(dist);

    // A stale hash must not resolve to HTML: the browser rejects that for a module script.
    const stale = await fetch(`${url}/assets/app-oldhash.js`);
    expect(stale.status).toBe(404);
    expect(await stale.text()).not.toContain('<title>');

    expect((await fetch(`${url}/favicon.ico`)).status).toBe(404);
    expect((await fetch(`${url}/api/nope`)).status).toBe(404);
  });

  it('ignores the query string when deciding asset vs route', async () => {
    const { url } = await start(dist);
    expect((await fetch(`${url}/assets/app-oldhash.js?v=2`)).status).toBe(404);
    expect((await fetch(`${url}/run/x?tab=log`)).status).toBe(200);
  });
});

describe('originAllowed', () => {
  it('lets through no Origin, the same host and loopback dev origins only', () => {
    expect(originAllowed(undefined, '127.0.0.1:7777')).toBe(true);
    expect(originAllowed('http://127.0.0.1:7777', '127.0.0.1:7777')).toBe(true);
    expect(originAllowed('http://localhost:5173', '127.0.0.1:7777')).toBe(true);
    expect(originAllowed('https://evil.example', '127.0.0.1:7777')).toBe(false);
    expect(originAllowed('null', '127.0.0.1:7777')).toBe(false);
  });
});

describe('OfficeServer chat routes', () => {
  const draft: StoryDraft = {
    type: 'story',
    title: 'Export arrivals as CSV',
    userStory: 'As an officer, I want a CSV export, so that I can report monthly.',
    description: '',
    acceptanceCriteria: ['Given arrivals, when I export, then I get a CSV'],
    businessDecisions: [],
    openQuestions: [],
  };
  const turn: RunTurn = async (input) => {
    input.emit({ type: 'text', text: 'Noted.' });
    input.onDraft(draft);
    return { sdkSessionId: 's1', costUsd: 0.01, text: 'Noted.', errors: [] };
  };

  async function chatServer() {
    const store = new SqliteStore(':memory:');
    const loaded = loadConfigFromString(yaml, 'x');
    const submitted: string[] = [];
    const chat = new ChatService({
      project: (id) => loaded.project(id),
      store: new ChatStore(store),
      runTurn: turn,
      stories: { submitStory: (_p, key) => submitted.push(key) },
    });
    const server = new OfficeServer(loaded, store, new BoardStore(store), {
      host: '127.0.0.1',
      port: 0,
      log: () => {},
      chat,
    });
    const url = await server.start();
    open.push({ store, server });
    return { url, submitted };
  }

  const post = (url: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(url, {
      method: 'POST',
      headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it('starts a session, streams a turn over SSE and submits the draft', async () => {
    const { url, submitted } = await chatServer();

    const started = await post(`${url}/api/projects/pa/chat`);
    expect(started.status).toBe(201);
    const { id } = (await started.json()) as { id: string };

    const res = await post(`${url}/api/chat/${id}/messages`, { text: 'We need an export' });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('event: text');
    expect(text).toContain('event: draft');
    expect(text).toContain('event: done');

    const view = (await (await fetch(`${url}/api/chat/${id}`)).json()) as {
      messages: unknown[];
      draft: StoryDraft | null;
    };
    expect(view.messages).toHaveLength(2);
    expect(view.draft?.title).toBe(draft.title);

    const sub = await post(`${url}/api/chat/${id}/submit`);
    expect(sub.status).toBe(200);
    expect(await sub.json()).toMatchObject({ queued: true, session: { status: 'submitted' } });
    expect(submitted).toEqual([`chat:${id}`]);
    expect((await post(`${url}/api/chat/${id}/submit`)).status).toBe(409);
  });

  it('answers validation failures with a status code, not a stream', async () => {
    const { url } = await chatServer();
    expect((await post(`${url}/api/projects/nope/chat`)).status).toBe(404);
    expect((await fetch(`${url}/api/chat/chat_00`)).status).toBe(404);
    const { id } = (await (await post(`${url}/api/projects/pa/chat`)).json()) as { id: string };
    expect((await post(`${url}/api/chat/${id}/messages`, { text: '' })).status).toBe(400);
    expect((await post(`${url}/api/chat/${id}/submit`)).status).toBe(409); // no draft yet
  });

  it('refuses cross-origin POSTs', async () => {
    const { url } = await chatServer();
    const res = await post(`${url}/api/projects/pa/chat`, undefined, {
      origin: 'https://evil.example',
    });
    expect(res.status).toBe(403);
  });

  it('does not mount the chat when no service is given', async () => {
    const { url } = await start();
    expect((await post(`${url}/api/projects/pa/chat`)).status).toBe(404);
  });
});
