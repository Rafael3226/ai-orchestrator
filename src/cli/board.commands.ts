import { TrelloSource } from '../board/trello/trello.source.js';
import { loadConfig } from '../config/config.loader.js';
import { type BoardCredential, resolveBoardCredentials } from '../config/credentials.js';
import { loadOrchestratorEnv } from '../config/env.js';

const STANDARD_COLUMNS = [
  'Backlog',
  'Ready for Dev',
  'In Progress',
  'In Review',
  'Blocked',
  'Done',
];
const STANDARD_LABELS = ['be', 'fe', 'qa', 'devops', 'ai-failed', 'needs-human', 'ai-generated'];

function credFor(ref: string): BoardCredential {
  const env = process.env;
  const apiKey = env[`${ref}_API_KEY`];
  const token = env[`${ref}_TOKEN`];
  if (!apiKey || !token)
    throw new Error(`missing ${ref}_API_KEY / ${ref}_TOKEN in the environment`);
  return { ref, apiKey, token, apiSecret: env[`${ref}_API_SECRET`] };
}

/** `orchestrator boards --cred TRELLO_MAIN` — discover board ids. */
export async function listBoards(ref: string): Promise<number> {
  const cred = credFor(ref);
  const boards = await TrelloSource.listBoards(cred);
  const me = await new TrelloSource('_', cred).whoAmI();
  console.log(
    `token belongs to @${me.username} (member id ${me.id}) — use this as board.botMemberId\n`,
  );
  const w = Math.max(...boards.map((b) => b.name.length), 4);
  for (const b of boards) console.log(`${b.id}  ${b.name.padEnd(w)}  ${b.url}`);
  return 0;
}

/** `orchestrator lists <boardId> --cred TRELLO_MAIN` — columns, labels, members. */
export async function describeBoard(boardId: string, ref: string): Promise<number> {
  const t = await new TrelloSource(boardId, credFor(ref)).describe();
  console.log(`# ${t.name} (${t.boardId})\n\ncolumns:`);
  for (const c of t.columns) console.log(`  ${c.id}  ${c.name}`);
  console.log('\nlabels:');
  for (const l of t.labels) console.log(`  ${l.id}  ${l.name}${l.color ? ` (${l.color})` : ''}`);
  console.log('\nmembers:');
  for (const m of t.members) console.log(`  ${m.id}  @${m.username}  ${m.displayName}`);
  return 0;
}

/**
 * `orchestrator init-board <name> --cred TRELLO_MAIN` — create a board with the
 * standard columns and labels, and print the YAML block to paste.
 */
export async function initBoard(name: string, ref: string): Promise<number> {
  const cred = credFor(ref);
  const board = await TrelloSource.createBoard(cred, name, STANDARD_COLUMNS);
  await TrelloSource.ensureLabels(cred, board.id, STANDARD_LABELS);
  const me = await new TrelloSource(board.id, cred).whoAmI();
  console.log(`created ${board.url}\n`);
  console.log(`    board:
      provider: trello
      boardId: "${board.id}"
      credentials: ${ref}
      botMemberId: "${me.id}"
      columns:
        backlog: Backlog
        ready: Ready for Dev
        inProgress: In Progress
        review: In Review
        blocked: Blocked
        done: Done`);
  return 0;
}

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const secs = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  return `${Math.round(secs / 3600)}h ago`;
}

/** `orchestrator status` — queue and outbox counts from the local database. */
export async function showStatus(): Promise<number> {
  const env = loadOrchestratorEnv();
  const loaded = loadConfig(env.ORCHESTRATOR_CONFIG);
  const { SqliteStore } = await import('../db/sqlite.store.js');
  const { BoardStore } = await import('../board/board.store.js');
  const store = new SqliteStore(env.ORCHESTRATOR_DB);
  const boardStore = new BoardStore(store);
  try {
    for (const p of loaded.config.projects) {
      const tasks = store.listTasks({ projectId: p.id });
      const byState = tasks.reduce<Record<string, number>>(
        (acc, t) => ((acc[t.state] = (acc[t.state] ?? 0) + 1), acc),
        {},
      );
      const cursor = boardStore.getCursor(p.id);
      console.log(
        `${p.id}${p.enabled ? '' : ' (disabled)'}: ${tasks.length} task(s) ${JSON.stringify(byState)} · cursor ${cursor.cursor ?? 'none'} · tick ${cursor.tick}`,
      );
      if (p.board.webhook.enabled) {
        const w = boardStore.getWebhookStats(p.id);
        console.log(
          w
            ? `  webhook: ${w.registeredId ?? 'unregistered'} · last delivery ${ago(w.lastDeliveryAt)} · ` +
                `${w.delivered} delivered / ${w.rejected} rejected / ${w.dropped} dropped`
            : '  webhook: enabled, but nothing delivered yet',
        );
      }
      for (const t of tasks.filter((x) => !['review', 'cancelled'].includes(x.state)).slice(-10)) {
        console.log(
          `  [${t.card_short_id}] ${t.state.padEnd(11)} ${t.role.padEnd(6)} ${t.title.slice(0, 60)}${t.pr_url ? '  ' + t.pr_url : ''}`,
        );
      }
    }
    console.log(`outbox: ${JSON.stringify(boardStore.outboxCounts())}`);
    return 0;
  } finally {
    store.close();
  }
}

export { resolveBoardCredentials };
