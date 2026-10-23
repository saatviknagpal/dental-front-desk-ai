// One chat turn: load session from DB → LLM ↔ tools loop → persist → reply.
// The web tier holds no state, so any instance can serve any turn.

import { randomUUID } from "node:crypto";
import { llmConfig } from "./config";
import { db } from "./db";
import { complete, llmReady, type ChatMessage, type CompletionResponse } from "./llm";
import { PRACTICE } from "./practice";
import { addUsage, costUsd, emptyUsage, type Usage } from "./pricing";
import { SYSTEM_STATIC, systemDynamic } from "./prompt";
import { ensureSeeded } from "./seed";
import { fmtTs, practiceNow } from "./time";
import { executeTool, TOOL_DEFINITIONS, type ToolContext } from "./tools";

const MAX_TOOL_ROUNDS = 8;
const MAX_HISTORY_MESSAGES = 80;
export const MAX_USER_CHARS = 2000;

export interface ToolEvent {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  error?: string;
  ms: number;
}

export interface TurnResult {
  sessionId: string;
  reply: string;
  toolEvents: ToolEvent[];
  model: string;
  degraded?: boolean;
  /** Tokens + estimated cost of the LLM calls made in this turn. */
  usage: Usage;
}

interface SessionRow {
  id: string;
  llm_messages: ChatMessage[];
  access: { verified: number[]; household: number[] };
  failed_verifications: number;
}

const FALLBACK_REPLY = `I'm sorry, I'm having trouble on my end right now. You can call us at ${PRACTICE.phone} (Mon-Sat, 8 AM-6 PM), or try again in a moment. If this is a dental emergency with trouble breathing, swallowing or uncontrolled bleeding, please call 911.`;

async function loadSession(sessionId: string | undefined): Promise<{ id: string; messages: ChatMessage[]; ctx: ToolContext }> {
  const row = sessionId ? await db.get<SessionRow>("SELECT * FROM sessions WHERE id = $1", [sessionId]) : undefined;
  if (row) {
    return {
      id: row.id,
      messages: row.llm_messages ?? [],
      ctx: { sessionId: row.id, verified: row.access?.verified ?? [], household: row.access?.household ?? [], failedVerifications: row.failed_verifications },
    };
  }
  const id = randomUUID();
  const now = fmtTs(practiceNow());
  await db.run("INSERT INTO sessions (id, started_at, last_active_at, model) VALUES ($1,$2,$2,$3)", [id, now, llmConfig().model]);
  return { id, messages: [], ctx: { sessionId: id, verified: [], household: [], failedVerifications: 0 } };
}

/** Keep the last N messages, cutting only at a user message so tool calls stay paired with results. */
function trimHistory(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= MAX_HISTORY_MESSAGES) return messages;
  let start = messages.length - MAX_HISTORY_MESSAGES;
  while (start < messages.length && messages[start].role !== "user") start++;
  return messages.slice(start);
}

async function saveSession(id: string, messages: ChatMessage[], ctx: ToolContext, model: string, turnUsage: Usage) {
  const prev = await db.get<{ usage: Usage | null }>("SELECT usage FROM sessions WHERE id = $1", [id]);
  const total = addUsage(prev?.usage ?? emptyUsage(), turnUsage);
  await db.run("UPDATE sessions SET llm_messages = $1, access = $2, failed_verifications = $3, last_active_at = $4, model = $5, usage = $7 WHERE id = $6", [
    JSON.stringify(trimHistory(messages)),
    JSON.stringify({ verified: ctx.verified, household: ctx.household }),
    ctx.failedVerifications,
    fmtTs(practiceNow()),
    model,
    id,
    JSON.stringify(total),
  ]);
}

async function logMessage(sessionId: string, role: "user" | "assistant" | "tool" | "llm", content: string) {
  await db.run("INSERT INTO messages (session_id, role, content, created_at) VALUES ($1,$2,$3,$4)", [sessionId, role, content, fmtTs(practiceNow())]);
}

async function callModel(messages: ChatMessage[]): Promise<CompletionResponse & { model: string; ms: number }> {
  const cfg = llmConfig();
  const models = [cfg.model, cfg.fallbackModel].filter(Boolean);
  let lastErr: unknown;
  for (const model of models) {
    try {
      const started = Date.now();
      const res = await complete({ systemStatic: SYSTEM_STATIC, systemDynamic: systemDynamic(), messages, tools: TOOL_DEFINITIONS, model });
      return { ...res, model, ms: Date.now() - started };
    } catch (err) {
      lastErr = err;
      console.error(`[agent] model ${model} failed:`, (err as Error).message);
    }
  }
  throw lastErr;
}

export async function runTurn(sessionId: string | undefined, userText: string): Promise<TurnResult> {
  await ensureSeeded();
  const session = await loadSession(sessionId);
  const { messages, ctx } = session;
  const text = userText.trim().slice(0, MAX_USER_CHARS);
  messages.push({ role: "user", content: text });
  await logMessage(session.id, "user", text);

  const toolEvents: ToolEvent[] = [];
  let reply = "";
  let model = llmConfig().model;
  let degraded = false;
  let usage = emptyUsage();

  if (!llmReady()) {
    reply = "The assistant isn't configured yet (missing LLM_API_KEY). " + FALLBACK_REPLY;
    degraded = true;
  } else {
    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const res = await callModel(messages);
        model = res.model;
        // Trace every model decision with its token usage and cost (shown in /staff and /evals).
        const u = res.usage ?? { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
        const step = { calls: 1, ...u, costUsd: costUsd(model, u.inputTokens, u.cachedInputTokens, u.outputTokens), llmMs: res.ms };
        usage = addUsage(usage, step);
        await logMessage(
          session.id,
          "llm",
          JSON.stringify({
            step: round + 1,
            model,
            decision: res.toolCalls.length ? "call_tools" : "reply",
            tool_calls: res.toolCalls.map((c) => ({ name: c.name, args: c.arguments })),
            text: res.content ?? "",
            ...step,
          }),
        );
        if (!res.toolCalls.length) {
          reply = res.content?.trim() || "Sorry, could you say that another way?";
          break;
        }
        messages.push({ role: "assistant", content: res.content, tool_calls: res.toolCalls });
        for (const call of res.toolCalls) {
          const started = Date.now();
          const result = await executeTool(ctx, call.name, call.arguments);
          const event: ToolEvent = { name: call.name, args: call.arguments, ok: result.ok, error: result.ok ? undefined : result.error, ms: Date.now() - started };
          toolEvents.push(event);
          await logMessage(session.id, "tool", JSON.stringify({ ...event, result }));
          messages.push({ role: "tool", tool_call_id: call.id, name: call.name, content: JSON.stringify(result) });
        }
      }
      if (!reply) {
        // Too many tool rounds: stop looping and hand off rather than spin.
        reply = `I'm sorry, I'm having trouble finishing that. I've asked our front desk to follow up, or you can call us at ${PRACTICE.phone}.`;
        await executeTool(ctx, "notify_staff", { type: "human_handoff", urgency: "normal", summary: "Assistant hit its tool-call limit mid-conversation; please review the transcript and follow up." });
        degraded = true;
      }
    } catch {
      reply = FALLBACK_REPLY;
      degraded = true;
    }
  }

  messages.push({ role: "assistant", content: reply });
  await logMessage(session.id, "assistant", reply);
  await saveSession(session.id, messages, ctx, model, usage);
  return { sessionId: session.id, reply, toolEvents, model, degraded, usage };
}

export async function recordFeedback(sessionId: string, rating: 1 | -1, comment?: string) {
  await db.run("UPDATE sessions SET rating = $1, feedback_comment = COALESCE($2, feedback_comment) WHERE id = $3", [rating, comment?.slice(0, 1000) ?? null, sessionId]);
}
