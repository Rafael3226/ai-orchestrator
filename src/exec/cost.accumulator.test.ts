import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { summarizeCost } from './cost.accumulator.js';

const base = {
  type: 'result',
  subtype: 'success',
  duration_ms: 1000,
  duration_api_ms: 800,
  is_error: false,
  num_turns: 5,
  result: 'done',
  stop_reason: 'end_turn',
  total_cost_usd: 0.5,
  usage: {
    input_tokens: 100,
    output_tokens: 50,
    cache_read_input_tokens: 10,
    cache_creation_input_tokens: 5,
  },
  permission_denials: [],
  uuid: 'u',
  session_id: 's',
} as unknown as SDKResultMessage;

describe('summarizeCost', () => {
  it('sums modelUsage across models (includes subagents), not the main-loop usage', () => {
    const r = {
      ...base,
      modelUsage: {
        'claude-opus-5': {
          inputTokens: 1000,
          outputTokens: 200,
          cacheReadInputTokens: 5000,
          cacheCreationInputTokens: 100,
          webSearchRequests: 0,
          costUSD: 0.4,
          contextWindow: 1,
          maxOutputTokens: 1,
        },
        'claude-haiku-4-5': {
          inputTokens: 300,
          outputTokens: 50,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUSD: 0.01,
          contextWindow: 1,
          maxOutputTokens: 1,
        },
      },
    } as SDKResultMessage;
    const c = summarizeCost(r);
    expect(c.totalCostUsd).toBeCloseTo(0.41, 6);
    expect(c.inputTokens).toBe(1300);
    expect(c.outputTokens).toBe(250);
    expect(c.cacheReadTokens).toBe(5000);
    expect(c.estimated).toBe(false);
    expect(c.reportedCostUsd).toBe(0.5);
    expect(Object.keys(c.perModel)).toHaveLength(2);
  });

  it('falls back to main-loop usage and flags estimated when modelUsage is zeroed (crash path)', () => {
    const r = { ...base, modelUsage: {} } as SDKResultMessage;
    const c = summarizeCost(r);
    expect(c.estimated).toBe(true);
    expect(c.inputTokens).toBe(100);
    expect(c.totalCostUsd).toBe(0.5);
  });

  it('returns an empty estimated summary for a missing result', () => {
    const c = summarizeCost(null);
    expect(c.totalCostUsd).toBe(0);
    expect(c.estimated).toBe(true);
  });
});
