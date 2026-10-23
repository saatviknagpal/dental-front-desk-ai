// Tools the LLM can call. Deterministic TypeScript over Postgres.
//
// Invariants enforced here (not in the prompt, so the model can't talk its way around them):
//  - Only real, open slots can be booked; bookings are atomic, so a slot can't be double-booked.
//  - Patient-scoped tools only work on patients verified (name + DOB) or registered in THIS session.
//  - Emergency bookings always create a staff notification.
//  - Errors come back as { ok: false, error, message } so the model can recover gracefully.

import { db, transaction, type Q } from "./db";
import { enqueue } from "./queue";
import { APPOINTMENT_TYPES, BOOKING_HORIZON_DAYS, currentPractice, CLOSE_HOUR, OPEN_HOUR, OPEN_WEEKDAYS, SLOT_MINUTES, type AppointmentType } from "./practice";
import { addDays, addMinutes, dayName, fmtDate, fmtTs, humanTs, parseTs, practiceNow, startOfDay, weekday } from "./time";

export { TOOL_DEFINITIONS, type ToolDefinition } from "./tool-definitions";

// ---------------------------------------------------------------------------
// Types

export interface ToolContext {
  sessionId: string;
  /** Full access: verified with name + DOB, registered here, or a minor in their household. */
  verified: number[];
  /** Booking-only access: adult household members of a verified patient (e.g. a spouse). */
  household: number[];
  failedVerifications: number;
  /** Caller IP (or similar), for the cross-chat lockout. */
  caller?: string;
}

export type ToolResult = { ok: true; [key: string]: unknown } | { ok: false; error: string; message: string; [key: string]: unknown };

type Args = Record<string, unknown>;

interface PatientRow {
  id: number;
  first_name: string;
  last_name: string;
  dob: string;
  phone: string;
  insurance_name: string | null;
  household_id: number | null;
  email: string | null;
}

interface ProviderRow {
  id: number;
  name: string;
  title: string;
  services: string;
}

interface AppointmentRow {
  id: number;
  patient_id: number;
  provider_id: number;
  type: AppointmentType;
  start_ts: string;
  end_ts: string;
  status: string;
}

const MAX_FAILED_VERIFICATIONS = 3;
const LOCKOUT_MINUTES = 15;
const MAX_FAILED_PER_NAME = 20;

class ToolError extends Error {
  constructor(
    public code: string,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const fail = (code: string, message: string, extra: Record<string, unknown> = {}): ToolResult => ({ ok: false, error: code, message, ...extra });

// ---------------------------------------------------------------------------
// Small helpers

const normName = (s: string) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function normPhone(raw: unknown): string | null {
  let digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  return digits.length === 10 ? digits : null;
}

/** Accepts YYYY-MM-DD or MM/DD/YYYY. */
function normDob(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  const iso = us ? `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}` : s;
  const d = parseTs(iso);
  return d ? fmtDate(d) : null;
}

function normEmail(raw: unknown): string | null {
  const s = String(raw ?? "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) ? s : null;
}

function normInsurance(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s || /^(none|no|n\/a|na|null|self[- ]?pay|no insurance|uninsured)$/i.test(s)) return null;
  return s;
}

function ageOn(dob: string, at: Date): number {
  const d = parseTs(dob)!;
  let age = at.getUTCFullYear() - d.getUTCFullYear();
  if (at.getUTCMonth() < d.getUTCMonth() || (at.getUTCMonth() === d.getUTCMonth() && at.getUTCDate() < d.getUTCDate())) age--;
  return age;
}

function apptType(raw: unknown): AppointmentType {
  const s = String(raw ?? "").toLowerCase().trim();
  const map: Record<string, AppointmentType> = {
    cleaning: "cleaning",
    "teeth cleaning": "cleaning",
    checkup: "checkup",
    "check-up": "checkup",
    "general checkup": "checkup",
    exam: "checkup",
    emergency: "emergency",
  };
  const t = map[s];
  if (!t) throw new ToolError("INVALID_APPOINTMENT_TYPE", `Unknown appointment type "${raw}". Use cleaning, checkup or emergency.`);
  return t;
}

const pid = () => currentPractice().id;
const providers = () => db.all<ProviderRow>("SELECT * FROM providers WHERE practice_id = $1 ORDER BY id", [pid()]);
const providerById = (id: number) => (Number.isInteger(id) ? db.get<ProviderRow>("SELECT * FROM providers WHERE id = $1 AND practice_id = $2", [id, pid()]) : Promise.resolve(undefined));
const canDo = (p: ProviderRow, t: AppointmentType) => p.services.split(",").includes(t);

async function requireAccess(ctx: ToolContext, patientId: unknown, level: "full" | "booking"): Promise<PatientRow> {
  const id = Number(patientId);
  const allowed = ctx.verified.includes(id) || (level === "booking" && ctx.household.includes(id));
  if (!Number.isInteger(id) || !allowed) {
    throw new ToolError(
      "NOT_VERIFIED",
      level === "full"
        ? "This patient has not been verified in this conversation. Verify their identity (full name + date of birth) or register them first."
        : "This patient isn't linked to anyone verified in this conversation. Verify or register them first.",
    );
  }
  const p = await db.get<PatientRow>("SELECT * FROM patients WHERE id = $1 AND practice_id = $2", [id, pid()]);
  if (!p) throw new ToolError("PATIENT_NOT_FOUND", "Patient not found.");
  return p;
}

async function upcomingAppointments(patientId: number) {
  const rows = await db.all<AppointmentRow & { provider_name: string }>(
    `SELECT a.*, p.name AS provider_name FROM appointments a JOIN providers p ON p.id = a.provider_id
     WHERE a.patient_id = $1 AND a.status = 'booked' AND a.start_ts >= $2 ORDER BY a.start_ts`,
    [patientId, fmtTs(practiceNow())],
  );
  return rows.map((a) => ({
    appointment_id: a.id,
    type: a.type,
    label: APPOINTMENT_TYPES[a.type].label,
    start_time: a.start_ts,
    display: humanTs(parseTs(a.start_ts)!),
    provider_id: a.provider_id,
    provider_name: a.provider_name,
  }));
}

function slotTimes(start: Date, type: AppointmentType): string[] {
  const n = APPOINTMENT_TYPES[type].minutes / SLOT_MINUTES;
  return Array.from({ length: n }, (_, i) => fmtTs(addMinutes(start, i * SLOT_MINUTES)));
}

/** Earliest bookable start: emergencies can be same-day soon; others need 1 hour lead time. */
function earliestStart(type: AppointmentType): Date {
  const lead = type === "emergency" ? 15 : 60;
  const t = addMinutes(practiceNow(), lead);
  const rem = t.getUTCMinutes() % SLOT_MINUTES;
  return rem ? addMinutes(t, SLOT_MINUTES - rem) : t;
}

function validateStart(raw: unknown, type: AppointmentType): Date {
  const start = parseTs(String(raw ?? ""));
  if (!start) throw new ToolError("INVALID_TIME", `Could not read start_time "${raw}". Use "YYYY-MM-DD HH:MM" exactly as returned by find_available_slots.`);
  const end = addMinutes(start, APPOINTMENT_TYPES[type].minutes);
  if (!OPEN_WEEKDAYS.has(weekday(start))) throw new ToolError("CLOSED", "The office is closed on Sundays.");
  if (start.getUTCMinutes() % SLOT_MINUTES !== 0 || start.getUTCHours() < OPEN_HOUR || end > addMinutes(startOfDay(start), CLOSE_HOUR * 60)) {
    throw new ToolError("OUTSIDE_HOURS", "That time is outside office hours (8:00 AM to 6:00 PM, Mon-Sat).");
  }
  if (start < earliestStart(type)) throw new ToolError("IN_PAST", "That time has already passed or is too soon to book.");
  return start;
}

type TimeOfDay = "morning" | "afternoon" | "late_afternoon" | "any";

interface SearchFilters {
  timeOfDay: TimeOfDay;
  after?: string; // "HH:MM"
  before?: string; // "HH:MM" (appointment must start before this)
  days?: Set<number>; // weekday numbers
}

function matchesFilters(start: Date, f: SearchFilters): boolean {
  const hm = fmtTs(start).slice(11);
  if (f.timeOfDay === "morning" && hm >= "12:00") return false;
  if (f.timeOfDay === "afternoon" && (hm < "12:00" || hm >= "17:00")) return false;
  if (f.timeOfDay === "late_afternoon" && hm < "15:00") return false;
  if (f.after && hm < f.after) return false;
  if (f.before && hm >= f.before) return false;
  if (f.days && !f.days.has(weekday(start))) return false;
  return true;
}

const DAY_NUM: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

function parseFilters(args: Args): SearchFilters {
  const tod = String(args.time_of_day ?? "any").toLowerCase();
  const timeOfDay: TimeOfDay = (["morning", "afternoon", "late_afternoon", "any"] as const).includes(tod as TimeOfDay) ? (tod as TimeOfDay) : "any";
  const hhmm = (v: unknown) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? "").trim());
    return m ? `${m[1].padStart(2, "0")}:${m[2]}` : undefined;
  };
  let days: Set<number> | undefined;
  if (Array.isArray(args.days_of_week) && args.days_of_week.length) {
    days = new Set(args.days_of_week.map((d) => DAY_NUM[String(d).toLowerCase()]).filter((d) => d !== undefined));
    if (!days.size) days = undefined;
  }
  return { timeOfDay, after: hhmm(args.after_time), before: hhmm(args.before_time), days };
}

function parseRange(args: Args): { from: Date; to: Date } {
  const today = startOfDay(practiceNow());
  let from = parseTs(String(args.date_from ?? "")) ?? today;
  let to = parseTs(String(args.date_to ?? "")) ?? addDays(from, 6);
  from = startOfDay(from);
  to = startOfDay(to);
  if (to < from) throw new ToolError("INVALID_RANGE", "date_to is before date_from.");
  if (from < today) from = today;
  if (to < from) to = from;
  const max = addDays(today, BOOKING_HORIZON_DAYS - 1);
  if (from > max) throw new ToolError("TOO_FAR_AHEAD", "We can only book up to about 8 weeks ahead. Offer to note a callback request or pick an earlier date.");
  if (to > max) to = max;
  return { from, to };
}

/** Set of "providerId|YYYY-MM-DD HH:MM" for open slots in [from, to]. */
async function openSlotSet(from: Date, to: Date): Promise<Set<string>> {
  const rows = await db.all<{ provider_id: number; start_ts: string }>(
    "SELECT provider_id, start_ts FROM slots WHERE status = 'open' AND start_ts >= $1 AND start_ts < $2",
    [fmtTs(from), fmtTs(addDays(to, 1))],
  );
  return new Set(rows.map((r) => `${r.provider_id}|${r.start_ts}`));
}

interface Candidate {
  start: Date;
  provider: ProviderRow;
}

async function findCandidates(type: AppointmentType, from: Date, to: Date, f: SearchFilters, providerId?: number): Promise<Candidate[]> {
  const open = await openSlotSet(from, to);
  // Most specialized first: hygienists take cleanings, keeping dentists free for exams/emergencies.
  const capable = (await providers())
    .filter((p) => canDo(p, type) && (!providerId || p.id === providerId))
    .sort((a, b) => a.services.split(",").length - b.services.split(",").length);
  const minStart = earliestStart(type);
  const out: Candidate[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    if (!OPEN_WEEKDAYS.has(weekday(day))) continue;
    for (let t = addMinutes(day, OPEN_HOUR * 60); addMinutes(t, APPOINTMENT_TYPES[type].minutes) <= addMinutes(day, CLOSE_HOUR * 60); t = addMinutes(t, SLOT_MINUTES)) {
      if (t < minStart || !matchesFilters(t, f)) continue;
      const times = slotTimes(t, type);
      const p = capable.find((pr) => times.every((ts) => open.has(`${pr.id}|${ts}`)));
      if (p) out.push({ start: t, provider: p });
    }
  }
  return out;
}

/** Pick a short, varied list (max 2 per day, spread out) instead of 10 adjacent times. */
function diversify<T extends { start: Date }>(cands: T[], limit: number): T[] {
  const byDay = new Map<string, T[]>();
  for (const c of cands) {
    const k = fmtDate(c.start);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k)!.push(c);
  }
  const picked: T[] = [];
  for (const list of byDay.values()) {
    picked.push(list[0]);
    const later = list.find((c) => c.start.getTime() - list[0].start.getTime() >= 3 * 60 * 60_000);
    if (later) picked.push(later);
    if (picked.length >= limit) break;
  }
  return picked.slice(0, limit).sort((a, b) => a.start.getTime() - b.start.getTime());
}

const slotView = (c: Candidate, type: AppointmentType) => ({
  start_time: fmtTs(c.start),
  display: humanTs(c.start),
  provider_id: c.provider.id,
  provider_name: c.provider.name,
  duration_minutes: APPOINTMENT_TYPES[type].minutes,
});

/**
 * Claim the slots for an appointment inside a transaction. The conditional
 * UPDATE (status = 'open') is the concurrency guard: under READ COMMITTED a
 * competing transaction blocks on the row lock, then re-checks the WHERE and
 * matches 0 rows, so exactly one booking wins. Throws SLOT_TAKEN.
 */
async function claimSlots(tx: Q, appointmentId: number, providerId: number, start: Date, type: AppointmentType) {
  const times = slotTimes(start, type);
  const r = await tx.run(
    "UPDATE slots SET status = 'booked', appointment_id = $1 WHERE provider_id = $2 AND status = 'open' AND start_ts = ANY($3)",
    [appointmentId, providerId, times],
  );
  if (r.rowCount !== times.length) throw new ToolError("SLOT_TAKEN", "Sorry, that time was just taken by someone else.");
}

async function releaseSlots(tx: Q, appointmentId: number) {
  await tx.run("UPDATE slots SET status = 'open', appointment_id = NULL WHERE appointment_id = $1", [appointmentId]);
}

async function assertNoPatientOverlap(tx: Q, patientId: number, start: Date, type: AppointmentType, ignoreAppointmentId = -1) {
  const end = addMinutes(start, APPOINTMENT_TYPES[type].minutes);
  const clash = await tx.get<AppointmentRow>(
    "SELECT * FROM appointments WHERE patient_id = $1 AND status = 'booked' AND id != $2 AND start_ts < $3 AND end_ts > $4",
    [patientId, ignoreAppointmentId, fmtTs(end), fmtTs(start)],
  );
  if (clash) throw new ToolError("PATIENT_CONFLICT", `This patient already has an appointment at ${humanTs(parseTs(clash.start_ts)!)}.`);
}

type Card = { appointment_id: number; patient_name: string; label: string; start_time: string; display: string; provider_name: string; duration_minutes: number };

/** Queue a confirmation email (outbox) inside the booking's transaction, if the patient has an email. */
async function queueConfirmation(q: Q, email: string | null, appointments: Card[]) {
  if (!email || !appointments.length) return;
  const { slug, name, address, phone, timezone } = currentPractice();
  await enqueue(q, "booking_confirmation", { to: email, practice: { slug, name, address, phone, timezone }, appointments });
}

/** Store a staff alert and queue its outside delivery (webhook) in the same transaction. */
async function insertNotification(q: Q, type: string, urgency: string, summary: string, sessionId: string, patientId: number | null) {
  const r = await q.get<{ id: number }>(
    "INSERT INTO notifications (type, urgency, patient_id, summary, session_id, created_at, practice_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
    [type, urgency, patientId, summary, sessionId, fmtTs(practiceNow()), pid()],
  );
  await enqueue(q, "staff_alert", { notification_id: r!.id, type, urgency, text: `${currentPractice().name}: ${summary}` });
  return r!.id;
}

interface BookingInput {
  patient: PatientRow;
  type: AppointmentType;
  start: Date;
  provider: ProviderRow;
  notes?: string | null;
  emergencySummary?: string | null;
}

/** Insert one appointment and claim its slots. Must run inside a transaction. */
async function bookOne(tx: Q, ctx: ToolContext, b: BookingInput) {
  await assertNoPatientOverlap(tx, b.patient.id, b.start, b.type);
  const now = fmtTs(practiceNow());
  const appt = await tx.get<{ id: number }>(
    `INSERT INTO appointments (patient_id, provider_id, type, start_ts, end_ts, status, notes, emergency_summary, session_id, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,'booked',$6,$7,$8,$9,$9) RETURNING id`,
    [b.patient.id, b.provider.id, b.type, fmtTs(b.start), fmtTs(addMinutes(b.start, APPOINTMENT_TYPES[b.type].minutes)), b.notes ?? null, b.emergencySummary ?? null, ctx.sessionId, now],
  );
  await claimSlots(tx, appt!.id, b.provider.id, b.start, b.type);
  return {
    appointment_id: appt!.id,
    patient_name: `${b.patient.first_name} ${b.patient.last_name}`,
    type: b.type,
    label: APPOINTMENT_TYPES[b.type].label,
    start_time: fmtTs(b.start),
    display: humanTs(b.start),
    provider_name: b.provider.name,
    duration_minutes: APPOINTMENT_TYPES[b.type].minutes,
  };
}

async function resolveBooking(ctx: ToolContext, args: Args): Promise<BookingInput> {
  const patient = await requireAccess(ctx, args.patient_id, "booking");
  const type = apptType(args.appointment_type);
  const start = validateStart(args.start_time, type);
  const provider = await providerById(Number(args.provider_id));
  if (!provider) throw new ToolError("INVALID_PROVIDER", "Unknown provider_id. Use the provider_id returned by find_available_slots.");
  if (!canDo(provider, type)) throw new ToolError("PROVIDER_CANNOT_DO", `${provider.name} doesn't do ${APPOINTMENT_TYPES[type].label.toLowerCase()} appointments.`);
  return { patient, type, start, provider };
}

async function alternativesNear(type: AppointmentType, start: Date) {
  const from = startOfDay(start);
  return diversify(await findCandidates(type, from, addDays(from, 3), { timeOfDay: "any" }), 4).map((c) => slotView(c, type));
}

// ---------------------------------------------------------------------------
// Tool implementations

const LOCKED = () =>
  fail("VERIFICATION_LOCKED", "Too many failed verification attempts. Do not try again; offer to have the front desk call them back (notify_staff with type callback).");

async function verify_patient(ctx: ToolContext, args: Args): Promise<ToolResult> {
  if (ctx.failedVerifications >= MAX_FAILED_VERIFICATIONS) return LOCKED();
  const dob = normDob(args.date_of_birth);
  const name = normName(String(args.full_name ?? ""));
  if (!dob || !name.includes(" ")) return fail("MISSING_INFO", "Need the patient's full name (first and last) and date of birth (YYYY-MM-DD).");
  // The lockout is also counted per name across all chats, so opening a new chat doesn't reset it.
  const since = fmtTs(addMinutes(practiceNow(), -LOCKOUT_MINUTES));
  // Lock this caller after 3 misses for a name; lock the name for everyone only after many misses,
  // so one person can't lock a real patient out by guessing wrong on purpose.
  const recent = await db.get<{ mine: number; total: number }>(
    "SELECT count(*) FILTER (WHERE caller IS NOT DISTINCT FROM $3)::int AS mine, count(*)::int AS total FROM verification_failures WHERE name_key = $1 AND created_at >= $2",
    [`${pid()}:${name}`, since, ctx.caller ?? null],
  );
  if ((recent?.mine ?? 0) >= MAX_FAILED_VERIFICATIONS || (recent?.total ?? 0) >= MAX_FAILED_PER_NAME) return LOCKED();
  const tokens = name.split(" ");
  let match = (await db.all<PatientRow>("SELECT * FROM patients WHERE dob = $1 AND practice_id = $2", [dob, pid()])).filter(
    (p) => tokens[0] === normName(p.first_name) && tokens[tokens.length - 1] === normName(p.last_name),
  );
  const phone = normPhone(args.phone);
  if (match.length > 1) {
    if (!phone) return fail("NEED_PHONE", "More than one record matches. Ask for the phone number on file to confirm.");
    match = match.filter((p) => p.phone === phone);
  }
  if (match.length !== 1) {
    ctx.failedVerifications++;
    await db.run("INSERT INTO verification_failures (name_key, session_id, created_at, caller) VALUES ($1,$2,$3,$4)", [`${pid()}:${name}`, ctx.sessionId, fmtTs(practiceNow()), ctx.caller ?? null]);
    return fail(
      "NOT_FOUND",
      "No patient record matches that name and date of birth. Don't say which part didn't match. Ask them to double-check spelling and DOB, or offer to register them as a new patient.",
      { attempts_remaining: Math.max(0, MAX_FAILED_VERIFICATIONS - ctx.failedVerifications) },
    );
  }
  const p = match[0];
  if (!ctx.verified.includes(p.id)) ctx.verified.push(p.id);

  const now = practiceNow();
  const household = p.household_id ? await db.all<PatientRow>("SELECT * FROM patients WHERE household_id = $1 AND id != $2 ORDER BY dob", [p.household_id, p.id]) : [];
  for (const m of household) {
    const list = ageOn(m.dob, now) < 18 ? ctx.verified : ctx.household;
    if (!list.includes(m.id)) list.push(m.id);
  }
  return {
    ok: true,
    patient: {
      patient_id: p.id,
      first_name: p.first_name,
      last_name: p.last_name,
      insurance_on_file: p.insurance_name ?? "none (self-pay)",
      phone_last4: p.phone.slice(-4),
    },
    household_members: household.map((m) => ({
      patient_id: m.id,
      first_name: m.first_name,
      last_name: m.last_name,
      age: ageOn(m.dob, now),
      access: ageOn(m.dob, now) < 18 ? "full (minor)" : "booking only (adult: they must verify themselves to view or change their existing appointments)",
    })),
    email_on_file: !!p.email,
    upcoming_appointments: await upcomingAppointments(p.id),
  };
}

async function register_patient(ctx: ToolContext, args: Args): Promise<ToolResult> {
  const first = String(args.first_name ?? "").trim();
  const last = String(args.last_name ?? "").trim();
  const dob = normDob(args.date_of_birth);
  if (!first || !last) return fail("MISSING_INFO", "First and last name are required.");
  if (!dob) return fail("INVALID_DOB", "Date of birth must be a real date (YYYY-MM-DD).");
  const now = practiceNow();
  const age = ageOn(dob, now);
  if (parseTs(dob)! > now || age > 120) return fail("INVALID_DOB", "That date of birth doesn't look right. Please double-check it.");

  let householdId: number | null = null;
  let guardianPhone: string | null = null;
  if (args.same_household_as_patient_id !== undefined && args.same_household_as_patient_id !== null) {
    const anchor = await requireAccess(ctx, args.same_household_as_patient_id, "booking");
    householdId = anchor.household_id ?? anchor.id;
    guardianPhone = anchor.phone;
  }
  const phone = normPhone(args.phone) ?? guardianPhone;
  if (!phone) return fail("INVALID_PHONE", "Need a valid 10-digit US phone number.");

  const dup = (await db.all<PatientRow>("SELECT * FROM patients WHERE dob = $1 AND practice_id = $2", [dob, pid()])).find(
    (p) => normName(p.first_name) === normName(first) && normName(p.last_name) === normName(last),
  );
  if (dup) return fail("ALREADY_REGISTERED", "A patient with this name and date of birth is already on file. Treat them as an existing patient and use verify_patient.");

  const insurance = normInsurance(args.insurance_name);
  const email = args.email ? normEmail(args.email) : null;
  if (args.email && !email) return fail("INVALID_EMAIL", "That email address doesn't look right. Ask them to check it, or register without one.");
  let id: number;
  try {
    id = await transaction(async (tx) => {
      const r = await tx.get<{ id: number }>(
        // uq_patients_identity also catches two registrations racing past the duplicate check above
        "INSERT INTO patients (first_name, last_name, dob, phone, insurance_name, household_id, created_at, practice_id, email) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",
        [first, last, dob, phone, insurance, householdId, fmtTs(now), pid(), email],
      );
      if (householdId === null) await tx.run("UPDATE patients SET household_id = id WHERE id = $1", [r!.id]);
      return r!.id;
    });
  } catch (e) {
    if ((e as { code?: string }).code === "23505") return fail("ALREADY_REGISTERED", "A patient with this name and date of birth is already on file. Treat them as an existing patient and use verify_patient.");
    throw e;
  }
  ctx.verified.push(id);
  return {
    ok: true,
    patient: { patient_id: id, first_name: first, last_name: last, date_of_birth: dob, insurance: insurance ?? "none (self-pay)", age, email_on_file: !!email },
    note: insurance ? undefined : "No insurance on file. Mention self-pay prices and the membership plan if relevant.",
  };
}

async function email_confirmation(ctx: ToolContext, args: Args): Promise<ToolResult> {
  const patient = await requireAccess(ctx, args.patient_id, "booking");
  const email = normEmail(args.email);
  if (!email) return fail("INVALID_EMAIL", "That email address doesn't look right. Ask them to check it.");
  const upcoming = await upcomingAppointments(patient.id);
  if (!upcoming.length) return fail("NO_UPCOMING", "This patient has no upcoming appointments to confirm.");
  const name = `${patient.first_name} ${patient.last_name}`;
  await transaction(async (tx) => {
    await tx.run("UPDATE patients SET email = $1 WHERE id = $2", [email, patient.id]);
    await queueConfirmation(
      tx,
      email,
      upcoming.map((a) => ({ appointment_id: a.appointment_id, patient_name: name, label: a.label, start_time: a.start_time, display: a.display, provider_name: a.provider_name, duration_minutes: APPOINTMENT_TYPES[a.type].minutes })),
    );
  });
  return { ok: true, queued_to: email, appointments: upcoming.length, note: "The email is on its way (usually within a minute). Say it's on its way, not that it was sent. The address is saved for future confirmations." };
}

async function list_appointments(ctx: ToolContext, args: Args): Promise<ToolResult> {
  const p = await requireAccess(ctx, args.patient_id, "full");
  return { ok: true, patient_id: p.id, upcoming_appointments: await upcomingAppointments(p.id) };
}

async function find_available_slots(_ctx: ToolContext, args: Args): Promise<ToolResult> {
  const type = apptType(args.appointment_type);
  const { from, to } = parseRange(args);
  const filters = parseFilters(args);
  const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 10);
  const providerId = args.provider_id ? Number(args.provider_id) : undefined;

  const found = diversify(await findCandidates(type, from, to, filters, providerId), limit);
  if (found.length) {
    return { ok: true, appointment_type: type, searched: { from: fmtDate(from), to: fmtDate(to) }, slots: found.map((c) => slotView(c, type)) };
  }
  // Nothing matched: look further out (same filters first, then any time) so the bot can offer alternatives.
  let next = diversify(await findCandidates(type, addDays(to, 1), addDays(to, 21), filters, providerId), 3);
  let relaxed = false;
  if (!next.length) {
    next = diversify(await findCandidates(type, from, addDays(to, 21), { timeOfDay: "any" }, providerId), 3);
    relaxed = true;
  }
  return {
    ok: true,
    appointment_type: type,
    searched: { from: fmtDate(from), to: fmtDate(to) },
    slots: [],
    message: "No openings match those preferences.",
    next_available: next.map((c) => slotView(c, type)),
    next_available_note: relaxed ? "These ignore the time-of-day/day filters." : "These are the next openings with the same preferences.",
  };
}

async function book_appointment(ctx: ToolContext, args: Args): Promise<ToolResult> {
  const b = await resolveBooking(ctx, args);
  const summary = String(args.emergency_summary ?? "").trim();
  if (b.type === "emergency" && summary.length < 5) {
    return fail("MISSING_EMERGENCY_SUMMARY", "Ask what's going on (symptoms, when it started, pain level) and pass it as emergency_summary.");
  }
  if (b.type !== "emergency" && args.confirm_additional !== true) {
    const existing = (await upcomingAppointments(b.patient.id)).find((a) => a.type === b.type);
    if (existing) {
      return fail(
        "ALREADY_HAS_UPCOMING",
        `This patient already has a ${existing.label.toLowerCase()} on ${existing.display}. Ask whether they want to reschedule that one instead. If they really want an additional one, call again with confirm_additional=true.`,
        { existing },
      );
    }
  }
  b.notes = args.notes ? String(args.notes) : null;
  b.emergencySummary = b.type === "emergency" ? summary : null;
  try {
    const result = await transaction(async (tx) => {
      const booked = await bookOne(tx, ctx, b);
      await queueConfirmation(tx, b.patient.email, [booked]);
      const notificationId =
        b.type === "emergency"
          ? await insertNotification(
              tx,
              "emergency",
              "high",
              `EMERGENCY visit booked for ${booked.patient_name} at ${booked.display} with ${booked.provider_name}. Patient reports: ${summary}`,
              ctx.sessionId,
              b.patient.id,
            )
          : null;
      return { booked, notificationId };
    });
    return {
      ok: true,
      appointment: result.booked,
      staff_notified: !!result.notificationId,
      insurance_on_file: b.patient.insurance_name ?? "none (self-pay)",
      ...(result.notificationId ? { tell_patient: "Tell the patient you've let the dental team know what's going on so they're ready for them." } : {}),
    };
  } catch (e) {
    if (e instanceof ToolError && e.code === "SLOT_TAKEN") return fail(e.code, e.message, { alternatives: await alternativesNear(b.type, b.start) });
    throw e;
  }
}

async function reschedule_appointment(ctx: ToolContext, args: Args): Promise<ToolResult> {
  const patient = await requireAccess(ctx, args.patient_id, "full");
  const appt = await db.get<AppointmentRow>("SELECT * FROM appointments WHERE id = $1 AND patient_id = $2", [Number(args.appointment_id) || 0, patient.id]);
  if (!appt || appt.status !== "booked") return fail("APPOINTMENT_NOT_FOUND", "No active appointment with that id for this patient. Use list_appointments.");
  if (appt.start_ts < fmtTs(practiceNow())) return fail("APPOINTMENT_PAST", "That appointment has already happened.");
  const start = validateStart(args.new_start_time, appt.type);
  const provider = await providerById(Number(args.provider_id ?? appt.provider_id));
  if (!provider || !canDo(provider, appt.type)) return fail("INVALID_PROVIDER", "Use a provider_id returned by find_available_slots for this appointment type.");
  try {
    // Release + claim in one transaction: if the new time is gone, the original booking is untouched.
    await transaction(async (tx) => {
      await releaseSlots(tx, appt.id);
      await assertNoPatientOverlap(tx, patient.id, start, appt.type, appt.id);
      await queueConfirmation(tx, patient.email, [
        { appointment_id: appt.id, patient_name: `${patient.first_name} ${patient.last_name}`, label: APPOINTMENT_TYPES[appt.type].label, start_time: fmtTs(start), display: humanTs(start), provider_name: provider.name, duration_minutes: APPOINTMENT_TYPES[appt.type].minutes },
      ]);
      await claimSlots(tx, appt.id, provider.id, start, appt.type);
      await tx.run("UPDATE appointments SET start_ts = $1, end_ts = $2, provider_id = $3, updated_at = $4, session_id = $5 WHERE id = $6", [
        fmtTs(start),
        fmtTs(addMinutes(start, APPOINTMENT_TYPES[appt.type].minutes)),
        provider.id,
        fmtTs(practiceNow()),
        ctx.sessionId,
        appt.id,
      ]);
    });
  } catch (e) {
    if (e instanceof ToolError && e.code === "SLOT_TAKEN") return fail(e.code, e.message, { alternatives: await alternativesNear(appt.type, start) });
    throw e;
  }
  return {
    ok: true,
    appointment: {
      appointment_id: appt.id,
      label: APPOINTMENT_TYPES[appt.type].label,
      previous_time: humanTs(parseTs(appt.start_ts)!),
      new_time: humanTs(start),
      display: humanTs(start),
      start_time: fmtTs(start),
      provider_name: provider.name,
      patient_name: `${patient.first_name} ${patient.last_name}`,
      duration_minutes: APPOINTMENT_TYPES[appt.type].minutes,
    },
  };
}

async function cancel_appointment(ctx: ToolContext, args: Args): Promise<ToolResult> {
  const patient = await requireAccess(ctx, args.patient_id, "full");
  const appt = await db.get<AppointmentRow>("SELECT * FROM appointments WHERE id = $1 AND patient_id = $2", [Number(args.appointment_id) || 0, patient.id]);
  if (!appt || appt.status !== "booked") return fail("APPOINTMENT_NOT_FOUND", "No active appointment with that id for this patient. Use list_appointments.");
  const start = parseTs(appt.start_ts)!;
  if (start < practiceNow()) return fail("APPOINTMENT_PAST", "That appointment has already happened.");
  await transaction(async (tx) => {
    await releaseSlots(tx, appt.id);
    await tx.run("UPDATE appointments SET status = 'cancelled', cancel_reason = $1, updated_at = $2, session_id = $3 WHERE id = $4", [
      args.reason ? String(args.reason) : null,
      fmtTs(practiceNow()),
      ctx.sessionId,
      appt.id,
    ]);
  });
  const hoursAway = (start.getTime() - practiceNow().getTime()) / 3_600_000;
  return {
    ok: true,
    cancelled: { appointment_id: appt.id, label: APPOINTMENT_TYPES[appt.type].label, was: humanTs(start) },
    late_cancellation: hoursAway < 24,
    note: hoursAway < 24 ? "Less than 24 hours' notice. No fee, but kindly mention we appreciate 24 hours' notice when possible." : undefined,
  };
}

async function find_family_slots(ctx: ToolContext, args: Args): Promise<ToolResult> {
  const members = Array.isArray(args.members) ? (args.members as Args[]) : [];
  if (members.length < 2 || members.length > 6) return fail("INVALID_MEMBERS", "Provide 2 to 6 members, each with patient_id and appointment_type.");
  const resolved = [];
  for (const m of members) resolved.push({ patient: await requireAccess(ctx, m.patient_id, "booking"), type: apptType(m.appointment_type) });
  const arrangement = String(args.arrangement ?? "back_to_back") === "same_time" ? "same_time" : "back_to_back";
  const { from, to } = parseRange(args);
  const filters = parseFilters(args);
  const limit = Math.min(Math.max(Number(args.limit) || 3, 1), 5);

  const open = await openSlotSet(from, to);
  const allProviders = (await providers()).sort((a, b) => a.services.split(",").length - b.services.split(",").length);
  const minStart = resolved.reduce((acc, m) => (earliestStart(m.type) > acc ? earliestStart(m.type) : acc), new Date(0));
  const options: { start: Date; bookings: Record<string, unknown>[] }[] = [];

  let daysWithOptions = 0;
  for (let day = from; day <= to && daysWithOptions < limit; day = addDays(day, 1)) {
    if (!OPEN_WEEKDAYS.has(weekday(day))) continue;
    const close = addMinutes(day, CLOSE_HOUR * 60);
    const before = options.length;
    for (let t = addMinutes(day, OPEN_HOUR * 60); t < close; t = addMinutes(t, SLOT_MINUTES)) {
      if (t < minStart || !matchesFilters(t, filters)) continue;
      // Greedy plan: each member takes the first capable provider free at the cursor.
      const used = new Set<string>();
      const plan: { start: Date; provider: ProviderRow; type: AppointmentType; patient: PatientRow }[] = [];
      let cursor = t;
      for (const m of resolved) {
        if (addMinutes(cursor, APPOINTMENT_TYPES[m.type].minutes) > close) break;
        const times = slotTimes(cursor, m.type);
        const p = allProviders.find((pr) => canDo(pr, m.type) && times.every((ts) => open.has(`${pr.id}|${ts}`) && !used.has(`${pr.id}|${ts}`)));
        if (!p) break;
        times.forEach((ts) => used.add(`${p.id}|${ts}`));
        plan.push({ start: cursor, provider: p, type: m.type, patient: m.patient });
        if (arrangement === "back_to_back") cursor = addMinutes(cursor, APPOINTMENT_TYPES[m.type].minutes);
      }
      if (plan.length === resolved.length) {
        options.push({
          start: t,
          bookings: plan.map((x) => ({ patient_id: x.patient.id, patient_name: x.patient.first_name, appointment_type: x.type, ...slotView({ start: x.start, provider: x.provider }, x.type) })),
        });
      }
    }
    if (options.length > before) daysWithOptions++;
  }

  const picked = diversify(options, limit);
  if (!picked.length) {
    return { ok: true, options: [], message: `No ${arrangement.replace(/_/g, "-")} openings for everyone in that range. Try a wider date range, a different time of day, or splitting across two visits.` };
  }
  return { ok: true, arrangement, options: picked.map((o, i) => ({ option: i + 1, day: `${dayName(o.start)} ${fmtDate(o.start)}`, bookings: o.bookings })) };
}

async function book_family_appointments(ctx: ToolContext, args: Args): Promise<ToolResult> {
  const bookings = Array.isArray(args.bookings) ? (args.bookings as Args[]) : [];
  if (bookings.length < 1 || bookings.length > 6) return fail("INVALID_BOOKINGS", "Provide 1 to 6 bookings.");
  const inputs: BookingInput[] = [];
  for (const b of bookings) inputs.push(await resolveBooking(ctx, b));
  try {
    const booked = await transaction(async (tx) => {
      const out = [];
      for (const b of inputs) out.push(await bookOne(tx, ctx, b));
      // One email per address (a parent's kids usually share the parent's email).
      for (const email of new Set(inputs.map((b) => b.patient.email).filter(Boolean))) {
        await queueConfirmation(tx, email, out.filter((_, i) => inputs[i].patient.email === email));
      }
      return out;
    });
    return { ok: true, appointments: booked };
  } catch (e) {
    if (e instanceof ToolError) return fail(e.code, `${e.message} Nothing was booked (all-or-nothing). Search again with find_family_slots.`);
    throw e;
  }
}

async function notify_staff(ctx: ToolContext, args: Args): Promise<ToolResult> {
  const type = ["emergency", "human_handoff", "callback"].includes(String(args.type)) ? String(args.type) : "callback";
  const urgency = String(args.urgency) === "high" ? "high" : "normal";
  const summary = String(args.summary ?? "").trim();
  if (summary.length < 5) return fail("MISSING_SUMMARY", "Include a short summary for the staff.");
  const pid = Number(args.patient_id);
  const patientId = ctx.verified.includes(pid) || ctx.household.includes(pid) ? pid : null;
  const phone = normPhone(args.callback_phone);
  const text = phone ? `${summary} (callback: ${phone})` : summary;
  const id = await transaction((tx) => insertNotification(tx, type, urgency, text, ctx.sessionId, patientId));
  return { ok: true, notification_id: id, message: "Staff have been notified." };
}

// ---------------------------------------------------------------------------
// Registry

const HANDLERS: Record<string, (ctx: ToolContext, args: Args) => Promise<ToolResult>> = {
  verify_patient,
  register_patient,
  list_appointments,
  find_available_slots,
  book_appointment,
  reschedule_appointment,
  cancel_appointment,
  find_family_slots,
  book_family_appointments,
  notify_staff,
  email_confirmation,
};

/** Execute a tool by name. Never throws: unexpected errors become { ok: false }. */
export async function executeTool(ctx: ToolContext, name: string, args: Args): Promise<ToolResult> {
  const handler = HANDLERS[name];
  if (!handler) return fail("UNKNOWN_TOOL", `No tool named ${name}.`);
  try {
    return await handler(ctx, args ?? {});
  } catch (e) {
    if (e instanceof ToolError) return fail(e.code, e.message, e.extra);
    console.error(`[tool:${name}]`, e);
    return fail("INTERNAL_ERROR", "Something went wrong on our side. Apologize briefly, and offer to try again or have the front desk call them.");
  }
}
