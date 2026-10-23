// Best-effort push of staff alerts to an external webhook (Slack, Discord,
// Zapier...). Alerts are always stored in the DB first; the webhook is a bonus
// channel and must never fail or slow down the patient's conversation.

import { staffWebhookUrl } from "./config";

export async function notifyStaffWebhook(payload: { type: string; urgency: string; text: string }): Promise<void> {
  const url = staffWebhookUrl();
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, text: `[${payload.urgency.toUpperCase()}] ${payload.type}: ${payload.text}` }),
      signal: AbortSignal.timeout(3000),
    });
  } catch (err) {
    console.warn("[notify] staff webhook failed:", (err as Error).message);
  }
}
