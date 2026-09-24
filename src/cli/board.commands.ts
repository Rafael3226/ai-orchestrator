import { AdoSource } from '../board/azure-devops/ado.source.js';
import type { BoardSource } from '../board/board.source.js';
import { JiraSource } from '../board/jira/jira.source.js';
import { TrelloSource } from '../board/trello/trello.source.js';
import { loadConfig } from '../config/config.loader.js';
import { BOARD_PROVIDERS, type BoardProvider } from '../config/config.schema.js';
import {
  type BoardCredential,
  credentialOf,
  resolveBoardCredentials,
} from '../config/credentials.js';
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

/** Work item types to read states from when the CLI has no project config to go on. */
const ADO_DISCOVERY_TYPES = ['User Story', 'Product Backlog Item', 'Issue', 'Bug', 'Task'];

export interface BoardCliOptions {
  readonly provider: string;
  readonly cred: string;
}

type ProjectLister = { listProjects?: () => Promise<{ id: string; name: string; url: string }[]> };

function providerOf(o: BoardCliOptions): BoardProvider {
  if (!(BOARD_PROVIDERS as readonly string[]).includes(o.provider)) {
    throw new Error(`--provider must be one of ${BOARD_PROVIDERS.join(', ')}`);
  }
  return o.provider as BoardProvider;
}

function credFor(ref: string, kind: BoardProvider): BoardCredential {
  const creds = resolveBoardCredentials(new Map([[ref, { kind, projects: ['(cli)'] }]]));
  return creds.get(ref) as BoardCredential;
}

/**
 * A source for ad-hoc CLI use. `target` locates the board: a Trello board id,
 * `organization/project` for Azure DevOps, or `site/PROJECTKEY` for Jira.
 */
function sourceFor(o: BoardCliOptions, target: string): BoardSource & ProjectLister {
  const provider = providerOf(o);
  const cred = credFor(o.cred, provider);
  switch (provider) {
    case 'trello':
      return new TrelloSource(target, credentialOf(cred, 'trello', o.cred));
    case 'azure-devops': {
      const [organization = '', project = ''] = target.split('/');
      if (!organization) throw new Error('azure-devops: pass organization or organization/project');
      return new AdoSource(
        target,
        { organization, project, workItemTypes: ADO_DISCOVERY_TYPES },
        credentialOf(cred, 'azure-devops', o.cred),
        { lenientTypes: true },
      );
    }
    case 'jira': {
      const [rawSite = '', projectKey = ''] = target.split('/');
      if (!rawSite) throw new Error('jira: pass site or site/PROJECTKEY, e.g. acme/PROJ');
      const site = rawSite.includes('.') ? rawSite : `${rawSite}.atlassian.net`;
      return new JiraSource(target, { site, projectKey }, credentialOf(cred, 'jira', o.cred));
    }
  }
}

/** `orchestrator whoami <target>` — the id to put in board.botMemberId. */
export async function whoAmI(target: string, o: BoardCliOptions): Promise<number> {
  const me = await sourceFor(o, target).whoAmI();
  console.log(`${o.cred} authenticates as ${me.username}\n\n    botMemberId: "${me.id}"`);
  return 0;
}

/** `orchestrator boards [target]` — Trello board ids, or Azure DevOps / Jira projects. */
export async function listBoards(target: string | undefined, o: BoardCliOptions): Promise<number> {
  const provider = providerOf(o);
  if (provider === 'trello') {
    const cred = credentialOf(credFor(o.cred, 'trello'), 'trello', o.cred);
    const boards = await TrelloSource.listBoards(cred);
    const me = await new TrelloSource('_', cred).whoAmI();
    console.log(
      `token belongs to @${me.username} (member id ${me.id}) — use this as board.botMemberId\n`,
    );
    const w = Math.max(...boards.map((b) => b.name.length), 4);
    for (const b of boards) console.log(`${b.id}  ${b.name.padEnd(w)}  ${b.url}`);
    return 0;
  }
  if (!target) {
    throw new Error(
      provider === 'jira'
        ? 'jira: pass the site, e.g. `boards acme --provider jira`'
        : 'azure-devops: pass the organization, e.g. `boards contoso --provider azure-devops`',
    );
  }
  const source = sourceFor(o, target);
  const me = await source.whoAmI();
  console.log(
    `${o.cred} authenticates as ${me.username} (id ${me.id}) — use this as board.botMemberId\n`,
  );
  const projects = (await source.listProjects?.()) ?? [];
  const w = Math.max(...projects.map((p) => p.id.length), 4);
  for (const p of projects) console.log(`${p.id.padEnd(w)}  ${p.name}  ${p.url}`);
  return 0;
}

/** `orchestrator lists <target>` — columns, labels, members with their ids. */
export async function describeBoard(target: string, o: BoardCliOptions): Promise<number> {
  const t = await sourceFor(o, target).describe();
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
 *
 * Trello only: Azure DevOps states and Jira statuses belong to a process or a
 * workflow that an admin owns. For those, `<name>` is the target and this
 * prints a `board:` block mapping the states that already exist.
 */
export async function initBoard(name: string, o: BoardCliOptions): Promise<number> {
  const provider = providerOf(o);
  if (provider !== 'trello') return printBoardBlock(name, o);
  const ref = o.cred;
  const cred = credentialOf(credFor(ref, 'trello'), 'trello', ref);
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

async function printBoardBlock(target: string, o: BoardCliOptions): Promise<number> {
  const [a = '', b = ''] = target.split('/');
  if (!b)
    throw new Error(
      `${o.provider}: pass the target as ${o.provider === 'jira' ? 'site/PROJECTKEY' : 'organization/project'}`,
    );
  const source = sourceFor(o, target);
  const [t, me] = await Promise.all([source.describe(), source.whoAmI()]);
  const where =
    o.provider === 'jira'
      ? `      site: ${a}\n      projectKey: ${b}`
      : `      organization: ${a}\n      project: ${b}`;
  console.log(`# ${o.provider} states are not created from here; this maps the ones that exist.\n`);
  console.log(`    board:
      provider: ${o.provider}
${where}
      credentials: ${o.cred}
      botMemberId: "${me.id}"
      columns:
${t.columns.map((c) => `        ${columnAlias(c.name)}: ${c.name}`).join('\n')}`);
  return 0;
}

/** `In Review` -> `inReview`: a valid `board.columns` alias. */
export function columnAlias(name: string): string {
  const words = name
    .toLocaleLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const camel = words
    .map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join('');
  return /^[a-z]/.test(camel) ? camel : `s${camel}`;
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
