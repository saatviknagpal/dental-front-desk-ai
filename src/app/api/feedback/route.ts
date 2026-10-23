import { NextResponse } from "next/server";
import { recordFeedback } from "@/lib/agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { sessionId?: string; rating?: number; comment?: string };
  if (!body.sessionId || (body.rating !== 1 && body.rating !== -1)) {
    return NextResponse.json({ error: "sessionId and rating (1 or -1) are required" }, { status: 400 });
  }
  await recordFeedback(body.sessionId, body.rating, typeof body.comment === "string" ? body.comment : undefined);
  return NextResponse.json({ ok: true });
}
