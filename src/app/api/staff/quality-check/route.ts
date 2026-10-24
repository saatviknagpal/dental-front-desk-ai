import { NextResponse } from "next/server";
import { judgeAvailable, judgeProvider } from "@/lib/judge";
import { withPractice } from "@/lib/practice";
import { queueQualityChecks, startWorker } from "@/lib/queue";
import { staffScope } from "@/lib/staffGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Queue AI quality checks for this practice's ungraded chats. Admins only (it spends API credits). */
export async function POST(req: Request) {
  const scope = staffScope(req);
  if (scope instanceof NextResponse) return scope;
  if (!scope.admin) return NextResponse.json({ error: "Only admins can run quality checks" }, { status: 403 });
  if (!judgeAvailable()) return NextResponse.json({ error: `No API key for the judge (${judgeProvider().provider}).` }, { status: 400 });
  startWorker();
  const queued = await withPractice(scope.practice, () => queueQualityChecks());
  return NextResponse.json({ queued });
}
