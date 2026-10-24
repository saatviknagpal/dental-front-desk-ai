// Push a staff alert to the practice's own webhook (Slack, Discord, Zapier...).
// Called by the job queue, never inline in a chat turn: alerts are stored in
// the DB first and delivered here with retries. Throws so the queue retries.
//
// The message carries no patient details (chat tools like Slack aren't covered
// for health data); staff follow the link to the dashboard, behind the login.

import { appUrl, staffWebhookUrl } from "./config";

const WHAT: Record<string, string> = {
  emergency: "New emergency",
  human_handoff: "A patient asked to talk to a person",
  callback: "A patient asked for a callback",
};

export function alertText(practice: { slug: string; name: string }, type: string, urgency: string): string {
  return `${urgency === "high" ? "URGENT: " : ""}${WHAT[type] ?? "New alert"} at ${practice.name}. Details on the front desk dashboard: ${appUrl()}/staff?practice=${practice.slug}`;
}

export async function notifyStaffWebhook(payload: { practice: string; text: string }): Promise<void> {
  const url = staffWebhookUrl(payload.practice);
  if (!url) return;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: payload.text }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`webhook responded ${res.status}`);
}
