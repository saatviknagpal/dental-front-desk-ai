// Guardrails around every chat turn, enforced in code (not just the prompt):
//  - input moderation (self-harm, threats, abuse) before the LLM sees the message
//  - an output check that blocks replies exposing another patient's name or phone
//  - per-session and per-caller limits so one user can't run up LLM cost

import OpenAI from "openai";
import { llmConfig } from "./config";
import { db } from "./db";
import { currentPractice } from "./practice";
import { rateLimit } from "./ratelimit";

export const MAX_TURNS_PER_SESSION = 40;
export const REQUESTS_PER_MINUTE_PER_CALLER = 20;

export type InputVerdict = { ok: true } | { ok: false; reason: string; reply: string };

const CRISIS_REPLY = `I'm really sorry you're going through this. I'm only a scheduling assistant, but you deserve support right now. In the US you can call or text 988 (Suicide & Crisis Lifeline) any time, or call 911 if you're in danger. If there's anything about your dental care I can help with, I'm here.`;
const abuseReply = () => `I'm here to help with appointments and questions about ${currentPractice().name}. I can't continue with messages like that, but I'm glad to help with scheduling, insurance or our hours.`;
const LEAK_REPLY = `For privacy, I can't share details about other patients. I can help with your own appointments once I verify your full name and date of birth.`;

let moderationClient: OpenAI | undefined;

/** OpenAI moderation (free). Fails open: if the check itself errors, the chat continues. */
export async function moderateInput(text: string): Promise<InputVerdict> {
  const cfg = llmConfig("openai");
  if (!cfg.apiKey || process.env.MODERATION_DISABLED === "true") return { ok: true };
  try {
    moderationClient ??= new OpenAI({ apiKey: cfg.apiKey, timeout: 3000, maxRetries: 0 });
    const res = await moderationClient.moderations.create({ model: "omni-moderation-latest", input: text });
    const r = res.results[0];
    if (!r?.flagged) return { ok: true };
    const c = r.categories as unknown as Record<string, boolean>;
    if (c["self-harm"] || c["self-harm/intent"] || c["self-harm/instructions"]) return { ok: false, reason: "self-harm", reply: CRISIS_REPLY };
    if (c["harassment/threatening"] || c["violence"] || c["hate/threatening"] || c["harassment"] || c["hate"]) return { ok: false, reason: "abuse", reply: abuseReply() };
    return { ok: true };
  } catch {
    return { ok: true };
  }
}

/** Per-caller rate limit (fixed one-minute window). */
export function allowRequest(callerKey: string): Promise<boolean> {
  return rateLimit(`chat:${callerKey}`, REQUESTS_PER_MINUTE_PER_CALLER, 60);
}

const PHONE_RE = /\(?\b(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})\b/g;
const NAME_RE = /\b([A-Z][a-zà-ÿ'-]+)\s+([A-Z][a-zà-ÿ'-]+)\b/g;

/**
 * Returns a safe replacement if the reply mentions a patient (by full name or
 * phone) who is not verified in this chat and whom the user didn't name
 * themselves. Otherwise returns null.
 */
export async function checkOutput(reply: string, allowedPatientIds: number[], userTexts: string[]): Promise<{ reply: string; reason: string } | null> {
  const said = userTexts.join(" ").toLowerCase();
  const saidDigits = userTexts.join(" ").replace(/\D/g, "");

  const phones = [...reply.matchAll(PHONE_RE)].map((m) => m[1] + m[2] + m[3]).filter((p) => !saidDigits.includes(p));
  const names = [...reply.matchAll(NAME_RE)]
    .map((m) => [m[1], m[2]])
    .filter(([f, l]) => !said.includes(`${f} ${l}`.toLowerCase()));
  if (!phones.length && !names.length) return null;

  const leaked = await db.all<{ id: number }>(
    `SELECT id FROM patients
     WHERE NOT (id = ANY($1::int[]))
       AND (phone = ANY($2::text[]) OR (lower(first_name) || ' ' || lower(last_name)) = ANY($3::text[]))
     LIMIT 1`,
    [allowedPatientIds, phones, names.map(([f, l]) => `${f} ${l}`.toLowerCase())],
  );
  return leaked.length ? { reply: LEAK_REPLY, reason: "other-patient-data" } : null;
}
