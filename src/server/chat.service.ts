import { randomBytes } from 'node:crypto';

import {
  createSdkMcpServer,
  type Options,
  query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
  tool,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import type { WorkItemDraft } from '../board/board.actions.js';
import type { BoardCard } from '../board/board.types.js';
import type { ProjectConfig } from '../config/config.loader.js';
import type { ChatSessionRow, ChatStore } from '../db/chat.store.js';
import { summarizeCost } from '../exec/cost.accumulator.js';
import { preview } from '../exec/sdk.session.js';
import { AGENT_ENV } from '../policy/tool.policy.js';
import { sanitizeCardText } from '../prompt/user.prompt.js';

import {
  type ChatSessionView,
  type ChatStreamEvent,
  STORY_TYPES,
  type StoryDraft,
} from './chat.types.js';

/**
 * The BA chat: the "User → BA" step of the flow. A stakeholder talks to a
 * business analyst in the office UI; the BA keeps a structured story draft up
 * to date through `propose_story`; "Create story" queues it on the outbox like
 * any other board write, and the flow (`flow.newItems.story`) decides who picks
 * it up — PM, in the standard setup.
 *
 * Unlike a task run this is interactive and has no worktree: the BA reads the
 * project's checkout to ground its vocabulary and writes nothing anywhere.
 */

export const CHAT_SERVER_KEY = 'chat';
export const MAX_MESSAGE_CHARS = 4000;
const TURN_MAX_TURNS = 15;
const TURN_WALL_CLOCK_MS = 5 * 60_000;

const DISALLOWED = [
  'WebFetch',
  'WebSearch',
  'SlashCommand',
  'Skill',
  'Agent',
  'Task',
  'Edit',
  'Write',
  'NotebookEdit',
  'Bash',
];

export const proposeStoryShape = {
  type: z.enum(STORY_TYPES),
  title: z.string().min(5).max(200),
  userStory: z.string().min(10).max(1000),
  description: z.string().max(8000),
  acceptanceCriteria: z.array(z.string().min(5).max(500)).min(1).max(30),
  businessDecisions: z
    .array(z.object({ title: z.string().min(3).max(160), rationale: z.string().min(5).max(2000) }))
    .max(30),
  openQuestions: z.array(z.string().min(3).max(500)).max(20),
} as const;

/** Byte-stable per project so the prompt cache hits across turns and sessions. */
export function buildChatSystemAppend(project: ProjectConfig): string {
  return [
    `You are BA, the business analyst of an AI dev team working on "${project.name}".`,
    'A stakeholder is talking to you to turn a need into a work item the team can build.',
    '',
    '## How you work',
    '- Interview. When something needed is missing, ask ONE focused question at a time.',
    '- The current directory is the project repository. Read it only to ground terminology and',
    '  check feasibility — you never change anything, and you have no network access.',
    '- Write stories to INVEST: independent, negotiable, valuable, estimable, small, testable.',
    '  Split a need that is too big and say so.',
    '- The user story reads "As a <role>, I want <capability>, so that <benefit>".',
    '- Acceptance criteria are testable, one per entry, in Given / When / Then form.',
    '- Record every business decision the stakeholder makes (a rule, a scope cut, a choice',
    '  between options) with its rationale. Unresolved points go in openQuestions.',
    '- Call mcp__chat__propose_story whenever the draft materially changes, so the stakeholder',
    '  always sees the current version. The stakeholder creates the story from that draft.',
    "- Never promise dates or estimates — planning is PM's job.",
    '- Answer in the language the stakeholder writes in. Keep replies short.',
  ].join('\n');
}

/** The card the story becomes: acceptance criteria travel separately as a checklist. */
export function draftToWorkItem(draft: StoryDraft, sessionId: string): WorkItemDraft {
  const body: string[] = [draft.userStory.trim()];
  if (draft.description.trim()) body.push('', draft.description.trim());
  if (draft.businessDecisions.length) {
    body.push(
      '',
      '## Business decisions',
      ...draft.businessDecisions.map((d) => `- **${d.title}** — ${d.rationale}`),
    );
  }
  if (draft.openQuestions.length) {
    body.push('', '## Open questions', ...draft.openQuestions.map((q) => `- ${q}`));
  }
  body.push('', `<sub>Written with BA in the office chat (${sessionId}).</sub>`);
  return {
    type: draft.type,
    title: draft.title,
    description: body.join('\n'),
    acceptanceCriteria: draft.acceptanceCriteria,
    assignTo: 'default',
  };
}

/** Where a confirmed story goes. The orchestrator implements it with its outbox. */
export interface StorySink {
  submitStory(projectId: string, keyPrefix: string, item: WorkItemDraft): void;
}

export interface TurnInput {
  readonly project: ProjectConfig;
  /** SDK session to continue; null on the first turn. */
  readonly resume: string | null;
  readonly prompt: string;
  readonly systemAppend: string;
  readonly model: string;
  readonly maxTurns: number;
  readonly maxBudgetUsd: number;
  readonly onDraft: (draft: StoryDraft) => void;
  readonly emit: (e: ChatStreamEvent) => void;
  readonly signal: AbortSignal;
}

export interface TurnResult {
  readonly sdkSessionId: string | null;
  readonly costUsd: number;
  /** Everything the BA said this turn, joined. */
  readonly text: string;
  readonly errors: readonly string[];
}

/** One user message → one BA reply. Injectable so tests never reach the SDK. */
export type RunTurn = (input: TurnInput) => Promise<TurnResult>;

export class ChatError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 402 | 503,
    message: string,
  ) {
    super(message);
    this.name = 'ChatError';
  }
}

export interface ChatServiceDeps {
  /** Throws for an unknown project id. */
  readonly project: (id: string) => ProjectConfig;
  readonly store: ChatStore;
  readonly runTurn?: RunTurn;
  /** Absent in office-only mode: chatting works, submitting does not. */
  readonly stories?: StorySink | null;
  readonly log?: (msg: string) => void;
}

export class ChatService {
  private readonly busy = new Set<string>();
  private readonly runTurn: RunTurn;
  private stories: StorySink | null;

  constructor(private readonly deps: ChatServiceDeps) {
    this.runTurn = deps.runTurn ?? sdkRunTurn;
    this.stories = deps.stories ?? null;
  }

  /** Late binding: the orchestrator is built after the server in some start paths. */
  attachStories(sink: StorySink): void {
    this.stories = sink;
  }

  static keyPrefix(sessionId: string): string {
    return `chat:${sessionId}`;
  }

  start(projectId: string): ChatSessionView {
    const project = this.projectOr404(projectId);
    if (!project.enabled) throw new ChatError(409, `project ${projectId} is disabled`);
    const id = `chat_${randomBytes(8).toString('hex')}`;
    this.deps.store.create(id, projectId);
    return this.view(id);
  }

  view(sessionId: string): ChatSessionView {
    const s = this.session(sessionId);
    return {
      id: s.id,
      projectId: s.projectId,
      status: s.status,
      messages: this.deps.store.messages(s.id),
      draft: s.draft,
      createdCard: s.createdCard,
      costUsd: s.costUsd,
      budgetUsd: this.budgetFor(s.projectId),
      busy: this.busy.has(s.id),
    };
  }

  /**
   * Run one BA turn. Events stream through `emit`; the last one is always
   * `done` or `error`. Validation failures throw ChatError before anything is
   * emitted, so the route can still answer with a plain status code.
   */
  async send(
    sessionId: string,
    rawText: string,
    emit: (e: ChatStreamEvent) => void,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<void> {
    const s = this.session(sessionId);
    const text = this.checkSendable(s, rawText);
    this.busy.add(s.id);
    this.deps.store.addMessage(s.id, 'user', text);

    const turnAbort = new AbortController();
    const onAbort = () => turnAbort.abort();
    signal.addEventListener('abort', onAbort);
    const timer = setTimeout(() => turnAbort.abort(), TURN_WALL_CLOCK_MS);
    try {
      await this.turn(s, text, emit, turnAbort.signal);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.log?.(`chat ${s.id}: turn failed: ${message}`);
      emit({ type: 'error', message });
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      this.busy.delete(s.id);
    }
  }

  /** Throws a ChatError the route turns into a status code. Returns the trimmed text. */
  private checkSendable(s: ChatSessionRow, rawText: string): string {
    if (s.status !== 'open') throw new ChatError(409, 'this story was already submitted');
    const text = rawText.trim();
    if (!text) throw new ChatError(400, 'empty message');
    if (text.length > MAX_MESSAGE_CHARS) {
      throw new ChatError(400, `message is longer than ${MAX_MESSAGE_CHARS} characters`);
    }
    const budget = this.budgetFor(s.projectId);
    if (s.costUsd >= budget) {
      throw new ChatError(402, `this conversation used its $${budget.toFixed(2)} budget`);
    }
    if (this.busy.has(s.id)) throw new ChatError(409, 'BA is still answering');
    return text;
  }

  private async turn(
    s: ChatSessionRow,
    text: string,
    emit: (e: ChatStreamEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const project = this.projectOr404(s.projectId);
    const ba = project.agents.BA;
    let draft = s.draft;
    const r = await this.runTurn({
      project,
      resume: s.sdkSessionId,
      prompt: sanitizeCardText(text, MAX_MESSAGE_CHARS),
      systemAppend: buildChatSystemAppend(project),
      model: ba.model,
      maxTurns: Math.min(TURN_MAX_TURNS, ba.budget.maxTurns),
      maxBudgetUsd: Math.max(0.01, this.budgetFor(s.projectId) - s.costUsd),
      onDraft: (d) => {
        draft = d;
        this.deps.store.setDraft(s.id, d);
        emit({ type: 'draft', draft: d });
      },
      emit,
      signal,
    });
    this.deps.store.finishTurn(s.id, r.sdkSessionId, r.costUsd);
    const reply = r.text.trim();
    if (reply) this.deps.store.addMessage(s.id, 'assistant', reply);
    if (r.errors.length && !reply) {
      emit({ type: 'error', message: r.errors.join('; ') });
      return;
    }
    emit({ type: 'done', draft, costUsd: r.costUsd, totalCostUsd: s.costUsd + r.costUsd });
  }

  /** Queue the draft as a card. Idempotent per session: the outbox key is the session id. */
  submit(sessionId: string): { queued: true; assignTo: string } {
    const s = this.session(sessionId);
    if (!s.draft) throw new ChatError(409, 'there is no draft to create yet');
    if (s.status !== 'open') throw new ChatError(409, 'this story was already submitted');
    if (this.busy.has(s.id)) throw new ChatError(409, 'BA is still answering');
    if (!this.stories) {
      throw new ChatError(503, 'the orchestrator is not running, so nothing can be created');
    }
    const project = this.projectOr404(s.projectId);
    this.stories.submitStory(
      s.projectId,
      ChatService.keyPrefix(s.id),
      draftToWorkItem(s.draft, s.id),
    );
    this.deps.store.setStatus(s.id, 'submitted');
    this.deps.log?.(`chat ${s.id}: story queued for ${s.projectId}`);
    return { queued: true, assignTo: project.flow.newItems[s.draft.type] ?? 'none' };
  }

  /** Wired to BoardWriter's onCreated: learns the card a submitted chat produced. */
  noteCreated(idempotencyKey: string, card: BoardCard): void {
    const m = /^chat:(chat_[0-9a-f]+):/.exec(idempotencyKey);
    if (!m?.[1] || !this.deps.store.get(m[1])) return;
    this.deps.store.setCreated(m[1], { id: card.id, shortId: card.shortId, url: card.url });
  }

  private session(id: string): ChatSessionRow {
    const s = this.deps.store.get(id);
    if (!s) throw new ChatError(404, `no chat session ${id}`);
    return s;
  }

  private projectOr404(id: string): ProjectConfig {
    try {
      return this.deps.project(id);
    } catch {
      throw new ChatError(404, `unknown project ${id}`);
    }
  }

  /** Twice a headless BA run: a conversation is several turns. */
  private budgetFor(projectId: string): number {
    try {
      return this.deps.project(projectId).agents.BA.budget.maxUsd * 2;
    } catch {
      return 0;
    }
  }
}

/** The real turn: Agent SDK, read-only tools, one in-process `propose_story` tool. */
export const sdkRunTurn: RunTurn = async (input) => {
  const abort = new AbortController();
  input.signal.addEventListener('abort', () => abort.abort());
  const q = query({ prompt: singleMessage(input.prompt), options: chatOptions(input, abort) });
  const out: TurnAccumulator = { texts: [], errors: [], sdkSessionId: input.resume, result: null };
  try {
    for await (const msg of q) {
      if (absorb(msg, out, input.emit)) break;
    }
  } catch (err) {
    out.errors.push(err instanceof Error ? err.message : String(err));
  } finally {
    try {
      q.close();
    } catch {
      /* already closed */
    }
  }
  if (out.result && out.result.subtype !== 'success') out.errors.push(...out.result.errors);
  return {
    sdkSessionId: out.sdkSessionId,
    costUsd: summarizeCost(out.result).totalCostUsd,
    text: out.texts.join('\n\n'),
    errors: out.errors,
  };
};

interface TurnAccumulator {
  texts: string[];
  errors: string[];
  sdkSessionId: string | null;
  result: SDKResultMessage | null;
}

/** Custom in-process tools need streaming input: one user message, then the turn ends. */
async function* singleMessage(content: string): AsyncGenerator<SDKUserMessage> {
  yield {
    type: 'user',
    session_id: '',
    parent_tool_use_id: null,
    message: { role: 'user', content },
  } as SDKUserMessage;
}

function chatServer(onDraft: (d: StoryDraft) => void) {
  return createSdkMcpServer({
    name: CHAT_SERVER_KEY,
    version: '1.0.0',
    tools: [
      tool(
        'propose_story',
        'Replace the story draft the stakeholder sees. Call whenever the draft materially changes.',
        proposeStoryShape,
        async (args) => {
          onDraft(args);
          return { content: [{ type: 'text' as const, text: 'draft updated' }] };
        },
      ),
    ],
  });
}

function chatOptions(input: TurnInput, abort: AbortController): Options {
  return {
    cwd: input.project.repo.path,
    model: input.model,
    allowedTools: ['Read', 'Glob', 'Grep', `mcp__${CHAT_SERVER_KEY}__*`],
    disallowedTools: DISALLOWED,
    permissionMode: 'dontAsk',
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: input.systemAppend,
      excludeDynamicSections: true,
    },
    // Never load the target repo's hooks or .mcp.json.
    settingSources: [],
    mcpServers: { [CHAT_SERVER_KEY]: chatServer(input.onDraft) },
    maxTurns: input.maxTurns,
    maxBudgetUsd: input.maxBudgetUsd,
    includePartialMessages: false,
    abortController: abort,
    env: { ...process.env, ...AGENT_ENV } as Record<string, string>,
    ...(input.resume ? { resume: input.resume } : {}),
  };
}

/** Fold one SDK message into the turn. Returns true on the result, which ends the turn. */
function absorb(
  msg: SDKMessage,
  out: TurnAccumulator,
  emit: (e: ChatStreamEvent) => void,
): boolean {
  if (msg.type === 'system' && msg.subtype === 'init') out.sdkSessionId = msg.session_id;
  if (msg.type === 'assistant') {
    for (const block of msg.message.content) {
      if (block.type === 'text' && block.text.trim()) {
        out.texts.push(block.text);
        emit({ type: 'text', text: block.text });
      } else if (block.type === 'tool_use') {
        emit({ type: 'tool', name: `${block.name} ${preview(block.input, 80)}` });
      }
    }
  }
  if (msg.type !== 'result') return false;
  out.result = msg;
  out.sdkSessionId = msg.session_id;
  return true;
}
