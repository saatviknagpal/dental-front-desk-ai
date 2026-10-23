// Eval report: reads eval_runs / eval_results / eval_steps (written by
// `npm run evals`) and shows metrics, the judge rubric, every check with the
// DB records it looked at, and the full trajectory of each simulated chat.

import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/lib/db";
import { JUDGE_RUBRIC, type JudgeVerdict } from "@/lib/judge";
import { fmtUsd, type Usage } from "@/lib/pricing";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Eval report — Bright Smile Dental" };

interface RunRow {
  id: number;
  started_at: string;
  model: string;
  judge_model: string | null;
  k: number;
  scenarios: number;
  pass_k: number;
  runs_passed: number;
  runs_total: number;
  metrics: {
    tool_calls: number;
    tool_success_rate: number;
    hallucination_rate: number | null;
    redundancy_avg: number | null;
    tone_avg: number | null;
    clarity_avg: number | null;
    latency_p50_ms: number;
    latency_p95_ms: number;
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
    cost_usd: number;
    avg_cost_per_conversation_usd: number;
    avg_tokens_per_conversation: number;
    judge_cost_usd: number;
  };
}
interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}
interface ResultRow {
  id: number;
  scenario_id: string;
  title: string;
  rep: number;
  passed: boolean;
  checks: Check[];
  judge: JudgeVerdict | { skipped: string } | null;
  usage: Usage | null;
  turns: number;
  seconds: number;
}
interface StepRow {
  result_id: number;
  seq: number;
  role: "user" | "llm" | "tool" | "assistant" | "guardrail";
  content: unknown;
}
interface LlmStep extends Usage {
  step: number;
  model: string;
  decision: "call_tools" | "reply";
  tool_calls: { name: string; args: Record<string, unknown> }[];
  text: string;
}
interface ToolStep {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  error?: string;
  ms: number;
  result: unknown;
}

const isJudge = (j: ResultRow["judge"]): j is JudgeVerdict => !!j && !("skipped" in j);
const n = (x: number) => Math.round(x).toLocaleString();

function Badge({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${ok ? "bg-brand-soft text-brand-strong" : "bg-danger-soft text-danger"}`}>{children}</span>;
}

function Trajectory({ steps }: { steps: StepRow[] }) {
  return (
    <ol className="space-y-2 text-sm">
      {steps.map((s) => {
        if (s.role === "user") {
          return (
            <li key={s.seq} className="flex justify-end">
              <div className="max-w-[80%] rounded-xl bg-user-bubble px-3 py-2 text-user-text">
                <div className="text-[10px] uppercase tracking-wide opacity-70">Patient</div>
                {String(s.content)}
              </div>
            </li>
          );
        }
        if (s.role === "assistant") {
          return (
            <li key={s.seq}>
              <div className="max-w-[80%] whitespace-pre-wrap rounded-xl bg-surface-2 px-3 py-2">
                <div className="text-[10px] uppercase tracking-wide text-muted">Ava (sent to patient)</div>
                {String(s.content)}
              </div>
            </li>
          );
        }
        if (s.role === "guardrail") {
          return (
            <li key={s.seq} className="rounded-lg bg-danger-soft px-3 py-2 font-mono text-xs text-danger">
              Guardrail triggered: {JSON.stringify(s.content)}
            </li>
          );
        }
        if (s.role === "llm") {
          const c = s.content as LlmStep;
          return (
            <li key={s.seq} className="rounded-lg border border-dashed border-border px-3 py-2 font-mono text-xs">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-semibold text-brand-strong">LLM step {c.step}</span>
                <span className="text-muted">{c.model}</span>
                <span>
                  decided: <b>{c.decision === "call_tools" ? `call ${c.tool_calls.map((t) => t.name).join(", ")}` : "reply to patient"}</b>
                </span>
                <span className="text-muted">
                  {n(c.inputTokens)} in ({n(c.cachedInputTokens)} cached) · {n(c.outputTokens)} out · {fmtUsd(c.costUsd)} · {c.llmMs}ms
                </span>
              </div>
              {c.decision === "call_tools" && c.tool_calls.map((t, i) => <div key={i} className="mt-1 break-all text-muted">→ {t.name}({JSON.stringify(t.args)})</div>)}
            </li>
          );
        }
        const t = s.content as ToolStep;
        return (
          <li key={s.seq}>
            <details className={`rounded-lg px-3 py-2 font-mono text-xs ${t.ok ? "bg-brand-soft" : "bg-warn-soft"}`}>
              <summary className="cursor-pointer">
                {t.ok ? "✓" : "!"} tool <b>{t.name}</b>
                {t.error ? ` → ${t.error}` : ""} · {t.ms}ms <span className="text-muted">(click for args + result)</span>
              </summary>
              <div className="mt-2 text-muted">args</div>
              <pre className="overflow-x-auto whitespace-pre-wrap break-all">{JSON.stringify(t.args, null, 2)}</pre>
              <div className="mt-2 text-muted">result</div>
              <pre className="overflow-x-auto whitespace-pre-wrap break-all">{JSON.stringify(t.result, null, 2)}</pre>
            </details>
          </li>
        );
      })}
    </ol>
  );
}

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
        <h1 className="text-2xl font-semibold">Eval report</h1>
        <p className="mt-3 text-muted">
          No eval runs yet. Run <code className="rounded bg-surface-2 px-1.5 py-0.5">npm run evals</code> and refresh.
        </p>
      </main>
    );
  }

  const results = await db.all<ResultRow>("SELECT * FROM eval_results WHERE run_id = $1 ORDER BY scenario_id, rep", [run.id]);
  const steps = await db.all<StepRow>(
    "SELECT s.result_id, s.seq, s.role, s.content FROM eval_steps s JOIN eval_results r ON r.id = s.result_id WHERE r.run_id = $1 ORDER BY s.result_id, s.seq",
    [run.id],
  );
  const stepsBy = new Map<number, StepRow[]>();
  for (const s of steps) {
    if (!stepsBy.has(s.result_id)) stepsBy.set(s.result_id, []);
    stepsBy.get(s.result_id)!.push(s);
  }
  const ids = [...new Set(results.map((r) => r.scenario_id))];
  const m = run.metrics;
  const metrics = [
    { label: `pass^${run.k} (scenarios)`, value: `${run.pass_k}/${run.scenarios}`, sub: "all k runs passed" },
    { label: "Runs passed", value: `${run.runs_passed}/${run.runs_total}` },
    { label: "Tool calls succeeded", value: `${Math.round(100 * m.tool_success_rate)}%`, sub: `${m.tool_calls} calls (some failures expected)` },
    { label: "Hallucination rate", value: m.hallucination_rate === null ? "—" : `${Math.round(100 * m.hallucination_rate)}%` },
    { label: "Redundancy", value: m.redundancy_avg === null ? "—" : m.redundancy_avg.toFixed(2), sub: "re-asks / chat" },
    { label: "Tone · clarity", value: m.tone_avg === null ? "—" : `${m.tone_avg.toFixed(1)} · ${(m.clarity_avg ?? 0).toFixed(1)}`, sub: "out of 5" },
    { label: "Latency / turn", value: `${(m.latency_p50_ms / 1000).toFixed(1)}s`, sub: `P95 ${(m.latency_p95_ms / 1000).toFixed(1)}s` },
    { label: "Tokens / chat", value: n(m.avg_tokens_per_conversation), sub: `${m.input_tokens ? Math.round((100 * m.cached_input_tokens) / m.input_tokens) : 0}% of input cached` },
    { label: "Cost / chat", value: fmtUsd(m.avg_cost_per_conversation_usd), sub: `≈ $${(m.avg_cost_per_conversation_usd * 10_000).toFixed(0)}/day at 10k chats` },
    { label: "Run cost", value: fmtUsd(m.cost_usd), sub: `+ judge ${fmtUsd(m.judge_cost_usd)}` },
  ];

  return (
    <main className="mx-auto max-w-6xl space-y-8 px-4 py-6 md:px-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Eval report</h1>
          <p className="max-w-2xl text-sm text-muted">
            Simulated patients (an LLM playing a persona with a goal) chat with the real agent. Outcomes are checked against the final database state; a judge from a different model family scores conversation quality against the rubric below.
          </p>
        </div>
        <Link href="/staff" className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-surface-2">
          Staff dashboard
        </Link>
      </header>

      <section className="overflow-x-auto rounded-2xl border border-border bg-surface">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="text-xs text-muted">
            <tr className="border-b border-border">
              <th className="px-4 py-2 font-medium">Run</th>
              <th className="px-4 py-2 font-medium">When (UTC)</th>
              <th className="px-4 py-2 font-medium">Model</th>
              <th className="px-4 py-2 font-medium">pass^k</th>
              <th className="px-4 py-2 font-medium">Runs</th>
              <th className="px-4 py-2 font-medium">Cost / chat</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} className={`border-b border-border last:border-0 ${r.id === run.id ? "bg-brand-soft" : ""}`}>
                <td className="px-4 py-2">
                  <Link href={`/evals?run=${r.id}`} className="font-medium text-brand hover:underline">
                    #{r.id}
                  </Link>
                </td>
                <td className="px-4 py-2">{r.started_at}</td>
                <td className="px-4 py-2 font-mono text-xs">{r.model}</td>
                <td className="px-4 py-2">
                  {r.pass_k}/{r.scenarios} <span className="text-muted">(k={r.k})</span>
                </td>
                <td className="px-4 py-2">
                  {r.runs_passed}/{r.runs_total}
                </td>
                <td className="px-4 py-2">{fmtUsd(r.metrics.avg_cost_per_conversation_usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">
          Run #{run.id} · <code className="rounded bg-surface-2 px-1.5 py-0.5 text-base">{run.model}</code>
          {run.judge_model && <span className="ml-2 text-sm font-normal text-muted">judge: {run.judge_model}</span>}
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {metrics.map((x) => (
            <div key={x.label} className="rounded-xl border border-border bg-surface px-4 py-3">
              <div className="text-xs text-muted">{x.label}</div>
              <div className="mt-1 text-xl font-semibold">{x.value}</div>
              {x.sub && <div className="text-xs text-muted">{x.sub}</div>}
            </div>
          ))}
        </div>
      </section>

      <details className="rounded-2xl border border-border bg-surface">
        <summary className="cursor-pointer px-5 py-3 font-semibold">Judge rubric &amp; pass criteria</summary>
        <div className="space-y-3 border-t border-border px-5 py-4 text-sm">
          <p className="text-muted">
            A scenario run passes only if <b>every outcome check</b> passes (code, against the final database) <b>and</b> the judge passes it. The judge passes a conversation when all of these hold:
          </p>
          <table className="w-full text-left">
            <thead className="text-xs text-muted">
              <tr>
                <th className="pb-2 pr-3 font-medium">Criterion</th>
                <th className="pb-2 pr-3 font-medium">Scale</th>
                <th className="pb-2 pr-3 font-medium">Pass if</th>
                <th className="pb-2 font-medium">What it measures</th>
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
      </details>

      <section className="space-y-3">
        {ids.map((id) => {
          const group = results.filter((r) => r.scenario_id === id);
          const allPass = group.every((r) => r.passed);
          return (
            <details key={id} className="rounded-2xl border border-border bg-surface" open={!allPass}>
              <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2 px-5 py-3">
                <div className="flex items-center gap-3">
                  <Badge ok={allPass}>{allPass ? "PASS" : "FAIL"}</Badge>
                  <span className="font-medium">{group[0].title}</span>
                </div>
                <span className="text-sm text-muted">
                  {group.filter((r) => r.passed).length}/{group.length} runs · {id}
                </span>
              </summary>
              <div className="space-y-6 border-t border-border px-5 py-4">
                {group.map((r) => (
                  <div key={r.id} className="space-y-3">
                    <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                      Run {r.rep + 1} <Badge ok={r.passed}>{r.passed ? "pass" : "fail"}</Badge>
                      <span className="font-normal text-muted">
                        {r.turns} turns · {r.seconds}s{r.usage ? ` · ${r.usage.calls} LLM calls · ${n(r.usage.inputTokens + r.usage.outputTokens)} tokens · ${fmtUsd(r.usage.costUsd)}` : ""}
                      </span>
                    </h3>

                    <div>
                      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Outcome checks (against the database)</div>
                      <ul className="space-y-1 text-sm">
                        {r.checks.map((c) => (
                          <li key={c.name} className={c.pass ? "" : "text-danger"}>
                            {c.pass ? "✓" : "✗"} {c.name}
                            {c.detail && <div className="ml-5 break-all font-mono text-xs text-muted">{c.detail}</div>}
                          </li>
                        ))}
                      </ul>
                    </div>

                    {isJudge(r.judge) ? (
                      <div className={`rounded-xl px-4 py-3 text-sm ${r.judge.pass ? "bg-surface-2" : "bg-warn-soft"}`}>
                        <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">
                          Judge ({r.judge.judge_model}) · {r.judge.pass ? "pass" : "fail"}
                        </div>
                        <p className="mb-2">{r.judge.summary}</p>
                        <table className="w-full text-left text-xs">
                          <tbody>
                            {[
                              ["tone", `${r.judge.tone}/5`],
                              ["clarity", `${r.judge.clarity}/5`],
                              ["redundancy", String(r.judge.redundancy)],
                              ["hallucination", r.judge.hallucination ? `yes: ${r.judge.hallucination_detail}` : "no"],
                              ["policy_violations", r.judge.policy_violations.length ? r.judge.policy_violations.join("; ") : "none"],
                            ].map(([k, v]) => (
                              <tr key={k} className="align-top">
                                <td className="py-0.5 pr-3 font-mono">{k}</td>
                                <td className="py-0.5 pr-3 font-semibold whitespace-nowrap">{v}</td>
                                <td className="py-0.5 text-muted">{r.judge && isJudge(r.judge) ? r.judge.reasons?.[k] ?? "" : ""}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : r.judge ? (
                      <div className="text-xs text-muted">Judge skipped: {(r.judge as { skipped: string }).skipped}</div>
                    ) : null}

                    <details className="rounded-xl border border-border">
                      <summary className="cursor-pointer px-3 py-2 text-sm">
                        Trajectory: every message, LLM decision (tokens, cost, latency) and tool call (args + result)
                      </summary>
                      <div className="px-3 pb-3">
                        <Trajectory steps={stepsBy.get(r.id) ?? []} />
                      </div>
                    </details>
                  </div>
                ))}
              </div>
            </details>
          );
        })}
      </section>
    </main>
  );
}
