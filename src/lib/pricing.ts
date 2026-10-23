// Approximate list prices (USD per 1M tokens) used to estimate cost per call,
// per conversation and per eval run. Update when providers change pricing.
// Unknown models fall back to 0 and are marked as unpriced.

interface Price {
  input: number;
  cachedInput: number;
  output: number;
}

const PRICES: Record<string, Price> = {
  "gpt-4.1-mini": { input: 0.4, cachedInput: 0.1, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, cachedInput: 0.025, output: 0.4 },
  "gpt-4.1": { input: 2.0, cachedInput: 0.5, output: 8.0 },
  "gpt-4o-mini": { input: 0.15, cachedInput: 0.075, output: 0.6 },
  "claude-sonnet-5-5": { input: 3.0, cachedInput: 0.3, output: 15.0 },
  "claude-haiku-5-5": { input: 1.0, cachedInput: 0.1, output: 5.0 },
  "gemini-3.6-flash": { input: 0.3, cachedInput: 0.075, output: 2.5 },
  "gemini-3.5-flash": { input: 0.3, cachedInput: 0.075, output: 2.5 },
  "deepseek-chat": { input: 0.27, cachedInput: 0.07, output: 1.1 },
};

export interface Usage {
  calls: number;
  inputTokens: number; // includes cached
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number;
  llmMs: number;
}

export const emptyUsage = (): Usage => ({ calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0, llmMs: 0 });

export function costUsd(model: string, inputTokens: number, cachedInputTokens: number, outputTokens: number): number {
  const p = PRICES[model];
  if (!p) return 0;
  const uncached = Math.max(0, inputTokens - cachedInputTokens);
  return (uncached * p.input + cachedInputTokens * p.cachedInput + outputTokens * p.output) / 1_000_000;
}

export function addUsage(a: Usage, b: Partial<Usage>): Usage {
  return {
    calls: a.calls + (b.calls ?? 0),
    inputTokens: a.inputTokens + (b.inputTokens ?? 0),
    cachedInputTokens: a.cachedInputTokens + (b.cachedInputTokens ?? 0),
    outputTokens: a.outputTokens + (b.outputTokens ?? 0),
    costUsd: a.costUsd + (b.costUsd ?? 0),
    llmMs: a.llmMs + (b.llmMs ?? 0),
  };
}

export const fmtUsd = (n: number) => (n === 0 ? "$0" : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(3)}`);
