// Load test against the configured database (DATABASE_URL) and a running server.
//
//   npm run loadtest                         # 50 bookings race for one slot + 20 chats at once
//   npm run loadtest -- --bookers=100 --chats=0
//   npm run loadtest -- --url=https://your-app.onrender.com
//   npm run loadtest -- --keep              # race for a slot next week and keep the winner (shows on /staff)
//
// Part 1 calls the booking tool directly (no LLM) with N different patients for the same
// slot, then cleans up after itself (with --keep, the winning booking and its patient stay). Part 2 sends N chats to /api/chat at once and reports
// latency; those chats call the LLM (about $0.002 each) and show up on /staff.

import "dotenv/config";

process.env.DATABASE_POOL_MAX ||= "10";

import { closeDb, db } from "@/lib/db";
import { PRACTICES, withPractice } from "@/lib/practice";
import { ensureSeeded } from "@/lib/seed";
import { appointmentRange } from "@/lib/staff";
import { addDays, fmtDate, practiceNow, startOfDay } from "@/lib/time";
import { executeTool, type ToolContext } from "@/lib/tools";

const arg = (name: string, fallback: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const BOOKERS = Number(arg("bookers", "50"));
const CHATS = Number(arg("chats", "20"));
const URL_BASE = arg("url", "http://localhost:3000");
const KEEP = process.argv.includes("--keep");

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] ?? 0;
const ctxFor = (i: number): ToolContext => ({ sessionId: `loadtest-${i}`, verified: [], household: [], failedVerifications: 0, caller: `loadtest-${i}` });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tool = (ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<any> => executeTool(ctx, name, args);

async function bookingRace(): Promise<boolean> {
  console.log(`\n1) Booking race: ${BOOKERS} patients book the same slot at the same moment`);
  const letters = (n: number) => n.toString(26).replace(/./g, (c) => String.fromCharCode(97 + parseInt(c, 26)));
  const runId = letters(Date.now() % 1e9);
  const ctxs = Array.from({ length: BOOKERS }, (_, i) => ctxFor(i));
  const patientIds: number[] = [];
  let keptPatient: number | null = null;
  try {
    for (let i = 0; i < BOOKERS; i++) {
      const r = await tool(ctxs[i], "register_patient", { first_name: "Loadtest", last_name: `${runId}${letters(i)}`, date_of_birth: "1990-01-01", phone: `415556${String(i).padStart(4, "0")}` });
      if (!r.ok) throw new Error(`register failed: ${r.error}`);
      patientIds.push(r.patient.patient_id);
    }
    const today = startOfDay(practiceNow());
    const [from, to] = KEEP ? appointmentRange("next_week", today) : [addDays(today, 35), addDays(today, 49)];
    const found = await tool(ctxs[0], "find_available_slots", { appointment_type: "checkup", date_from: fmtDate(from), date_to: fmtDate(addDays(to, -1)) });
    const slot = found.slots?.[0];
    if (!slot) throw new Error("no open checkup slot found to race for");
    console.log(`   slot: ${slot.display} with ${slot.provider_name}`);

    const t0 = Date.now();
    const results = await Promise.all(
      ctxs.map((c, i) => tool(c, "book_appointment", { patient_id: patientIds[i], appointment_type: "checkup", start_time: slot.start_time, provider_id: slot.provider_id })),
    );
    const ms = Date.now() - t0;
    const winners = results.filter((r) => r.ok);
    const taken = results.filter((r) => r.error === "SLOT_TAKEN");
    const other = results.filter((r) => !r.ok && r.error !== "SLOT_TAKEN");
    const rows = await db.get<{ n: number }>(
      "SELECT count(*)::int AS n FROM appointments WHERE provider_id = $1 AND start_ts = $2 AND status = 'booked'",
      [slot.provider_id, slot.start_time],
    );
    const alternativesOffered = taken.every((r) => (r.alternatives?.length ?? 0) > 0);

    console.log(`   finished in ${ms} ms`);
    console.log(`   booked: ${winners.length} · told "slot taken": ${taken.length} · other errors: ${other.length}${other.length ? ` (${[...new Set(other.map((r) => r.error))].join(", ")})` : ""}`);
    console.log(`   appointments in the database for that slot: ${rows?.n}`);
    console.log(`   every loser was offered other times: ${alternativesOffered ? "yes" : "no"}`);

    if (winners[0]) {
      const winner = results.indexOf(winners[0]);
      if (KEEP) {
        keptPatient = patientIds[winner];
        console.log(`   kept: ${winners[0].appointment.patient_name}, ${winners[0].appointment.display} (see /staff, "Next week")`);
      } else {
        await tool(ctxs[winner], "cancel_appointment", { patient_id: patientIds[winner], appointment_id: winners[0].appointment.appointment_id });
      }
    }
    const ok = winners.length === 1 && rows?.n === 1 && taken.length === BOOKERS - 1 && alternativesOffered;
    console.log(`   result: ${ok ? "PASS (exactly one booking, no double booking)" : "FAIL"}`);
    return ok;
  } finally {
    if (patientIds.length) {
      const drop = patientIds.filter((id) => id !== keptPatient);
      await db.run("DELETE FROM appointments WHERE patient_id = ANY($1)", [drop]);
      await db.run("DELETE FROM patients WHERE id = ANY($1)", [drop]);
      console.log(`   cleaned up ${drop.length} test patients`);
    }
  }
}

async function chatBurst(): Promise<boolean> {
  if (!CHATS) return true;
  console.log(`\n2) Chat burst: ${CHATS} chats sent to ${URL_BASE}/api/chat at once`);
  const t0 = Date.now();
  const results = await Promise.all(
    Array.from({ length: CHATS }, async (_, i) => {
      const start = Date.now();
      try {
        const res = await fetch(`${URL_BASE}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Forwarded-For": `10.0.${Math.floor(i / 250)}.${i % 250}` },
          body: JSON.stringify({ message: "What are your hours on Saturday?", practice: PRACTICES[0].slug, requestId: `loadtest-${Date.now()}-${i}` }),
        });
        const body = res.ok ? await res.json().catch(() => ({})) : {};
        return { status: res.status, ms: Date.now() - start, sessionId: body.sessionId as string | undefined };
      } catch {
        return { status: 0, ms: Date.now() - start, sessionId: undefined };
      }
    }),
  );
  const ms = results.filter((r) => r.status === 200).map((r) => r.ms);
  const byStatus = results.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.status || "network error"]: (acc[r.status || "network error"] ?? 0) + 1 }), {});
  console.log(`   all done in ${Date.now() - t0} ms`);
  console.log(`   responses: ${Object.entries(byStatus).map(([s, n]) => `${s} x${n}`).join(", ")}`);
  if (ms.length) console.log(`   reply time: P50 ${(pct(ms, 50) / 1000).toFixed(1)}s · P95 ${(pct(ms, 95) / 1000).toFixed(1)}s · max ${(Math.max(...ms) / 1000).toFixed(1)}s`);
  const ok = ms.length === CHATS;
  console.log(`   result: ${ok ? "PASS (every chat answered)" : "FAIL"}`);
  const ids = results.map((r) => r.sessionId).filter((id): id is string => !!id);
  await db.run("DELETE FROM messages WHERE session_id = ANY($1)", [ids]);
  await db.run("DELETE FROM sessions WHERE id = ANY($1)", [ids]);
  console.log(`   cleaned up ${ids.length} test chats`);
  return ok;
}

(async () => {
  await ensureSeeded();
  const race = await withPractice(PRACTICES[0], bookingRace);
  const burst = await chatBurst();
  await closeDb();
  process.exit(race && burst ? 0 : 1);
})().catch(async (err) => {
  console.error(err);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
