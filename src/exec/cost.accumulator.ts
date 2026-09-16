import type { ModelUsage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';

import type { CostSummary } from './exec.driver.js';

const EMPTY: CostSummary = {
  totalCostUsd: 0,
  reportedCostUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  perModel: {},
  estimated: true,
};

/**
 * Cost rules that bite at fan-out scale:
 *  - `usage` is the MAIN LOOP ONLY; `modelUsage` includes subagents. Use modelUsage.
 *  - per-assistant-message output_tokens is a placeholder; never sum it.
 *  - parallel tool calls share one message.id; dedupe if you ever count them.
 *  - a crash result may carry zeroed usage — flag it as estimated.
 */
export function summarizeCost(result: SDKResultMessage | null): CostSummary {
  if (!result) return EMPTY;
  const perModel: Record<string, CostSummary['perModel'][string]> = {};
  let totalCostUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;

  for (const [model, u] of Object.entries(result.modelUsage ?? {}) as [string, ModelUsage][]) {
    perModel[model] = {
      costUsd: u.costUSD,
      input: u.inputTokens,
      output: u.outputTokens,
      cacheRead: u.cacheReadInputTokens,
      cacheCreation: u.cacheCreationInputTokens,
    };
    totalCostUsd += u.costUSD;
    inputTokens += u.inputTokens;
    outputTokens += u.outputTokens;
    cacheReadTokens += u.cacheReadInputTokens;
    cacheCreationTokens += u.cacheCreationInputTokens;
  }

  const zeroed =
    Object.keys(perModel).length === 0 ||
    (inputTokens + outputTokens === 0 && result.num_turns > 0);
  if (zeroed) {
    // Fall back to the main-loop usage so the number is at least a floor.
    const u = result.usage;
    inputTokens = u?.input_tokens ?? 0;
    outputTokens = u?.output_tokens ?? 0;
    cacheReadTokens = u?.cache_read_input_tokens ?? 0;
    cacheCreationTokens = u?.cache_creation_input_tokens ?? 0;
    totalCostUsd = result.total_cost_usd ?? 0;
  }

  return {
    totalCostUsd: round(totalCostUsd),
    reportedCostUsd: round(result.total_cost_usd ?? 0),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    perModel,
    estimated: zeroed,
  };
}

const round = (n: number): number => Math.round(n * 1e6) / 1e6;
