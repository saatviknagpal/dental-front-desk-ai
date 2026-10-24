// Shared pieces of the eval report: row types, the per-run detail view and the trajectory.

import { fmtUsd, type Usage } from "@/lib/pricing";
import type { JudgeVerdict } from "@/lib/judge";
import Icon from "@/components/Icon";

export interface RunRow {
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
export interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}
export interface ResultRow {
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
export interface StepRow {
  result_id: number;
  seq: number;
  role: "user" | "llm" | "tool" | "assistant" | "guardrail";
  content: unknown;
}
export interface LlmStep extends Usage {
  step: number;
  model: string;
  decision: "call_tools" | "reply";
  tool_calls: { name: string; args: Record<string, unknown> }[];
  text: string;
}
export interface ToolStep {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  error?: string;
  ms: number;
  result: unknown;
}

export const isJudge = (j: ResultRow["judge"]): j is JudgeVerdict => !!j && !("skipped" in j);
export const n = (x: number) => Math.round(x).toLocaleString();

export function Badge({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold ${ok ? "bg-success-soft text-success" : "bg-danger-soft text-danger"}`}><Icon name={ok ? "check" : "x"} className="size-3.5" />{children}</span>;
}

export function Trajectory({ steps }: { steps: StepRow[] }) {
  return (
    <ol className="space-y-2 text-sm">
      {steps.map((s) => {
        if (s.role === "user") {
          return (
            <li key={s.seq} className="flex justify-end">
              <div className="max-w-[80%] rounded-xl bg-user-bubble px-3 py-2 text-user-text">
                <div className="text-xs font-bold opacity-80">Patient</div>
                {String(s.content)}
              </div>
            </li>
          );
        }
        if (s.role === "assistant") {
          return (
            <li key={s.seq}>
              <div className="max-w-[80%] whitespace-pre-wrap rounded-xl bg-surface-2 px-3 py-2">
                <div className="text-xs font-bold text-muted">Assistant (sent to patient)</div>
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
              {c.decision === "call_tools" && c.tool_calls.map((t, i) => <div key={i} className="mt-1 break-all text-muted">{t.name}({JSON.stringify(t.args)})</div>)}
            </li>
          );
        }
        const t = s.content as ToolStep;
        return (
          <li key={s.seq}>
            <details className={`rounded-lg px-3 py-2 font-mono text-xs ${t.ok ? "bg-brand-soft" : "bg-warn-soft"}`}>
              <summary className="cursor-pointer">
                <Icon name={t.ok ? "check" : "alertCircle"} className="mr-1 inline size-3.5 align-[-2px]" />
                tool <b>{t.name}</b>
                {t.error ? `: ${t.error}` : ""} · {t.ms}ms <span className="text-muted">(click for args + result)</span>
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

export function RunDetail({ r, steps, openTrajectory = false }: { r: ResultRow; steps: StepRow[]; openTrajectory?: boolean }) {
  return (
    <div className="space-y-3">
      <h3 className="flex flex-wrap items-center gap-2 font-bold">
        Run {r.rep + 1} <Badge ok={r.passed}>{r.passed ? "pass" : "fail"}</Badge>
        <span className="font-normal text-muted">
          {r.turns} turns · {r.seconds}s{r.usage ? ` · ${r.usage.calls} LLM calls · ${n(r.usage.inputTokens + r.usage.outputTokens)} tokens · ${fmtUsd(r.usage.costUsd)}` : ""}
        </span>
      </h3>

      <div>
        <h2 className="mb-1 font-bold">Database checks <span className="font-normal text-muted">(did the right thing actually happen?)</span></h2>
        <ul className="space-y-1 text-sm">
          {r.checks.map((c) => (
            <li key={c.name} className={c.pass ? "" : "text-danger"}>
              <span className="inline-flex items-center gap-1.5">
                <Icon name={c.pass ? "check" : "x"} className={`size-4 ${c.pass ? "text-success" : ""}`} />
                {c.name}
                <span className="sr-only">{c.pass ? "(passed)" : "(failed)"}</span>
              </span>
              {c.detail && <div className="ml-5.5 break-all font-mono text-xs text-muted">{c.detail}</div>}
            </li>
          ))}
        </ul>
      </div>

      {isJudge(r.judge) ? (
        <div className={`rounded-xl px-4 py-3 text-sm ${r.judge.pass ? "bg-surface-2" : "bg-warn-soft"}`}>
          <div className="mb-1 font-bold">
            Judge's grade: {r.judge.pass ? "pass" : "fail"} <span className="font-normal text-muted">({r.judge.judge_model})</span>
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

      <details className="rounded-xl border border-border" open={openTrajectory}>
        <summary className="cursor-pointer px-3 py-2 text-sm">
          Full conversation, step by step: each message, each AI decision (tokens, cost, time) and each tool call (inputs and result)
        </summary>
        <div className="px-3 pb-3">
          <Trajectory steps={steps} />
        </div>
      </details>
    </div>
  );
}
