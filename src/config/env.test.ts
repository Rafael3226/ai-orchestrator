import { describe, expect, it } from 'vitest';

import { loadOrchestratorEnv } from './env.js';

describe('loadOrchestratorEnv', () => {
  it('applies defaults and coerces the port', () => {
    const env = loadOrchestratorEnv({ ORCHESTRATOR_PORT: '8080' });
    expect(env.ORCHESTRATOR_PORT).toBe(8080);
    expect(env.ORCHESTRATOR_HOST).toBe('127.0.0.1');
    expect(env.LOG_LEVEL).toBe('info');
    expect(Object.isFrozen(env)).toBe(true);
  });

  it('treats an empty ANTHROPIC_API_KEY as unset', () => {
    expect(loadOrchestratorEnv({ ANTHROPIC_API_KEY: '' }).ANTHROPIC_API_KEY).toBeUndefined();
  });
});
