import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { PRACTICES, withPractice } from "@/lib/practice";
import { processJobs, queueQualityChecks } from "@/lib/queue";
import { seed } from "@/lib/seed";
import { executeTool, type ToolContext } from "@/lib/tools";

const [brightSmile, harbor] = PRACTICES;
const ctx = (): ToolContext => ({ sessionId: "t", verified: [], household: [], failedVerifications: 0 });

beforeEach(async () => {
  await seed({ reset: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("quality check queue", () => {
  it("queues each ungraded finished chat once, skipping graded and one-message chats", async () => {
    const mk = async (id: string, userMsgs: number, judged = false) => {
      await db.run("INSERT INTO sessions (id, started_at, last_active_at, practice_id, judge) VALUES ($1, 'x', 'x', $2, $3)", [id, brightSmile.id, judged ? '{"pass":true}' : null]);
      for (let i = 0; i < userMsgs; i++) await db.run("INSERT INTO messages (session_id, role, content, created_at) VALUES ($1, 'user', 'hi', 'x')", [id]);
    };
    await mk("two-turns", 2);
    await mk("one-turn", 1);
    await mk("graded", 3, true);
    expect(await withPractice(brightSmile, () => queueQualityChecks())).toBe(1);
    expect(await withPractice(brightSmile, () => queueQualityChecks())).toBe(0);
    expect(await withPractice(harbor, () => queueQualityChecks())).toBe(0);
    const job = await db.get<{ payload: { session_id: string; practice: string } }>("SELECT payload FROM jobs WHERE type = 'quality_check'");
    expect(job?.payload).toEqual({ session_id: "two-turns", practice: "bright-smile" });
  });
});

describe("staff alerts", () => {
  it("go to the practice's own channel and carry no patient details", async () => {
    vi.stubEnv("STAFF_WEBHOOKS", JSON.stringify({ "bright-smile": "https://hooks.test/bright", "harbor-family": "https://hooks.test/harbor" }));
    vi.stubEnv("APP_URL", "https://app.test");
    const sent: { url: string; body: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => (sent.push({ url, body: String(init.body) }), new Response("ok"))));

    const summary = "Maria Lopez, cracked molar, pain 9/10, callback 6175550123";
    await withPractice(harbor, () => executeTool(ctx(), "notify_staff", { type: "emergency", urgency: "high", summary }));
    await withPractice(harbor, () => processJobs());

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://hooks.test/harbor");
    const { text } = JSON.parse(sent[0].body);
    expect(text).toBe(`URGENT: New emergency at ${harbor.name}. Details on the front desk dashboard: https://app.test/staff?practice=harbor-family`);
    expect(text).not.toMatch(/Maria|molar|6175550123/);
    expect((await db.get<{ summary: string }>("SELECT summary FROM notifications ORDER BY id DESC LIMIT 1"))?.summary).toBe(summary);
  });

  it("sends nothing when the practice has no channel configured", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await withPractice(brightSmile, () => executeTool(ctx(), "notify_staff", { type: "human_handoff", urgency: "normal", summary: "Billing question" }));
    await withPractice(brightSmile, () => processJobs());
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
