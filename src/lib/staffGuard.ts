// Server-side check for staff routes: which practice may this request touch?

import { NextResponse } from "next/server";
import { PRACTICES, practiceBySlug, type Practice } from "./practice";
import { STAFF_ACCESS_HEADER } from "./staffAuth";

export type StaffScope = { practice: Practice; admin: boolean; practices: Practice[] };

export function staffScope(req: Request): StaffScope | NextResponse {
  const access = req.headers.get(STAFF_ACCESS_HEADER);
  const requested = new URL(req.url).searchParams.get("practice");
  if (access === "admin") {
    const practice = requested ? practiceBySlug(requested) : PRACTICES[0];
    return practice ? { practice, admin: true, practices: PRACTICES } : NextResponse.json({ error: "Unknown practice" }, { status: 404 });
  }
  const own = practiceBySlug(access);
  if (!own) return NextResponse.json({ error: "Staff login required" }, { status: 401 });
  if (requested && requested !== own.slug) return NextResponse.json({ error: "Not your practice" }, { status: 403 });
  return { practice: own, admin: false, practices: [own] };
}
