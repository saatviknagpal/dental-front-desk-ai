import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { staffScope } from "@/lib/staffGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Retry a failed delivery (email or webhook) of the signed-in practice. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const scope = staffScope(req);
  if (scope instanceof NextResponse) return scope;
  const { id } = await params;
  const r = await db.run(
    "UPDATE jobs SET status = 'pending', attempts = 0, run_at = now(), last_error = NULL WHERE id = $1 AND practice_id = $2 AND status = 'failed'",
    [Number(id), scope.practice.id],
  );
  return r.rowCount ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Not found" }, { status: 404 });
}
