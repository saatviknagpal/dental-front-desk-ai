import { beforeEach, describe, expect, it } from "vitest";
import { seed } from "@/lib/seed";
import { askedWeekday, executeTool, type ToolContext } from "@/lib/tools";


beforeEach(async () => {
  await seed({ reset: true });
});

describe("weekday the patient asked for", () => {
  it("reads the latest message that names one day", () => {
    expect(askedWeekday(["Can I get a cleaning next Tuesday morning?", "Priya Raman, 3/12/1992, no insurance"])).toBe(2);
    expect(askedWeekday(["Tuesday please", "actually Thursday works better"])).toBe(4);
  });

  it("stays out of it when the patient names several days or rules one out", () => {
    expect(askedWeekday(["Monday or Tuesday"])).toBeUndefined();
    expect(askedWeekday(["I can't do Tuesday"])).toBeUndefined();
    expect(askedWeekday(["any day next week"])).toBeUndefined();
  });

  it("warns when the model searches a day that isn't the one asked for", async () => {
    const ctx: ToolContext = { sessionId: "t", verified: [], household: [], failedVerifications: 0, userTexts: ["cleaning next Tuesday morning?"] };
    const wrong = (await executeTool(ctx, "find_available_slots", { appointment_type: "cleaning", date_from: "2026-10-26", date_to: "2026-10-26" })) as { warning?: string };
    expect(wrong.warning).toMatch(/Tuesday.*2026-10-27/);
    const right = (await executeTool(ctx, "find_available_slots", { appointment_type: "cleaning", date_from: "2026-10-27", date_to: "2026-10-27" })) as { warning?: string };
    expect(right.warning).toBeUndefined();
  });
});
