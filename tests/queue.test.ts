import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { PermanentJobError, processJobs } from "@/lib/queue";
import { seed } from "@/lib/seed";
import { executeTool, type ToolContext } from "@/lib/tools";

const ctx = (): ToolContext => ({ sessionId: "q", verified: [], household: [], failedVerifications: 0 });
const jobs = () => db.all<{ status: string; attempts: number; last_error: string | null }>("SELECT status, attempts, last_error FROM jobs ORDER BY id");

beforeEach(async () => {
  await seed({ reset: true });
});

describe("job queue", () => {
  it("queues a staff alert job together with the alert", async () => {
    const r = await executeTool(ctx(), "notify_staff", { type: "human_handoff", urgency: "normal", summary: "Billing question about a double charge" });
    expect(r.ok).toBe(true);
    expect(await jobs()).toEqual([{ status: "pending", attempts: 0, last_error: null }]);
  });

  it("runs due jobs and marks them done", async () => {
    await executeTool(ctx(), "notify_staff", { type: "callback", urgency: "normal", summary: "Please call back" });
    const seen: unknown[] = [];
    expect(await processJobs(10, { staff_alert: async (p) => void seen.push(p) })).toBe(1);
    expect(seen).toHaveLength(1);
    expect((await jobs())[0].status).toBe("done");
  });

  it("retries a failed delivery later instead of losing it", async () => {
    await executeTool(ctx(), "notify_staff", { type: "callback", urgency: "normal", summary: "Please call back" });
    await processJobs(10, {
      staff_alert: async () => {
        throw new Error("webhook down");
      },
    });
    const [job] = await jobs();
    expect(job).toMatchObject({ status: "pending", attempts: 1, last_error: "webhook down" });
    expect(await processJobs()).toBe(0); // backoff: not due yet
  });

  it("fails permanent errors right away instead of retrying", async () => {
    await executeTool(ctx(), "notify_staff", { type: "callback", urgency: "normal", summary: "Please call back" });
    await processJobs(10, {
      staff_alert: async () => {
        throw new PermanentJobError("rejected");
      },
    });
    expect((await jobs())[0]).toMatchObject({ status: "failed", attempts: 1 });
  });

  it("creates no job when the booking that caused it rolls back", async () => {
    const c = ctx();
    await executeTool(c, "verify_patient", { full_name: "John Smith", date_of_birth: "1985-06-14" });
    const r = await executeTool(c, "book_appointment", { patient_id: 1, appointment_type: "emergency", start_time: "2026-10-27 12:00", provider_id: 1, emergency_summary: "Broken tooth" });
    expect(r.ok).toBe(false); // 12:00 is lunch, so the slot claim fails and the transaction rolls back
    expect(await jobs()).toEqual([]);
  });
});
