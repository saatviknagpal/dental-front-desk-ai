import { NextResponse } from "next/server";
import { MAX_USER_CHARS, runTurn, SessionBusyError } from "@/lib/agent";
import { clientIp } from "@/lib/clientIp";
import { allowRequest } from "@/lib/guardrails";
import { practiceBySlug, PRACTICES, withPractice } from "@/lib/practice";
import { startWorker } from "@/lib/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  startWorker();
  const caller = clientIp(req.headers);
  if (!(await allowRequest(caller))) {
    return NextResponse.json({ error: "Too many messages. Please wait a minute and try again." }, { status: 429 });
  }
  let body: { sessionId?: string; message?: string; practice?: string; requestId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return NextResponse.json({ error: "Message is required" }, { status: 400 });
  if (message.length > MAX_USER_CHARS) return NextResponse.json({ error: `Message is too long (max ${MAX_USER_CHARS} characters)` }, { status: 413 });

  const requestId = typeof body.requestId === "string" && /^[\w-]{8,64}$/.test(body.requestId) ? body.requestId : undefined;
  const practice = body.practice === undefined ? PRACTICES[0] : practiceBySlug(body.practice);
  if (!practice) return NextResponse.json({ error: "Unknown practice" }, { status: 404 });
  try {
    const result = await withPractice(practice, () => runTurn(typeof body.sessionId === "string" ? body.sessionId : undefined, message, caller, requestId));
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof SessionBusyError) return NextResponse.json({ error: "Still working on your last message. One moment." }, { status: 409 });
    throw e;
  }
}
