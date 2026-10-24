import { NextResponse } from "next/server";
import { demoResetAllowed } from "@/lib/config";
import { seed } from "@/lib/seed";
import { staffScope } from "@/lib/staffGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const scope = staffScope(req);
  if (scope instanceof NextResponse) return scope;
  if (!scope.admin || !demoResetAllowed()) return NextResponse.json({ error: "Demo reset is not allowed" }, { status: 403 });
  await seed({ reset: true });
  return NextResponse.json({ ok: true });
}
