import type { ProjectConfig } from '../config/config.loader.js';
import { type BoardCredential, credentialOf } from '../config/credentials.js';

import { AdoSource } from './azure-devops/ado.source.js';
import type { BoardSource, WebhookRegistrar } from './board.source.js';
import { JiraSource } from './jira/jira.source.js';
import { TrelloSource } from './trello/trello.source.js';

/** The one place a provider key becomes a concrete source. */
export function createBoardSource(project: ProjectConfig, cred: BoardCredential): BoardSource {
  const board = project.board;
  const ref = board.credentials;
  switch (board.provider) {
    case 'trello':
      return new TrelloSource(board.boardId, credentialOf(cred, 'trello', ref));
    case 'azure-devops':
      return new AdoSource(board.boardId, board, credentialOf(cred, 'azure-devops', ref), {
        watchStates: watchedColumns(project),
      });
    case 'jira':
      return new JiraSource(board.boardId, board, credentialOf(cred, 'jira', ref), {
        watchStatuses: watchedColumns(project),
      });
  }
}

/**
 * Every column name a route triggers on or a writeback moves into: what
 * reconcile has to list. Cards anywhere else can never be dispatched.
 */
export function watchedColumns(project: ProjectConfig): string[] {
  const names = new Set<string>();
  for (const r of project.routes) if (r.when.column) names.add(r.when.column);
  for (const name of Object.values(project.board.columns)) names.add(name);
  return [...names];
}

export function isWebhookRegistrar(source: BoardSource): source is BoardSource & WebhookRegistrar {
  const s = source as Partial<WebhookRegistrar>;
  return (
    source.capabilities.canRegisterWebhook &&
    typeof s.listWebhooks === 'function' &&
    typeof s.createWebhook === 'function' &&
    typeof s.updateWebhook === 'function' &&
    typeof s.deleteWebhook === 'function'
  );
}
