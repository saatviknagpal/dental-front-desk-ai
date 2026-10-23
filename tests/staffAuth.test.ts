import { afterEach, describe, expect, it, vi } from "vitest";
import { staffScope } from "@/lib/staffGuard";
import { STAFF_ACCESS_HEADER, staffAccess } from "@/lib/staffAuth";

const basic = (user: string, pass: string) => `Basic ${btoa(`${user}:${pass}`)}`;

afterEach(() => vi.unstubAllEnvs());

describe("staff login", () => {
  it("maps admin and per-practice passwords to the right access", () => {
    vi.stubEnv("STAFF_PASSWORD", "admin-pw");
    vi.stubEnv("STAFF_PASSWORDS", JSON.stringify({ "harbor-family": "harbor-pw" }));
    expect(staffAccess(basic("anyone", "admin-pw"))).toBe("admin");
    expect(staffAccess(basic("harbor-family", "harbor-pw"))).toBe("harbor-family");
    expect(staffAccess(basic("bright-smile", "harbor-pw"))).toBeNull(); // right password, wrong practice
    expect(staffAccess(basic("harbor-family", "nope"))).toBeNull();
    expect(staffAccess("Basic !!!not-base64")).toBeNull();
    expect(staffAccess(null)).toBeNull();
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
