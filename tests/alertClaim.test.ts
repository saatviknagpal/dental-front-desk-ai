import { describe, expect, it } from "vitest";
import { ALERT_CLAIM } from "@/lib/agent";

describe("alert promise detection", () => {
  it("matches claims that staff were alerted, not offers", () => {
    for (const s of ["I have alerted our dental team as well.", "I am also alerting our dental team immediately.", "I've let our dental team know what's going on.", "I've notified the front desk."]) expect(s).toMatch(ALERT_CLAIM);
    for (const s of ["Would you like me to notify our team?", "I can alert the front desk if you'd like.", "Our team will call you."]) expect(s).not.toMatch(ALERT_CLAIM);
  });
});
