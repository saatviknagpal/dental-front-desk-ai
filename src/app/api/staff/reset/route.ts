import { NextResponse } from "next/server";
import { demoResetAllowed } from "@/lib/config";
import { seed } from "@/lib/seed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  if (!demoResetAllowed()) return NextResponse.json({ error: "Demo reset is disabled" }, { status: 403 });
  await seed({ reset: true });
  return NextResponse.json({ ok: true });
}
