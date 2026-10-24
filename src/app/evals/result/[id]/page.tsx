// One scenario run in full: every check, the judge's reasons and the whole trajectory.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { RunDetail, type ResultRow, type StepRow } from "../../shared";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Eval run details" };

export default async function EvalResultPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id)) notFound();
  const r = await db.get<ResultRow & { run_id: number; model: string; started_at: string }>(
    "SELECT r.*, e.model, e.started_at FROM eval_results r JOIN eval_runs e ON e.id = r.run_id WHERE r.id = $1",
    [id],
  );
  if (!r) notFound();
  const steps = await db.all<StepRow>("SELECT result_id, seq, role, content FROM eval_steps WHERE result_id = $1 ORDER BY seq", [id]);

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-4 py-6 md:px-8">
      <header>
        <p className="text-sm text-muted">
          <a href={`/evals?run=${r.run_id}`} className="underline underline-offset-2 hover:text-text">
            Eval run #{r.run_id}
          </a>{" "}
          · {r.started_at} UTC · {r.model}
        </p>
        <h1 className="mt-1 text-2xl font-bold">{r.title}</h1>
        <p className="font-mono text-xs text-muted">{r.scenario_id}</p>
      </header>
      <RunDetail r={r} steps={steps} openTrajectory />
    </main>
  );
}
