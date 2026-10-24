// Booking confirmation emails via Resend (https://resend.com). Called by the job
// queue, never inline in a chat turn. Throws on failure so the queue retries.

import { icsFile, type Booking, type PracticeInfo } from "./calendar";
import { PermanentJobError } from "./queue";

export interface ConfirmationPayload {
  to: string;
  practice: PracticeInfo;
  appointments: Booking[];
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function confirmationEmail({ practice, appointments }: ConfirmationPayload) {
  const rows = appointments
    .map((a) => `<li><b>${esc(a.label)}</b> for ${esc(a.patient_name)}: ${esc(a.display)} with ${esc(a.provider_name)} (${a.duration_minutes} min)</li>`)
    .join("");
  return {
    subject: appointments.length === 1 ? `Your ${appointments[0].label.toLowerCase()} at ${practice.name}: ${appointments[0].display}` : `Your appointments at ${practice.name}`,
    html: `<p>You're booked at <b>${esc(practice.name)}</b>.</p><ul>${rows}</ul>
<p>${esc(practice.address)}<br>Questions or changes: chat with us or call ${esc(practice.phone)}.</p>
<p>First visit? Please bring a photo ID, your insurance card (if any) and a list of medications, and arrive 10 minutes early.</p>
<p>The attached calendar file adds the visit to your calendar.</p>`,
    attachments: appointments.map((a) => ({ filename: `appointment-${a.start_time.slice(0, 10)}-${a.appointment_id}.ics`, content: Buffer.from(icsFile(a, practice)).toString("base64") })),
  };
}

export async function sendConfirmationEmail(p: ConfirmationPayload): Promise<void> {
  const key = process.env.RESEND_API_KEY?.trim();
  if (!key) return;
  const from = process.env.EMAIL_FROM?.trim() || `${p.practice.name} <onboarding@resend.dev>`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [p.to], ...confirmationEmail(p) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const msg = `resend ${res.status}: ${(await res.text()).slice(0, 200)}`;
    throw res.status >= 400 && res.status < 500 && res.status !== 429 ? new PermanentJobError(msg) : new Error(msg);
  }
}
