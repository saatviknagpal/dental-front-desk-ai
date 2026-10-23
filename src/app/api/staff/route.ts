import { NextResponse } from "next/server";
import { demoResetAllowed } from "@/lib/config";
import { ensureSeeded } from "@/lib/seed";
import { dashboard } from "@/lib/staff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// NOTE: demo only. In production this sits behind staff auth (SSO) with audit logging.
export async function GET() {
  await ensureSeeded();
  return NextResponse.json({ ...(await dashboard()), demoResetAllowed: demoResetAllowed() });
}
