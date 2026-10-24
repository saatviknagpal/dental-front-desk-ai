import { afterEach, describe, expect, it, vi } from "vitest";

const flagged = vi.fn();
vi.mock("openai", () => ({
  default: class {
    moderations = { create: async () => ({ results: [flagged()] }) };
  },
}));

const { moderateInput } = await import("@/lib/guardrails");
const result = (...cats: string[]) => ({ flagged: true, categories: Object.fromEntries(cats.map((c) => [c, true])) });

afterEach(() => vi.unstubAllEnvs());

describe("input moderation", () => {
  it("lets dental injuries through even though they are flagged as violence", async () => {
    vi.stubEnv("OPENAI_API_KEY", "k");
    flagged.mockReturnValue(result("violence"));
    expect(await moderateInput("I knocked out part of my front tooth")).toEqual({ ok: true });
  });

  it("still stops threats", async () => {
    vi.stubEnv("OPENAI_API_KEY", "k");
    flagged.mockReturnValue(result("harassment", "harassment/threatening", "violence"));
    expect(await moderateInput("I'm going to hurt your receptionist")).toMatchObject({ ok: false, reason: "abuse" });
  });
});
