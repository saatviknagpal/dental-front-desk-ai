import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Acknowledge (or re-open) a staff alert. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { acknowledged?: boolean };
  await db.run("UPDATE notifications SET acknowledged = $1 WHERE id = $2", [body.acknowledged !== false, Number(id)]);
  return NextResponse.json({ ok: true });
}
