// Push a staff alert to an external webhook (Slack, Discord, Zapier...).
// Called by the job queue, never inline in a chat turn: alerts are stored in
// the DB first and delivered here with retries. Throws so the queue retries.

import { staffWebhookUrl } from "./config";

export async function notifyStaffWebhook(payload: { type: string; urgency: string; text: string }): Promise<void> {
  const url = staffWebhookUrl();
  if (!url) return;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, text: `[${payload.urgency.toUpperCase()}] ${payload.type}: ${payload.text}` }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`webhook responded ${res.status}`);
}
