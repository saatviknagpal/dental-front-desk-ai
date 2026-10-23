# Bright Smile Dental — AI front-desk chat assistant

A conversational assistant ("Ava") for a dental practice. It books, reschedules and cancels appointments against a real database, handles new and existing patients, family back-to-back bookings and emergencies, answers insurance and pricing questions, and hands off to staff when needed. A front-desk dashboard shows staff alerts, bookings and conversations, and an eval harness with simulated patients tests the main scenarios.

- **Live demo:** _TBD (Render URL)_ · patient chat at `/`, staff dashboard at `/staff`
- **Walkthrough video:** _TBD (Loom)_

**Stack:** Next.js 15 (TypeScript, App Router) · Tailwind CSS v4 · Postgres (Supabase) · OpenAI `gpt-4.1-mini` (Claude, Gemini and DeepSeek can be swapped in through env) · Vitest.

---

## Scenarios covered

| Scenario | How it works |
|---|---|
| **New patient** | Collects name, DOB, phone and insurance, then calls `register_patient`. Uninsured patients get self-pay prices plus the membership and financing options. |
| **First appointment** | Cleaning (60 min), checkup (30 min) or emergency (30 min). `find_available_slots` returns real openings, the patient confirms, then `book_appointment` runs. |
| **Emergency** | Collects a summary (what happened, onset, pain, swelling). Red flags (trouble breathing or swallowing, spreading swelling) get **911/ER guidance first**. Otherwise it books the soonest emergency slot, and **staff are alerted automatically**. |
| **Existing patient** | Verifies name + DOB, then handles follow-up booking, rescheduling (atomic move) or cancelling (offers a reschedule first). |
| **Times don't work** | Re-searches with time-of-day, before/after times and specific weekdays. If nothing matches, it returns the next available times. |
| **Vague dates** | A 7-week calendar plus phrase mappings ("later next week", "early next month") go into the prompt, so the model never has to do weekday math itself. |
| **Family** | Household members come back with verification. `find_family_slots` finds **back-to-back** (or same-time) options, and `book_family_appointments` books them all or none. |
| **General inquiries** | Hours (Mon–Sat 8–6), location, parking, insurance (all major plans), self-pay, membership and financing. |
| **Escalation** | A patient asking for a person, complaints, billing disputes, or a stuck conversation → `notify_staff` → staff dashboard (+ optional Slack webhook). |
| **Unexpected input** | Off-topic messages, prompt injection and gibberish get a polite redirect. Tool errors come back as structured results the model can recover from. |
| **Other languages** | Replies in the patient's language (tested with Spanish). |

## Architecture

```
Browser (React)                     Next.js route handlers (stateless)
 ├─ /        patient chat  ───────►  POST /api/chat ──► Agent loop (src/lib/agent.ts)
 └─ /staff   front desk    ───────►  GET  /api/staff        │  load session from DB
                                                            │  LLM ⇄ tools (≤ 8 rounds)
                                                            │  save session + transcript
                                           ┌────────────────┴───────────────┐
                                    LLM adapters (llm.ts)            Tools (tools.ts)
                                    OpenAI-compatible | Claude       deterministic, validated,
                                    + fallback model                 session-scoped access guard
                                                                            │
                                                         Postgres: providers · patients · slots (30-min)
                                                         appointments · notifications · sessions · messages
```

- **`src/lib/`** holds all the domain logic, framework-free: `tools.ts` (scheduling rules), `agent.ts` (turn loop), `llm.ts` (provider adapters), `prompt.ts`, `db.ts`, `seed.ts`, `judge.ts`. It would move into a NestJS service unchanged; the Next.js routes are thin wrappers.
- **`src/app/api/`** has the chat, feedback and staff routes. **`src/components/`** has the chat UI and staff dashboard.
- **`tests/`** has unit tests for the tools (no LLM). **`evals/`** runs simulated-patient evals against the real agent.

## Key design decisions

1. **Safety rules live in code, not just in the prompt.** The model can't book a time that isn't actually open, act on a patient it hasn't verified, or book an emergency without the staff alert. A prompt can be argued with; a tool's validation can't.
2. **No double booking.** Booking is a conditional `UPDATE slots … WHERE status = 'open'` inside a transaction, and a row-count mismatch returns `SLOT_TAKEN`. Under concurrent requests exactly one wins, and the loser gets alternatives. There's a test for this.
3. **Privacy.** Verification needs name + DOB. Errors never reveal which field was wrong, so records can't be enumerated, and access locks after 3 failures. For families, minors are fully accessible to a verified parent, but adult household members (a spouse) are **booking-only**: viewing or changing *their* appointments requires their own verification.
4. **Confirm before every write.** The prompt requires it, and the evals check that every successful booking, reschedule or cancel followed an explicit "yes".
5. **Stateless web tier.** Sessions, tool access and chat history are stored in Postgres, so any instance can serve any turn.
6. **Provider-agnostic LLM with a fallback model.** OpenAI is the primary; Claude, Gemini and DeepSeek work through one env var. This keeps model comparisons cheap (see the evals section).
7. **Prompt split into a static part and a dynamic part.** Persona, rules and practice facts are cached (with explicit `cache_control` on Claude); only the date calendar changes per turn.

## Prioritization & scope decisions

> _Draft — Saatvik to rewrite in his own words._

I treated this as a system handling **10,000+ conversations a day across hundreds of practices**. At that volume, rare failures happen every day. I ranked the work by **patient impact if it goes wrong**, and built from the top down:

| Priority | What | Why it's load-bearing |
|---|---|---|
| **P0** | Booking correctness: only real slots, no double booking, confirm before writes | A wrong booking means a patient shows up to no appointment. That's the worst trust failure, and at scale it would happen daily. |
| **P0** | Emergency safety: 911/ER guidance for red flags, emergency booking always alerts staff | The only scenario with possible health impact. It can't depend on the model remembering a step. |
| **P0** | Identity and privacy: verification, no enumeration, household access rules | PHI exposure is a legal and HIPAA risk for every practice on the platform. |
| **P1** | Core flows: new patient, existing patient, reschedule/cancel, insurance/pricing/hours | The bulk of real conversations. |
| **P1** | Graceful failure: structured tool errors, LLM retry + fallback model, "call us" fallback, tool-loop cap with automatic handoff | Provider outages and rate limits are certain at this volume. A stuck patient is a lost patient. |
| **P2** | Harder flows: family back-to-back, vague dates, changing their mind, a slot taken mid-chat | Common enough to matter. Built on top of the P0 primitives. |
| **P2** | Operations: staff dashboard, feedback (thumbs + comments), transcripts, simulated-patient evals, an LLM judge for production chats | You can't improve what you can't see. The evals also guard against regressions when changing prompts or models. |
| **Not built** | SMS/voice channels, real practice-management integration (Dentrix, OpenDental), staff auth/SSO, multi-location config, reminders | Valuable, but either need integrations I don't have, or don't affect whether the core conversation is correct. |

**Failure modes I designed for**

| Failure | Mitigation | What's still a risk |
|---|---|---|
| Model invents a time or says "booked" too early | Tools reject anything that isn't an open slot; the prompt and judge check for premature "booked" claims | The model could still phrase things misleadingly; the judge's hallucination check watches for this |
| Two patients take the same slot | Atomic conditional update, `SLOT_TAKEN` + alternatives | — |
| Wrong patient's data exposed | Session-scoped access guard, generic errors, lockout | Phone-based verification (SMS one-time code) would be stronger |
| Missed emergency | Red-flag rules, automatic staff alert, eval scenarios for both paths | Unusual symptom descriptions; more eval scenarios needed |
| LLM outage, slowness or rate limits | SDK retries, fallback model, friendly fallback, max 8 tool rounds | No queueing or backpressure yet |
| Load | Stateless app + Postgres connection pool; ~10k conversations/day ≈ 0.1/s average, maybe ~5–10/s at peak | **Not load-tested.** At this scale the real limit is LLM rate limits and cost (~6–8 calls per conversation), not the web tier |

**What I'd do next for production scale:** Postgres with a `location_id` on every table (or a schema per tenant), Redis for hot session state, a queue (SQS) for staff alerts with SMS paging and acknowledgment SLAs, routing simple FAQ turns to a smaller model, load tests, OpenTelemetry tracing per tool call, PHI retention policies, BAAs with the LLM providers, and running the eval suite in CI on every prompt or model change.

## Evals

Two layers:

1. **Unit tests** (`npm test`, 19 tests, no LLM): booking rules, concurrency (two simultaneous bookings → exactly one wins), verification and lockout, household access, family all-or-nothing, reschedule atomicity.
2. **Simulated-patient evals** (`npm run evals`): an LLM plays a patient ("digital human") with a persona and a goal, and talks to the real agent. Modeled on τ-bench, Bluejay and Peerlogic's dental simulations.
   - **Outcome checks are in code against the final database state:** e.g. "a cleaning for Priya exists next week before noon", "an emergency notification exists", "John's appointment date never appears in the impostor's chat".
   - **An LLM judge from a different model family** (Gemini judging the OpenAI bot, to avoid self-preference bias) scores tone, clarity, redundancy (re-asking for known info), hallucination and policy violations.
   - **pass^3:** each scenario runs 3 times and passes only if all 3 pass, which measures consistency and not luck.
   - **Metrics use Bluejay's names:** outcome pass rate, tool call accuracy, hallucination rate, redundancy, latency P50/P95.
   - **14 scenarios:** new patient (insured / uninsured), emergency, reschedule ("later next week, afternoon"), cancel, family back-to-back, impostor, red-flag emergency, billing handoff, FAQ, prompt injection, changing their mind, slot taken mid-chat, Spanish speaker.
   - **Model comparison:** `npm run evals -- --models openai:gpt-4.1-mini,anthropic:claude-sonnet-5-5` runs the same benchmark on two models, which is the "is the new model better than ours?" question.
3. **Production evals** (`npm run evals:prod`): the same judge scores real conversations. Flagged chats show on `/staff` alongside 👍/👎 feedback, and real failures become new scenarios. That's the feedback loop.

**Latest results** (gpt-4.1-mini, judged by gemini-3.6-flash, 16 scenarios; full trajectories at `/evals`):

| Metric | Result |
|---|---|
| Outcome pass rate | 16/16 scenarios |
| Hallucination rate (judge) | 0% |
| Redundancy (re-asks for known info) | 0.00 per conversation |
| Tone / clarity (judge, 1-5) | 5.0 / 5.0 |
| Latency per turn | P50 1.8s, P95 3.2s |
| Tokens per conversation | ~30k (78% of input served from prompt cache) |
| Cost per conversation | ~$0.0055, so roughly $55/day at 10k conversations (LLM only) |

How the evals changed the bot: the first run passed 8/14. It surfaced (1) a redundant "is that correct?" after the patient had already picked a listed time, (2) emergencies booked without telling the patient that staff were alerted, and (3) the family flow asking for the kids' birthdays before verifying the parent. The judge also caught Ava re-asking a patient's name and DOB after a failed lookup. Each was fixed in the prompt or tool results and re-verified.

## Run it locally

Needs Node ≥ 22.

```bash
npm install
cp .env.example .env     # set LLM_API_KEY (OpenAI). DATABASE_URL optional (see below)
npm run dev              # http://localhost:3000  ·  staff: http://localhost:3000/staff
```

- **Database:** with `DATABASE_URL` set (Supabase → Project Settings → Database → Connection string → Session pooler), it uses Postgres. Without it, it falls back to **PGlite** (Postgres in-process via WASM), so it runs with zero setup. Demo data is seeded automatically on the first request. To reset it, run `npm run seed` or use the button on `/staff`.
- **Tests:** `npm test` · **Evals:** `npm run evals` (needs the OpenAI key; set `GEMINI_API_KEY` for the judge) · **Production judge:** `npm run evals:prod`

### Demo data

| Patient | DOB | Notes |
|---|---|---|
| John Smith | 1985-06-14 | Delta Dental, has a checkup booked |
| Emily Chen | 1990-11-02 | Cigna, has a cleaning booked |
| David Kim | 1978-01-23 | MetLife, has a checkup booked |
| Maria Garcia | 1987-04-09 | Aetna. Household: Carlos (spouse), Sofia (9), Mateo (6) |
| Robert Brown | 1960-09-12 | No insurance (self-pay), has a cleaning booked |

Providers: Dr. Maya Patel (DDS, also does cleanings), Dr. James Okafor (DDS), Lena Torres and Sam Rivera (hygienists). Slots are every 30 min, Mon–Sat 8–6, for 8 weeks, with lunch and ~30% of hours pre-blocked.

## Deploy

`render.yaml` is included. Create a Render Web Service from the repo, set `LLM_API_KEY` and `DATABASE_URL`, and deploy.

## Notes

- The practice and patients are fictional.
- `/staff` has no authentication. It's a demo; in production it would sit behind SSO with audit logs.
- I used AI coding assistants while building this, as the assignment allows. The design decisions and tradeoffs are my own.
