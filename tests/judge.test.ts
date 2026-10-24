import { afterEach, describe, expect, it, vi } from "vitest";

const complete = vi.fn();
vi.mock("@/lib/llm", () => ({ complete: (...a: unknown[]) => complete(...a) }));

const { judgeAvailable, judgeConversation } = await import("@/lib/judge");
const good = { content: '{"tone":5,"clarity":5,"redundancy":0,"hallucination":false,"policy_violations":[],"summary":"ok"}' };
const rows = [{ role: "user", content: "hi" }];

afterEach(() => {
  vi.unstubAllEnvs();
  complete.mockReset();
});

describe("judge fallback", () => {
  it("uses the OpenAI judge when the main judge fails", async () => {
    vi.stubEnv("EVAL_JUDGE_PROVIDER", "gemini");
    vi.stubEnv("GEMINI_API_KEY", "g");
    vi.stubEnv("OPENAI_API_KEY", "o");
    complete.mockRejectedValueOnce(new Error("429 quota")).mockResolvedValueOnce(good);
    const v = await judgeConversation(rows);
    expect(complete.mock.calls.map((c) => `${c[0].provider}:${c[0].model}`)).toEqual(["gemini:gemini-3.6-flash", "openai:gpt-4.1"]);
    expect(v.judge_model).toBe("openai:gpt-4.1");
    expect(v.pass).toBe(true);
  });

  it("goes straight to the fallback when the main judge has no key", async () => {
    vi.stubEnv("EVAL_JUDGE_PROVIDER", "gemini");
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "o");
    complete.mockResolvedValueOnce(good);
    expect(judgeAvailable()).toBe(true);
    expect((await judgeConversation(rows)).judge_model).toBe("openai:gpt-4.1");
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("rethrows when there is no fallback key", async () => {
    vi.stubEnv("EVAL_JUDGE_PROVIDER", "gemini");
    vi.stubEnv("GEMINI_API_KEY", "g");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("LLM_API_KEY", "");
    complete.mockRejectedValueOnce(new Error("429 quota"));
    await expect(judgeConversation(rows)).rejects.toThrow("429");
  });
});
