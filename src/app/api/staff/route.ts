import { NextResponse } from "next/server";
import { demoResetAllowed } from "@/lib/config";
import { withPractice } from "@/lib/practice";
import { ensureSeeded } from "@/lib/seed";
import { dashboard } from "@/lib/staff";
import { staffScope } from "@/lib/staffGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const scope = staffScope(req);
  if (scope instanceof NextResponse) return scope;
  await ensureSeeded();
  const data = await withPractice(scope.practice, () => dashboard(scope.practice.id));
  return NextResponse.json({
    ...data,
    practice: { slug: scope.practice.slug, name: scope.practice.name },
    practices: scope.practices.map((p) => ({ slug: p.slug, name: p.name })),
    admin: scope.admin,
    demoResetAllowed: scope.admin && demoResetAllowed(),
  });
}
