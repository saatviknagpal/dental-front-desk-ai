import { afterEach, describe, expect, it, vi } from "vitest";
import { staffScope } from "@/lib/staffGuard";
import { clearLoginFailures, LOGIN_LOCK_MS, LOGIN_MAX_FAILURES, loginLocked, recordLoginFailure, STAFF_ACCESS_HEADER, staffAccess } from "@/lib/staffAuth";

const basic = (user: string, pass: string) => `Basic ${btoa(`${user}:${pass}`)}`;

afterEach(() => vi.unstubAllEnvs());

describe("staff login", () => {
  it("maps admin and per-practice passwords to the right access", () => {
    vi.stubEnv("STAFF_PASSWORD", "admin-pw");
    vi.stubEnv("STAFF_PASSWORDS", JSON.stringify({ "harbor-family": "harbor-pw" }));
    expect(staffAccess(basic("anyone", "admin-pw"))).toBe("admin");
    expect(staffAccess(basic("harbor-family", "harbor-pw"))).toBe("harbor-family");
    expect(staffAccess(basic("bright-smile", "harbor-pw"))).toBeNull();
    expect(staffAccess(basic("harbor-family", "nope"))).toBeNull();
    expect(staffAccess("Basic !!!not-base64")).toBeNull();
    expect(staffAccess(null)).toBeNull();
  });

  it("locks a client out after too many wrong passwords, then lets it back in", () => {
    const t = 1_000_000;
    for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i++) recordLoginFailure("1.2.3.4", t);
    expect(loginLocked("1.2.3.4", t)).toBe(false);
    recordLoginFailure("1.2.3.4", t);
    expect(loginLocked("1.2.3.4", t)).toBe(true);
    expect(loginLocked("5.6.7.8", t)).toBe(false);
    expect(loginLocked("1.2.3.4", t + LOGIN_LOCK_MS + 1)).toBe(false);
    recordLoginFailure("9.9.9.9", t);
    clearLoginFailures("9.9.9.9");
    expect(loginLocked("9.9.9.9", t)).toBe(false);
  });

  it("keeps practice staff inside their own practice", () => {
    const req = (access: string, query = "") => new Request(`http://x/api/staff${query}`, { headers: { [STAFF_ACCESS_HEADER]: access } });
    const own = staffScope(req("harbor-family"));
    expect("practice" in own && own.practice.slug).toBe("harbor-family");
    expect((staffScope(req("harbor-family", "?practice=bright-smile")) as Response).status).toBe(403);
    const admin = staffScope(req("admin", "?practice=harbor-family"));
    expect("practice" in admin && admin.admin && admin.practice.slug).toBe("harbor-family");
    expect((staffScope(new Request("http://x/api/staff")) as Response).status).toBe(401);
  });
});
