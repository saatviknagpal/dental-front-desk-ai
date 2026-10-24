import { NextResponse } from "next/server";
import { llmConfig } from "@/lib/config";
import { db } from "@/lib/db";
import { llmReady } from "@/lib/llm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const cfg = llmConfig();
  // Render restarts or holds back a deploy that can't reach the database.
  const dbOk = await db.get("SELECT 1").then(() => true, () => false);
  if (!dbOk) return NextResponse.json({ ok: false, error: "database unreachable" }, { status: 503 });
  return NextResponse.json({ ok: true, llmConfigured: llmReady(), provider: cfg.provider, model: cfg.model });
}
