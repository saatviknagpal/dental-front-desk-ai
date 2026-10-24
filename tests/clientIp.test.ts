import { afterEach, describe, expect, it, vi } from "vitest";
import { clientIp } from "@/lib/clientIp";

afterEach(() => vi.unstubAllEnvs());

describe("client IP", () => {
  const h = (o: Record<string, string>) => new Headers(o);

  it("uses the trusted edge header when configured", () => {
    vi.stubEnv("CLIENT_IP_HEADER", "cf-connecting-ip");
    expect(clientIp(h({ "cf-connecting-ip": "98.37.1.2", "x-forwarded-for": "1.1.1.1, 10.27.84.5" }))).toBe("98.37.1.2");
  });

  it("ignores that header when not configured, so clients can't pick their own IP", () => {
    vi.stubEnv("CLIENT_IP_HEADER", "");
    expect(clientIp(h({ "cf-connecting-ip": "6.6.6.6", "x-forwarded-for": "6.6.6.6, 203.0.113.9" }))).toBe("203.0.113.9");
    expect(clientIp(h({}))).toBe("local");
  });
});
