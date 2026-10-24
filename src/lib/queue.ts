// Background jobs on Postgres (transactional outbox).
//
// enqueue() runs inside the same transaction as the write that caused it (e.g. an
// emergency booking), so a job exists if and only if that write committed. Workers
// claim jobs with FOR UPDATE SKIP LOCKED, so any number of app instances can run a
// worker without double-processing. Failed jobs retry with exponential backoff.

import { db, type Q } from "./db";
import { sendConfirmationEmail, type ConfirmationPayload } from "./email";
import { judgeSession } from "./judge";
import { notifyStaffWebhook } from "./notify";
import { currentPractice, practiceBySlug, PRACTICES, withPractice } from "./practice";

export type JobType = "staff_alert" | "booking_confirmation" | "quality_check";

export interface Job {
  id: number;
  type: JobType;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

type Handler = (payload: Record<string, unknown>) => Promise<void>;

export class PermanentJobError extends Error {}

const HANDLERS: Record<JobType, Handler> = {
  staff_alert: (p) => notifyStaffWebhook({ practice: String(p.practice), text: String(p.text) }),
  booking_confirmation: (p) => sendConfirmationEmail(p as unknown as ConfirmationPayload),
  quality_check: async (p) => {
    const practice = practiceBySlug(String(p.practice)) ?? PRACTICES[0];
    const verdict = await withPractice(practice, () => judgeSession(String(p.session_id)));
    await db.run("UPDATE sessions SET judge = $1 WHERE id = $2", [JSON.stringify(verdict), String(p.session_id)]);
  },
};

export async function queueQualityChecks(limit = 50): Promise<number> {
  const practice = currentPractice();
  const sessions = await db.all<{ id: string }>(
    `SELECT s.id FROM sessions s
     WHERE s.practice_id = $1 AND s.judge IS NULL
       AND (SELECT count(*) FROM messages m WHERE m.session_id = s.id AND m.role = 'user') >= 2
       AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.type = 'quality_check' AND j.status IN ('pending', 'running') AND j.payload->>'session_id' = s.id)
     ORDER BY s.last_active_at DESC LIMIT $2`,
    [practice.id, limit],
  );
  for (const s of sessions) await enqueue(db, "quality_check", { session_id: s.id, practice: practice.slug });
  return sessions.length;
}

export async function enqueue(q: Q, type: JobType, payload: Record<string, unknown>): Promise<void> {
  await q.run("INSERT INTO jobs (type, payload, practice_id) VALUES ($1, $2, $3)", [type, JSON.stringify(payload), currentPractice().id]);
}

export async function processJobs(limit = 10, handlers: Record<string, Handler> = HANDLERS): Promise<number> {
  const jobs = await db.all<Job>(
    `UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_at = now()
     WHERE id IN (SELECT id FROM jobs WHERE status = 'pending' AND run_at <= now() AND type = ANY($2) ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
     RETURNING id, type, payload, attempts, max_attempts`,
    [limit, Object.keys(handlers)],
  );
  for (const job of jobs) {
    try {
      await handlers[job.type](job.payload);
      await db.run("UPDATE jobs SET status = 'done', finished_at = now(), last_error = NULL WHERE id = $1", [job.id]);
    } catch (err) {
      const giveUp = err instanceof PermanentJobError || job.attempts >= job.max_attempts;
      await db.run(
        `UPDATE jobs SET status = $2, last_error = $3, run_at = now() + ($4 || ' seconds')::interval WHERE id = $1`,
        [job.id, giveUp ? "failed" : "pending", (err as Error).message.slice(0, 500), String(2 ** job.attempts * 5)],
      );
    }
  }
  return jobs.length;
}

export async function requeueStuckJobs(): Promise<void> {
  await db.run("UPDATE jobs SET status = 'pending' WHERE status = 'running' AND locked_at < now() - interval '5 minutes'");
  await db.run("DELETE FROM jobs WHERE status = 'done' AND finished_at < now() - interval '7 days'");
  await db.run("DELETE FROM chat_requests WHERE created_at < now() - interval '1 day'");
}

let started = false;

export function startWorker(intervalMs = 3000): void {
  if (started) return;
  started = true;
  const tick = async () => {
    try {
      await requeueStuckJobs();
      while ((await processJobs()) > 0);
    } catch (err) {
      console.error("[queue] worker tick failed:", (err as Error).message);
    }
    setTimeout(tick, intervalMs).unref();
  };
  setTimeout(tick, intervalMs).unref();
}
