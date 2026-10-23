import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { PRACTICES, withPractice } from "@/lib/practice";
import { seed } from "@/lib/seed";
import { executeTool, type ToolContext } from "@/lib/tools";

const [brightSmile, harbor] = PRACTICES;
const ctx = (): ToolContext => ({ sessionId: "t", verified: [], household: [], failedVerifications: 0 });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const at = (p: (typeof PRACTICES)[number], c: ToolContext, name: string, args: Record<string, unknown>): Promise<any> => withPractice(p, () => executeTool(c, name, args));

beforeEach(async () => {
  await seed({ reset: true });
});

describe("multi-tenant isolation", () => {
  it("can't find another practice's patient", async () => {
    expect((await at(harbor, ctx(), "verify_patient", { full_name: "John Smith", date_of_birth: "1985-06-14" })).error).toBe("NOT_FOUND");
    expect((await at(brightSmile, ctx(), "verify_patient", { full_name: "John Smith", date_of_birth: "1985-06-14" })).ok).toBe(true);
  });

  it("only offers the practice's own providers", async () => {
    const r = await at(harbor, ctx(), "find_available_slots", { appointment_type: "checkup", date_from: "2026-10-26", date_to: "2026-10-31" });
    expect(r.slots.length).toBeGreaterThan(0);
    expect(r.slots.every((s: { provider_id: number }) => [5, 6, 7].includes(s.provider_id))).toBe(true);
  });

  it("can't book a slot with another practice's provider", async () => {
    const c = ctx();
    await at(harbor, c, "verify_patient", { full_name: "Ana Lopez", date_of_birth: "1992-03-03" });
    const r = await at(harbor, c, "book_appointment", { patient_id: 9, appointment_type: "cleaning", start_time: "2026-10-27 08:00", provider_id: 3 });
    expect(r.error).toBe("INVALID_PROVIDER");
  });

  it("registers new patients and alerts under the right practice", async () => {
    const c = ctx();
    const reg = await at(harbor, c, "register_patient", { first_name: "Lee", last_name: "Park", date_of_birth: "1990-01-01", phone: "6175550123", insurance_name: "none" });
    await at(harbor, c, "notify_staff", { type: "callback", urgency: "normal", summary: "Wants a call about pricing" });
    expect(await db.get("SELECT practice_id FROM patients WHERE id = $1", [reg.patient.patient_id])).toEqual({ practice_id: 2 });
    expect(await db.all("SELECT practice_id FROM notifications")).toEqual([{ practice_id: 2 }]);
  });
});
