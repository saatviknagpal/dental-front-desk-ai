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
  if (process.env.STAFF_PASSWORD && pass === process.env.STAFF_PASSWORD) return "admin";
  const own = practicePasswords()[user];
  return own && pass === own ? user : null;
}
