import { describe, expect, it } from "vitest";
import { appointmentRange } from "@/lib/staff";
import { fmtDate, parseTs } from "@/lib/time";

const days = (r: Parameters<typeof appointmentRange>[0], today: string) => appointmentRange(r, parseTs(`${today} 00:00`)!).map(fmtDate);

describe("staff appointment ranges", () => {
  it("covers today, the rest of this week, next week and three weeks", () => {
    // 2026-10-23 is a Friday
    expect(days("today", "2026-10-23")).toEqual(["2026-10-23", "2026-10-24"]);
    expect(days("this_week", "2026-10-23")).toEqual(["2026-10-23", "2026-10-26"]);
    expect(days("next_week", "2026-10-23")).toEqual(["2026-10-26", "2026-11-02"]);
    expect(days("3_weeks", "2026-10-23")).toEqual(["2026-10-23", "2026-11-13"]);
  });

  it("treats Monday as the start of a new week and Sunday as the end of one", () => {
    expect(days("this_week", "2026-10-26")).toEqual(["2026-10-26", "2026-11-02"]);
    expect(days("next_week", "2026-10-25")).toEqual(["2026-10-26", "2026-11-02"]);
  });
});
