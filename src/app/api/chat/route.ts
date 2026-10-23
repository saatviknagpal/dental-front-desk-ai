import { NextResponse } from "next/server";
import { MAX_USER_CHARS, runTurn } from "@/lib/agent";
import { allowRequest } from "@/lib/guardrails";
import { practiceBySlug, PRACTICES, withPractice } from "@/lib/practice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const caller = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "local";
  if (!(await allowRequest(caller))) {
    return NextResponse.json({ error: "Too many messages. Please wait a minute and try again." }, { status: 429 });
  }
  let body: { sessionId?: string; message?: string; practice?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return NextResponse.json({ error: "Message is required" }, { status: 400 });
  if (message.length > MAX_USER_CHARS) return NextResponse.json({ error: `Message is too long (max ${MAX_USER_CHARS} characters)` }, { status: 413 });

  const practice = body.practice === undefined ? PRACTICES[0] : practiceBySlug(body.practice);
  if (!practice) return NextResponse.json({ error: "Unknown practice" }, { status: 404 });
  const result = await withPractice(practice, () => runTurn(typeof body.sessionId === "string" ? body.sessionId : undefined, message));
  return NextResponse.json(result);
}
