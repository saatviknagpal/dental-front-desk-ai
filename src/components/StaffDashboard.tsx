"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { fmtUsd, type Usage } from "@/lib/pricing";
import Icon from "./Icon";

interface Notification {
  id: number;
  type: "emergency" | "human_handoff" | "callback";
  urgency: "high" | "normal";
  summary: string;
  patient_name: string | null;
  patient_phone: string | null;
  acknowledged: boolean;
  created_at: string;
  session_id: string | null;
}

interface Appointment {
  id: number;
  label: string;
  display: string;
  status: string;
  patient_name: string;
  provider_name: string;
  insurance_name: string | null;
  emergency_summary: string | null;
  via_chat: boolean;
  type: string;
}

interface SessionSummary {
  id: string;
  started_at: string;
  last_active_at: string;
  model: string | null;
  rating: number | null;
  feedback_comment: string | null;
  user_messages: number;
  first_message: string | null;
  tool_errors: number;
  judge: { pass: boolean; tone: number; summary: string; policy_violations: string[]; hallucination: boolean } | null;
  usage: Usage | null;
}

interface Dashboard {
  now: string;
  stats: { openAlerts: number; conversations: number; chatBookings: number; thumbsUp: number; thumbsDown: number; avgCostUsd: number };
  notifications: Notification[];
  appointments: Appointment[];
  sessions: SessionSummary[];
  demoResetAllowed: boolean;
  practice: { slug: string; name: string };
  practices: { slug: string; name: string }[];
  admin: boolean;
  failedJobs: { id: string; type: string; attempts: number; last_error: string | null; created_at: string; to: string | null; text: string | null }[];
}

interface TranscriptMessage {
  id: number;
  role: "user" | "assistant" | "tool" | "llm" | "guardrail";
  content: string;
  created_at: string;
}

const TYPE_STYLE: Record<Notification["type"], { label: string; cls: string }> = {
  emergency: { label: "Emergency", cls: "bg-danger-soft text-danger" },
  human_handoff: { label: "Needs a human", cls: "bg-warn-soft text-warn" },
  callback: { label: "Callback", cls: "bg-info-soft text-info" },
};

function Card({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-surface">
      <header className="flex items-center justify-between border-b border-border px-5 py-3">
        <h2 className="font-semibold">{title}</h2>
        {right}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

function Transcript({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [messages, setMessages] = useState<TranscriptMessage[] | null>(null);
  useEffect(() => {
    fetch(`/api/staff/sessions/${sessionId}`)
      .then((r) => r.json())
      .then((d) => setMessages(d.messages))
      .catch(() => setMessages([]));
  }, [sessionId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-20 flex justify-end bg-black/40" onClick={onClose}>
      <aside
        className="flex h-full w-full max-w-xl flex-col bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Conversation transcript"
      >
        <header className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="font-semibold">Transcript</h2>
          <button type="button" onClick={onClose} autoFocus className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-sm hover:bg-surface-2">
            <Icon name="close" className="size-4" />
            Close
          </button>
        </header>
        <div className="flex-1 space-y-3 overflow-y-auto p-5 text-sm">
          {messages === null && <p className="text-muted">Loading…</p>}
          {messages?.map((m) => {
            if (m.role === "guardrail") {
              return (
                <div key={m.id} className="rounded-lg bg-danger-soft px-3 py-1.5 font-mono text-xs text-danger">
                  Guardrail triggered: {m.content}
                </div>
              );
            }
            if (m.role === "llm") {
              let c: { step?: number; model?: string; decision?: string; tool_calls?: { name: string }[]; inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; costUsd?: number; llmMs?: number } = {};
              try {
                c = JSON.parse(m.content);
              } catch {
                /* ignore */
              }
              return (
                <div key={m.id} className="rounded-lg border border-dashed border-border px-3 py-1.5 font-mono text-xs text-muted">
                  LLM step {c.step} · {c.model} · {c.decision === "call_tools" ? `calls ${c.tool_calls?.map((t) => t.name).join(", ")}` : "replies"} · {c.inputTokens} in ({c.cachedInputTokens} cached) / {c.outputTokens} out · {fmtUsd(c.costUsd ?? 0)} · {c.llmMs}ms
                </div>
              );
            }
            if (m.role === "tool") {
              let parsed: { name?: string; ok?: boolean; error?: string; args?: unknown } = {};
              try {
                parsed = JSON.parse(m.content);
              } catch {
                /* ignore */
              }
              return (
                <details key={m.id} className={`rounded-lg px-3 py-2 font-mono text-xs ${parsed.ok ? "bg-brand-soft" : "bg-warn-soft"}`}>
                  <summary className="inline-flex cursor-pointer items-center gap-1.5">
                    <Icon name={parsed.ok ? "check" : "alertCircle"} className="size-3.5" />
                    {parsed.name}
                    {parsed.error ? `: ${parsed.error}` : ""}
                  </summary>
                  <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all">{JSON.stringify(JSON.parse(m.content), null, 2)}</pre>
                </details>
              );
            }
            return (
              <div key={m.id} className={m.role === "user" ? "text-right" : ""}>
                <div className={`inline-block max-w-[90%] whitespace-pre-wrap rounded-xl px-3 py-2 text-left ${m.role === "user" ? "bg-user-bubble text-user-text" : "bg-surface-2"}`}>
                  {m.content}
                </div>
                <div className="mt-0.5 text-xs text-muted">{m.created_at.slice(11)}</div>
              </div>
            );
          })}
        </div>
      </aside>
    </div>
  );
}

export default function StaffDashboard() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState(false);
  const [openSession, setOpenSession] = useState<string | null>(null);
  const [showCancelled, setShowCancelled] = useState(false);

  const load = useCallback(async () => {
    try {
      const slug = new URLSearchParams(window.location.search).get("practice") ?? "";
      const r = await fetch(`/api/staff?practice=${encodeURIComponent(slug)}`, { cache: "no-store" });
      setData(await r.json());
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const ack = async (id: number, acknowledged: boolean) => {
    await fetch(`/api/staff/notifications/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ acknowledged }) });
    load();
  };

  const retryJob = async (id: string) => {
    await fetch(`/api/staff/jobs/${id}?practice=${data?.practice.slug ?? ""}`, { method: "POST" });
    load();
  };

  const reset = async () => {
    if (!window.confirm("Reset all demo data (patients, appointments, chats)?")) return;
    await fetch("/api/staff/reset", { method: "POST" });
    load();
  };

  if (!data) return <div className="p-10 text-muted">{error ? "Couldn't load the dashboard." : "Loading…"}</div>;

  const satisfaction = data.stats.thumbsUp + data.stats.thumbsDown ? Math.round((100 * data.stats.thumbsUp) / (data.stats.thumbsUp + data.stats.thumbsDown)) : null;
  const appts = data.appointments.filter((a) => showCancelled || a.status === "booked");

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-6 md:px-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-brand text-on-brand" aria-hidden="true">
            <Icon name="tooth" className="size-6" />
          </div>
          <div>
          <h1 className="text-2xl font-bold">Front desk dashboard</h1>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
            <select
              aria-label="Practice"
              value={data.practice.slug}
              onChange={(e) => {
                window.history.replaceState(null, "", `/staff?practice=${e.target.value}`);
                setData(null);
                load();
              }}
              className="min-h-9 rounded-lg border border-border bg-surface px-2 text-text"
            >
              {data.practices.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.name}
                </option>
              ))}
            </select>
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-success" aria-hidden="true" />
              Live, refreshes every 5s · {data.now}
            </span>
          </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={`/p/${data.practice.slug}`} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-border px-3 text-sm hover:bg-surface-2">
            <Icon name="external" className="size-4" />
            Open patient chat
          </Link>
          {data.admin && (
            <Link href="/evals" className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-border px-3 text-sm hover:bg-surface-2">
              <Icon name="checkCircle" className="size-4" />
              Eval report
            </Link>
          )}
          {data.demoResetAllowed && (
            <button type="button" onClick={reset} className="inline-flex min-h-10 items-center rounded-lg border border-danger/30 px-3 text-sm text-danger hover:bg-danger-soft">
              Reset demo data
            </button>
          )}
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          { label: "Open alerts", value: data.stats.openAlerts, accent: data.stats.openAlerts ? "text-danger" : "" },
          { label: "Conversations", value: data.stats.conversations },
          { label: "Booked via chat", value: data.stats.chatBookings, sub: `avg ${fmtUsd(data.stats.avgCostUsd)} LLM cost / chat` },
          { label: "Satisfaction", value: satisfaction === null ? "—" : `${satisfaction}%`, sub: `${data.stats.thumbsUp} helpful · ${data.stats.thumbsDown} not helpful` },
        ].map((s) => (
          <div key={s.label} className="rounded-2xl border border-border bg-surface px-5 py-4">
            <div className="text-sm text-muted">{s.label}</div>
            <div className={`mt-1 text-2xl font-bold tabular-nums ${s.accent ?? ""}`}>{s.value}</div>
            {s.sub && <div className="text-xs text-muted">{s.sub}</div>}
          </div>
        ))}
      </div>

      {data.failedJobs.length > 0 && (
        <Card title="Delivery problems">
          <ul className="space-y-2 text-sm">
            {data.failedJobs.map((j) => (
              <li key={j.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border px-3 py-2">
                <div className="min-w-0">
                  <div className="font-medium">{j.type === "booking_confirmation" ? `Confirmation email to ${j.to}` : `Staff alert: ${j.text ?? ""}`}</div>
                  <div className="truncate text-xs text-muted">{j.last_error}</div>
                </div>
                <button type="button" onClick={() => retryJob(j.id)} className="min-h-9 rounded-lg border border-border px-3 text-sm font-bold text-brand-strong hover:bg-surface-2">
                  Retry
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <Card title="Alerts">
            {data.notifications.length === 0 ? (
              <p className="text-sm text-muted">No alerts. Emergencies and handoff requests from the chat show up here.</p>
            ) : (
              <ul className="space-y-3">
                {data.notifications.map((n) => (
                  <li key={n.id} className={`rounded-xl border border-border p-3 ${n.acknowledged ? "opacity-55" : ""}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${TYPE_STYLE[n.type]?.cls ?? ""}`}>
                        {TYPE_STYLE[n.type]?.label ?? n.type}
                        {n.urgency === "high" ? " · urgent" : ""}
                      </span>
                      <span className="text-xs text-muted">{n.created_at}</span>
                    </div>
                    <p className="mt-2 text-sm">{n.summary}</p>
                    {(n.patient_name || n.patient_phone) && (
                      <p className="mt-1 text-xs text-muted">
                        {n.patient_name} {n.patient_phone ? `· ${n.patient_phone.replace(/(\d{3})(\d{3})(\d{4})/, "($1) $2-$3")}` : ""}
                      </p>
                    )}
                    <div className="mt-3 flex gap-2 text-sm">
                      <button type="button" onClick={() => ack(n.id, !n.acknowledged)} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border px-3 font-bold text-brand-strong hover:bg-surface-2">
                        {!n.acknowledged && <Icon name="check" className="size-4" />}
                        {n.acknowledged ? "Re-open" : "Mark handled"}
                      </button>
                      {n.session_id && (
                        <button type="button" onClick={() => setOpenSession(n.session_id)} className="min-h-9 rounded-lg px-3 text-muted hover:bg-surface-2 hover:text-text">
                          View chat
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="lg:col-span-3">
          <Card
            title="Upcoming appointments (3 weeks)"
            right={
              <label className="flex items-center gap-2 text-sm text-muted">
                <input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} className="accent-[var(--brand)]" />
                Show cancelled
              </label>
            }
          >
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-sm">
                <thead className="text-xs text-muted">
                  <tr>
                    <th className="pb-2 font-medium">When</th>
                    <th className="pb-2 font-medium">Patient</th>
                    <th className="pb-2 font-medium">Visit</th>
                    <th className="pb-2 font-medium">Provider</th>
                    <th className="pb-2 font-medium">Insurance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {appts.map((a) => (
                    <tr key={a.id} className={a.status === "cancelled" ? "text-muted line-through" : ""}>
                      <td className="py-2 pr-3 whitespace-nowrap">{a.display}</td>
                      <td className="py-2 pr-3">
                        {a.patient_name}
                        {a.via_chat && <span className="ml-1.5 rounded bg-brand-soft px-1.5 py-0.5 text-xs text-brand-strong no-underline">chat</span>}
                      </td>
                      <td className="py-2 pr-3">
                        <span className={a.type === "emergency" ? "font-medium text-danger" : ""}>{a.label}</span>
                        {a.emergency_summary && <div className="text-xs text-muted">{a.emergency_summary}</div>}
                      </td>
                      <td className="py-2 pr-3 whitespace-nowrap">{a.provider_name}</td>
                      <td className="py-2">{a.insurance_name ?? <span className="text-muted">Self-pay</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      </div>

      <Card title="Recent conversations (feedback loop)">
        {data.sessions.length === 0 ? (
          <p className="text-sm text-muted">No conversations yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="text-xs text-muted">
                <tr>
                  <th className="pb-2 font-medium">Last active</th>
                  <th className="pb-2 font-medium">First message</th>
                  <th className="pb-2 font-medium">Turns</th>
                  <th className="pb-2 font-medium">Tool errors</th>
                  <th className="pb-2 font-medium">Tokens · cost</th>
                  <th className="pb-2 font-medium">Rating</th>
                  <th className="pb-2 font-medium">AI review</th>
                  <th className="pb-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.sessions.map((s) => (
                  <tr key={s.id}>
                    <td className="py-2 pr-3 whitespace-nowrap">{s.last_active_at}</td>
                    <td className="max-w-xs truncate py-2 pr-3">{s.first_message ?? "—"}</td>
                    <td className="py-2 pr-3">{s.user_messages}</td>
                    <td className={`py-2 pr-3 ${s.tool_errors ? "text-warn" : "text-muted"}`}>{s.tool_errors}</td>
                    <td className="py-2 pr-3 whitespace-nowrap text-muted">
                      {s.usage ? `${(s.usage.inputTokens + s.usage.outputTokens).toLocaleString()} · ${fmtUsd(s.usage.costUsd)}` : "—"}
                    </td>
                    <td className="py-2 pr-3">
                      {s.rating === 1 ? (
                        <span className="inline-flex items-center gap-1 text-success"><Icon name="thumbsUp" className="size-4" />Helpful</span>
                      ) : s.rating === -1 ? (
                        <span className="inline-flex items-center gap-1 text-danger"><Icon name="thumbsDown" className="size-4" />Not helpful</span>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                      {s.feedback_comment && <div className="text-xs text-muted">“{s.feedback_comment}”</div>}
                    </td>
                    <td className="py-2 pr-3" title={s.judge ? [s.judge.summary, ...s.judge.policy_violations].join(" · ") : "Not reviewed yet (npm run evals:prod)"}>
                      {!s.judge ? (
                        <span className="text-muted">—</span>
                      ) : s.judge.pass ? (
                        <span className="rounded-full bg-brand-soft px-2 py-0.5 text-xs text-brand-strong">ok · tone {s.judge.tone}/5</span>
                      ) : (
                        <span className="rounded-full bg-warn-soft px-2 py-0.5 text-xs text-warn">flagged</span>
                      )}
                    </td>
                    <td className="py-2 text-right">
                      <button type="button" onClick={() => setOpenSession(s.id)} className="min-h-9 rounded-lg px-3 font-bold text-brand-strong hover:bg-surface-2">
                        View
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {openSession && <Transcript sessionId={openSession} onClose={() => setOpenSession(null)} />}
    </div>
  );
}
