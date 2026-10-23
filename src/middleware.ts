// Staff-only areas (dashboard, eval report, staff APIs) require a login.
// The verified access level is passed to the routes in a request header;
// any value the client sent for that header is overwritten.
// Without any staff password set, these routes are open in development and
// closed in production.

import { NextResponse, type NextRequest } from "next/server";
import { STAFF_ACCESS_HEADER, staffAccess, staffAuthConfigured } from "./lib/staffAuth";

export const config = { matcher: ["/staff/:path*", "/evals/:path*", "/api/staff/:path*"] };

const challenge = () => new NextResponse("Staff login required.", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="Front desk"' } });

export function middleware(req: NextRequest) {
  let access = staffAccess(req.headers.get("authorization"));
  if (!staffAuthConfigured()) {
    if (process.env.NODE_ENV === "production") return new NextResponse("Staff area is not configured.", { status: 503 });
    access = "admin";
  }
  if (!access) return challenge();
  if (access !== "admin" && req.nextUrl.pathname.startsWith("/evals")) return challenge();

  const headers = new Headers(req.headers);
  headers.set(STAFF_ACCESS_HEADER, access);
  return NextResponse.next({ request: { headers } });
}
