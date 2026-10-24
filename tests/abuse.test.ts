import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { seed } from "@/lib/seed";
import { executeTool, type ToolContext } from "@/lib/tools";

// Clock pinned to Fri 2026-10-23 10:00 (see vitest.config.ts).

const newCtx = (caller?: string): ToolContext => ({ sessionId: "abuse", verified: [], household: [], failedVerifications: 0, caller });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<any> => executeTool(ctx, name, args);
const names = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel"];
const register = (ctx: ToolContext, i: number, extra: Record<string, unknown> = {}) =>
  call(ctx, "register_patient", { first_name: names[i], last_name: "Tester", date_of_birth: "1990-01-01", phone: `415555${String(2000 + i)}`, insurance_name: "none", ...extra });

beforeEach(async () => {
  await seed({ reset: true });
});

describe("booking abuse limits", () => {
  it("caps new registrations per connection per day", async () => {
    const ctx = newCtx("203.0.113.9");
    for (let i = 0; i < 6; i++) expect((await register(ctx, i)).ok).toBe(true);
    expect((await register(ctx, 6)).error).toBe("REGISTRATION_LIMIT");
    expect((await register(newCtx("198.51.100.4"), 7)).ok).toBe(true); // a different connection is fine
  });

  it("caps how many separate households share one phone number, but not family members", async () => {
    const phone = "4155559999";
    expect((await register(newCtx(), 0, { phone })).ok).toBe(true);
    expect((await register(newCtx(), 1, { phone })).ok).toBe(true);
    expect((await register(newCtx(), 2, { phone })).error).toBe("PHONE_LIMIT");
    const ctx = newCtx();
    const parent = await call(ctx, "verify_patient", { full_name: "Alpha Tester", date_of_birth: "1990-01-01" });
    const child = await call(ctx, "register_patient", { first_name: "Kid", last_name: "Tester", date_of_birth: "2018-05-05", insurance_name: "none", same_household_as_patient_id: parent.patient.patient_id });
    expect(child.ok).toBe(true);
  });

  it("caps upcoming appointments per patient, except emergencies", async () => {
    const ctx = newCtx();
    const { patient } = await register(ctx, 0);
    const book = async (type: string, day: string, extra: Record<string, unknown> = {}) => {
      const found = await call(ctx, "find_available_slots", { appointment_type: type, date_from: day, date_to: day });
      const s = found.slots[0];
      return call(ctx, "book_appointment", { patient_id: patient.patient_id, appointment_type: type, start_time: s.start_time, provider_id: s.provider_id, confirm_additional: true, ...extra });
    };
    for (const day of ["2026-10-26", "2026-10-27", "2026-10-28"]) expect((await book("checkup", day)).ok).toBe(true);
    expect((await book("cleaning", "2026-10-29")).error).toBe("TOO_MANY_UPCOMING");
    expect((await book("emergency", "2026-10-29", { emergency_summary: "cracked molar, pain 8/10" })).ok).toBe(true);
  });
});

describe("insurance member ID", () => {
  it("stores a cleaned-up member ID and policyholder, rejects junk, and ignores them for self-pay", async () => {
    const ok = await register(newCtx(), 0, { insurance_name: "Delta Dental", insurance_member_id: "abc-123 456", policyholder_name: "Pat Tester" });
    expect(ok.ok).toBe(true);
    expect(ok.patient.member_id_on_file).toBe(true);
    expect(await db.get("SELECT insurance_member_id, insurance_subscriber FROM patients WHERE id = $1", [ok.patient.patient_id])).toEqual({ insurance_member_id: "ABC123456", insurance_subscriber: "Pat Tester" });
    expect((await register(newCtx(), 1, { insurance_name: "Cigna", insurance_member_id: "12" })).error).toBe("INVALID_MEMBER_ID");
    const selfPay = await register(newCtx(), 2, { insurance_member_id: "ABC123456" });
    expect(selfPay.patient.member_id_on_file).toBe(false);
  });
});
