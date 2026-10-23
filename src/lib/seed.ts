// Demo data: providers, patients, 30-minute slots for the next 8 weeks, and a
// few existing appointments. Everything is relative to "today" so the demo
// always has availability. Deterministic (seeded RNG) so evals are repeatable.

import { db, transaction, truncateAll, type Q } from "./db";
import { APPOINTMENT_TYPES, BOOKING_HORIZON_DAYS, CLOSE_HOUR, OPEN_HOUR, OPEN_WEEKDAYS, SLOT_MINUTES, type AppointmentType } from "./practice";
import { addDays, addMinutes, fmtTs, parseTs, practiceNow, startOfDay, weekday } from "./time";

// id, name, title, services, practice_id
export const PROVIDERS: [number, string, string, string, number][] = [
  [1, "Dr. Maya Patel", "DDS, General Dentist", "checkup,emergency,cleaning", 1],
  [2, "Dr. James Okafor", "DDS, General Dentist", "checkup,emergency", 1],
  [3, "Lena Torres", "RDH, Dental Hygienist", "cleaning", 1],
  [4, "Sam Rivera", "RDH, Dental Hygienist", "cleaning", 1],
  [5, "Dr. Priya Raman", "DDS, General Dentist", "checkup,emergency,cleaning", 2],
  [6, "Dr. Owen Walsh", "DDS, General Dentist", "checkup,emergency", 2],
  [7, "Kim Nguyen", "RDH, Dental Hygienist", "cleaning", 2],
];

// id, first, last, dob, phone, insurance (null = self-pay), household_id, practice_id
export const PATIENTS: [number, string, string, string, string, string | null, number, number][] = [
  [1, "John", "Smith", "1985-06-14", "4155550101", "Delta Dental", 1, 1],
  [2, "Emily", "Chen", "1990-11-02", "4155550102", "Cigna", 2, 1],
  [3, "David", "Kim", "1978-01-23", "4155550103", "MetLife", 3, 1],
  [4, "Maria", "Garcia", "1987-04-09", "4155550104", "Aetna", 4, 1],
  [5, "Carlos", "Garcia", "1985-08-30", "4155550105", "Aetna", 4, 1],
  [6, "Sofia", "Garcia", "2017-02-15", "4155550104", "Aetna", 4, 1],
  [7, "Mateo", "Garcia", "2020-07-04", "4155550104", "Aetna", 4, 1],
  [8, "Robert", "Brown", "1960-09-12", "4155550106", null, 8, 1],
  [9, "Ana", "Lopez", "1992-03-03", "6175550111", "Delta Dental", 9, 2],
  [10, "Tom", "Becker", "1975-12-01", "6175550112", null, 10, 2],
];

// patient_id, type, days from today, earliest hour
const EXISTING_APPOINTMENTS: [number, AppointmentType, number, number][] = [
  [1, "checkup", 10, 10],
  [2, "cleaning", 4, 14],
  [3, "checkup", 6, 9],
  [8, "cleaning", 12, 11],
  [9, "checkup", 5, 9],
];

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let seededCache = false;

export async function isSeeded(): Promise<boolean> {
  return !!(await db.get("SELECT 1 AS x FROM providers LIMIT 1"));
}

/** Seed once per process if the DB is empty (cheap after the first call). */
export async function ensureSeeded(): Promise<void> {
  if (seededCache) return;
  if (!(await isSeeded())) await seed();
  seededCache = true;
}

/** Multi-row INSERT in chunks (keeps parameter count under Postgres limits). */
async function bulkInsert(tx: Q, table: string, columns: string[], rows: unknown[][], chunk = 500) {
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const values = part.map((_, r) => `(${columns.map((__, c) => `$${r * columns.length + c + 1}`).join(",")})`).join(",");
    await tx.run(`INSERT INTO ${table} (${columns.join(",")}) VALUES ${values}`, part.flat());
  }
}

export async function seed({ reset = false, rngSeed = 42 } = {}): Promise<void> {
  if (reset) {
    await truncateAll();
    seededCache = false;
  } else if (await isSeeded()) {
    return;
  }

  const random = rng(rngSeed);
  const today = startOfDay(practiceNow());
  const created = fmtTs(practiceNow());

  // Mon-Sat 8:00-18:00. Lunch (12-1) blocked. ~30% of other hours blocked in
  // 1-hour chunks to simulate other patients' bookings.
  const slotRows: unknown[][] = [];
  for (let d = 0; d < BOOKING_HORIZON_DAYS; d++) {
    const day = addDays(today, d);
    if (!OPEN_WEEKDAYS.has(weekday(day))) continue;
    for (const [providerId] of PROVIDERS) {
      const busy = new Set<number>();
      for (let h = OPEN_HOUR; h < CLOSE_HOUR; h++) if (h !== 12 && random() < 0.3) busy.add(h);
      for (let t = addMinutes(day, OPEN_HOUR * 60); t < addMinutes(day, CLOSE_HOUR * 60); t = addMinutes(t, SLOT_MINUTES)) {
        const h = t.getUTCHours();
        slotRows.push([providerId, fmtTs(t), h === 12 || busy.has(h) ? "blocked" : "open"]);
      }
    }
  }

  await transaction(async (tx) => {
    await bulkInsert(tx, "providers", ["id", "name", "title", "services", "practice_id"], PROVIDERS);
    await bulkInsert(
      tx,
      "patients",
      ["id", "first_name", "last_name", "dob", "phone", "insurance_name", "household_id", "practice_id", "created_at"],
      PATIENTS.map((p) => [...p, created]),
    );
    // Explicit ids above: move the identity sequence past them.
    await tx.run("SELECT setval(pg_get_serial_sequence('patients', 'id'), (SELECT max(id) FROM patients))");
    await bulkInsert(tx, "slots", ["provider_id", "start_ts", "status"], slotRows);
    for (const [patientId, type, dayOffset, hour] of EXISTING_APPOINTMENTS) {
      await seedAppointment(tx, patientId, type, addMinutes(addDays(today, dayOffset), hour * 60), created);
    }
  });
  seededCache = true;
}

async function seedAppointment(tx: Q, patientId: number, type: AppointmentType, earliest: Date, created: string) {
  const { minutes } = APPOINTMENT_TYPES[type];
  const n = minutes / SLOT_MINUTES;
  // Most specialized provider first (hygienists for cleanings).
  const practiceId = PATIENTS.find((p) => p[0] === patientId)![7];
  const capable = PROVIDERS.filter((p) => p[4] === practiceId && p[3].split(",").includes(type))
    .sort((a, b) => a[3].split(",").length - b[3].split(",").length)
    .map((p) => p[0]);
  const open = await tx.all<{ provider_id: number; start_ts: string }>(
    "SELECT provider_id, start_ts FROM slots WHERE status = 'open' AND start_ts >= $1 ORDER BY start_ts, provider_id",
    [fmtTs(earliest)],
  );
  const openSet = new Set(open.map((r) => `${r.provider_id}|${r.start_ts}`));
  const starts = [...new Set(open.map((r) => r.start_ts))];
  for (const ts of starts) {
    const start = parseTs(ts)!;
    const needed = Array.from({ length: n }, (_, i) => fmtTs(addMinutes(start, i * SLOT_MINUTES)));
    const providerId = capable.find((id) => needed.every((t) => openSet.has(`${id}|${t}`)));
    if (providerId === undefined) continue;
    const r = { provider_id: providerId };
    const appt = await tx.get<{ id: number }>(
      `INSERT INTO appointments (patient_id, provider_id, type, start_ts, end_ts, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'booked',$6,$6) RETURNING id`,
      [patientId, r.provider_id, type, needed[0], fmtTs(addMinutes(start, minutes)), created],
    );
    await tx.run("UPDATE slots SET status = 'booked', appointment_id = $1 WHERE provider_id = $2 AND start_ts = ANY($3)", [appt!.id, r.provider_id, needed]);
    return;
  }
  throw new Error(`could not seed appointment for patient ${patientId}`);
}
