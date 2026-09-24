import { resolve } from 'node:path';

import { BoardStore } from '../board/board.store.js';
import { loadConfig } from '../config/config.loader.js';
import { loadOrchestratorEnv } from '../config/env.js';
import { SqliteStore } from '../db/sqlite.store.js';
import { LocalDriver } from '../exec/local.driver.js';
import { Orchestrator, type OrchestratorLogger } from '../scheduler/orchestrator.js';
import { OfficeServer } from '../server/http.server.js';
import { WebhookServer } from '../server/webhook.server.js';

const stamp = () => new Date().toISOString().slice(11, 19);
const logger: OrchestratorLogger = {
  info: (m) => console.log(`[${stamp()}] ${m}`),
  warn: (m) => console.warn(`[${stamp()}] ⚠ ${m}`),
  error: (m) => console.error(`[${stamp()}] ✖ ${m}`),
};

function waitForSignal(onStop: () => Promise<void>): Promise<number> {
  return new Promise<number>((resolvePromise) => {
    let stopping = false;
    const shutdown = async (signal: string) => {
      if (stopping) return;
      stopping = true;
      logger.info(`${signal} received`);
      await onStop();
      resolvePromise(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  });
}

/** `start`: daemon + office server + webhook receiver. */
export async function startDaemon(
  opts: { noServer?: boolean; noWebhook?: boolean } = {},
): Promise<number> {
  const env = loadOrchestratorEnv();
  const loaded = loadConfig(env.ORCHESTRATOR_CONFIG);
  for (const d of loaded.diagnostics) logger.warn(`config: ${d.projectId ?? '-'}: ${d.message}`);

  const store = new SqliteStore(env.ORCHESTRATOR_DB);
  const boardStore = new BoardStore(store);

  const wantsWebhooks =
    !opts.noWebhook && loaded.config.projects.some((p) => p.enabled && p.board.webhook.enabled);
  const pathSecret = env.ORCHESTRATOR_WEBHOOK_PATH_SECRET;
  if (wantsWebhooks && !pathSecret) {
    throw new Error(
      'webhooks are enabled but ORCHESTRATOR_WEBHOOK_PATH_SECRET is not set — ' +
        'pick any unguessable string; it becomes part of the public callback URL',
    );
  }
  const webhookServer =
    wantsWebhooks && pathSecret
      ? new WebhookServer({
          host: env.ORCHESTRATOR_WEBHOOK_HOST,
          port: env.ORCHESTRATOR_WEBHOOK_PORT,
          pathPrefix: env.ORCHESTRATOR_WEBHOOK_PATH_PREFIX,
          pathSecret,
          log: logger.info,
        })
      : null;

  const orchestrator = new Orchestrator(
    loaded,
    store,
    new LocalDriver(),
    logger,
    undefined,
    webhookServer,
    {
      publicUrl: env.ORCHESTRATOR_WEBHOOK_PUBLIC_URL,
      pathPrefix: env.ORCHESTRATOR_WEBHOOK_PATH_PREFIX,
      pathSecret: pathSecret ?? 'none',
    },
  );
  const server = opts.noServer
    ? null
    : new OfficeServer(loaded, store, boardStore, {
        host: env.ORCHESTRATOR_HOST,
        port: env.ORCHESTRATOR_PORT,
        webDist: resolve('web/dist'),
        log: logger.info,
      });

  await orchestrator.start();
  if (server) await server.start();

  return waitForSignal(async () => {
    await orchestrator.stop();
    if (server) await server.stop();
    store.close();
  });
}

/** `serve`: office server only, over an existing database. No polling, no agents. */
export async function serveOnly(): Promise<number> {
  const env = loadOrchestratorEnv();
  const loaded = loadConfig(env.ORCHESTRATOR_CONFIG);
  const store = new SqliteStore(env.ORCHESTRATOR_DB);
  const boardStore = new BoardStore(store);
  const server = new OfficeServer(loaded, store, boardStore, {
    host: env.ORCHESTRATOR_HOST,
    port: env.ORCHESTRATOR_PORT,
    webDist: resolve('web/dist'),
    log: logger.info,
  });
  await server.start();
  return waitForSignal(async () => {
    await server.stop();
    store.close();
  });
}
