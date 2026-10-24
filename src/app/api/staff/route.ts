import { NextResponse } from "next/server";
import { demoResetAllowed } from "@/lib/config";
import { withPractice } from "@/lib/practice";
import { ensureSeeded } from "@/lib/seed";
import { APPOINTMENT_RANGES, dashboard, type AppointmentRange } from "@/lib/staff";
import { staffScope } from "@/lib/staffGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const scope = staffScope(req);
  if (scope instanceof NextResponse) return scope;
  await ensureSeeded();
  const q = new URL(req.url).searchParams;
  const range = APPOINTMENT_RANGES.find((r) => r === q.get("range")) as AppointmentRange | undefined;
  const sessionsLimit = Number(q.get("sessions")) || undefined;
  const data = await withPractice(scope.practice, () => dashboard(scope.practice.id, { range, sessionsLimit }));
  return NextResponse.json({
    ...data,
    practice: { slug: scope.practice.slug, name: scope.practice.name },
    practices: scope.practices.map((p) => ({ slug: p.slug, name: p.name })),
    admin: scope.admin,
    demoResetAllowed: scope.admin && demoResetAllowed(),
  });
}
