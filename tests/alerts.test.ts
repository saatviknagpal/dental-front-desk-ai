import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { PRACTICES, withPractice } from "@/lib/practice";
import { processJobs } from "@/lib/queue";
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
    // The full summary is still stored for the dashboard.
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
