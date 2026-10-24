// Who is signed in to the staff area. HTTP Basic auth:
//  - username = practice slug + that practice's password (STAFF_PASSWORDS JSON) -> that practice only
//  - any username + STAFF_PASSWORD -> admin (every practice, plus the eval report)
// Kept free of Node APIs so the edge middleware can use it.

export type StaffAccess = "admin" | string; // a practice slug

export const STAFF_ACCESS_HEADER = "x-staff-access";

function practicePasswords(): Record<string, string> {
  try {
    return JSON.parse(process.env.STAFF_PASSWORDS || "{}");
  } catch {
    return {};
  }
}

export function staffAuthConfigured(): boolean {
  return !!process.env.STAFF_PASSWORD || Object.keys(practicePasswords()).length > 0;
}

/** Compare without stopping at the first different character, so response time doesn't hint at the password. */
function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

// Wrong-password lockout per client IP.
// shortcut: in-memory, so each app instance counts on its own; move to Redis/Postgres when running several instances.
export const LOGIN_MAX_FAILURES = 10;
export const LOGIN_LOCK_MS = 15 * 60_000;
const failures = new Map<string, { count: number; first: number }>();

export function loginLocked(ip: string, now = Date.now()): boolean {
  const f = failures.get(ip);
  if (f && now - f.first > LOGIN_LOCK_MS) failures.delete(ip);
  return (failures.get(ip)?.count ?? 0) >= LOGIN_MAX_FAILURES;
}

export function recordLoginFailure(ip: string, now = Date.now()): void {
  if (failures.size > 10_000) for (const [k, v] of failures) if (now - v.first > LOGIN_LOCK_MS) failures.delete(k);
  const f = failures.get(ip);
  if (!f || now - f.first > LOGIN_LOCK_MS) failures.set(ip, { count: 1, first: now });
  else f.count++;
}

export function clearLoginFailures(ip: string): void {
  failures.delete(ip);
}

export function staffAccess(authorization: string | null): StaffAccess | null {
  const [scheme, encoded] = (authorization ?? "").split(" ");
  if (scheme !== "Basic" || !encoded) return null;
  let decoded: string;
  try {
    decoded = atob(encoded);
  } catch {
    return null;
  }
  const i = decoded.indexOf(":");
  const user = decoded.slice(0, i);
  const pass = decoded.slice(i + 1);
  if (process.env.STAFF_PASSWORD && safeEqual(pass, process.env.STAFF_PASSWORD)) return "admin";
  const own = practicePasswords()[user];
  return typeof own === "string" && own && safeEqual(pass, own) ? user : null;
}
