# Dental front-desk chat assistant

A chat assistant that does the front desk's job for dental practices: it books, moves and cancels appointments, answers insurance and pricing questions, and handles emergencies. It only works through tools over a real Postgres database, so it can't offer a time that isn't open, and it hands off to staff when a person should take over.

- Live demo: https://dental-front-desk-ai.onrender.com (free instance; the first load can take about 50 seconds while it wakes up)
- Walkthrough video: https://www.loom.com/share/5fa680a239a2483ab2faa68c7376361c

## Trying it

The home page lists two demo practices that share one deployment. Each has its own assistant, dentists, patients and timezone:

- Bright Smile Dental, San Francisco, assistant "Ava": `/p/bright-smile`
- Harbor Family Dental, Boston, assistant "Nora": `/p/harbor-family`

New patients can just say they're new. To try the existing-patient flows, use one of these made-up patients:

| Practice | Patient | Date of birth | Good for |
|---|---|---|---|
| Bright Smile | John Smith | June 14, 1985 | Rescheduling or cancelling his checkup |
| Bright Smile | Maria Garcia | April 9, 1987 | Family booking (husband Carlos, kids Sofia and Mateo) |
| Bright Smile | David Kim | January 23, 1978 | Emergency visit |
| Bright Smile | Robert Brown | September 12, 1960 | No insurance, billing complaint |
| Harbor Family | Ana Lopez | March 3, 1992 | Emergency at the second practice |

Staff pages: `/staff` is the front desk dashboard (alerts, appointments, every conversation) and `/evals` shows the test results. Each practice's staff log in with the practice as the username (`bright-smile` or `harbor-family`) and only see their own practice; an admin login sees both, the eval report and a "Reset demo data" button. Passwords are in the submission email, not in this repo.

## What it handles

Everything from the brief, plus a few things I added:

| Scenario | What happens |
|---|---|
| New patient | Collects full name, date of birth, phone and insurance, registers them, and offers 2-3 real open times as buttons. Insurance member ID is asked for but optional, so booking never waits on a card. |
| Appointment types | Cleaning (60 min), general checkup (30 min) and emergency (30 min). |
| Times that don't work | It searches again by morning or afternoon, before or after a time, or specific weekdays, and falls back to the next openings it can find. |
| Vague dates | "Later next week", "early next month", "next Tuesday": the prompt carries a 7-week calendar with fixed ranges, and if the model searches a day that isn't the weekday the patient named, the tool tells it the right date before any time is offered. |
| Existing patient | Verifies name and date of birth, then books a follow-up, reschedules (one atomic move, shown as "Moved" with the old time) or cancels (after offering to reschedule). |
| Family | A verified parent's household comes back with them, so it doesn't re-ask the kids' details. It finds back-to-back slots and books everyone or no one. A spouse can be booked, but has to verify to see or change their own appointments. |
| Emergency | Asks what happened, pain level and swelling, books the soonest emergency slot, and tells the patient the team knows. The staff alert is saved in the same database transaction as the booking. |
| Red flags | Trouble breathing or swallowing, or swelling spreading to the eye or neck: tells them to call 911 or go to the ER, alerts staff right away, and doesn't book. |
| Needs a person | Asking for a human, complaints and billing disputes become a callback request for the front desk. |
| Insurance and payment | Accepts all major plans. Patients without insurance hear the self-pay prices, the membership plan and financing. |
| Hours and location | Open 8 to 6, Monday to Saturday; address and parking. |
| Added | Multiple practices, a staff dashboard, Slack alerts per practice, confirmation cards with "Add to calendar", optional email confirmations, replies in the patient's language, limits against slot hoarding, and an AI quality check of finished chats. |

For accessibility the chat uses Atkinson Hyperlegible (a font made for low vision), has larger-text and dark-mode switches, works by keyboard, labels everything for screen readers, keeps tap targets big, and respects reduced-motion settings.

## Architecture

```
Browser                               Next.js route handlers (stateless)
 /p/[practice]   patient chat  ─────►  POST /api/chat ─► guardrails ─► agent loop ─► guardrails
 /staff, /evals  staff only    ─────►  GET  /api/staff        │
                                                               ├─ LLM adapters (OpenAI-compatible, Claude)
                                                               └─ tools: validated, scoped to the practice
                                                                  and to patients verified in this chat
                                                                        │
       Postgres: providers · patients · 30-min slots · appointments · alerts · chats · jobs
                                                                        │
       job worker (in-process, FOR UPDATE SKIP LOCKED) ─► practice's Slack / email, with retries
```

Each message goes through input checks, then a loop where the model either replies or calls tools (search slots, verify, register, book, reschedule, cancel, alert staff), then output checks. The tools hold every rule. The app servers keep nothing in memory between messages; the conversation, who's been verified and the token usage all live in Postgres.

Technologies: Next.js 15 and TypeScript, Tailwind CSS v4, Postgres on Supabase (free tier), with PGlite (an in-process Postgres) when no database is configured. The model is OpenAI `gpt-4.1-mini`; Gemini, DeepSeek and Claude work by changing `LLM_PROVIDER`. Vitest for tests, Render for hosting, Slack incoming webhooks for alerts, Resend for email.

Code layout: `src/lib/` is the domain logic and doesn't import Next.js (tools, agent loop, model adapters, prompt, guardrails, job queue, database), so it could move into its own service. `src/app/api/` routes are thin wrappers. UI is in `src/components/`, unit tests in `tests/`, simulated-patient evals in `evals/`.

## Design decisions

The rules are in code, not the prompt. The model decides what to do and the tools decide whether it's allowed. It can't book a time that isn't open, touch a patient who hasn't been verified, or book an emergency without the staff alert. You can talk a prompt out of a rule; you can't talk a tool out of returning an error.

Booking is one conditional update: `UPDATE slots ... WHERE status = 'open'` inside a transaction. If two people race for the same slot, the database lets exactly one win and the other is offered alternatives. I didn't add a temporary hold like a ticketing site uses during checkout, because there's no checkout here; booking is instant once the patient picks, so a hold would only leave slots stuck.

Picking a listed time counts as the patient's yes. It saves a round of "are you sure?". Vague picks ("the morning one" when there are two), cancellations and multi-person bookings still get an explicit yes.

Identity is name plus date of birth, the same as calling a front desk. It's easy for patients and weaker than a text-message code, so a failed lookup never says which detail was wrong, three misses lock that caller out for 15 minutes, and the count lives in the database so a new chat doesn't reset it. A name only locks for everyone after 20 misses, so nobody can lock out the real patient on purpose. Every outgoing reply is also checked for another patient's name or phone number.

Guardrails run on every message. OpenAI moderation catches self-harm (the reply gives the 988 line) and threats or abuse (a polite refusal). Moderation flags injuries like "I knocked out my tooth" as violence, so that category is ignored; testing the live site caught this blocking real emergencies. Each visitor gets 20 messages a minute and each chat 40 turns, so nobody can run up the model bill. One more check runs after the model replies: if it tells the patient the team was alerted and no alert went out that turn, the server sends one. The evals caught the model saying "I've alerted our dental team" without calling the tool, and changing the prompt didn't fix it.

Retries can't double-book. Each message carries an idempotency key, so if the connection drops after a booking and the patient taps Send again, the server returns the saved reply. A chat also handles one message at a time, so two open tabs can't both book.

Limits against bots grabbing every slot: at most 3 upcoming appointments per patient (emergencies don't count), 6 new patients per connection per day, and 2 separate households per phone number (family members join a household instead). These are counted inside a locked transaction, so twenty bot chats at once still can't race past them. On Render the visitor's IP comes from Cloudflare's `cf-connecting-ip` header, because the last `X-Forwarded-For` entry there is Render's own proxy.

Alerts and emails go through a job queue in Postgres. The booking or alert and its job row are written in the same transaction, so a job exists exactly when the write committed. Workers claim jobs with `FOR UPDATE SKIP LOCKED`, which is safe with any number of instances, retry with backoff, give up early on errors a retry can't fix, and pick up jobs left behind by a crash. Alerts show on the practice's `/staff` page (with a count in the tab title and a chime for emergencies) and post to that practice's own Slack. The Slack message says only what happened and links to the dashboard. Names and symptoms stay behind the staff login, because Slack isn't covered for health data.

No Redis. Postgres is already the queue, the lock and the session store, and 10,000 conversations a day is about one every ten seconds. Redis would make sense at far higher traffic for shared counters or caching.

On the model: the brief asks for one with a free tier. Gemini's free tier works with `LLM_PROVIDER=gemini`, but its daily limit (20 requests on my key) runs out within a single eval run, so I used `gpt-4.1-mini`. It costs about half a cent per conversation and was the most reliable at tool calls in my evals. The stable part of the prompt is built once per practice so providers can cache it.

Every table that matters carries a `practice_id`, and the current practice travels with each request through `AsyncLocalStorage`, so the clock, the prompt and every query use that practice's data and timezone. Staff pages use HTTP Basic auth with a password per practice plus an admin password, compared in constant time, with a 15-minute lockout after ten wrong tries.

## Prioritization

I built this as if it were going live for hundreds of practices and 10,000+ conversations a day. At that volume a one-in-a-thousand bug happens ten times a day, so I ordered the work by how much it hurts a patient when it goes wrong.

| Priority | What | Why |
|---|---|---|
| P0 | Correct bookings: real slots only, no double booking, consent before changes | A patient showing up for an appointment that doesn't exist is the fastest way to lose a practice's trust. |
| P0 | Emergencies: 911 advice for red flags, a guaranteed staff alert | The only part with real health risk, so it can't depend on the model remembering a step. |
| P0 | Identity and privacy: verification, lockouts, household rules, the output check | Leaking one patient's data is a legal problem for every practice on the platform. |
| P1 | The everyday flows: new and existing patients, reschedule, cancel, insurance, hours | Most real conversations. |
| P1 | Failing gracefully: tool errors the model can recover from, retries, a "please call us" reply, and a cap on tool calls that hands off to staff | Model outages and rate limits are certain at this volume. |
| P2 | Families, vague dates, changing their mind, a slot taken mid-chat | Common enough to matter, and built on the P0 pieces. |
| P2 | Staff dashboard, feedback loop, evals, cost tracking | You can't fix what you can't see, and evals catch regressions when the prompt or model changes. |
| Not built | Text messages and phone calls, practice software (Dentrix, OpenDental), reminders, staff single sign-on, per-practice hours, patient search for staff | Each needs an outside integration, or doesn't change whether the core conversation is right. |

Failure modes I planned for, and what's still open:

| Failure | What handles it | Still open |
|---|---|---|
| Model invents a time or claims a booking | Tools only accept open slots; booking cards come from tool results; evals check the database | Wording can still mislead, which the judge watches for |
| Two patients book the same slot | Conditional update in a transaction | Nothing known |
| Another patient's data in a reply | Verification on every tool, generic errors, lockouts, output check | A one-time text code would be stronger than date of birth |
| Missed emergency | Red-flag rules, the alert in the same transaction, the alert-promise check, eval scenarios | Unusual ways of describing symptoms |
| Model outage | SDK retries, a friendly "please call us" reply, an optional fallback model (`LLM_FALLBACK_MODEL`) | No queue for chat requests under heavy load |
| Slack or email down | Job retries with backoff; failed deliveries show on `/staff` with a Retry button | Alerts go to a chat channel, not a pager |

What changes at 10,000+ conversations a day. The design already scales out, so it's mostly configuration:

| Limit today | Change |
|---|---|
| Model rate limits (about 40k tokens per conversation, roughly 280k tokens a minute on average) | A higher OpenAI tier, and a cheaper model for simple FAQ turns |
| One free Render instance that sleeps | Two or more paid instances, mainly so a crash or deploy doesn't stop chats; the app mostly waits on the model, so it scales out rather than up |
| Supabase's free pooler (about 15 connections) | The transaction pooler or a bigger plan; Postgres can scale up a long way before it needs replicas |
| Rate-limit and login counters kept in each instance's memory | Move them into Postgres |
| The dashboard polls every 5 seconds | Poll less often, or push changes |
| About 200k message rows a day | Archive or delete old transcripts |

## Testing and evals

Unit tests (`npm test`, 73 of them, no model calls) cover booking rules, simultaneous bookings, verification and lockouts, household access, all-or-nothing family bookings, atomic reschedules, guardrails, the job queue, emails and calendar files, date handling, practice isolation, staff logins, the abuse limits (including 8 registrations fired at once) and the judge fallback.

Load test (`npm run loadtest`): 50 patients book the same slot at the same moment against the real database. Exactly one gets it, the other 49 are offered other times, and the test patients are cleaned up afterwards. A burst of 20 chats was all answered, at about 5 seconds each, mostly waiting on the model.

Simulated-patient evals (`npm run evals`): another model plays a patient with a persona and a goal and chats with the real assistant, the way τ-bench does it. Checks then run in code against the database ("a cleaning for Priya exists next week before noon", "an emergency alert exists"), because the bot saying "you're booked" doesn't mean a booking exists. A judge from a different model family scores tone, clarity, repeated questions, made-up facts and rule breaks, with a reason for each (OpenAI `gpt-4.1` steps in if Gemini is unavailable). There are 20 scenarios, each run three times, and one only passes if all three do. Four are written to break the bot: someone hoarding Saturday slots with made-up friends, a junk member ID, someone pushing for antibiotic doses, and someone who only wants to see times. Every run is stored with each message, model decision, tool call, cost and latency, and shown on `/evals`. `--models` runs the same scenarios on two models side by side.

Latest full run (`gpt-4.1-mini`, judged by `gpt-4.1` because Gemini's free quota was used up):

| Metric | Result |
|---|---|
| Scenarios passing all 3 runs | 18 of 20 (58 of 60 runs) |
| Made-up facts (judge) | 2% |
| Re-asking for something already given | 0.08 per conversation |
| Tone / clarity | 5.0 / 5.0 |
| Reply time | 1.9s typical, 3.5s at the 95th percentile |
| Cost | about $0.006 per conversation, around $63 a day at 10k conversations |

The two failures: it gave a "first visit" note to a couple who were already patients, and the judge marked a conversation as medical advice even though the assistant refused every request for a drug or a dose. I left the judge alone rather than tune it until the numbers looked better.

The feedback loop in production: patients rate each chat with a thumbs up or down, and the "Run quality check" button on `/staff` (or `npm run evals:prod`) has the judge grade finished conversations. Staff read the ones flagged as bad, and real failures become new eval scenarios.

## Challenges and what I changed

- The evals kept finding real bugs. Early on the bot asked "is that correct?" after a patient had already picked a time, and asked for kids' birthdays before verifying the parent. Later, the scenarios built to break it caught it telling a patient "all 5 Saturdays are booked" when the limit had refused two, offering to "verify" another patient for a caller fishing for a phone number, and claiming it had alerted staff in an emergency without doing it. The first two were prompt fixes. The last one needed code, because the prompt fix made that scenario fail three times out of three.
- The model sometimes picked the wrong date for "next Tuesday". The calendar in the prompt was right and the model ignored it, so the slot search now checks the weekday the patient named and points out the right date.
- Testing the deployed site found problems local testing couldn't. Next.js prefetches links in production, and prefetching the staff link popped up a login box on the patient chat. Moderation blocked "I knocked out part of my tooth" as violence. Every visitor looked like one IP behind Render's proxy, which would have shared one rate limit across everyone. All three are fixed.
- Gemini's free tier ran out mid-run more than once, which is why the judge falls back to OpenAI and why the bot runs on `gpt-4.1-mini`.

## Privacy and HIPAA

This isn't HIPAA compliant, and it only holds made-up patients. Before real patient data it would need business associate agreements with the model provider (with zero data retention), the database and app hosts and the email provider; per-person staff accounts through the practice's single sign-on with a second factor; an audit log of who opened which record; retention rules for transcripts; and a security risk assessment.

## Running it locally

Needs Node 22 or newer.

```bash
npm install
cp .env.example .env     # set LLM_API_KEY (an OpenAI key); everything else is optional
npm run dev              # http://localhost:3000
```

Without `DATABASE_URL` it runs on PGlite, an in-process Postgres, so there's nothing else to install. With it (Supabase: Connect, then Session pooler) it uses that database. Demo data is created on the first request; `npm run seed` or the button on `/staff` resets it. `.env.example` lists every setting with a comment.

Other commands: `npm test`, `npm run evals` (needs the OpenAI key; `GEMINI_API_KEY` for the Gemini judge), `npm run evals:prod`, `npm run loadtest`.

Resend's free tier only delivers to the Resend account's own email address, so confirmation emails reach that address only.

## Deploying

`render.yaml` is included. Create a Render Blueprint from the repo and set `LLM_API_KEY`, `DATABASE_URL`, `STAFF_PASSWORD`, `STAFF_PASSWORDS`, and optionally `STAFF_WEBHOOKS` (per-practice Slack) and `GEMINI_API_KEY`. Set `CLIENT_IP_HEADER=cf-connecting-ip` so limits use each visitor's real IP. The job worker starts with the server, and `/api/health` also checks the database.
