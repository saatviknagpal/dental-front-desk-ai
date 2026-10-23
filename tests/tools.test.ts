import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { seed } from "@/lib/seed";
import { executeTool, type ToolContext } from "@/lib/tools";

// Clock pinned to Fri 2026-10-23 10:00 (see vitest.config.ts).

const newCtx = (id = "test"): ToolContext => ({ sessionId: id, verified: [], household: [], failedVerifications: 0 });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<any> => executeTool(ctx, name, args);
const all = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.all<T>(sql, params);
const get = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.get<T>(sql, params);

async function verifyJohn(ctx: ToolContext) {
  const r = await call(ctx, "verify_patient", { full_name: "John Smith", date_of_birth: "1985-06-14" });
  expect(r.ok).toBe(true);
  return r;
}

async function firstSlot(ctx: ToolContext, type: string, from = "2026-10-26", to = "2026-10-31", extra: Record<string, unknown> = {}) {
  const r = await call(ctx, "find_available_slots", { appointment_type: type, date_from: from, date_to: to, ...extra });
  expect(r.ok).toBe(true);
  expect(r.slots.length).toBeGreaterThan(0);
  return r.slots[0];
}

beforeEach(async () => {
  await seed({ reset: true });
});

describe("seed", () => {
  it("creates providers, patients, slots and existing appointments", async () => {
    expect(await all("SELECT * FROM providers")).toHaveLength(7); // 2 practices
    expect(await all("SELECT * FROM patients")).toHaveLength(10);
    expect(await all("SELECT * FROM appointments WHERE status='booked'")).toHaveLength(5);
    expect(await get("SELECT count(*)::int AS n FROM slots WHERE start_ts LIKE '2026-10-25%'")).toEqual({ n: 0 }); // Sunday
  });
});

describe("find_available_slots", () => {
  it("returns only open slots in range that match the time of day", async () => {
    const r = await call(newCtx(), "find_available_slots", { appointment_type: "cleaning", date_from: "2026-10-26", date_to: "2026-10-31", time_of_day: "morning" });
    expect(r.ok).toBe(true);
    for (const s of r.slots) {
      expect(s.start_time >= "2026-10-26" && s.start_time < "2026-11-01").toBe(true);
      expect(s.start_time.slice(11) < "12:00").toBe(true);
      const slot = await get<{ status: string }>("SELECT status FROM slots WHERE provider_id=$1 AND start_ts=$2", [s.provider_id, s.start_time]);
      expect(slot?.status).toBe("open");
    }
  });

  it("never returns times in the past", async () => {
    const r = await call(newCtx(), "find_available_slots", { appointment_type: "checkup", date_from: "2026-10-01", date_to: "2026-10-23" });
    for (const s of r.slots) expect(s.start_time >= "2026-10-23 11:00").toBe(true);
  });

  it("offers next_available when nothing matches", async () => {
    const r = await call(newCtx(), "find_available_slots", { appointment_type: "checkup", date_from: "2026-10-25", date_to: "2026-10-25" }); // Sunday
    expect(r.slots).toHaveLength(0);
    expect(r.next_available.length).toBeGreaterThan(0);
  });
});

describe("verification guard", () => {
  it("refuses to book for an unverified patient id", async () => {
    const ctx = newCtx();
    const slot = await firstSlot(ctx, "checkup");
    const r = await call(ctx, "book_appointment", { patient_id: 1, appointment_type: "checkup", start_time: slot.start_time, provider_id: slot.provider_id });
    expect(r).toMatchObject({ ok: false, error: "NOT_VERIFIED" });
  });

  it("does not reveal which field mismatched and locks after 3 failures", async () => {
    const ctx = newCtx();
    for (let i = 0; i < 3; i++) {
      const r = await call(ctx, "verify_patient", { full_name: "John Smith", date_of_birth: "1985-06-15" });
      expect(r.error).toBe("NOT_FOUND");
      expect(JSON.stringify(r)).not.toContain("1985-06-14");
    }
    expect((await call(ctx, "verify_patient", { full_name: "John Smith", date_of_birth: "1985-06-14" })).error).toBe("VERIFICATION_LOCKED");
  });

  it("keeps the lockout when the caller starts a new chat", async () => {
    for (let i = 0; i < 3; i++) await call(newCtx(`s${i}`), "verify_patient", { full_name: "John Smith", date_of_birth: "1985-06-15" });
    expect((await call(newCtx("fresh"), "verify_patient", { full_name: "John Smith", date_of_birth: "1985-06-14" })).error).toBe("VERIFICATION_LOCKED");
  });

  it("verifies case/spacing-insensitively and returns upcoming appointments", async () => {
    const r = await call(newCtx(), "verify_patient", { full_name: "  john   SMITH ", date_of_birth: "06/14/1985" });
    expect(r.ok).toBe(true);
    expect(r.upcoming_appointments).toHaveLength(1);
  });

  it("gives adult household members booking-only access, minors full access", async () => {
    const ctx = newCtx();
    await call(ctx, "verify_patient", { full_name: "Maria Garcia", date_of_birth: "1987-04-09" });
    expect((await call(ctx, "list_appointments", { patient_id: 5 })).error).toBe("NOT_VERIFIED"); // Carlos (adult)
    expect((await call(ctx, "list_appointments", { patient_id: 6 })).ok).toBe(true); // Sofia (minor)
  });
});

describe("booking", () => {
  it("registers a new patient and books a cleaning atomically", async () => {
    const ctx = newCtx();
    const reg = await call(ctx, "register_patient", { first_name: "Priya", last_name: "Shah", date_of_birth: "1994-03-12", phone: "(415) 555-0199", insurance_name: "Delta Dental" });
    expect(reg.ok).toBe(true);
    const slot = await firstSlot(ctx, "cleaning");
    const r = await call(ctx, "book_appointment", { patient_id: reg.patient.patient_id, appointment_type: "cleaning", start_time: slot.start_time, provider_id: slot.provider_id });
    expect(r.ok).toBe(true);
    const booked = await all<{ status: string }>("SELECT status FROM slots WHERE appointment_id = $1", [r.appointment.appointment_id]);
    expect(booked).toHaveLength(2); // 60 min = 2 slots
  });

  it("rejects duplicate registration", async () => {
    const r = await call(newCtx(), "register_patient", { first_name: "John", last_name: "Smith", date_of_birth: "1985-06-14", phone: "4155550101" });
    expect(r.error).toBe("ALREADY_REGISTERED");
  });

  it("prevents double booking the same slot across sessions", async () => {
    const a = newCtx("a");
    const b = newCtx("b");
    await verifyJohn(a);
    await call(b, "verify_patient", { full_name: "Emily Chen", date_of_birth: "1990-11-02" });
    const slot = await firstSlot(a, "checkup");
    const args = { appointment_type: "checkup", start_time: slot.start_time, provider_id: slot.provider_id };
    expect((await call(a, "book_appointment", { ...args, patient_id: 1, confirm_additional: true })).ok).toBe(true);
    const second = await call(b, "book_appointment", { ...args, patient_id: 2 });
    expect(second.error).toBe("SLOT_TAKEN");
    expect(second.alternatives.length).toBeGreaterThan(0);
    expect(await all("SELECT * FROM appointments WHERE patient_id = 2 AND type='checkup'")).toHaveLength(0); // rolled back
  });

  it("exactly one of two simultaneous bookings for the same slot wins", async () => {
    const a = newCtx("a");
    const b = newCtx("b");
    await call(a, "verify_patient", { full_name: "David Kim", date_of_birth: "1978-01-23" });
    await call(b, "verify_patient", { full_name: "Emily Chen", date_of_birth: "1990-11-02" });
    const slot = await firstSlot(a, "emergency", "2026-10-27", "2026-10-27");
    const args = { appointment_type: "emergency", start_time: slot.start_time, provider_id: slot.provider_id, emergency_summary: "Broken tooth, pain 7/10" };
    const results = await Promise.all([call(a, "book_appointment", { ...args, patient_id: 3 }), call(b, "book_appointment", { ...args, patient_id: 2 })]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => r.error === "SLOT_TAKEN")).toHaveLength(1);
    expect(await all("SELECT * FROM appointments WHERE type = 'emergency'")).toHaveLength(1);
  });

  it("flags an existing upcoming appointment of the same type", async () => {
    const ctx = newCtx();
    await verifyJohn(ctx);
    const slot = await firstSlot(ctx, "checkup");
    const r = await call(ctx, "book_appointment", { patient_id: 1, appointment_type: "checkup", start_time: slot.start_time, provider_id: slot.provider_id });
    expect(r.error).toBe("ALREADY_HAS_UPCOMING");
  });

  it("rejects Sundays, past times and invented times", async () => {
    const ctx = newCtx();
    await verifyJohn(ctx);
    const base = { patient_id: 1, appointment_type: "cleaning", provider_id: 3 };
    expect((await call(ctx, "book_appointment", { ...base, start_time: "2026-10-25 10:00" })).error).toBe("CLOSED");
    expect((await call(ctx, "book_appointment", { ...base, start_time: "2026-10-22 10:00" })).error).toBe("IN_PAST");
    expect((await call(ctx, "book_appointment", { ...base, start_time: "2026-10-27 17:30" })).error).toBe("OUTSIDE_HOURS"); // 60 min would end 18:30
    expect((await call(ctx, "book_appointment", { ...base, start_time: "2026-10-27 12:00" })).error).toBe("SLOT_TAKEN"); // lunch is blocked
  });

  it("emergency requires a summary and always notifies staff", async () => {
    const ctx = newCtx();
    await verifyJohn(ctx);
    const slot = await firstSlot(ctx, "emergency", "2026-10-23", "2026-10-24");
    const base = { patient_id: 1, appointment_type: "emergency", start_time: slot.start_time, provider_id: slot.provider_id };
    expect((await call(ctx, "book_appointment", base)).error).toBe("MISSING_EMERGENCY_SUMMARY");
    const r = await call(ctx, "book_appointment", { ...base, emergency_summary: "Cracked molar, pain 8/10 since last night" });
    expect(r.ok).toBe(true);
    expect(r.staff_notified).toBe(true);
    expect(await all("SELECT * FROM notifications WHERE type='emergency' AND urgency='high'")).toHaveLength(1);
  });
});

describe("reschedule and cancel", () => {
  it("reschedules, freeing the old slots", async () => {
    const ctx = newCtx();
    const v = await verifyJohn(ctx);
    const appt = v.upcoming_appointments[0];
    const slot = await firstSlot(ctx, "checkup", "2026-10-27", "2026-10-28");
    const r = await call(ctx, "reschedule_appointment", { patient_id: 1, appointment_id: appt.appointment_id, new_start_time: slot.start_time, provider_id: slot.provider_id });
    expect(r.ok).toBe(true);
    const old = await get<{ status: string }>("SELECT status FROM slots WHERE provider_id=$1 AND start_ts=$2", [appt.provider_id, appt.start_time]);
    expect(old?.status).toBe("open");
    expect((await get<{ start_ts: string }>("SELECT start_ts FROM appointments WHERE id=$1", [appt.appointment_id]))?.start_ts).toBe(slot.start_time);
  });

  it("cannot reschedule or cancel someone else's appointment", async () => {
    const ctx = newCtx();
    await verifyJohn(ctx);
    const emilyAppt = (await get<{ id: number }>("SELECT id FROM appointments WHERE patient_id = 2"))!;
    expect((await call(ctx, "cancel_appointment", { patient_id: 1, appointment_id: emilyAppt.id })).error).toBe("APPOINTMENT_NOT_FOUND");
    expect((await call(ctx, "cancel_appointment", { patient_id: 2, appointment_id: emilyAppt.id })).error).toBe("NOT_VERIFIED");
  });

  it("cancels and frees slots", async () => {
    const ctx = newCtx();
    const v = await verifyJohn(ctx);
    const r = await call(ctx, "cancel_appointment", { patient_id: 1, appointment_id: v.upcoming_appointments[0].appointment_id, reason: "travel" });
    expect(r.ok).toBe(true);
    expect(await all("SELECT * FROM slots WHERE appointment_id = $1", [v.upcoming_appointments[0].appointment_id])).toHaveLength(0);
  });
});

describe("family scheduling", () => {
  it("finds and books back-to-back appointments all-or-nothing", async () => {
    const ctx = newCtx();
    await call(ctx, "verify_patient", { full_name: "Maria Garcia", date_of_birth: "1987-04-09" });
    const members = [
      { patient_id: 4, appointment_type: "cleaning" },
      { patient_id: 6, appointment_type: "cleaning" },
      { patient_id: 7, appointment_type: "checkup" },
    ];
    const r = await call(ctx, "find_family_slots", { members, date_from: "2026-10-31", date_to: "2026-11-07", days_of_week: ["saturday"] });
    expect(r.ok).toBe(true);
    expect(r.options.length).toBeGreaterThan(0);
    const opt = r.options[0].bookings;
    expect(opt).toHaveLength(3);
    // back-to-back: each starts when the previous ends
    const minutes = (ts: string) => new Date(ts.replace(" ", "T") + "Z").getTime() / 60000;
    expect(minutes(opt[1].start_time) - minutes(opt[0].start_time)).toBe(60);
    expect(minutes(opt[2].start_time) - minutes(opt[1].start_time)).toBe(60);
    expect(new Date(opt[0].start_time.replace(" ", "T") + "Z").getUTCDay()).toBe(6);

    const booked = await call(ctx, "book_family_appointments", { bookings: opt.map((b: Record<string, unknown>) => ({ patient_id: b.patient_id, appointment_type: b.appointment_type, start_time: b.start_time, provider_id: b.provider_id })) });
    expect(booked.ok).toBe(true);
    expect(booked.appointments).toHaveLength(3);

    // Re-booking the same option fails entirely and books nothing extra
    const again = await call(ctx, "book_family_appointments", { bookings: opt.map((b: Record<string, unknown>) => ({ patient_id: b.patient_id, appointment_type: b.appointment_type, start_time: b.start_time, provider_id: b.provider_id })) });
    expect(again.ok).toBe(false);
    expect(await all("SELECT * FROM appointments WHERE patient_id IN (4,6,7) AND status='booked'")).toHaveLength(3);
  });
});
