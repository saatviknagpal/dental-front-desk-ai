// Eval report: reads eval_runs / eval_results (written by `npm run evals`) and
// shows each run's metrics, the judge rubric and a scenario table. Each scenario
// run opens its own page (/evals/result/<id>) with checks, judge and trajectory.

import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/lib/db";
import { JUDGE_RUBRIC } from "@/lib/judge";
import { fmtUsd } from "@/lib/pricing";
import Icon from "@/components/Icon";
import ThemeToggle from "@/components/ThemeToggle";
import { Badge, n, type ResultRow, type RunRow } from "./shared";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Eval report" };

export default async function EvalsPage({ searchParams }: { searchParams: Promise<{ run?: string }> }) {
  const { run: runParam } = await searchParams;
  let runs: RunRow[] = [];
  try {
    runs = await db.all<RunRow>("SELECT * FROM eval_runs ORDER BY id DESC LIMIT 20");
  } catch {
    /* table not created yet */
  }
  const run = runs.find((r) => String(r.id) === runParam) ?? runs[0];

  if (!run) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-12">
        <h1 className="text-2xl font-bold">Eval report</h1>
        <p className="mt-3 text-muted">
          No eval runs yet. Run <code className="rounded bg-surface-2 px-1.5 py-0.5">npm run evals</code> and refresh.
        </p>
      </main>
    );
  }

  const results = await db.all<Omit<ResultRow, "judge"> & { judge: unknown }>(
    "SELECT id, scenario_id, title, rep, passed, checks, judge, usage, turns, seconds FROM eval_results WHERE run_id = $1 ORDER BY scenario_id, rep",
    [run.id],
  );
  const ids = [...new Set(results.map((r) => r.scenario_id))];
  const m = run.metrics;
  const judged = m.tone_avg !== null;
  const metrics = [
    { label: "Scenarios passed every time", value: `${run.pass_k}/${run.scenarios}`, sub: `each scenario ran ${run.k} times; all ${run.k} had to pass` },
    { label: "Individual runs passed", value: `${run.runs_passed}/${run.runs_total}`, sub: "a run passes when every check passes" },
    { label: "Tool calls that worked", value: `${Math.round(100 * m.tool_success_rate)}%`, sub: `${m.tool_calls} calls; some failures are on purpose (e.g. slot taken)` },
    { label: "Made-up facts", value: m.hallucination_rate === null ? "not judged" : `${Math.round(100 * m.hallucination_rate)}%`, sub: "share of chats where the judge found an invented fact" },
    { label: "Repeated questions", value: m.redundancy_avg === null ? "not judged" : m.redundancy_avg.toFixed(2), sub: "times per chat the bot re-asked known info" },
    { label: "Tone · clarity", value: judged ? `${m.tone_avg!.toFixed(1)} · ${(m.clarity_avg ?? 0).toFixed(1)}` : "not judged", sub: "judge score out of 5" },
    { label: "Reply time", value: `${(m.latency_p50_ms / 1000).toFixed(1)}s`, sub: `typical; slowest 5% take ${(m.latency_p95_ms / 1000).toFixed(1)}s+` },
    { label: "Tokens per chat", value: n(m.avg_tokens_per_conversation), sub: `${m.input_tokens ? Math.round((100 * m.cached_input_tokens) / m.input_tokens) : 0}% served from the prompt cache (cheaper)` },
    { label: "Cost per chat", value: fmtUsd(m.avg_cost_per_conversation_usd), sub: `about $${(m.avg_cost_per_conversation_usd * 10_000).toFixed(0)}/day at 10k chats` },
    { label: "This run cost", value: fmtUsd(m.cost_usd + m.judge_cost_usd), sub: `bot ${fmtUsd(m.cost_usd)} + judge ${fmtUsd(m.judge_cost_usd)}` },
  ];

  return (
    <main className="mx-auto max-w-6xl space-y-8 px-4 py-6 md:px-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Eval report</h1>
          <p className="mt-1 max-w-2xl text-muted">
            A second AI plays a patient with a goal (for example &quot;book a cleaning next week&quot;) and chats with the real assistant. Afterwards, code checks the database to see if the right thing happened, and a judge from a different AI company grades the conversation.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <ThemeToggle />
          <Link href="/staff" className="inline-flex min-h-10 items-center rounded-lg border border-border px-3 text-sm hover:bg-surface-2">
            Staff dashboard
          </Link>
        </div>
      </header>

      <section className="space-y-3">
        <h2 className="text-lg font-bold">
          Run #{run.id} <span className="text-base font-normal text-muted">· {run.started_at} UTC · assistant model {run.model}{run.judge_model ? ` · judge ${run.judge_model}` : ""}</span>
        </h2>
        {!judged && (
          <p className="flex items-center gap-2 rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
            <Icon name="alertCircle" className="size-4" />
            The judge didn&apos;t run for this run (rate limit), so quality scores are missing. The database checks still ran.
          </p>
        )}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {metrics.map((x) => (
            <div key={x.label} className="rounded-xl border border-border bg-surface px-4 py-3">
              <div className="text-sm text-muted">{x.label}</div>
              <div className="mt-1 text-xl font-bold tabular-nums">{x.value}</div>
              <div className="mt-0.5 text-xs text-muted">{x.sub}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-bold">Scenarios</h2>
        <p className="text-sm text-muted">Each run opens in a new tab with every check, the judge&apos;s reasons and the full conversation.</p>
        <div className="overflow-x-auto rounded-2xl border border-border bg-surface">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b border-border text-xs text-muted">
              <tr>
                <th className="px-4 py-2.5 font-bold">Result</th>
                <th className="px-4 py-2.5 font-bold">What the patient tries to do</th>
                <th className="px-4 py-2.5 font-bold">Runs (open in a new tab)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {ids.map((id) => {
                const group = results.filter((r) => r.scenario_id === id);
                const passed = group.filter((r) => r.passed).length;
                return (
                  <tr key={id} className="align-top">
                    <td className="px-4 py-3 whitespace-nowrap">
                      <Badge ok={passed === group.length}>
                        {passed}/{group.length} passed
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-bold">{group[0].title}</div>
                      <div className="font-mono text-xs text-muted">{id}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-2">
                        {group.map((r) => (
                          <a
                            key={r.id}
                            href={`/evals/result/${r.id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={`inline-flex min-h-9 items-center gap-1.5 rounded-lg border px-3 font-bold hover:bg-surface-2 ${r.passed ? "border-border text-text" : "border-danger/40 text-danger"}`}
                          >
                            <Icon name={r.passed ? "check" : "x"} className={`size-4 ${r.passed ? "text-success" : ""}`} />
                            Run {r.rep + 1}
                            <span className="sr-only">{r.passed ? "passed" : "failed"}, opens in a new tab</span>
                            <Icon name="external" className="size-3.5 text-muted" />
                          </a>
                        ))}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <details className="group rounded-2xl border border-border bg-surface">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-3 font-bold">
          <Icon name="chevron" className="size-4 -rotate-90 text-muted transition-transform group-open:rotate-0" />
          How a run passes, and the judge&apos;s rubric
        </summary>
        <div className="space-y-3 border-t border-border px-5 py-4 text-sm">
          <p className="text-muted">
            A run passes only if <b>every database check</b> passes (written in code, run against the final database) <b>and</b> the judge passes it. The judge passes a conversation when all of these hold:
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left">
              <thead className="text-xs text-muted">
                <tr>
                  <th className="pb-2 pr-3 font-bold">Criterion</th>
                  <th className="pb-2 pr-3 font-bold">Scale</th>
                  <th className="pb-2 pr-3 font-bold">Pass if</th>
                  <th className="pb-2 font-bold">What it measures</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {JUDGE_RUBRIC.map((r) => (
                  <tr key={r.key}>
                    <td className="py-2 pr-3 font-mono text-xs">{r.key}</td>
                    <td className="py-2 pr-3">{r.scale}</td>
                    <td className="py-2 pr-3 whitespace-nowrap">{r.passIf}</td>
                    <td className="py-2">{r.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </details>

      <section className="space-y-3">
        <h2 className="text-lg font-bold">Earlier runs</h2>
        <div className="overflow-x-auto rounded-2xl border border-border bg-surface">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b border-border text-xs text-muted">
              <tr>
                <th className="px-4 py-2.5 font-bold">Run</th>
                <th className="px-4 py-2.5 font-bold">When (UTC)</th>
                <th className="px-4 py-2.5 font-bold">Assistant model</th>
                <th className="px-4 py-2.5 font-bold">Scenarios passed every time</th>
                <th className="px-4 py-2.5 font-bold">Runs passed</th>
                <th className="px-4 py-2.5 font-bold">Cost per chat</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {runs.map((r) => (
                <tr key={r.id} className={r.id === run.id ? "bg-brand-soft" : ""}>
                  <td className="px-4 py-2">
                    {r.id === run.id ? (
                      <span className="font-bold">#{r.id} (shown above)</span>
                    ) : (
                      <a href={`/evals?run=${r.id}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-bold text-brand-strong hover:underline">
                        #{r.id}
                        <Icon name="external" className="size-3.5" />
                        <span className="sr-only">opens in a new tab</span>
                      </a>
                    )}
                  </td>
                  <td className="px-4 py-2 tabular-nums">{r.started_at}</td>
                  <td className="px-4 py-2 font-mono text-xs">{r.model}</td>
                  <td className="px-4 py-2 tabular-nums">
                    {r.pass_k}/{r.scenarios}
                  </td>
                  <td className="px-4 py-2 tabular-nums">
                    {r.runs_passed}/{r.runs_total}
                  </td>
                  <td className="px-4 py-2 tabular-nums">{fmtUsd(r.metrics.avg_cost_per_conversation_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
