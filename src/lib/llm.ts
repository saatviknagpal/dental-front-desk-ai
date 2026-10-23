// Provider adapters. The agent speaks one neutral format (OpenAI-style chat
// messages); each adapter translates to its provider's API. OpenAI, Gemini and
// DeepSeek all expose OpenAI-compatible endpoints, so one adapter covers them;
// Anthropic (Claude) gets its own.

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { llmConfig, type ProviderName } from "./config";
import type { ToolDefinition } from "./tools";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; name: string; content: string };

export interface CompletionRequest {
  /** Stable part of the system prompt (cacheable). */
  systemStatic: string;
  /** Per-turn part (current time, calendar). */
  systemDynamic: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  model: string;
  temperature?: number;
  /** Use a different provider than LLM_PROVIDER (e.g. a Gemini judge). */
  provider?: ProviderName;
}

export interface CompletionResponse {
  content: string | null;
  toolCalls: ToolCall[];
  /** inputTokens includes cachedInputTokens. */
  usage?: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
}

const TIMEOUT_MS = 45_000;

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

const openaiClients = new Map<string, OpenAI>();
const anthropicClients = new Map<string, Anthropic>();

async function completeOpenAICompatible(req: CompletionRequest): Promise<CompletionResponse> {
  const cfg = llmConfig(req.provider);
  const key = `${cfg.baseURL}|${cfg.apiKey}`;
  if (!openaiClients.has(key)) openaiClients.set(key, new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL || undefined, maxRetries: 2, timeout: TIMEOUT_MS }));
  const client = openaiClients.get(key)!;
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: req.systemDynamic ? `${req.systemStatic}\n\n${req.systemDynamic}` : req.systemStatic },
    ...req.messages.map((m): OpenAI.Chat.ChatCompletionMessageParam => {
      if (m.role === "tool") return { role: "tool", tool_call_id: m.tool_call_id, content: m.content };
      if (m.role === "assistant") {
        return {
          role: "assistant",
          content: m.content ?? "",
          ...(m.tool_calls?.length
            ? { tool_calls: m.tool_calls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) }
            : {}),
        };
      }
      return { role: "user", content: m.content };
    }),
  ];
  const res = await client.chat.completions.create({
    model: req.model,
    messages,
    ...(req.tools.length ? { tools: req.tools.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.parameters } })) } : {}),
    temperature: req.temperature ?? 0.3,
  });
  const msg = res.choices[0]?.message;
  return {
    content: msg?.content ?? null,
    toolCalls: (msg?.tool_calls ?? []).map((c, i) => ({ id: c.id || `call_${Date.now()}_${i}`, name: c.function.name, arguments: parseArgs(c.function.arguments) })),
    usage: res.usage
      ? {
          inputTokens: res.usage.prompt_tokens,
          cachedInputTokens: res.usage.prompt_tokens_details?.cached_tokens ?? 0,
          outputTokens: res.usage.completion_tokens,
        }
      : undefined,
  };
}

async function completeAnthropic(req: CompletionRequest): Promise<CompletionResponse> {
  const cfg = llmConfig(req.provider);
  if (!anthropicClients.has(cfg.apiKey)) anthropicClients.set(cfg.apiKey, new Anthropic({ apiKey: cfg.apiKey, maxRetries: 2, timeout: TIMEOUT_MS }));
  const client = anthropicClients.get(cfg.apiKey)!;
  // Claude wants tool results as user-turn content blocks; merge consecutive ones.
  const messages: Anthropic.MessageParam[] = [];
  for (const m of req.messages) {
    if (m.role === "tool") {
      const block: Anthropic.ToolResultBlockParam = { type: "tool_result", tool_use_id: m.tool_call_id, content: m.content };
      const last = messages[messages.length - 1];
      if (last?.role === "user" && Array.isArray(last.content) && last.content.every((b) => b.type === "tool_result")) {
        (last.content as Anthropic.ToolResultBlockParam[]).push(block);
      } else {
        messages.push({ role: "user", content: [block] });
      }
    } else if (m.role === "assistant") {
      const content: Anthropic.ContentBlockParam[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const c of m.tool_calls ?? []) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.arguments });
      messages.push({ role: "assistant", content: content.length ? content : [{ type: "text", text: "…" }] });
    } else {
      messages.push({ role: "user", content: m.content });
    }
  }
  const res = await client.messages.create({
    model: req.model,
    max_tokens: 1024,
    temperature: req.temperature ?? 0.3,
    // Static instructions are cached across all conversations; only the dynamic block changes.
    system: [
      { type: "text" as const, text: req.systemStatic, cache_control: { type: "ephemeral" as const } },
      ...(req.systemDynamic ? [{ type: "text" as const, text: req.systemDynamic }] : []),
    ],
    ...(req.tools.length ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Tool.InputSchema })) } : {}),
    messages,
  });
  const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
  return {
    content: text || null,
    toolCalls: res.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, arguments: (b.input ?? {}) as Record<string, unknown> })),
    usage: {
      inputTokens: res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0),
      cachedInputTokens: res.usage.cache_read_input_tokens ?? 0,
      outputTokens: res.usage.output_tokens,
    },
  };
}

export function complete(req: CompletionRequest): Promise<CompletionResponse> {
  return llmConfig(req.provider).provider === "anthropic" ? completeAnthropic(req) : completeOpenAICompatible(req);
}

export function llmReady(): boolean {
  const cfg = llmConfig();
  return !!cfg.apiKey && cfg.apiKey !== "your-api-key-here" && !!cfg.model;
}
