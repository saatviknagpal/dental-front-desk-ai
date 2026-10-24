"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import BookingCard, { type Booking } from "./BookingCard";
import Icon, { type IconName } from "./Icon";

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
  bookings?: Booking[];
  choices?: { label: string; message: string }[];
  failed?: boolean;
}

interface Props {
  greeting: string;
  practice: { slug: string; name: string; assistantName: string; address: string; phone: string; hoursText: string; parking: string; timezone: string };
}

const QUICK_REPLIES: { icon: IconName; title: string; hint: string; message: string }[] = [
  { icon: "calendarPlus", title: "Book a cleaning", hint: "New patient visit", message: "I'm a new patient and want to book a cleaning" },
  { icon: "calendarClock", title: "Reschedule", hint: "Move an existing visit", message: "I need to reschedule my appointment" },
  { icon: "alert", title: "Dental emergency", hint: "Pain, swelling or a broken tooth", message: "I have a dental emergency" },
  { icon: "users", title: "Family visits", hint: "Book for several people", message: "Book appointments for my family" },
  { icon: "wallet", title: "No insurance?", hint: "Self-pay and payment plans", message: "What if I don't have insurance?" },
  { icon: "mapPin", title: "Hours & location", hint: "Address and parking", message: "What are your hours and location?" },
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

export default function Chat({ greeting, practice }: Props) {
  const [messages, setMessages] = useState<Message[]>([{ id: "greeting", role: "assistant", text: greeting }]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [showSteps, setShowSteps] = useState(false);
  const [largeText, setLargeText] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  const [rating, setRating] = useState<1 | -1 | null>(null);
  const [comment, setComment] = useState("");
  const [commentSent, setCommentSent] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Resending the same text after a failure reuses its request id, so the server never runs it twice.
  const retryRef = useRef<{ text: string; id: string } | null>(null);

  // Restore per-viewer prefs. Conversations always start fresh on reload (privacy on shared computers).
  useEffect(() => {
    const prefs = store.get(PREFS_KEY);
    if (prefs) {
      try {
        const p = JSON.parse(prefs);
        setShowSteps(!!p.showSteps);
        setLargeText(!!p.largeText);
        setDarkMode(!!p.darkMode);
      } catch {
        /* ignore */
      }
    }
    store.set(SESSION_KEY, null);
  }, []);

  useEffect(() => {
    store.set(PREFS_KEY, JSON.stringify({ showSteps, largeText, darkMode }));
    document.documentElement.style.setProperty("--base-font", largeText ? "19px" : "16px");
    document.documentElement.dataset.theme = darkMode ? "dark" : "light";
  }, [showSteps, largeText, darkMode]);

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
      const requestId = retryRef.current?.text === trimmed ? retryRef.current.id : crypto.randomUUID();
      retryRef.current = { text: trimmed, id: requestId };
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, message: trimmed, practice: practice.slug, requestId }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Request failed");
        retryRef.current = null;
        setSessionId(data.sessionId);
        store.set(SESSION_KEY, data.sessionId);
        setMessages((m) => [...m, { id: uid(), role: "assistant", text: data.reply, toolEvents: data.toolEvents, bookings: data.bookings, choices: data.choices }]);
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
    setInfoOpen(false);
    inputRef.current?.focus();
  };

  const userCount = messages.filter((m) => m.role === "user").length;
  const tel = `tel:${practice.phone.replace(/\D/g, "")}`;

  const avatar = (
    <div className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-brand-soft text-brand" aria-hidden="true">
      <Icon name="tooth" className="size-4.5" />
    </div>
  );

  return (
    <div className="flex h-dvh flex-col">
      <header className="border-b border-border bg-surface">
        <div className="flex items-center gap-3 px-4 py-3 lg:px-6">
          <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand text-on-brand" aria-hidden="true">
            <Icon name="tooth" className="size-6" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-bold sm:text-lg">{practice.name}</h1>
            <p className="flex items-center gap-1.5 truncate text-sm text-muted">
              <span className="size-2 shrink-0 rounded-full bg-success" aria-hidden="true" />
              {practice.assistantName}, virtual front desk
            </p>
          </div>
          <a href={tel} className="hidden h-10 items-center gap-2 rounded-lg border border-border px-3 text-sm font-bold hover:bg-surface-2 sm:inline-flex">
            <Icon name="phone" className="size-4" />
            {practice.phone}
          </a>
          <button type="button" onClick={newChat} className="inline-flex h-10 items-center gap-2 rounded-lg border border-border px-3 text-sm hover:bg-surface-2">
            <Icon name="newChat" className="size-4" />
            <span className="max-sm:sr-only">New chat</span>
          </button>
          <button
            type="button"
            onClick={() => setInfoOpen((v) => !v)}
            className="inline-flex h-10 items-center gap-2 rounded-lg border border-border px-3 text-sm hover:bg-surface-2 lg:hidden"
            aria-expanded={infoOpen}
            aria-controls="practice-info"
          >
            <Icon name={infoOpen ? "close" : "info"} className="size-4" />
            <span className="max-sm:sr-only">{infoOpen ? "Close" : "Info"}</span>
          </button>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1">
        <main className="flex min-h-0 flex-1 flex-col">
          <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-6" role="log" aria-live="polite" aria-label="Conversation">
            <div className="mx-auto flex max-w-3xl flex-col gap-5">
              {messages.map((m) => (
                <div key={m.id} className={`msg-in flex gap-2.5 ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                  {m.role === "assistant" && avatar}
                  <div className="min-w-0 max-w-[85%] sm:max-w-[75%]">
                    <div
                      className={`px-4 py-3 [overflow-wrap:anywhere] ${
                        m.role === "user"
                          ? "rounded-2xl rounded-tr-md bg-user-bubble text-user-text"
                          : `rounded-2xl rounded-tl-md border ${m.failed ? "border-danger/40 bg-danger-soft" : "border-border bg-surface"}`
                      }`}
                    >
                      <span className="sr-only">{m.role === "user" ? "You said:" : `${practice.assistantName} said:`}</span>
                      <RichText text={m.text} />
                    </div>
                    {m.bookings?.map((b) => <BookingCard key={b.appointment_id} booking={b} practice={practice} />)}
                    {m.choices && m.choices.length > 0 && m.id === messages[messages.length - 1]?.id && !pending && (
                      <div className="mt-3" role="group" aria-label="Available times">
                        <p className="mb-2 text-sm text-muted">Tap a time to book it</p>
                        <div className="flex flex-wrap gap-2">
                          {m.choices.map((c) => (
                            <button
                              key={c.label}
                              type="button"
                              onClick={() => send(c.message)}
                              className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-border bg-surface px-3.5 text-left text-sm font-bold text-brand-strong transition-colors hover:border-brand hover:bg-brand-soft"
                            >
                              <Icon name="clock" className="size-4" />
                              {c.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {showSteps && m.toolEvents && m.toolEvents.length > 0 && (
                      <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Assistant steps">
                        {m.toolEvents.map((t, i) => (
                          <li
                            key={i}
                            title={JSON.stringify(t.args)}
                            className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs ${t.ok ? "bg-surface-2 text-muted" : "bg-warn-soft text-warn"}`}
                          >
                            <Icon name={t.ok ? "check" : "alertCircle"} className="size-3.5" />
                            {TOOL_LABELS[t.name] ?? t.name}
                            {!t.ok && t.error ? ` (${t.error})` : ""}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              ))}

              {pending && (
                <div className="flex gap-2.5">
                  {avatar}
                  <div className="flex items-center gap-1 rounded-2xl rounded-tl-md border border-border bg-surface px-4 py-3.5">
                    <span className="sr-only">{practice.assistantName} is typing</span>
                    <span className="typing-dot size-2 rounded-full bg-muted" />
                    <span className="typing-dot size-2 rounded-full bg-muted" />
                    <span className="typing-dot size-2 rounded-full bg-muted" />
                  </div>
                </div>
              )}

              {userCount === 0 && (
                <div className="sm:pl-10.5" role="group" aria-label="Suggested questions">
                  <p className="mb-2 text-sm text-muted">Or pick one to get started</p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {QUICK_REPLIES.map((q) => (
                      <button
                        key={q.title}
                        type="button"
                        onClick={() => send(q.message)}
                        className="flex min-h-14 items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2.5 text-left transition-colors hover:border-brand hover:bg-brand-soft"
                      >
                        <span className={`grid size-9 shrink-0 place-items-center rounded-lg ${q.icon === "alert" ? "bg-danger-soft text-danger" : "bg-brand-soft text-brand"}`}>
                          <Icon name={q.icon} className="size-4.5" />
                        </span>
                        <span className="min-w-0">
                          <span className="block text-sm font-bold">{q.title}</span>
                          <span className="block text-sm text-muted">{q.hint}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {userCount >= 2 && sessionId && !pending && (
                <div className="mx-auto mt-2 w-full max-w-md rounded-xl border border-border bg-surface px-4 py-3 text-sm">
                  {rating === null ? (
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-muted">How is {practice.assistantName} doing?</span>
                      <div className="flex gap-2">
                        <button type="button" onClick={() => sendFeedback(1)} className="grid size-10 place-items-center rounded-lg border border-border text-muted hover:bg-surface-2 hover:text-text" aria-label="Helpful">
                          <Icon name="thumbsUp" className="size-4.5" />
                        </button>
                        <button type="button" onClick={() => sendFeedback(-1)} className="grid size-10 place-items-center rounded-lg border border-border text-muted hover:bg-surface-2 hover:text-text" aria-label="Not helpful">
                          <Icon name="thumbsDown" className="size-4.5" />
                        </button>
                      </div>
                    </div>
                  ) : commentSent ? (
                    <p className="flex items-center gap-2 text-muted">
                      <Icon name="checkCircle" className="size-4 text-success" />
                      Thanks, your feedback helps us improve.
                    </p>
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
                        className="min-h-10 min-w-0 flex-1 rounded-lg border border-border bg-bg px-3"
                        aria-label="Feedback comment"
                      />
                      <button type="submit" className="min-h-10 rounded-lg bg-brand px-3 font-bold text-on-brand hover:bg-brand-strong">
                        Send
                      </button>
                    </form>
                  )}
                </div>
              )}
            </div>
          </div>

          <form
            className="border-t border-border bg-surface px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
          >
            <div className="mx-auto max-w-3xl">
              <div className="flex items-end gap-2 rounded-2xl border border-border bg-bg p-1.5 transition-colors focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/20">
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
                  placeholder={`Message ${practice.assistantName}…`}
                  className="max-h-40 min-h-11 flex-1 resize-none bg-transparent px-3 py-2.5 [field-sizing:content] placeholder:text-muted focus-visible:outline-none"
                  autoFocus
                />
                <button
                  type="submit"
                  disabled={pending || !input.trim()}
                  aria-label="Send message"
                  className="grid size-11 shrink-0 place-items-center rounded-xl bg-brand text-on-brand transition-colors hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Icon name="arrowUp" className="size-5" />
                </button>
              </div>
              <p className="mt-2 text-center text-xs text-muted">
                {practice.assistantName} is an AI assistant and can&apos;t give medical advice. For emergencies with trouble breathing, call 911.
              </p>
            </div>
          </form>
        </main>

        <aside
          id="practice-info"
          onKeyDown={(e) => e.key === "Escape" && setInfoOpen(false)}
          className={`${infoOpen ? "absolute inset-0 z-20 block" : "hidden"} overflow-y-auto bg-bg lg:static lg:block lg:w-80 lg:shrink-0 lg:border-l lg:border-border lg:bg-surface`}
        >
          <div className="space-y-6 p-5 text-sm">
            <section>
              <h2 className="mb-2 flex items-center gap-2 font-bold">
                <Icon name="clock" className="size-4 text-brand" />
                Hours
              </h2>
              <p className="text-muted">{practice.hoursText}</p>
            </section>
            <section>
              <h2 className="mb-2 flex items-center gap-2 font-bold">
                <Icon name="mapPin" className="size-4 text-brand" />
                Location
              </h2>
              <p className="text-muted">{practice.address}</p>
              <p className="mt-1 text-muted">{practice.parking}</p>
            </section>
            <section>
              <h2 className="mb-2 flex items-center gap-2 font-bold">
                <Icon name="phone" className="size-4 text-brand" />
                Talk to a person
              </h2>
              <a href={tel} className="inline-flex min-h-10 items-center rounded-lg border border-border px-3 font-bold text-brand-strong hover:bg-surface-2">
                Call {practice.phone}
              </a>
            </section>
            <section className="flex gap-3 rounded-xl border border-danger/25 bg-danger-soft p-3 text-danger">
              <Icon name="alert" className="mt-0.5 size-4" />
              <div>
                <p className="font-bold">Medical emergency?</p>
                <p className="mt-0.5">Trouble breathing or swallowing, or swelling spreading to your eye or neck: call 911.</p>
              </div>
            </section>
            <section className="space-y-1 border-t border-border pt-5">
              <h2 className="mb-1 font-bold">Display</h2>
              {[
                { label: "Larger text", checked: largeText, set: setLargeText },
                { label: "Dark mode", checked: darkMode, set: setDarkMode },
                { label: "Show assistant steps (demo)", checked: showSteps, set: setShowSteps },
              ].map((o) => (
                <label key={o.label} className="flex min-h-10 cursor-pointer items-center justify-between gap-3">
                  <span>{o.label}</span>
                  <input type="checkbox" className="size-4.5 accent-[var(--brand)]" checked={o.checked} onChange={(e) => o.set(e.target.checked)} />
                </label>
              ))}
            </section>
            <Link href={`/staff?practice=${practice.slug}`} className="inline-flex items-center gap-1.5 text-muted underline-offset-2 hover:text-text hover:underline">
              Staff dashboard
              <Icon name="external" className="size-3.5" />
            </Link>
          </div>
        </aside>
      </div>
    </div>
  );
}

