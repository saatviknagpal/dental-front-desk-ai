import { NextResponse } from "next/server";
import { demoResetAllowed } from "@/lib/config";
import { practiceBySlug, PRACTICES, withPractice } from "@/lib/practice";
import { ensureSeeded } from "@/lib/seed";
import { dashboard } from "@/lib/staff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const slug = new URL(req.url).searchParams.get("practice");
  const practice = slug ? practiceBySlug(slug) : PRACTICES[0];
  if (!practice) return NextResponse.json({ error: "Unknown practice" }, { status: 404 });
  await ensureSeeded();
  const data = await withPractice(practice, () => dashboard(practice.id));
  return NextResponse.json({
    ...data,
    practice: { slug: practice.slug, name: practice.name },
    practices: PRACTICES.map((p) => ({ slug: p.slug, name: p.name })),
    demoResetAllowed: demoResetAllowed(),
  });
}
