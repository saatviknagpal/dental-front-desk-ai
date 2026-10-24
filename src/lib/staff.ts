// Read models for the staff dashboard.

import { db } from "./db";
import { APPOINTMENT_TYPES, type AppointmentType } from "./practice";
import { addDays, fmtTs, humanTs, parseTs, practiceNow, startOfDay, weekday } from "./time";

export const APPOINTMENT_RANGES = ["today", "this_week", "next_week", "3_weeks"] as const;
export type AppointmentRange = (typeof APPOINTMENT_RANGES)[number];
const MAX_APPOINTMENTS = 500;
export const SESSIONS_PAGE = 20;

export function appointmentRange(range: AppointmentRange, today: Date): [Date, Date] {
  const nextMon = addDays(today, (8 - weekday(today)) % 7 || 7);
  if (range === "today") return [today, addDays(today, 1)];
  if (range === "this_week") return [today, nextMon];
  if (range === "next_week") return [nextMon, addDays(nextMon, 7)];
  return [today, addDays(today, 21)];
}

export async function dashboard(practiceId: number, opts: { range?: AppointmentRange; sessionsLimit?: number } = {}) {
  const range = opts.range ?? "this_week";
  const sessionsLimit = Math.min(Math.max(opts.sessionsLimit ?? SESSIONS_PAGE, 1), 500);
  const now = practiceNow();
  const today = startOfDay(now);

  const notifications = await db.all<Record<string, unknown>>(
    `SELECT n.*, p.first_name || ' ' || p.last_name AS patient_name, p.phone AS patient_phone
     FROM notifications n LEFT JOIN patients p ON p.id = n.patient_id
     WHERE n.practice_id = $1
     ORDER BY n.acknowledged ASC, CASE n.urgency WHEN 'high' THEN 0 ELSE 1 END, n.id DESC LIMIT 50`,
    [practiceId],
  );

  const [from, to] = appointmentRange(range, today);
  const apptRows = (
    await db.all<{ type: AppointmentType; start_ts: string; session_id: string | null; [k: string]: unknown }>(
      `SELECT a.id, a.type, a.start_ts, a.status, a.emergency_summary, a.notes, a.session_id, a.updated_at,
              p.first_name || ' ' || p.last_name AS patient_name, p.insurance_name, p.insurance_member_id, p.insurance_subscriber, pr.name AS provider_name
       FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN providers pr ON pr.id = a.provider_id
       WHERE a.start_ts >= $1 AND a.start_ts < $2 AND p.practice_id = $3
       ORDER BY a.start_ts LIMIT ${MAX_APPOINTMENTS + 1}`,
      [fmtTs(from), fmtTs(to), practiceId],
    )
  ).map((a) => ({ ...a, label: APPOINTMENT_TYPES[a.type].label, display: humanTs(parseTs(a.start_ts)!), via_chat: !!a.session_id }));

  const appointments = apptRows.slice(0, MAX_APPOINTMENTS);

  const sessionRows = await db.all<Record<string, unknown>>(
    `SELECT s.id, s.started_at, s.last_active_at, s.model, s.rating, s.feedback_comment, s.judge, s.usage,
            (SELECT count(*)::int FROM messages m WHERE m.session_id = s.id AND m.role = 'user') AS user_messages,
            (SELECT content FROM messages m WHERE m.session_id = s.id AND m.role = 'user' ORDER BY m.id LIMIT 1) AS first_message,
            (SELECT count(*)::int FROM messages m WHERE m.session_id = s.id AND m.role = 'tool' AND m.content LIKE '%"ok":false%') AS tool_errors
     FROM sessions s WHERE s.practice_id = $1 ORDER BY s.last_active_at DESC, s.id LIMIT $2`,
    [practiceId, sessionsLimit + 1],
  );

  const failedJobs = await db.all<Record<string, unknown>>(
    `SELECT id, type, attempts, last_error, created_at, payload->>'to' AS to, payload->>'text' AS text
     FROM jobs WHERE practice_id = $1 AND status = 'failed' AND type IN ('staff_alert', 'booking_confirmation') ORDER BY id DESC LIMIT 20`,
    [practiceId],
  );

  const stats = await db.get<{ conversations: number; up: number; down: number; chat_bookings: number; total_cost: number }>(
    `SELECT (SELECT count(*)::int FROM sessions WHERE practice_id = $1) AS conversations,
            (SELECT coalesce(sum((usage->>'costUsd')::float), 0) FROM sessions WHERE practice_id = $1) AS total_cost,
            (SELECT count(*)::int FROM sessions WHERE practice_id = $1 AND rating = 1) AS up,
            (SELECT count(*)::int FROM sessions WHERE practice_id = $1 AND rating = -1) AS down,
            (SELECT count(*)::int FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE p.practice_id = $1 AND a.session_id IS NOT NULL AND a.status = 'booked') AS chat_bookings`,
    [practiceId],
  );

  return {
    now: fmtTs(now),
    stats: {
      openAlerts: notifications.filter((n) => !n.acknowledged).length,
      conversations: stats?.conversations ?? 0,
      chatBookings: stats?.chat_bookings ?? 0,
      thumbsUp: stats?.up ?? 0,
      thumbsDown: stats?.down ?? 0,
      avgCostUsd: stats?.conversations ? Number(stats.total_cost) / stats.conversations : 0,
    },
    notifications,
    appointments,
    appointmentsView: { range, from: fmtTs(from).slice(0, 10), to: fmtTs(addDays(to, -1)).slice(0, 10), truncated: apptRows.length > MAX_APPOINTMENTS },
    sessions: sessionRows.slice(0, sessionsLimit),
    sessionsHasMore: sessionRows.length > sessionsLimit,
    failedJobs,
  };
}

export function transcript(sessionId: string) {
  return db.all<{ id: number; role: string; content: string; created_at: string }>(
    "SELECT id, role, content, created_at FROM messages WHERE session_id = $1 ORDER BY id",
    [sessionId],
  );
}
