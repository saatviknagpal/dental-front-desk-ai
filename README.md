# Dental front-desk chat assistant

A chat assistant for dental practices. Patients use it to book, move and cancel appointments, ask about insurance and pricing, and get help with emergencies. It talks to a real Postgres database through a small set of tools, so it can only offer times that are actually open, and it hands off to the front desk when a person is needed.

There are two demo practices, each with its own patients, dentists and timezone:

- `/p/bright-smile`: Bright Smile Dental, San Francisco (Pacific). `/` redirects here.
- `/p/harbor-family`: Harbor Family Dental, Boston (Eastern).

Staff pages are `/staff` (alerts, bookings, conversations, failed deliveries) and `/evals` (eval results). Each practice's staff sign in with their practice as the username and see only their own practice. An admin login sees every practice and the eval report.

Live demo: _Render URL_ · Walkthrough video: _Loom link_

Stack: Next.js 15 (TypeScript), Tailwind CSS v4, Postgres (Supabase), OpenAI `gpt-4.1-mini`, Vitest. Claude, Gemini and DeepSeek also work by changing one env var.

## What it handles

| Scenario | How |
|---|---|
| New patient | Collects name, date of birth, phone and insurance, then registers them. Patients without insurance hear the self-pay prices, the membership plan and financing. |
| First appointment | Cleaning (60 min), checkup (30 min) or emergency (30 min). It searches real open slots, offers two or three (also as buttons the patient can tap), and books the one the patient picks. |
| Confirmation | After a booking the chat shows a confirmation card with "Add to calendar" (.ics) and Google Calendar buttons. If the patient gave an email, a confirmation email with the calendar file goes out too. |
| Emergency | Asks what happened, when it started, pain level and swelling. Red flags (trouble breathing or swallowing, swelling spreading to the eye or neck) get 911/ER advice first. Otherwise it books the soonest emergency slot, and the staff alert is created in the same database transaction as the booking. |
| Existing patient | Verifies name and date of birth, then books a follow-up, reschedules (as one atomic move) or cancels (offering a reschedule first). |
| Times that don't work | Searches again by morning/afternoon, before or after a time, or specific weekdays. If nothing fits, it offers the next openings it can find. |
| Vague dates | The prompt includes a 7-week calendar and fixed ranges for phrases like "later next week" and "early next month", so the model doesn't have to work out weekdays itself. |
| Family | A verified parent's household comes back with them. It finds back-to-back (or same-time) slots for everyone and books them all or none. |
| General questions | Hours (Mon-Sat, 8-6), address, parking, accepted insurance, self-pay, membership, financing. |
| Needs a person | Requests for a human, complaints, billing disputes or a conversation going in circles create a handoff alert for the front desk. |
| Other languages | Replies in the patient's language. Spanish is covered by an eval. |

## Architecture

```
Browser                               Next.js route handlers (stateless)
 /p/[practice]   patient chat  ─────►  POST /api/chat ─► guardrails ─► agent loop ─► guardrails
 /staff, /evals  staff only    ─────►  GET  /api/staff        │
                                                               ├─ LLM adapters: OpenAI-compatible or Claude, with a fallback model
                                                               └─ tools: validated, scoped to the current practice and to the
                                                                  patients verified in this chat
                                                                        │
       Postgres: practices' providers · patients · 30-min slots · appointments · alerts · chats · jobs
                                                                        │
       job worker (in-process, FOR UPDATE SKIP LOCKED) ─► staff webhook, retried with backoff
```

Code layout: `src/lib/` holds the domain logic and doesn't depend on Next.js (tools, agent loop, LLM adapters, prompt, guardrails, queue, database). The routes in `src/app/api/` are thin wrappers, so this would move into a NestJS service without changes. UI is in `src/components/`, unit tests in `tests/`, simulated-patient evals in `evals/`.

## Design decisions

**The rules live in code, not just the prompt.** The model can't book a time that isn't open, act on a patient it hasn't verified, or book an emergency without the staff alert. You can argue a prompt out of a rule. You can't argue with a tool that returns an error.

**No double booking.** Booking is a conditional `UPDATE slots ... WHERE status = 'open'` inside a transaction. If the row count is wrong, the whole booking rolls back and the patient is offered alternatives. A test fires two bookings at the same slot at once and checks that exactly one wins.

**Privacy.** Existing patients verify with full name and date of birth. A failed lookup never says which field was wrong. Three misses for a name lock that caller out for 15 minutes, and the count is stored in the database, so opening a new chat doesn't reset it. A name is only locked for everyone after 20 misses, so one person guessing wrong on purpose can't lock the real patient out. A verified parent can manage their children's appointments. An adult in the same household (a spouse) can be booked, but viewing or changing their existing appointments needs their own verification.

**Confirmation.** Ava always lists options with day, time and provider. If the patient picks one of them, that counts as the go-ahead and it books. Vague picks, cancellations and multi-person family bookings get an explicit yes/no first.

**Guardrails around every turn.** Incoming messages go through OpenAI moderation. Self-harm gets a short reply with the 988 crisis line, and abuse gets a polite refusal. If the check itself fails, the chat continues. Outgoing replies are checked for any other patient's full name or phone number; if one shows up and that patient isn't verified in this chat (and the user didn't type it), the reply is replaced. Each caller gets 20 messages a minute (keyed by the IP our proxy reports, not one the client can fake) and each chat 40 turns, which limits cost abuse. A chat handles one message at a time: if a second arrives while the first is still running (two tabs, a retry), it gets "still working" instead of both racing to update the same chat. Each message also carries an idempotency key. If the connection drops after a booking and the patient taps Send again, the server returns the saved reply instead of running the turn twice. Every guardrail hit is logged and shows up in the staff transcript.

**Alerts and confirmation emails go through a job queue.** Saving an alert or a booking also inserts a `jobs` row in the same transaction, so a job exists if and only if the write it belongs to committed. A worker claims jobs with `FOR UPDATE SKIP LOCKED` (safe with any number of app instances) and retries temporary failures with exponential backoff, up to five times. Errors that can't succeed on retry, like a rejected email address, fail right away. Failed deliveries show on the practice's `/staff` page with a Retry button, so nothing disappears quietly. Jobs stuck in "running" after a crash are picked up again after five minutes, and finished jobs are deleted after a week. It's plain Postgres, so there is no extra service to run.

**Multiple practices.** Patients, providers, alerts, chats and jobs carry a `practice_id`, and a unique index stops the same person being registered twice at one practice. Slots and appointments inherit it through their provider and patient. The current practice rides along with each request in Node's `AsyncLocalStorage`, so the clock, the prompt and every query use that practice's data and timezone without passing it through every function. A chat started at one practice can't be continued at another. Tests check that one practice can't see or book the other's patients or providers.

**Stateless web tier.** Chat history, verified patients and token usage are stored per chat in Postgres, so any instance can serve any message.

**Swappable models.** OpenAI is the default. Claude, Gemini and DeepSeek work through `LLM_PROVIDER`, with an optional fallback model. The static part of the prompt (persona, rules, practice facts) is built once per practice so providers can cache it. Only the date calendar changes per turn.

**No Redis yet.** With one app instance, rate limits in memory and Postgres for everything else are enough. Redis becomes worth it at two or more instances, for shared rate-limit counters and a short-lived availability cache. Bookings would still be checked against Postgres.

**Staff access.** Staff pages use HTTP Basic auth. Each practice has its own password (`STAFF_PASSWORDS`), and the username is the practice slug, so Harbor's front desk can't open Bright Smile's chats or alerts. The admin password (`STAFF_PASSWORD`) sees every practice, the eval report and the demo reset. Patients don't log in. Like a phone call to a front desk, they identify themselves with name and date of birth.

## Prioritization and scope

I planned this as if it were serving hundreds of practices and 10,000+ conversations a day. At that volume, a one-in-a-thousand failure happens about ten times a day, so I ordered the work by what hurts a patient most when it goes wrong.

| Priority | What | Why |
|---|---|---|
| P0 | Booking correctness: real slots only, no double booking, consent before changes | A patient who shows up to an appointment that doesn't exist is the worst outcome for trust, and at this volume it would happen daily. |
| P0 | Emergency safety: 911/ER advice for red flags, automatic staff alert on emergency bookings | The one area with possible health impact, so it can't depend on the model remembering a step. |
| P0 | Identity and privacy: verification, lockout, household rules, output privacy check | Exposing patient data is a legal problem for every practice on the platform. |
| P1 | Core flows: new and existing patients, reschedule, cancel, insurance, hours | Most real conversations. |
| P1 | Failing gracefully: structured tool errors, retries and a fallback model, a "please call us" reply, a cap of 8 tool calls per turn that hands off to staff | Provider outages and rate limits are certain at this volume. |
| P2 | Harder flows: family bookings, vague dates, changing their mind, a slot taken mid-chat | Common enough to matter, and built on the P0 pieces. |
| P2 | Operations: staff dashboard, feedback, transcripts, job queue, evals, production judge, cost tracking | You can't fix what you can't see. Evals also catch regressions when the prompt or model changes. |
| Not built | SMS and voice, practice-management integration (Dentrix, OpenDental), reminders, staff SSO, per-practice opening hours | Each needs an outside integration or doesn't change whether the core conversation is right. |

Failure modes I designed for:

| Failure | What handles it | What's left |
|---|---|---|
| Model invents a time or says "booked" too early | Tools reject anything that isn't an open slot; the eval judge flags premature claims | Wording can still mislead; the judge's hallucination check watches for it |
| Two patients take the same slot | Conditional update in a transaction, then alternatives | Nothing known |
| Another patient's data in a reply | Verification guard on every tool, generic lookup errors, lockout, output privacy check | A one-time SMS code would be stronger than date of birth |
| Missed emergency | Red-flag rules, automatic alert, two eval scenarios | Unusual symptom descriptions; more scenarios needed |
| LLM outage or slowness | SDK retries, fallback model, friendly fallback reply, tool-call cap | No backpressure queue for chat requests |
| Webhook or email provider down | Job queue retries with backoff; permanent errors fail fast | Failed deliveries show on `/staff` with Retry, but nobody is paged yet |
| Load | Stateless app, connection pool, practice-scoped indexes | Not load-tested. At ~0.1 conversations/second on average (maybe 5-10/s at peak), the real limit is LLM rate limits and cost, not the web tier |

What I'd add next for production: per-practice hours, staff SSO with per-person accounts, schema migrations as a deploy step instead of at app start (today the setup runs under a Postgres advisory lock so instances starting together take turns), Redis once there's more than one instance, SMS confirmations and on-call paging through the job queue, routing simple FAQ turns to a cheaper model, load tests, tracing per tool call, PHI retention rules, BAAs with the model providers, and the eval suite in CI on every prompt or model change.

## Testing and evals

Unit tests (`npm test`, 48 tests, no LLM): booking rules, two simultaneous bookings for one slot, verification and lockout, household access, family all-or-nothing, atomic reschedule, guardrails, one turn at a time per chat, the job queue (retry, fail-fast, no job when the booking rolls back), confirmation emails and calendar files, weekday-to-date mapping in the prompt, practice isolation, and staff logins.

Simulated-patient evals (`npm run evals`): another LLM plays a patient with a persona and a goal and chats with the real agent. The approach follows τ-bench, which grades the final database state, not the wording.

- Outcome checks run in code against the database. For example: "a cleaning for Priya exists next week before noon", "an emergency alert exists", "John's appointment date never appears in the impostor's chat". Each check shows the records it looked at.
- A judge from a different model family (Gemini judging the OpenAI agent, to avoid a model grading itself) scores tone, clarity, redundancy, hallucination and policy violations, with a reason for each. The rubric is shown on `/evals`.
- Each scenario runs three times and only passes if all three pass (pass^3).
- 16 scenarios: new patient with and without insurance, emergency, red-flag emergency, reschedule to "later next week, afternoon", cancel, follow-up booking, family back-to-back, spouse booking, impostor with the wrong birthday, billing handoff, hours and location, prompt injection, changing their mind, a slot taken mid-chat, and a Spanish speaker.
- `npm run evals -- --models openai:gpt-4.1-mini,anthropic:claude-sonnet-5-5` runs the same scenarios on two models. That answers "is the new model better than the one we use?"
- Every run is stored in Postgres (`eval_runs`, `eval_results`, `eval_steps`) with the full trajectory: each patient message, each model decision with tokens, cost and latency, each tool call with arguments and result, and each reply.

Production evals (`npm run evals:prod`) run the same judge over real conversations. Flagged chats show on `/staff` next to thumbs up/down feedback, and real failures become new scenarios.

Latest full run (gpt-4.1-mini, judged by gemini-3.6-flash, 16 scenarios x 3 runs):

| Metric | Result |
|---|---|
| Scenarios passing all 3 runs | 16/16 (48/48 runs) |
| Hallucination rate | 0% (judge, previous run) |
| Re-asking for known info | 0.00 per conversation |
| Tone / clarity (1-5) | 5.0 / 5.0 (judge, previous run) |
| Latency per turn | P50 1.8s, P95 3.2s |
| Tokens per conversation | ~32k, about 90% of input served from the prompt cache |
| Cost per conversation | ~$0.0048, about $48/day at 10k conversations (model cost only) |

The judge hit Gemini's rate limit on this run, so the judge rows come from the run before it. Earlier runs had misses that turned out to be bugs in the checks (a Spanish yes the check didn't recognize, a name the attacker had typed themselves) and one simulated patient that never said "next week"; those are fixed.

The evals changed the bot more than once. The first run passed 8 of 14. It showed that Ava asked "is that correct?" after a patient had already picked a listed time, booked emergencies without telling the patient staff were alerted, and asked for the kids' birthdays before verifying the parent. The judge also caught her asking a patient's name and date of birth a second time after a failed lookup.

## Running it locally

Needs Node 22 or newer.

```bash
npm install
cp .env.example .env     # set LLM_API_KEY (OpenAI); DATABASE_URL is optional
npm run dev              # http://localhost:3000
```

With `DATABASE_URL` set (Supabase: Connect, then Session pooler), it uses that Postgres. Without it, it runs on PGlite, an in-process Postgres, so nothing else is needed. Demo data is created on the first request. `npm run seed` or the button on `/staff` resets it.

Without a verified domain, Resend's free tier only delivers to the email on the Resend account, so confirmation emails reach that address only.

Other commands: `npm test`, `npm run evals` (needs the OpenAI key, plus `GEMINI_API_KEY` for the judge), `npm run evals:prod`.

### Demo data

Bright Smile Dental (San Francisco):

| Patient | Date of birth | Notes |
|---|---|---|
| John Smith | 1985-06-14 | Delta Dental, has a checkup booked |
| Emily Chen | 1990-11-02 | Cigna, has a cleaning booked |
| David Kim | 1978-01-23 | MetLife, has a checkup booked |
| Maria Garcia | 1987-04-09 | Aetna. Household: Carlos (spouse), Sofia (9), Mateo (6) |
| Robert Brown | 1960-09-12 | No insurance, has a cleaning booked |

Providers: Dr. Maya Patel and Dr. James Okafor (dentists), Lena Torres and Sam Rivera (hygienists).

Harbor Family Dental (Boston):

| Patient | Date of birth | Notes |
|---|---|---|
| Ana Lopez | 1992-03-03 | Delta Dental, has a checkup booked |
| Tom Becker | 1975-12-01 | No insurance |

Providers: Dr. Priya Raman and Dr. Owen Walsh (dentists), Kim Nguyen (hygienist).

Both practices are open Monday to Saturday, 8 to 6, with 30-minute slots for 8 weeks. Lunch and about 30% of other hours are pre-blocked.

## Deploying

`render.yaml` is included. Create a Render web service from the repo and set `LLM_API_KEY`, `DATABASE_URL`, `STAFF_PASSWORD`, `STAFF_PASSWORDS` and (for emails) `RESEND_API_KEY`. The job worker starts with the server.

## Notes

The practices, patients and phone numbers are made up.
