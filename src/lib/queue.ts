// Background jobs on Postgres (transactional outbox).
//
// enqueue() runs inside the same transaction as the write that caused it (e.g. an
// emergency booking), so a job exists if and only if that write committed. Workers
// claim jobs with FOR UPDATE SKIP LOCKED, so any number of app instances can run a
// worker without double-processing. Failed jobs retry with exponential backoff.

import { db, type Q } from "./db";
import { notifyStaffWebhook } from "./notify";

export type JobType = "staff_alert";

export interface Job {
  id: number;
  type: JobType;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

type Handler = (payload: Record<string, unknown>) => Promise<void>;

const HANDLERS: Record<JobType, Handler> = {
  // Throws on failure so the job is retried.
  staff_alert: (p) => notifyStaffWebhook({ type: String(p.type), urgency: String(p.urgency), text: String(p.text) }),
};

export async function enqueue(q: Q, type: JobType, payload: Record<string, unknown>): Promise<void> {
  await q.run("INSERT INTO jobs (type, payload) VALUES ($1, $2)", [type, JSON.stringify(payload)]);
}

/** Claim and run up to `limit` due jobs. Returns how many were processed. */
export async function processJobs(limit = 10, handlers: Record<string, Handler> = HANDLERS): Promise<number> {
  const jobs = await db.all<Job>(
    `UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_at = now()
     WHERE id IN (SELECT id FROM jobs WHERE status = 'pending' AND run_at <= now() ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
     RETURNING id, type, payload, attempts, max_attempts`,
    [limit],
  );
  for (const job of jobs) {
    try {
      await handlers[job.type](job.payload);
      await db.run("UPDATE jobs SET status = 'done', finished_at = now(), last_error = NULL WHERE id = $1", [job.id]);
    } catch (err) {
      const giveUp = job.attempts >= job.max_attempts;
      await db.run(
        `UPDATE jobs SET status = $2, last_error = $3, run_at = now() + ($4 || ' seconds')::interval WHERE id = $1`,
        [job.id, giveUp ? "failed" : "pending", (err as Error).message.slice(0, 500), String(2 ** job.attempts * 5)],
      );
    }
  }
  return jobs.length;
}

/** Jobs stuck in 'running' (worker crashed mid-job) go back to pending after 5 minutes. */
export async function requeueStuckJobs(): Promise<void> {
  await db.run("UPDATE jobs SET status = 'pending' WHERE status = 'running' AND locked_at < now() - interval '5 minutes'");
}

let started = false;

/** Poll for jobs every few seconds in this process. Safe to run in every instance. */
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
