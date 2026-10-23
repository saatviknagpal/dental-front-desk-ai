// Staff-only areas (dashboard, eval report, staff APIs) require a password.
// HTTP Basic auth: the browser shows its own login prompt; any username works.
// Without STAFF_PASSWORD set, these routes are open in development and
// closed in production.

import { NextResponse, type NextRequest } from "next/server";

export const config = { matcher: ["/staff/:path*", "/evals/:path*", "/api/staff/:path*"] };

export function middleware(req: NextRequest) {
  const password = process.env.STAFF_PASSWORD;
  if (!password) {
    return process.env.NODE_ENV === "production" ? new NextResponse("Staff area is not configured.", { status: 503 }) : NextResponse.next();
  }
  const header = req.headers.get("authorization") ?? "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    const decoded = atob(encoded);
    if (decoded.slice(decoded.indexOf(":") + 1) === password) return NextResponse.next();
  }
  return new NextResponse("Staff login required.", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="Bright Smile staff"' } });
}
