import { NextResponse } from "next/server";
import { llmConfig } from "@/lib/config";
import { llmReady } from "@/lib/llm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const cfg = llmConfig();
  return NextResponse.json({ ok: true, llmConfigured: llmReady(), provider: cfg.provider, model: cfg.model });
}
