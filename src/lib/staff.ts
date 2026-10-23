// Read models for the staff dashboard.

import { db } from "./db";
import { APPOINTMENT_TYPES, type AppointmentType } from "./practice";
import { addDays, fmtTs, humanTs, parseTs, practiceNow, startOfDay } from "./time";

export async function dashboard() {
  const now = practiceNow();
  const today = startOfDay(now);

  const notifications = await db.all<Record<string, unknown>>(
    `SELECT n.*, p.first_name || ' ' || p.last_name AS patient_name, p.phone AS patient_phone
     FROM notifications n LEFT JOIN patients p ON p.id = n.patient_id
     ORDER BY n.acknowledged ASC, CASE n.urgency WHEN 'high' THEN 0 ELSE 1 END, n.id DESC LIMIT 50`,
  );

  const appointments = (
    await db.all<{ type: AppointmentType; start_ts: string; session_id: string | null; [k: string]: unknown }>(
      `SELECT a.id, a.type, a.start_ts, a.status, a.emergency_summary, a.notes, a.session_id, a.updated_at,
              p.first_name || ' ' || p.last_name AS patient_name, p.insurance_name, pr.name AS provider_name
       FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN providers pr ON pr.id = a.provider_id
       WHERE a.start_ts >= $1 AND a.start_ts < $2
       ORDER BY a.start_ts LIMIT 200`,
      [fmtTs(today), fmtTs(addDays(today, 21))],
    )
  ).map((a) => ({ ...a, label: APPOINTMENT_TYPES[a.type].label, display: humanTs(parseTs(a.start_ts)!), via_chat: !!a.session_id }));

  const sessions = await db.all<Record<string, unknown>>(
    `SELECT s.id, s.started_at, s.last_active_at, s.model, s.rating, s.feedback_comment, s.judge, s.usage,
            (SELECT count(*)::int FROM messages m WHERE m.session_id = s.id AND m.role = 'user') AS user_messages,
            (SELECT content FROM messages m WHERE m.session_id = s.id AND m.role = 'user' ORDER BY m.id LIMIT 1) AS first_message,
            (SELECT count(*)::int FROM messages m WHERE m.session_id = s.id AND m.role = 'tool' AND m.content LIKE '%"ok":false%') AS tool_errors
     FROM sessions s ORDER BY s.last_active_at DESC LIMIT 40`,
  );

  const stats = await db.get<{ conversations: number; up: number; down: number; chat_bookings: number; total_cost: number }>(
    `SELECT (SELECT count(*)::int FROM sessions) AS conversations,
            (SELECT coalesce(sum((usage->>'costUsd')::float), 0) FROM sessions) AS total_cost,
            (SELECT count(*)::int FROM sessions WHERE rating = 1) AS up,
            (SELECT count(*)::int FROM sessions WHERE rating = -1) AS down,
            (SELECT count(*)::int FROM appointments WHERE session_id IS NOT NULL AND status = 'booked') AS chat_bookings`,
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
    sessions,
  };
}

export function transcript(sessionId: string) {
  return db.all<{ id: number; role: string; content: string; created_at: string }>(
    "SELECT id, role, content, created_at FROM messages WHERE session_id = $1 ORDER BY id",
    [sessionId],
  );
}
