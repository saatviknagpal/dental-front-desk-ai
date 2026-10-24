import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { staffScope } from "@/lib/staffGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const scope = staffScope(req);
  if (scope instanceof NextResponse) return scope;
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { acknowledged?: boolean };
  const r = await db.run("UPDATE notifications SET acknowledged = $1 WHERE id = $2 AND practice_id = $3", [body.acknowledged !== false, Number(id), scope.practice.id]);
  return r.rowCount ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Not found" }, { status: 404 });
}
