import { z } from 'zod';

import { validateEnv } from './validate.js';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;

/** Docker Compose renders an unset variable as ''. Treat that as absent. */
const optionalText = z
  .string()
  .optional()
  .transform((v) => (v === '' ? undefined : v));

export const orchestratorEnvSchema = z.object({
  ORCHESTRATOR_CONFIG: z.string().min(1).default('./orchestrator.yaml'),
  ORCHESTRATOR_DB: z.string().min(1).default('./data/orchestrator.sqlite'),
  ORCHESTRATOR_HOST: z.string().min(1).default('127.0.0.1'),
  ORCHESTRATOR_PORT: z.coerce.number().int().min(1).max(65535).default(7777),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  ANTHROPIC_API_KEY: optionalText,
  GH_TOKEN: optionalText,
});

export type OrchestratorEnv = Readonly<z.infer<typeof orchestratorEnvSchema>>;

/**
 * Validate the orchestrator's own environment. Board credentials are NOT here:
 * they are resolved per credential ref after the YAML is parsed, so a missing
 * token fails naming the project that needs it (see `credentials.ts`).
 */
export function loadOrchestratorEnv(source: unknown = process.env): OrchestratorEnv {
  return validateEnv('orchestrator environment variables', orchestratorEnvSchema, source);
}
