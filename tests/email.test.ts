import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { confirmationEmail } from "@/lib/email";
import { processJobs } from "@/lib/queue";
import { seed } from "@/lib/seed";
import { executeTool, type ToolContext } from "@/lib/tools";

const ctx = (): ToolContext => ({ sessionId: "e", verified: [], household: [], failedVerifications: 0 });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (c: ToolContext, name: string, args: Record<string, unknown>): Promise<any> => executeTool(c, name, args);
const confirmations = () => db.all<{ payload: { to: string; appointments: unknown[] } }>("SELECT payload FROM jobs WHERE type = 'booking_confirmation'");

beforeEach(async () => {
  await seed({ reset: true });
});

describe("confirmation emails", () => {
  it("queues one with the booking when the patient has an email", async () => {
    const c = ctx();
    const reg = await call(c, "register_patient", { first_name: "Lee", last_name: "Park", date_of_birth: "1990-01-01", phone: "4155550123", insurance_name: "none", email: "Lee@Example.com" });
    const slots = await call(c, "find_available_slots", { appointment_type: "checkup", date_from: "2026-10-26", date_to: "2026-10-31" });
    const s = slots.slots[0];
    expect((await call(c, "book_appointment", { patient_id: reg.patient.patient_id, appointment_type: "checkup", start_time: s.start_time, provider_id: s.provider_id })).ok).toBe(true);
    const [job] = await confirmations();
    expect(job.payload.to).toBe("lee@example.com");
    expect(job.payload.appointments).toHaveLength(1);
  });

  it("queues nothing without an email, then sends on request and saves the address", async () => {
    const c = ctx();
    await call(c, "verify_patient", { full_name: "John Smith", date_of_birth: "1985-06-14" });
    expect(await confirmations()).toHaveLength(0);
    expect((await call(c, "email_confirmation", { patient_id: 1, email: "not-an-email" })).error).toBe("INVALID_EMAIL");
    expect((await call(c, "email_confirmation", { patient_id: 1, email: "john@example.com" })).ok).toBe(true);
    expect(await confirmations()).toHaveLength(1);
    expect(await db.get("SELECT email FROM patients WHERE id = 1")).toEqual({ email: "john@example.com" });
  });

  it("delivers through the queue with a calendar attachment", async () => {
    const c = ctx();
    await call(c, "verify_patient", { full_name: "John Smith", date_of_birth: "1985-06-14" });
    await call(c, "email_confirmation", { patient_id: 1, email: "john@example.com" });
    const sent: Record<string, unknown>[] = [];
    await processJobs(10, { booking_confirmation: async (p) => void sent.push(p) });
    expect(sent).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mail = confirmationEmail(sent[0] as any);
    expect(mail.subject).toContain("Bright Smile Dental");
    expect(mail.attachments[0].filename).toMatch(/\.ics$/);
    expect(Buffer.from(mail.attachments[0].content, "base64").toString()).toContain("BEGIN:VEVENT");
  });
});
