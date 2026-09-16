import { loadConfig } from '../config/config.loader.js';
import { loadOrchestratorEnv } from '../config/env.js';
import { SqliteStore } from '../db/sqlite.store.js';
import { LocalDriver } from '../exec/local.driver.js';
import { Orchestrator, type OrchestratorLogger } from '../scheduler/orchestrator.js';

export async function startDaemon(): Promise<number> {
  const env = loadOrchestratorEnv();
  const loaded = loadConfig(env.ORCHESTRATOR_CONFIG);
  for (const d of loaded.diagnostics) console.warn(`⚠ config: ${d.projectId ?? '-'}: ${d.message}`);

  const stamp = () => new Date().toISOString().slice(11, 19);
  const log: OrchestratorLogger = {
    info: (m) => console.log(`[${stamp()}] ${m}`),
    warn: (m) => console.warn(`[${stamp()}] ⚠ ${m}`),
    error: (m) => console.error(`[${stamp()}] ✖ ${m}`),
  };

  const store = new SqliteStore(env.ORCHESTRATOR_DB);
  const orchestrator = new Orchestrator(loaded, store, new LocalDriver(), log);
  await orchestrator.start();

  return new Promise<number>((resolve) => {
    let stopping = false;
    const shutdown = async (signal: string) => {
      if (stopping) return;
      stopping = true;
      log.info(`${signal} received`);
      await orchestrator.stop();
      store.close();
      resolve(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  });
}
