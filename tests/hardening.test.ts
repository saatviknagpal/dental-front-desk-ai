import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runTurn, SessionBusyError } from "@/lib/agent";
import { db } from "@/lib/db";
import { sendConfirmationEmail } from "@/lib/email";
import { PRACTICES } from "@/lib/practice";
import { PermanentJobError } from "@/lib/queue";
import { seed } from "@/lib/seed";
import { executeTool, type ToolContext } from "@/lib/tools";

const ctx = (caller: string, id = caller): ToolContext => ({ sessionId: id, verified: [], household: [], failedVerifications: 0, caller });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const verify = (c: ToolContext, dob: string): Promise<any> => executeTool(c, "verify_patient", { full_name: "John Smith", date_of_birth: dob });

beforeEach(async () => {
  await seed({ reset: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("verification lockout", () => {
  it("locks the caller who guessed wrong, not everyone else", async () => {
    for (let i = 0; i < 3; i++) await verify(ctx("attacker", `a${i}`), "1985-06-15");
    expect((await verify(ctx("attacker", "a-new"), "1985-06-14")).error).toBe("VERIFICATION_LOCKED");
    expect((await verify(ctx("real-john"), "1985-06-14")).ok).toBe(true);
  });
});

describe("one turn at a time per chat", () => {
  it("rejects a second message while the first is still running", async () => {
    const first = await runTurn(undefined, "hello", "x");
    await db.run("UPDATE sessions SET busy_until = now() + interval '1 minute' WHERE id = $1", [first.sessionId]);
    await expect(runTurn(first.sessionId, "hello again", "x")).rejects.toBeInstanceOf(SessionBusyError);
  });

  it("releases the chat after each turn", async () => {
    const first = await runTurn(undefined, "hello", "x");
    expect((await runTurn(first.sessionId, "hello again", "x")).sessionId).toBe(first.sessionId);
  });
});

describe("confirmation email delivery errors", () => {
  const payload = {
    to: "a@example.com",
    practice: { slug: "bright-smile", name: PRACTICES[0].name, address: PRACTICES[0].address, phone: PRACTICES[0].phone, timezone: PRACTICES[0].timezone },
    appointments: [{ appointment_id: 1, patient_name: "A B", label: "Cleaning", start_time: "2026-10-27 09:00", display: "Tue", provider_name: "Lena Torres", duration_minutes: 60 }],
  };
  const withStatus = (status: number) => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status })));
    return sendConfirmationEmail(payload);
  };

  it("gives up on errors that can't succeed (403)", async () => {
    await expect(withStatus(403)).rejects.toBeInstanceOf(PermanentJobError);
  });

  it("retries rate limits and server errors (429, 500)", async () => {
    for (const s of [429, 500]) {
      const err = await withStatus(s).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(PermanentJobError);
    }
  });
});
