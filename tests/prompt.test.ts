import { describe, expect, it } from "vitest";
import { systemDynamic } from "@/lib/prompt";
import { parseTs } from "@/lib/time";

describe("date phrases in the prompt", () => {
  it("maps weekday names to the right dates (today is Friday 2026-10-23)", () => {
    const p = systemDynamic(parseTs("2026-10-23 10:00"));
    expect(p).toContain('"Tuesday" / "this Tuesday": 2026-10-27; "next Tuesday": 2026-10-27');
    expect(p).toContain('"Friday" / "this Friday": 2026-10-23; "next Friday": 2026-10-30');
    expect(p).toContain('"Saturday" / "this Saturday": 2026-10-24; "next Saturday": 2026-10-31');
  });
});
