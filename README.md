# Relay: care that stays connected

**Live app: https://relay-care.onrender.com/**

Relay is a shared care platform for an older person, their family and their caregivers. It keeps medicines, routines and appointments in one place, gives the elder a simple screen to confirm their doses, and makes sure every open question has exactly one person following it up.

> Built solo for the Catalyst AI Hackathon 2026. All demo data is synthetic. Relay does not give medical advice and does not replace professional or emergency care.

## Try it: three perspectives

You don't need an account. On the [sign-in page](https://relay-care.onrender.com/sign-in), under **"Just exploring Relay?"**, choose a person. Relay creates a private, synthetic care circle just for your browser and opens the **real** app as that person:

| Person | Role | What to try |
|---|---|---|
| **Swastik** | Elder | A large-text "today" screen. Confirm the overdue Metformin, mark Amlodipine as taken, or ask for help. |
| **Ravi** | Caregiver | The follow-up queue. Claim "I'll check on this", resolve it, and see Meera already handling the help request. |
| **Priya** | Family administrator | The whole picture: today's doses, follow-ups, the care team, the care plan and the notification preview. |

Switch person at any time with **"View as"** in the demo banner. Changes made as one person show up for the others. For example, when Swastik confirms a late dose, Ravi's follow-up closes automatically. Your circle is private to your browser, sends no email, and is deleted after 24 hours.

The landing page also links to a shorter, browser-only walkthrough at [`/demo`](https://relay-care.onrender.com/demo).

## The problem

When an older parent lives alone, the family's real question is often "Did Dad take his tablets?", and the honest answer is often "we don't know". Most reminder apps make one of two mistakes:

1. **They treat silence as failure.** A dose nobody confirmed gets logged as "missed", so the record and the alarms can't be trusted.
2. **They alert everyone and assign no one.** Five relatives get the same notification. Everyone assumes someone else called, and nobody does.

## What makes Relay different

- **"Unconfirmed" is not "missed".** Each dose is *scheduled*, *taken*, *not taken*, *unconfirmed* or *void*. Silence only ever becomes **unconfirmed**, and only after a grace period. Every outcome records who reported it and how they know (self-reported, observed, reported by someone else, or system). A late confirmation reconciles the record instead of contradicting it.
- **Every follow-up has one owner.** An unconfirmed dose, a "not taken" report or a help request opens a single follow-up. "I'll check on this" is an atomic claim: exactly one person wins, and everyone else sees who is handling it.
- **The elder keeps their dignity.** The elder screen uses big type and big buttons, and asks one plain question per dose. It never mentions surveillance. The elder signs in with a username and passcode, with no email needed.
- **History stays honest.** Dose and follow-up histories are append-only. A correction adds a linked event with a reason; nothing is silently overwritten.
- **Email that respects people.** Reminders and alerts go out through a deduplicated outbox. Messages never include medicine or doctor names. Elders are never emailed. A send that may or may not have gone through is never retried, so nobody gets a duplicate alarm.

## Roles

| Capability | Family administrator | Caregiver | Elder |
|---|---|---|---|
| Medicines, routines, appointments | ✅ | ✅ | view own day |
| Record a dose outcome | ✅ | ✅ | own doses only |
| Claim and resolve follow-ups | ✅ (can also step in on others' claims) | ✅ (own claims) | sees status of own help requests |
| Invite or remove caregivers | ✅ | ❌ | ❌ |
| Notification Center, archive a care circle | ✅ | ❌ | ❌ |

Every rule is enforced on the server (`src/server/authz.ts`), not just hidden in the interface.

## Tech stack

| Layer | Choice |
|---|---|
| Frontend | React 19, TypeScript, Vite, Tailwind CSS 4, React Router |
| Backend | Node 22, Express 5, TypeScript. One service serves both the API and the built frontend |
| Auth | [Better Auth](https://www.better-auth.com): email and passcode, username sign-in for elders, database sessions |
| Database | PostgreSQL via Drizzle ORM, with Neon in production. PGlite (embedded Postgres) for local development and tests. Both run the same SQL migrations in `drizzle/` |
| Email | A provider interface with Brevo (HTTPS API) and a console provider for development and tests |
| Validation | Zod schemas shared by the API and the UI |

## Deployment architecture

```
Browser ──HTTPS──▶ Render web service (Node 22, Singapore)
                    ├─ Express: /api/*, /healthz, /internal/sweep
                    └─ static React build with SPA fallback
                          │
                          ├──TLS──▶ Neon PostgreSQL (migrations applied on start-up)
                          └──HTTPS─▶ Brevo email API (only when real sending is enabled)

External scheduler ──POST /internal/sweep (Bearer secret)──▶ reminders, overdue checks, demo clean-up
```

- `render.yaml` describes the service: build `npm ci --include=dev && npm run build`, start `npm start`, health check `/healthz`.
- Secrets (`BETTER_AUTH_SECRET`, `DATABASE_URL`, `SWEEP_SECRET`, `BREVO_API_KEY`) are set in the Render dashboard. They are never committed.
- There is no in-process timer. All background work happens in one idempotent **sweep**: generate upcoming doses → mark overdue doses unconfirmed → queue and send due notifications → delete expired demo circles. An external scheduler (e.g. cron-job.org every 5 minutes) or an administrator's "Run reminder check now" button triggers it.

## Security and privacy

- **Accounts:** Better Auth hashes passcodes (minimum 10 characters). Sessions are stored in the database and sent in HttpOnly, Secure, SameSite=Lax cookies.
- **Sessions:** family and caregiver sessions expire 7 days after sign-in. Elder devices keep a rolling 30-day session that an administrator can revoke. Sensitive actions require a sign-in within the last 15 minutes.
- **Rate limits:** sign-in and sign-up are limited per client IP. The server sets the client IP itself, so a spoofed forwarding header can't get around the limit.
- **Requests and headers:** cross-origin state-changing requests are rejected. Helmet sets security headers, including a Content Security Policy and HSTS.
- **Invitations:** a single-use 256-bit token, carried in the URL fragment so it never reaches server logs, and stored only as a hash. Each invitation expires after 72 hours and works only for the invited email address.
- **Demo isolation:** each visitor's circle is bound to an HttpOnly cookie whose token is stored only as a hash. A forged cookie just creates a new circle. Demo accounts have server-derived passwords that are never stored or shown. They cannot invite people, create circles or send email, and are rate-limited.
- **Real-email safety:** real sending needs both `REAL_EMAIL_SEND_ENABLED=true` and a provider key. It is off in this deployment, and a persistent cap (`EMAIL_REAL_SEND_CAP`) limits total sends. The scheduler endpoint checks its secret in constant time.
- **Secrets and data:** secrets live only in environment variables, and production refuses to start without a database URL and a strong auth secret. Logs never include connection strings or credentials. Archiving a care circle hides it and stops reminders, but deletes nothing.

## Accessibility

- Semantic HTML with full keyboard support and visible focus.
- Status is always shown with a symbol and words (✓ Taken, ? Unconfirmed), never colour alone.
- Atkinson Hyperlegible for body text and large touch targets.
- Checked with axe-core: 0 WCAG 2.2 AA violations on every page.
- No horizontal overflow from 375 px to 1920 px wide.

## Tests

```bash
npm test        # 197 Vitest + Supertest tests on an in-memory database
npm run lint    # ESLint + TypeScript
npm run build   # production build
```

The suites cover:

- Authentication and session policy.
- Server-side authorization for every role.
- Dose generation, including time zones and daylight-saving changes.
- The dose state machine and concurrent updates.
- The notification outbox (deduplication, retries, caps, never emailing elders).
- Invitations and single-owner follow-up claims.
- Profile archiving.
- Demo-circle isolation.
- Database pool error handling.

The live deployment was also smoke-tested end to end in a real browser with Playwright.

## Run it locally

```bash
npm install
cp .env.example .env     # set BETTER_AUTH_SECRET (instructions in the file)
npm run dev              # http://localhost:3000, with embedded PGlite stored in .data/
```

Leave `DATABASE_URL` unset to use PGlite. To run against PostgreSQL, set it, then `npm run build && npm start`. Email defaults to preview mode: nothing is sent.

Optional: `DEMO_SEED=enabled DEMO_PASSWORD='choose-a-local-passcode' npm run seed:demo` creates a fixed synthetic care circle for local testing.

## Project layout

```
src/server/   Express app, auth, authorization, routes, services (schedule, adherence, incidents, notifications, demo)
src/shared/   Zod schemas and types shared by the API and the UI
src/web/      React app: pages, components, demo
drizzle/      SQL migrations (shared by PGlite and PostgreSQL)
scripts/      migration, demo seed and email test utilities
tests/        Vitest + Supertest suites
```

## Current limitations

- **Hosting:** the app runs on Render's free plan. After a period of inactivity, the first request can take 30–60 seconds while the service wakes.
- **Reminders:**
  - Unattended reminders need the external scheduler to be connected. Until then, reminders run only when an administrator presses "Run reminder check now".
  - Real email sending is turned off in this deployment, so emails are created and shown in the Notification Center as previews.
  - When sending is on, "accepted" means the email provider accepted the message, not that it was delivered.
- **Schedules:** medicines and routines repeat daily at fixed times. Other patterns (weekly, "as needed", tapering doses) are not supported yet.
- **Interface:** English only. There are no push or SMS notifications.
- **Consent:** the consent record is the administrator's own declaration, not verified legal authority.
- **Demo:** demo-creation limits are kept in memory per server instance, which is fine for a single instance.
