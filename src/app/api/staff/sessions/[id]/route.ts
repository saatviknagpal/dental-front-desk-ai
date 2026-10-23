import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { transcript } from "@/lib/staff";
import { staffScope } from "@/lib/staffGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const scope = staffScope(req);
  if (scope instanceof NextResponse) return scope;
  const { id } = await params;
  const s = await db.get<{ practice_id: number }>("SELECT practice_id FROM sessions WHERE id = $1", [id]);
  if (!s || (!scope.admin && s.practice_id !== scope.practice.id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ messages: await transcript(id) });
}
