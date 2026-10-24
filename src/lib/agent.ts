// One chat turn: load session from DB → LLM ↔ tools loop → persist → reply.
// The web tier holds no state, so any instance can serve any turn.

import { randomUUID } from "node:crypto";
import { llmConfig } from "./config";
import { db } from "./db";
import { checkOutput, MAX_TURNS_PER_SESSION, moderateInput } from "./guardrails";
import { complete, llmReady, type ChatMessage, type CompletionResponse } from "./llm";
import { currentPractice } from "./practice";
import { addUsage, costUsd, emptyUsage, type Usage } from "./pricing";
import { systemDynamic, systemStatic } from "./prompt";
import { ensureSeeded } from "./seed";
import { fmtTs, practiceNow } from "./time";
import { executeTool, TOOL_DEFINITIONS, type ToolContext } from "./tools";

const MAX_TOOL_ROUNDS = 8;
const MAX_HISTORY_MESSAGES = 80;
/** A reply telling the patient staff were alerted ("I've alerted our dental team", "I've let the front desk know"). */
export const ALERT_CLAIM = /\bI(?:'ve| have|'m| am)?\s+(?:(?:also|just|already)\s+)*(?:alerted|notified|alerting|notifying|let)\s+(?:our|the)\s+(?:dental\s+)?(?:team|staff|front desk|office)\b/i;
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
  /** Appointments booked or moved this turn (for confirmation cards). */
  bookings: BookingCard[];
  /** Times offered this turn, from real tool results (for tap-to-pick buttons). */
  choices: { label: string; message: string }[];
}

export interface BookingCard {
  appointment_id: number;
  patient_name: string;
  label: string;
  start_time: string;
  display: string;
  provider_name: string;
  duration_minutes: number;
  previous_time?: string;
}

type Slot = { display: string; provider_name: string };

/** Pull confirmation cards and tap-to-pick choices out of a tool result. */
function collectUi(name: string, result: Record<string, unknown>, bookings: BookingCard[], choices: { label: string; message: string }[]) {
  if (!result.ok) {
    if (Array.isArray(result.alternatives)) choices.splice(0, choices.length, ...(result.alternatives as Slot[]).map(slotChoice));
    return;
  }
  if ((name === "book_appointment" || name === "reschedule_appointment") && result.appointment) bookings.push(result.appointment as BookingCard);
  if (name === "book_family_appointments") bookings.push(...(result.appointments as BookingCard[]));
  if (name === "find_available_slots") {
    const slots = ((result.slots as Slot[])?.length ? result.slots : result.next_available) as Slot[];
    choices.splice(0, choices.length, ...(slots ?? []).map(slotChoice));
  }
  if (name === "find_family_slots" && Array.isArray(result.options)) {
    choices.splice(0, choices.length, ...(result.options as { option: number; day: string; bookings: { display: string }[] }[]).map((o) => ({
      label: `Option ${o.option}: ${o.bookings[0].display}`,
      message: `Option ${o.option} works (starting ${o.bookings[0].display}).`,
    })));
  }
}

const slotChoice = (s: Slot) => ({ label: `${s.display} · ${s.provider_name}`, message: `${s.display} with ${s.provider_name} works for me.` });

interface SessionRow {
  id: string;
  llm_messages: ChatMessage[];
  access: { verified: number[]; household: number[] };
  failed_verifications: number;
}

const fallbackReply = () => `I'm sorry, I'm having trouble on my end right now. You can call us at ${currentPractice().phone} (Mon-Sat, 8 AM-6 PM), or try again in a moment. If this is a dental emergency with trouble breathing, swallowing or uncontrolled bleeding, please call 911.`;

/** A second message arrived for a chat whose previous turn is still running. */
export class SessionBusyError extends Error {}

async function loadSession(sessionId: string | undefined, caller?: string): Promise<{ id: string; messages: ChatMessage[]; ctx: ToolContext }> {
  const practiceId = currentPractice().id;
  if (sessionId) {
    // Claim the chat for this turn; the lease expires on its own if the server dies mid-turn.
    const row = await db.get<SessionRow>(
      `UPDATE sessions SET busy_until = now() + interval '2 minutes'
       WHERE id = $1 AND practice_id = $2 AND (busy_until IS NULL OR busy_until < now()) RETURNING *`,
      [sessionId, practiceId],
    );
    if (row) {
      return {
        id: row.id,
        messages: row.llm_messages ?? [],
        ctx: { sessionId: row.id, verified: row.access?.verified ?? [], household: row.access?.household ?? [], failedVerifications: row.failed_verifications, caller },
      };
    }
    if (await db.get("SELECT 1 FROM sessions WHERE id = $1 AND practice_id = $2", [sessionId, practiceId])) throw new SessionBusyError();
  }
  const id = randomUUID();
  const now = fmtTs(practiceNow());
  await db.run("INSERT INTO sessions (id, practice_id, started_at, last_active_at, model, busy_until) VALUES ($1,$2,$3,$3,$4, now() + interval '2 minutes')", [id, practiceId, now, llmConfig().model]);
  return { id, messages: [], ctx: { sessionId: id, verified: [], household: [], failedVerifications: 0, caller } };
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

async function logMessage(sessionId: string, role: "user" | "assistant" | "tool" | "llm" | "guardrail", content: string) {
  await db.run("INSERT INTO messages (session_id, role, content, created_at) VALUES ($1,$2,$3,$4)", [sessionId, role, content, fmtTs(practiceNow())]);
}

async function callModel(messages: ChatMessage[]): Promise<CompletionResponse & { model: string; ms: number }> {
  const cfg = llmConfig();
  const models = [cfg.model, cfg.fallbackModel].filter(Boolean);
  let lastErr: unknown;
  for (const model of models) {
    try {
      const started = Date.now();
      const res = await complete({ systemStatic: systemStatic(), systemDynamic: systemDynamic(), messages, tools: TOOL_DEFINITIONS, model });
      return { ...res, model, ms: Date.now() - started };
    } catch (err) {
      lastErr = err;
      console.error(`[agent] model ${model} failed:`, (err as Error).message);
    }
  }
  throw lastErr;
}

export async function runTurn(sessionId: string | undefined, userText: string, caller?: string, requestId?: string): Promise<TurnResult> {
  if (!requestId) return runTurnOnce(sessionId, userText, caller);
  // Claim the id first; a second request with the same id gets the saved reply, or "busy" while the first still runs.
  const claimed = await db.get("INSERT INTO chat_requests (request_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING request_id", [requestId]);
  if (!claimed) {
    const prev = await db.get<{ response: TurnResult | null }>("SELECT response FROM chat_requests WHERE request_id = $1", [requestId]);
    if (prev?.response) return prev.response;
    throw new SessionBusyError();
  }
  try {
    const result = await runTurnOnce(sessionId, userText, caller);
    await db.run("UPDATE chat_requests SET response = $2 WHERE request_id = $1", [requestId, JSON.stringify(result)]);
    return result;
  } catch (err) {
    await db.run("DELETE FROM chat_requests WHERE request_id = $1", [requestId]); // let a retry run it
    throw err;
  }
}

async function runTurnOnce(sessionId: string | undefined, userText: string, caller?: string): Promise<TurnResult> {
  await ensureSeeded();
  const session = await loadSession(sessionId, caller);
  try {
    return await runClaimedTurn(session, userText);
  } finally {
    await db.run("UPDATE sessions SET busy_until = NULL WHERE id = $1", [session.id]);
  }
}

async function runClaimedTurn(session: Awaited<ReturnType<typeof loadSession>>, userText: string): Promise<TurnResult> {
  const { messages, ctx } = session;
  const text = userText.trim().slice(0, MAX_USER_CHARS);
  messages.push({ role: "user", content: text });
  await logMessage(session.id, "user", text);

  const toolEvents: ToolEvent[] = [];
  let reply = "";
  let model = llmConfig().model;
  let degraded = false;
  let usage = emptyUsage();
  const bookings: BookingCard[] = [];
  const choices: { label: string; message: string }[] = [];

  const turns = await db.get<{ n: number }>("SELECT count(*)::int AS n FROM messages WHERE session_id = $1 AND role = 'user'", [session.id]);
  const moderation = await moderateInput(text);

  if ((turns?.n ?? 0) > MAX_TURNS_PER_SESSION) {
    reply = `This chat has gotten quite long. Please start a new chat, or call us at ${currentPractice().phone} and the front desk will help.`;
    await logMessage(session.id, "guardrail", JSON.stringify({ rule: "max-turns", limit: MAX_TURNS_PER_SESSION }));
  } else if (!moderation.ok) {
    reply = moderation.reply;
    await logMessage(session.id, "guardrail", JSON.stringify({ rule: "moderation", reason: moderation.reason }));
  } else if (!llmReady()) {
    reply = "The assistant isn't configured yet (missing LLM_API_KEY). " + fallbackReply();
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
          collectUi(call.name, result, bookings, choices);
          const event: ToolEvent = { name: call.name, args: call.arguments, ok: result.ok, error: result.ok ? undefined : result.error, ms: Date.now() - started };
          toolEvents.push(event);
          await logMessage(session.id, "tool", JSON.stringify({ ...event, result }));
          messages.push({ role: "tool", tool_call_id: call.id, name: call.name, content: JSON.stringify(result) });
        }
      }
      if (!reply) {
        // Too many tool rounds: stop looping and hand off rather than spin.
        reply = `I'm sorry, I'm having trouble finishing that. I've asked our front desk to follow up, or you can call us at ${currentPractice().phone}.`;
        await executeTool(ctx, "notify_staff", { type: "human_handoff", urgency: "normal", summary: "Assistant hit its tool-call limit mid-conversation; please review the transcript and follow up." });
        degraded = true;
      }
    } catch {
      reply = fallbackReply();
      degraded = true;
    }
  }

  // The model sometimes says "I've alerted the team" without calling notify_staff. Keep the promise in code.
  const alerted = toolEvents.some((e) => e.ok && (e.name === "notify_staff" || (e.name === "book_appointment" && e.args.appointment_type === "emergency")));
  if (!alerted && ALERT_CLAIM.test(reply)) {
    const urgent = /911|emergency room|\bER\b/i.test(reply);
    const args = { type: urgent ? "emergency" : "human_handoff", urgency: urgent ? "high" : "normal", summary: `Patient wrote: "${text.slice(0, 300)}". The assistant told them the team was alerted.` };
    const started = Date.now();
    const result = await executeTool(ctx, "notify_staff", args);
    toolEvents.push({ name: "notify_staff", args, ok: result.ok, error: result.ok ? undefined : result.error, ms: Date.now() - started });
    await logMessage(session.id, "guardrail", JSON.stringify({ rule: "alert-promise", result }));
  }

  // Never send another patient's name or phone, whatever the model produced.
  const userTexts = messages.filter((m) => m.role === "user").map((m) => m.content as string);
  const leak = await checkOutput(reply, [...ctx.verified, ...ctx.household], userTexts);
  if (leak) {
    await logMessage(session.id, "guardrail", JSON.stringify({ rule: "output-privacy", reason: leak.reason, blocked: reply }));
    reply = leak.reply;
  }

  messages.push({ role: "assistant", content: reply });
  await logMessage(session.id, "assistant", reply);
  await saveSession(session.id, messages, ctx, model, usage);
  // Offer tap-to-pick buttons only when the reply is still asking the patient to choose.
  return { sessionId: session.id, reply, toolEvents, model, degraded, usage, bookings, choices: bookings.length ? [] : choices };
}

export async function recordFeedback(sessionId: string, rating: 1 | -1, comment?: string) {
  await db.run("UPDATE sessions SET rating = $1, feedback_comment = COALESCE($2, feedback_comment) WHERE id = $3", [rating, comment?.slice(0, 1000) ?? null, sessionId]);
}
