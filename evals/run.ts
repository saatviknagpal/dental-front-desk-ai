// Simulated-patient eval runner ("digital humans" talking to the real agent).
//
//   npm run evals                                   # all scenarios, k=3 (pass^3)
//   npm run evals -- --only family --k 1            # quick single run of matching scenarios
//   npm run evals -- --models openai:gpt-4.1-mini,anthropic:claude-sonnet-5-5   # compare models
//   npm run evals -- --no-judge                     # skip the LLM judge
//
// Each run happens in its own worker process with its own in-memory Postgres
// (never touches the demo data) and a pinned clock, so runs are isolated and
// parallel. Results (checks + the DB records they saw, judge verdicts, full
// trajectories, tokens and cost) are saved to eval_runs / eval_results /
// eval_steps in the main database (DATABASE_URL) and shown at /evals.
// Metrics follow Bluejay's names: outcome pass rate, tool call accuracy,
// hallucination, redundancy, latency P50/P95.

import "dotenv/config";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { JudgeVerdict } from "../src/lib/judge";
import type { Usage } from "../src/lib/pricing";
import type { CheckResult, Turn } from "./scenarios";

const DONE = "[DONE]";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface Step {
  role: "user" | "llm" | "tool" | "assistant" | "guardrail";
  content: unknown;
}

interface RunResult {
  id: string;
  title: string;
  model: string;
  rep: number;
  passed: boolean;
  checks: CheckResult[];
  judge?: JudgeVerdict | { skipped: string };
  turns: Turn[];
  steps: Step[];
  usage: Usage; // agent LLM calls only (not the simulated patient or judge)
  latenciesMs: number[];
  toolCalls: number;
  toolErrors: number;
  seconds: number;
}

// ---------------------------------------------------------------------------
// Worker: run ONE scenario once, print the result as JSON on the last line.

async function worker(id: string, rep: number) {
  process.env.DATABASE_URL = "";
  process.env.PGLITE_DIR = "";
  process.env.NOW_OVERRIDE = "2026-10-23 10:00";
  process.env.STAFF_WEBHOOK_URL = "";

  const { runTurn } = await import("../src/lib/agent");
  const { closeDb, db } = await import("../src/lib/db");
  const { complete } = await import("../src/lib/llm");
  const { GREETING } = await import("../src/lib/prompt");
  const { seed } = await import("../src/lib/seed");
  const { addUsage, emptyUsage } = await import("../src/lib/pricing");
  const { judgeAvailable, judgeSession } = await import("../src/lib/judge");
  const { SCENARIOS } = await import("./scenarios");

  const s = SCENARIOS.find((x) => x.id === id)!;
  const started = Date.now();
  await seed({ reset: true });

  const patientSystem = `You are role-playing a person texting a dental office's website chat assistant. Stay in character.
Who you are: ${s.persona}
Your goal: ${s.goal}
Rules:
- Write like a real person texting: 1-2 short sentences, casual.
- Only share personal details when asked (give them exactly as listed, any format).
- When the assistant offers options, choose according to your goal. When it asks you to confirm, say yes if it matches your goal.
- Never play the assistant, never invent facts beyond the persona.
- Your goal is only done once the assistant clearly says it's booked / moved / cancelled / handled (or it clearly can't be done). If it asks you to confirm, answer yes or no; don't end the chat.
- When your goal is done, reply with exactly ${DONE}`;

  const turns: Turn[] = [];
  const latenciesMs: number[] = [];
  let usage = emptyUsage();
  let sessionId: string | undefined;
  let error: string | undefined;
  try {
    let user = s.opening;
    for (let i = 0; i < (s.maxTurns ?? 8); i++) {
      const t0 = Date.now();
      const r = await runTurn(sessionId, user);
      latenciesMs.push(Date.now() - t0);
      usage = addUsage(usage, r.usage);
      sessionId = r.sessionId;
      const turn = { user, reply: r.reply, toolEvents: r.toolEvents };
      turns.push(turn);
      if (r.degraded) throw new Error(`agent degraded: ${r.reply}`);
      if (s.afterTurn) await s.afterTurn(turn, i, sessionId);

      // From the simulated patient's point of view, the bot is the "user".
      const messages: { role: "user" | "assistant"; content: string }[] = [{ role: "user", content: GREETING }];
      for (const t of turns) messages.push({ role: "assistant", content: t.user }, { role: "user", content: t.reply });
      const res = await complete({
        systemStatic: patientSystem,
        systemDynamic: "",
        messages,
        tools: [],
        model: process.env.EVAL_PATIENT_MODEL || process.env.LLM_MODEL || "gpt-4.1-mini",
        temperature: 0.7,
      });
      user = (res.content ?? DONE).trim();
      if (user.includes(DONE)) break;
    }
  } catch (e) {
    error = (e as Error).message;
  }

  const checks: CheckResult[] = error ? [{ name: "conversation completed", pass: false, detail: error }] : await s.checks(turns);
  let judge: RunResult["judge"];
  if (process.env.EVAL_NO_JUDGE === "1") judge = { skipped: "--no-judge" };
  else if (!judgeAvailable()) judge = { skipped: "no judge API key" };
  else if (sessionId) {
    try {
      judge = await judgeSession(sessionId);
    } catch (e) {
      judge = { skipped: `judge error: ${(e as Error).message}` };
    }
  }

  // Full trajectory from the agent's own log: user, llm (decision + tokens + cost), tool (args + result), assistant.
  const steps: Step[] = sessionId
    ? (await db.all<{ role: Step["role"]; content: string }>("SELECT role, content FROM messages WHERE session_id = $1 ORDER BY id", [sessionId])).map((m) => {
        if (m.role === "llm" || m.role === "tool" || m.role === "guardrail") {
          try {
            return { role: m.role, content: JSON.parse(m.content) };
          } catch {
            /* fall through */
          }
        }
        return { role: m.role, content: m.content };
      })
    : [];

  const events = turns.flatMap((t) => t.toolEvents);
  const judgePass = !judge || "skipped" in judge || judge.pass;
  const result: RunResult = {
    id: s.id,
    title: s.title,
    model: `${process.env.LLM_PROVIDER}:${process.env.LLM_MODEL || "gpt-4.1-mini"}`,
    rep,
    passed: checks.every((c) => c.pass) && judgePass,
    checks,
    judge,
    turns,
    steps,
    usage,
    latenciesMs,
    toolCalls: events.length,
    toolErrors: events.filter((e) => !e.ok).length,
    seconds: Math.round((Date.now() - started) / 1000),
  };
  await closeDb();
  process.stdout.write(`\n@@RESULT@@${JSON.stringify(result)}\n`);
}

// ---------------------------------------------------------------------------
// Orchestrator

function runWorker(id: string, rep: number, env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...process.execArgv, __filename, "--worker", id, "--rep", String(rep)], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", () => {
      const line = out.split("\n").find((l) => l.startsWith("@@RESULT@@"));
      if (line) return resolve(JSON.parse(line.slice("@@RESULT@@".length)));
      resolve({
        id,
        title: id,
        model: `${env.LLM_PROVIDER}:${env.LLM_MODEL || "default"}`,
        rep,
        passed: false,
        checks: [{ name: "worker crashed", pass: false, detail: err.slice(-800) }],
        turns: [],
        steps: [],
        usage: { calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0, llmMs: 0 },
        latenciesMs: [],
        toolCalls: 0,
        toolErrors: 0,
        seconds: 0,
      });
    });
  });
}

async function pool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

const isJudge = (j: RunResult["judge"]): j is JudgeVerdict => !!j && !("skipped" in j);

function computeMetrics(results: RunResult[], k: number, scenarioIds: string[]) {
  const lat = results.flatMap((r) => r.latenciesMs);
  const judged = results.map((r) => r.judge).filter(isJudge);
  const calls = results.reduce((a, r) => a + r.toolCalls, 0);
  const errs = results.reduce((a, r) => a + r.toolErrors, 0);
  const n = results.length || 1;
  const sum = (f: (r: RunResult) => number) => results.reduce((a, r) => a + f(r), 0);
  return {
    pass_k: scenarioIds.filter((id) => results.filter((r) => r.id === id).every((r) => r.passed)).length,
    runs_passed: results.filter((r) => r.passed).length,
    tool_calls: calls,
    tool_success_rate: calls ? (calls - errs) / calls : 0,
    hallucination_rate: judged.length ? judged.filter((j) => j.hallucination).length / judged.length : null,
    redundancy_avg: judged.length ? judged.reduce((a, j) => a + j.redundancy, 0) / judged.length : null,
    tone_avg: judged.length ? judged.reduce((a, j) => a + j.tone, 0) / judged.length : null,
    clarity_avg: judged.length ? judged.reduce((a, j) => a + j.clarity, 0) / judged.length : null,
    judge_model: judged[0]?.judge_model ?? null,
    latency_p50_ms: pct(lat, 50),
    latency_p95_ms: pct(lat, 95),
    agent_llm_calls: sum((r) => r.usage.calls),
    input_tokens: sum((r) => r.usage.inputTokens),
    cached_input_tokens: sum((r) => r.usage.cachedInputTokens),
    output_tokens: sum((r) => r.usage.outputTokens),
    cost_usd: sum((r) => r.usage.costUsd),
    avg_cost_per_conversation_usd: sum((r) => r.usage.costUsd) / n,
    avg_tokens_per_conversation: sum((r) => r.usage.inputTokens + r.usage.outputTokens) / n,
    judge_cost_usd: judged.reduce((a, j) => a + (j.usage?.costUsd ?? 0), 0),
  };
}

async function saveToDb(startedAt: string, model: string, k: number, scenarioIds: string[], results: RunResult[], metrics: ReturnType<typeof computeMetrics>) {
  const { transaction } = await import("../src/lib/db");
  return transaction(async (tx) => {
    const run = await tx.get<{ id: number }>(
      `INSERT INTO eval_runs (started_at, model, judge_model, k, scenarios, pass_k, runs_passed, runs_total, metrics)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [startedAt, model, metrics.judge_model, k, scenarioIds.length, metrics.pass_k, metrics.runs_passed, results.length, JSON.stringify(metrics)],
    );
    for (const r of results) {
      const res = await tx.get<{ id: number }>(
        `INSERT INTO eval_results (run_id, scenario_id, title, rep, passed, checks, judge, usage, turns, seconds, latencies_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [run!.id, r.id, r.title, r.rep, r.passed, JSON.stringify(r.checks), r.judge ? JSON.stringify(r.judge) : null, JSON.stringify(r.usage), r.turns.length, r.seconds, JSON.stringify(r.latenciesMs)],
      );
      for (let i = 0; i < r.steps.length; i++) {
        await tx.run("INSERT INTO eval_steps (result_id, seq, role, content) VALUES ($1,$2,$3,$4)", [res!.id, i, r.steps[i].role, JSON.stringify(r.steps[i].content)]);
      }
    }
    return run!.id;
  });
}

async function main() {
  const { SCENARIOS } = await import("./scenarios");
  const only = arg("only");
  const k = Number(arg("k") || 3);
  const concurrency = Number(arg("concurrency") || 4);
  const scenarios = SCENARIOS.filter((s) => !only || s.id.includes(only));
  const scenarioIds = scenarios.map((s) => s.id);
  const models = (arg("models") || `${process.env.LLM_PROVIDER || "openai"}:${process.env.LLM_MODEL || "gpt-4.1-mini"}`).split(",").map((m) => {
    const [provider, ...rest] = m.split(":");
    return { provider, model: rest.join(":") };
  });

  const all: RunResult[] = [];
  for (const m of models) {
    const startedAt = new Date().toISOString().slice(0, 16).replace("T", " ");
    const env = { ...process.env, LLM_PROVIDER: m.provider, LLM_MODEL: m.model, EVAL_NO_JUDGE: process.argv.includes("--no-judge") ? "1" : "" };
    const label = `${m.provider}:${m.model || "default"}`;
    console.log(`\n=== ${label} — ${scenarios.length} scenarios × k=${k} (concurrency ${concurrency}) ===`);
    const jobs = scenarios.flatMap((s) => Array.from({ length: k }, (_, rep) => ({ id: s.id, rep })));
    const results = await pool(jobs, concurrency, async (j) => {
      const r = await runWorker(j.id, j.rep, env);
      console.log(`  ${r.passed ? "pass" : "FAIL"}  ${j.id} #${j.rep + 1}  (${r.turns.length} turns, ${r.seconds}s, $${r.usage.costUsd.toFixed(4)})`);
      return r;
    });
    all.push(...results);

    console.log(`\n${"scenario".padEnd(28)} pass^${k}  runs   failures`);
    for (const s of scenarios) {
      const rs = results.filter((r) => r.id === s.id);
      const ok = rs.filter((r) => r.passed).length;
      const failed = [
        ...new Set(
          rs.flatMap((r) => [
            ...r.checks.filter((c) => !c.pass).map((c) => c.name + (c.detail ? ` (${c.detail.slice(0, 80)})` : "")),
            ...(isJudge(r.judge) && !r.judge.pass ? [`judge: ${[r.judge.summary, ...r.judge.policy_violations].join("; ").slice(0, 120)}`] : []),
          ]),
        ),
      ];
      console.log(`${s.id.padEnd(28)} ${ok === rs.length ? " yes " : " no  "}   ${ok}/${rs.length}    ${failed.join(" | ")}`);
    }

    const mt = computeMetrics(results, k, scenarioIds);
    console.log(`\nMetrics (${label})`);
    console.log(`  Outcome pass rate:   ${mt.runs_passed}/${results.length} runs; pass^${k}: ${mt.pass_k}/${scenarios.length} scenarios`);
    console.log(`  Tool call accuracy:  ${Math.round(100 * mt.tool_success_rate)}% of ${mt.tool_calls} tool calls succeeded (failures are often expected, e.g. SLOT_TAKEN)`);
    if (mt.judge_model) {
      console.log(`  Hallucination rate:  ${Math.round(100 * (mt.hallucination_rate ?? 0))}%  (judge: ${mt.judge_model})`);
      console.log(`  Redundancy:          ${(mt.redundancy_avg ?? 0).toFixed(2)} re-asks per conversation`);
      console.log(`  Tone / clarity:      ${(mt.tone_avg ?? 0).toFixed(1)} / ${(mt.clarity_avg ?? 0).toFixed(1)} (out of 5)`);
    } else {
      console.log(`  LLM judge:           skipped`);
    }
    console.log(`  Latency per turn:    P50 ${(mt.latency_p50_ms / 1000).toFixed(1)}s, P95 ${(mt.latency_p95_ms / 1000).toFixed(1)}s`);
    console.log(`  Tokens:              ${Math.round(mt.avg_tokens_per_conversation).toLocaleString()} per conversation (${mt.cached_input_tokens.toLocaleString()} of ${mt.input_tokens.toLocaleString()} input tokens cached)`);
    console.log(`  Cost:                $${mt.avg_cost_per_conversation_usd.toFixed(4)} per conversation → ~$${(mt.avg_cost_per_conversation_usd * 10_000).toFixed(0)}/day at 10k conversations (agent only)`);

    try {
      const runId = await saveToDb(startedAt, label, k, scenarioIds, results, mt);
      console.log(`  Saved: eval run #${runId} → /evals?run=${runId}`);
    } catch (e) {
      console.log(`  (Could not save to DB: ${(e as Error).message})`);
    }
  }

  const dir = path.join(__dirname, "results");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify(all, null, 2));
  console.log(`\nRaw JSON copy: ${path.relative(process.cwd(), file)}`);
  const { closeDb } = await import("../src/lib/db");
  await closeDb();
  process.exitCode = all.every((r) => r.passed) ? 0 : 1;
}

if (process.argv.includes("--worker")) {
  worker(arg("worker")!, Number(arg("rep") || 0)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
