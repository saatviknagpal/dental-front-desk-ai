"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

interface ToolEvent {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  error?: string;
  ms: number;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  toolEvents?: ToolEvent[];
  failed?: boolean;
}

interface Props {
  greeting: string;
  practice: { slug: string; name: string; assistantName: string; address: string; phone: string; hoursText: string; parking: string };
}

const QUICK_REPLIES = [
  "I'm a new patient and want to book a cleaning",
  "I need to reschedule my appointment",
  "I have a dental emergency",
  "Book appointments for my family",
  "What if I don't have insurance?",
  "What are your hours and location?",
];

const TOOL_LABELS: Record<string, string> = {
  verify_patient: "Verified identity",
  register_patient: "Registered patient",
  list_appointments: "Looked up appointments",
  find_available_slots: "Checked availability",
  book_appointment: "Booked appointment",
  reschedule_appointment: "Rescheduled",
  cancel_appointment: "Cancelled",
  find_family_slots: "Checked family availability",
  book_family_appointments: "Booked family appointments",
  notify_staff: "Notified staff",
};

const SESSION_KEY = "bsd-session-id";
const PREFS_KEY = "bsd-prefs";

const store = {
  get(key: string) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      /* storage unavailable (private mode) — fine */
    }
  },
};

const uid = () => Math.random().toString(36).slice(2);

/** Minimal, safe rendering: paragraphs, "- " bullet lists, **bold**. No HTML injection. */
function RichText({ text }: { text: string }) {
  const blocks: { type: "p" | "ul"; lines: string[] }[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const isBullet = /^\s*([-•*]|\d+[.)])\s+/.test(line);
    const content = line.replace(/^\s*([-•*]|\d+[.)])\s+/, "");
    if (!line.trim()) {
      blocks.push({ type: "p", lines: [] });
      continue;
    }
    const last = blocks[blocks.length - 1];
    if (isBullet) {
      if (last?.type === "ul") last.lines.push(content);
      else blocks.push({ type: "ul", lines: [content] });
    } else if (last?.type === "p" && last.lines.length) last.lines.push(line);
    else blocks.push({ type: "p", lines: [line] });
  }
  const inline = (s: string, key: number) => (
    <span key={key}>
      {s.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
        part.startsWith("**") && part.endsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong> : <span key={i}>{part}</span>,
      )}
    </span>
  );
  return (
    <div className="space-y-2">
      {blocks
        .filter((b) => b.lines.length)
        .map((b, i) =>
          b.type === "ul" ? (
            <ul key={i} className="list-disc space-y-1 pl-5">
              {b.lines.map((l, j) => (
                <li key={j}>{inline(l, j)}</li>
              ))}
            </ul>
          ) : (
            <p key={i}>
              {b.lines.map((l, j) => (
                <span key={j}>
                  {j > 0 && <br />}
                  {inline(l, j)}
                </span>
              ))}
            </p>
          ),
        )}
    </div>
  );
}

function ToothIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 3c-2.2 0-4 1.8-4 4.3 0 2 .7 3.3 1.3 4.9.6 1.7.8 3.6 1.2 5.6.3 1.6.9 3.2 2.1 3.2 1.4 0 1.6-2 1.9-3.6.2-1.2.6-2.4 1.5-2.4h2c.9 0 1.3 1.2 1.5 2.4.3 1.6.5 3.6 1.9 3.6 1.2 0 1.8-1.6 2.1-3.2.4-2 .6-3.9 1.2-5.6.6-1.6 1.3-2.9 1.3-4.9C21 4.8 19.2 3 17 3c-1.9 0-3 1-5 1S8.9 3 7 3Z" />
    </svg>
  );
}

export default function Chat({ greeting, practice }: Props) {
  const [messages, setMessages] = useState<Message[]>([{ id: "greeting", role: "assistant", text: greeting }]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [showSteps, setShowSteps] = useState(false);
  const [largeText, setLargeText] = useState(false);
  const [rating, setRating] = useState<1 | -1 | null>(null);
  const [comment, setComment] = useState("");
  const [commentSent, setCommentSent] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Restore per-viewer prefs. Conversations always start fresh on reload (privacy on shared computers).
  useEffect(() => {
    const prefs = store.get(PREFS_KEY);
    if (prefs) {
      try {
        const p = JSON.parse(prefs);
        setShowSteps(!!p.showSteps);
        setLargeText(!!p.largeText);
      } catch {
        /* ignore */
      }
    }
    store.set(SESSION_KEY, null);
  }, []);

  useEffect(() => {
    store.set(PREFS_KEY, JSON.stringify({ showSteps, largeText }));
    document.documentElement.style.setProperty("--base-font", largeText ? "19px" : "16px");
  }, [showSteps, largeText]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, pending]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || pending) return;
      setInput("");
      const userMsg: Message = { id: uid(), role: "user", text: trimmed };
      setMessages((m) => [...m.filter((x) => !x.failed), userMsg]);
      setPending(true);
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, message: trimmed, practice: practice.slug }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Request failed");
        setSessionId(data.sessionId);
        store.set(SESSION_KEY, data.sessionId);
        setMessages((m) => [...m, { id: uid(), role: "assistant", text: data.reply, toolEvents: data.toolEvents }]);
      } catch {
        setMessages((m) => [
          ...m,
          { id: uid(), role: "assistant", failed: true, text: `Sorry, I couldn't reach the office system. Please try again, or call us at ${practice.phone}.` },
        ]);
        setInput(trimmed);
      } finally {
        setPending(false);
        inputRef.current?.focus();
      }
    },
    [pending, sessionId, practice.phone, practice.slug],
  );

  const sendFeedback = async (value: 1 | -1, text?: string) => {
    if (!sessionId) return;
    setRating(value);
    await fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, rating: value, comment: text }),
    }).catch(() => undefined);
    if (text) setCommentSent(true);
  };

  const newChat = () => {
    setMessages([{ id: "greeting", role: "assistant", text: greeting }]);
    setSessionId(null);
    store.set(SESSION_KEY, null);
    setRating(null);
    setComment("");
    setCommentSent(false);
    setInput("");
    inputRef.current?.focus();
  };

  const userCount = messages.filter((m) => m.role === "user").length;

  return (
    <div className="flex h-dvh flex-col md:flex-row">
      {/* Practice info: sidebar on desktop, collapsible on mobile */}
      <aside className="border-b border-border bg-surface md:w-80 md:shrink-0 md:border-r md:border-b-0">
        <div className="flex items-center gap-3 px-4 py-3 md:px-6 md:py-6">
          <div className="grid size-10 place-items-center rounded-xl bg-brand text-white">
            <ToothIcon className="size-6" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-semibold">{practice.name}</h1>
            <p className="text-sm text-muted">Chat with {practice.assistantName}, our virtual assistant</p>
          </div>
          <button
            type="button"
            onClick={() => setInfoOpen((v) => !v)}
            className="rounded-lg border border-border px-3 py-1.5 text-sm md:hidden"
            aria-expanded={infoOpen}
            aria-controls="practice-info"
          >
            Info
          </button>
        </div>
        <div id="practice-info" className={`${infoOpen ? "block" : "hidden"} space-y-5 px-4 pb-4 text-sm md:block md:px-6`}>
          <section>
            <h2 className="mb-1 font-medium">Hours</h2>
            <p className="text-muted">{practice.hoursText}</p>
          </section>
          <section>
            <h2 className="mb-1 font-medium">Location</h2>
            <p className="text-muted">{practice.address}</p>
            <p className="mt-1 text-muted">{practice.parking}</p>
          </section>
          <section>
            <h2 className="mb-1 font-medium">Prefer to talk to a person?</h2>
            <a className="font-medium text-brand underline-offset-2 hover:underline" href={`tel:${practice.phone.replace(/\D/g, "")}`}>
              Call {practice.phone}
            </a>
          </section>
          <section className="rounded-xl bg-danger-soft p-3 text-danger">
            <p className="font-medium">Medical emergency?</p>
            <p className="mt-0.5 opacity-90">Trouble breathing or swallowing, or swelling spreading to your eye or neck: call 911.</p>
          </section>
          <section className="space-y-2 border-t border-border pt-4">
            <h2 className="font-medium">Accessibility & display</h2>
            <label className="flex cursor-pointer items-center justify-between gap-3">
              <span>Larger text</span>
              <input type="checkbox" className="size-4 accent-[var(--brand)]" checked={largeText} onChange={(e) => setLargeText(e.target.checked)} />
            </label>
            <label className="flex cursor-pointer items-center justify-between gap-3">
              <span>Show assistant steps (demo)</span>
              <input type="checkbox" className="size-4 accent-[var(--brand)]" checked={showSteps} onChange={(e) => setShowSteps(e.target.checked)} />
            </label>
            <Link href={`/staff?practice=${practice.slug}`} className="block pt-1 text-muted underline-offset-2 hover:underline">
              Staff dashboard →
            </Link>
          </section>
        </div>
      </aside>

      {/* Chat */}
      <main className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-border bg-surface px-4 py-2.5">
          <div className="flex items-center gap-2 text-sm">
            <span className="relative flex size-2.5">
              <span className="absolute inline-flex size-full rounded-full bg-emerald-500 opacity-60" />
              <span className="relative inline-flex size-2.5 rounded-full bg-emerald-500" />
            </span>
            <span className="font-medium">{practice.assistantName}</span>
            <span className="text-muted">· usually replies in seconds</span>
          </div>
          <button type="button" onClick={newChat} className="rounded-lg px-3 py-1.5 text-sm text-muted hover:bg-surface-2">
            New chat
          </button>
        </div>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-6" role="log" aria-live="polite" aria-label="Conversation">
          <div className="mx-auto flex max-w-2xl flex-col gap-4">
            {messages.map((m) => (
              <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"} gap-2`}>
                {m.role === "assistant" && (
                  <div className="mt-1 grid size-8 shrink-0 place-items-center rounded-full bg-brand-soft text-brand" aria-hidden="true">
                    <ToothIcon className="size-4.5" />
                  </div>
                )}
                <div className="max-w-[85%]">
                  <div
                    className={
                      m.role === "user"
                        ? "rounded-2xl rounded-br-md bg-user-bubble px-4 py-2.5 text-user-text"
                        : `rounded-2xl rounded-bl-md border px-4 py-2.5 ${m.failed ? "border-danger/40 bg-danger-soft" : "border-border bg-surface"}`
                    }
                  >
                    <span className="sr-only">{m.role === "user" ? "You said:" : `${practice.assistantName} said:`}</span>
                    <RichText text={m.text} />
                  </div>
                  {showSteps && m.toolEvents && m.toolEvents.length > 0 && (
                    <ul className="mt-1.5 flex flex-wrap gap-1.5" aria-label="Assistant steps">
                      {m.toolEvents.map((t, i) => (
                        <li
                          key={i}
                          title={JSON.stringify(t.args)}
                          className={`rounded-full px-2 py-0.5 text-xs ${t.ok ? "bg-brand-soft text-brand-strong" : "bg-warn-soft text-warn"}`}
                        >
                          {t.ok ? "✓" : "!"} {TOOL_LABELS[t.name] ?? t.name}
                          {!t.ok && t.error ? ` (${t.error})` : ""}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            ))}

            {pending && (
              <div className="flex gap-2" aria-label={`${practice.assistantName} is typing`}>
                <div className="grid size-8 shrink-0 place-items-center rounded-full bg-brand-soft text-brand" aria-hidden="true">
                  <ToothIcon className="size-4.5" />
                </div>
                <div className="flex items-center gap-1 rounded-2xl rounded-bl-md border border-border bg-surface px-4 py-3">
                  <span className="typing-dot size-2 rounded-full bg-muted" />
                  <span className="typing-dot size-2 rounded-full bg-muted" />
                  <span className="typing-dot size-2 rounded-full bg-muted" />
                </div>
              </div>
            )}

            {userCount === 0 && (
              <div className="flex flex-wrap gap-2 pl-10" aria-label="Suggested questions">
                {QUICK_REPLIES.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => send(q)}
                    className="rounded-full border border-brand/30 bg-surface px-3.5 py-2 text-left text-sm text-brand-strong hover:bg-brand-soft"
                  >
                    {q}
                  </button>
                ))}
              </div>
            )}

            {userCount >= 2 && sessionId && !pending && (
              <div className="mx-auto mt-2 w-full max-w-md rounded-xl border border-border bg-surface px-4 py-3 text-sm">
                {rating === null ? (
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted">How is {practice.assistantName} doing?</span>
                    <div className="flex gap-2">
                      <button type="button" onClick={() => sendFeedback(1)} className="rounded-lg border border-border px-3 py-1 hover:bg-surface-2" aria-label="Helpful">
                        👍
                      </button>
                      <button type="button" onClick={() => sendFeedback(-1)} className="rounded-lg border border-border px-3 py-1 hover:bg-surface-2" aria-label="Not helpful">
                        👎
                      </button>
                    </div>
                  </div>
                ) : commentSent ? (
                  <p className="text-muted">Thanks, your feedback helps us improve.</p>
                ) : (
                  <form
                    className="flex gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (comment.trim()) sendFeedback(rating, comment.trim());
                    }}
                  >
                    <input
                      value={comment}
                      onChange={(e) => setComment(e.target.value)}
                      placeholder={rating === 1 ? "Thanks! Anything to add?" : "Sorry about that. What went wrong?"}
                      className="min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 py-1.5"
                      aria-label="Feedback comment"
                    />
                    <button type="submit" className="rounded-lg bg-brand px-3 py-1.5 text-white">
                      Send
                    </button>
                  </form>
                )}
              </div>
            )}
          </div>
        </div>

        <form
          className="border-t border-border bg-surface px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
        >
          <div className="mx-auto flex max-w-2xl items-end gap-2">
            <label htmlFor="chat-input" className="sr-only">
              Message {practice.assistantName}
            </label>
            <textarea
              id="chat-input"
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(input);
                }
              }}
              rows={1}
              maxLength={2000}
              placeholder="Type your message…"
              className="max-h-40 min-h-11 flex-1 resize-none rounded-xl border border-border bg-bg px-4 py-2.5 outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
              autoFocus
            />
            <button
              type="submit"
              disabled={pending || !input.trim()}
              className="h-11 rounded-xl bg-brand px-5 font-medium text-white transition hover:bg-brand-strong disabled:opacity-40"
            >
              Send
            </button>
          </div>
          <p className="mx-auto mt-2 max-w-2xl text-center text-xs text-muted">
            {practice.assistantName} is an AI assistant and can&apos;t give medical advice. For emergencies with trouble breathing, call 911.
          </p>
        </form>
      </main>
    </div>
  );
}
