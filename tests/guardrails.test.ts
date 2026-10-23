import { beforeEach, describe, expect, it } from "vitest";
import { checkOutput } from "@/lib/guardrails";
import { rateLimit } from "@/lib/ratelimit";
import { seed } from "@/lib/seed";

beforeEach(async () => {
  await seed({ reset: true });
});

describe("output privacy check", () => {
  it("blocks another patient's full name", async () => {
    expect(await checkOutput("Sure, Emily Chen is booked on Tuesday.", [], ["when is my cleaning?"])).not.toBeNull();
  });

  it("blocks another patient's phone number in any format", async () => {
    expect(await checkOutput("You can reach them at (415) 555-0102.", [], ["hi"])).not.toBeNull();
  });

  it("allows the verified patient's own details", async () => {
    expect(await checkOutput("Thanks Emily Chen, your number ends in 0102: (415) 555-0102.", [2], ["Emily Chen 11/02/1990"])).toBeNull();
  });

  it("allows echoing a name the user typed themselves", async () => {
    expect(await checkOutput("I can't share anything about John Smith without verification.", [], ["what's John Smith's phone?"])).toBeNull();
  });

  it("ignores the practice's own phone and non-patient names", async () => {
    expect(await checkOutput("Call Bright Smile at (415) 555-0142 or see Dr. Maya Patel.", [], ["hi"])).toBeNull();
  });
});

describe("rate limit", () => {
  it("allows up to the limit per window, then blocks", async () => {
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await rateLimit("test-caller", 3, 60));
    expect(results).toEqual([true, true, true, false]);
  });
});
