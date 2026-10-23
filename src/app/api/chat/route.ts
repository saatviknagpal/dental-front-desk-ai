import { NextResponse } from "next/server";
import { MAX_USER_CHARS, runTurn } from "@/lib/agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { sessionId?: string; message?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return NextResponse.json({ error: "Message is required" }, { status: 400 });
  if (message.length > MAX_USER_CHARS) return NextResponse.json({ error: `Message is too long (max ${MAX_USER_CHARS} characters)` }, { status: 413 });

  const result = await runTurn(typeof body.sessionId === "string" ? body.sessionId : undefined, message);
  return NextResponse.json(result);
}
