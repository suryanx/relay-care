# Relay — care that stays connected

Relay is a shared care platform for an elderly person, their family and their caregivers. Its central idea: **a dose nobody confirmed is not the same as a missed dose.** Relay tracks that uncertainty honestly, and routes each follow-up to exactly one accountable caregiver.

> Built for the Catalyst Solo AI Hackathon 2026. All demo data is synthetic. Relay does not give medical advice and does not replace professional or emergency care.

## Status

- **Checkpoint 1 (foundation):** sign-in, profiles, roles, an elder device sign-in, the email provider abstraction and tests.
- **Checkpoint 2 (care plan):** medicines, daily routines, appointments, and deterministic dose generation in the profile's time zone (bounded 24 h back / 48 h ahead, idempotent, DST-safe).
- **Checkpoint 3 (adherence):** an elder dashboard with four actions, a deterministic dose state machine, an append-only event history with provenance, corrections, help requests, and a family adherence view.
- **Checkpoint 4 (notifications):** a database-backed email outbox, a protected sweep endpoint, medicine/unconfirmed/not-taken/appointment/help emails, dedup, retries, real-send caps, and an admin Notification Center.
- **Checkpoint 5 (collaboration):** caregiver invitations, a separate account per caregiver, revocable access, follow-up incidents with single-owner claims, resolutions recorded through the adherence engine, help-request status for the elder, and an opt-in demo seed.

## Care team and follow-ups

**Invitations.** A family administrator invites a caregiver by email. The link (`/invite#<token>`) carries a 256-bit token in the URL *fragment*, so browsers never send it to the server's logs or in a Referer header. Only its SHA-256 hash is stored. Invitations are single-use, expire after 72 h, belong to one profile, can be revoked, and can only be accepted by a signed-in account with the invited email address. Caregivers use their own Better Auth accounts. Removing a caregiver takes effect on their very next request, and anything they had claimed goes back to the queue.

| | Family admin | Caregiver | Elder |
|---|---|---|---|
| Invite / remove caregivers, Notification Center | ✅ | ❌ | ❌ |
| Medicines, routines, appointments, record outcomes | ✅ | ✅ (assigned profiles only) | report own doses only |
| See follow-ups, claim and resolve your own | ✅ | ✅ | ❌ (sees help status) |
| Release or resolve someone else's claim | ✅ (intervention) | ❌ | ❌ |

**Follow-ups.** Created automatically, one per source record, from an Unconfirmed dose, an explicit Not Taken, or "I need help" (high priority). "I'll check on this" is an atomic claim: exactly one person wins and others get 409 showing who owns it; repeating your own claim does nothing. Resolving with Taken / Not Taken goes through the adherence engine (same history and record of how they know). "Could not verify" never marks a dose taken. A late confirmation closes the follow-up as *reconciled*. Every step is kept in `incident_events`. Unsent alert emails for a follow-up are cancelled once someone claims or closes it. Caregivers with alerts turned on receive those alerts; no separate follow-up email is sent.

## Demo data (opt-in)

```bash
DEMO_SEED=enabled DEMO_PASSWORD='choose-a-local-passcode' npm run seed:demo
```

This creates (or resets) a synthetic care circle: one admin, two caregivers, an elder login (`swastik.seed`), an upcoming medicine, an Unconfirmed dose, a help request, an appointment, and open follow-ups. It refuses to run without `DEMO_SEED=enabled`, and refuses in production unless `ALLOW_PRODUCTION_DEMO_SEED=true`. No passwords are stored in source. With local PGlite, stop `npm run dev` first.

## Email reminders and the sweep

One idempotent **sweep** does all background work: top up doses → mark overdue doses Unconfirmed → queue due notifications → send (or preview) them. Nothing runs in the background by itself. A sweep happens only when:

- an external scheduler calls `POST /internal/sweep` with `Authorization: Bearer $SWEEP_SECRET` (503 if no secret is configured, 401 if the secret is wrong); or
- a family administrator clicks **Run reminder check now**. This uses their session, is scoped to their profile, has a 30 s cooldown, and runs the same code.

Later, a scheduler such as cron-job.org can call it every 5 minutes:

```bash
curl -X POST https://<your-app>/internal/sweep -H "Authorization: Bearer $SWEEP_SECRET"
```

| Email | When | To (opted-in, never the elder) | Cancelled if |
|---|---|---|---|
| Medicine reminder | dose time − lead time | admins and caregivers | dose recorded, voided, snoozed, medicine stopped, or grace period passed |
| Reminder again | when a "remind me later" ends | admins and caregivers | dose recorded |
| Unconfirmed alert | after the grace period | admins | dose confirmed or reported before sending |
| Reported not taken | after an explicit report | admins | corrected before sending |
| Appointment reminder | `reminderHoursBefore` (default 24 h) | admins and caregivers | appointment cancelled or moved (a new reminder is queued) |
| Help request | when requested | admins | request closed |

Emails never contain medicine names, doctor names or dosing advice. They link back to Relay instead.

**Statuses:** `queued` → `sending` → `accepted` (the provider accepted it; **not** proof of delivery), `previewed` (not sent), `failed`, `uncertain`, `paused_limit` or `cancelled`.

**Exactly-once policy:** dedup keys make queueing idempotent, and a database lease plus row claiming stop two workers from sending the same row. A provider HTTP error (429/5xx) is retried with backoff (2, 4, 8 … min, at most 3 attempts). A timeout or network error after the request left is marked `uncertain` and is **never retried**: we would rather miss an email than send a duplicate medicine alert.

### Real-email safety
| Setting | Default | Effect |
|---|---|---|
| `REAL_EMAIL_SEND_ENABLED` | `false` | Real email requires exactly `true` **and** a Brevo key. A key alone never sends. Tests always preview. |
| `EMAIL_REAL_SEND_CAP` | `20` | Persistent cap (accepted + uncertain, counted in the database). Once reached, items become `paused_limit`. |
| `SWEEP_MAX_PER_RUN` | `25` | Maximum notifications processed per sweep. |
| `SWEEP_MAX_PER_PROFILE` | `10` | Maximum per profile per sweep; the rest wait for the next sweep. |
| `SWEEP_SECRET` | unset | Enables `/internal/sweep` (at least 32 characters). |

### Adherence principles
- States: `scheduled`, `taken`, `not_taken`, `unconfirmed`, `void`. **Silence never becomes "not taken".** Only the system marks a dose `unconfirmed`, and only after the profile's grace period (default 60 min, or later if the dose was snoozed).
- Every outcome records who recorded it, when, and how they know (`self_reported`, `observed`, `reported_by_other` or `system`). It also stores the claimed time taken separately from the time it was reported.
- `dose_events` is append-only. Corrections (by an admin, or by whoever recorded the outcome, within 24 h, with a reason) add a linked event; nothing is overwritten or erased.
- Concurrency: every change is a conditional update on a per-dose `version`, then re-evaluated on conflict. A repeated identical request is a no-op (200). A conflicting one gets 409.
- "Remind me later": 15 minutes, at most twice per dose. The prescribed time never changes.
- Relay never advises taking, doubling or skipping a dose.

### Dose generation rules
- Every medicine or routine is taken daily at one or more local times (`HH:mm`), between an inclusive start date and an optional end date.
- Dose ids are deterministic (`kind:sourceId:YYYY-MM-DDTHH:mm`), so running generation again never creates duplicates.
- Editing or stopping a medicine deletes only its **future doses with no recorded outcome**, then regenerates them. Past doses and anything with an outcome are never changed. An edit never back-fills earlier doses.
- DST: a time in the spring-forward gap moves forward (02:30 → 03:30). An ambiguous fall-back time uses its first occurrence.

## Design

The direction is **Warm Botanical × Editorial Minimalism**.

- **Colours:** Alabaster `#FAF7F2` page, Oat `#EFECE6` surfaces, Deep Botanical Teal `#16423C` for every primary action, Warm Charcoal `#1F2421` text. Terracotta `#C85A32` is decorative only (3.96:1 contrast); text uses `#A3431F` (5.8:1).
- **Type:** Newsreader for headings and for all times and counts (open, tabular figures). Atkinson Hyperlegible for body text and controls. Digits inside body text also render in Newsreader via a `unicode-range` face, so zeros are never slashed.
- **Status:** always shown with a symbol and words (✓ Taken, – Not taken, ? Unconfirmed, ○ Scheduled), never colour alone.
- **Layout:** a public landing page at `/`, a fictional demo at `/demo`, dashboards at `/home` ("People you care for", where each card shows *your role* in that care circle), and a care-profile sidebar on desktop ("Caring for Swastik / Your role: Caregiver") that becomes a tab row on mobile.

### Public demo (`/demo`)
Three fictional perspectives share one simulated morning: Swastik (elder), Ravi (caregiver) and Priya (family administrator). Actions run entirely in the browser through a small deterministic reducer (`src/web/demo/model.ts`, unit-tested): no API calls, no accounts, no email, no database. Taking a dose, asking for help, claiming and resolving a follow-up all update the other two views. "Reset demo" restores the story.

### Interactive real-app demo (from the sign-in page)
"Just exploring Relay?" opens the **real** dashboards as Swastik, Ravi or Priya. Each visitor gets a private synthetic care circle, created on demand by `POST /api/demo/start`:
- Four accounts with `@demo.relay.invalid` addresses, so email rules never send to them. Their passwords are derived on the server with HMAC(server secret) and are never shown or stored.
- Switching person only works within the circle bound to the visitor's HttpOnly `relay_demo` cookie. A forged or expired cookie just creates a new circle; it never reaches someone else's.
- Demo accounts cannot invite people, create care circles, create sign-ins or accept invitations.
- Rate-limited per IP and globally. Circles and their accounts are deleted by the sweep after 24 h.
- The public `/demo` page (linked from the landing page) is unchanged: a browser-only simulation.

### Care profile lifecycle
- **Archive a care circle** (admin only, recent sign-in, type the person's name): it is hidden from everyone, the elder's device is signed out, and pending reminder emails are cancelled. **No records are deleted.** It can be restored from "People you care for".
- **Remove a caregiver** is a separate action in Care team. Relay has no "delete user account" action.
- Creating a profile no longer needs free text for "They agreed". "Other" still requires a description. Every choice is stored as the administrator's declaration, with who made it and when.
- **Checked with axe-core:** 0 WCAG 2.2 AA violations on every page. No horizontal overflow at 375, 768, 1024, 1440 or 1920 px.

## Stack

| Layer | Choice |
|---|---|
| Frontend | React 19, Vite, TypeScript, Tailwind CSS 4, React Router |
| Backend | Node 22+, Express 5, TypeScript, one service that also serves the built frontend |
| Auth | [Better Auth](https://www.better-auth.com): email/passcode plus the username plugin, database sessions, HttpOnly cookies, database-backed rate limiting |
| Database | PostgreSQL via Drizzle ORM. **PGlite** (embedded Postgres) for development and tests only; any persistent PostgreSQL (e.g. Neon) in production. Both run the same SQL migrations in `drizzle/`. |
| Email | `EmailProvider` interface: `ConsoleEmailProvider` (dev/test) and `BrevoEmailProvider` (HTTPS API) |
| Tests | Vitest and Supertest (API, auth, authorization, email); Playwright MCP for browser checks |

## Getting started

```bash
npm install
cp .env.example .env        # then set BETTER_AUTH_SECRET (see the comment in the file)
npm run dev                 # http://localhost:3000 (Express + Vite, PGlite in .data/)
```

| Script | Purpose |
|---|---|
| `npm run dev` | Development server with hot reload |
| `npm run build` | Build the frontend to `dist/web` and the server to `dist/server` |
| `npm start` | Production server (requires `DATABASE_URL` and `BETTER_AUTH_SECRET`) |
| `npm test` | Automated tests (in-memory PGlite, console email) |
| `npm run lint` | ESLint and TypeScript type-check |
| `npm run db:generate` | Generate a SQL migration after editing `src/server/db/schema.ts` |
| `npm run email:test -- you@example.com` | Send one test email; reports which provider ran and whether a real API request was made |

## Roles and access

| Action | Family admin | Caregiver* | Elder |
|---|---|---|---|
| Create a care profile | ✅ | ✅ (becomes its admin) | ❌ |
| View the profile and care team | ✅ | ✅ | ❌ (sees only the elder home) |
| Create the elder's username sign-in | ✅ (recent sign-in required) | ❌ | ❌ |
| Sign out all elder devices | ✅ (recent sign-in required) | ❌ | ❌ |
| Elder home screen | ❌ | ❌ | ✅ |

\*Caregiver invitations arrive in a later checkpoint. Every rule is enforced on the server (`src/server/authz.ts`), not just hidden in the UI.

## Security notes

- Passcodes are hashed by Better Auth and must be at least 10 characters. Sessions are database-backed and stored in HttpOnly, SameSite=Lax cookies (also `Secure` over HTTPS).
- Session policy: elder devices keep a rolling 30-day session that an admin can revoke. Family administrator and caregiver sessions expire 7 days after sign-in, however often they're used.
- Rate limit: 5 sign-in or sign-up attempts per minute per client IP, in every environment. The server sets the client IP itself, so clients cannot spoof it.
- Sensitive admin actions require a sign-in within the last 15 minutes.
- Cross-origin state-changing API requests are rejected. Helmet security headers and a CSP are sent in production.
- The elder account cannot reach any administrator route. Its placeholder email (`*.invalid`) is never shown.
- The consent record is the admin's **attestation**, not verified legal authority.
- Secrets live only in `.env`, which git ignores. Production refuses to start without `DATABASE_URL` and a 32+ character `BETTER_AUTH_SECRET`.

## Email delivery honesty

A provider accepting a request is not proof of delivery. `npm run email:test` says explicitly whether it used the console provider (nothing sent) or made a real Brevo API request (accepted, delivery not confirmed).

## Project layout

```
src/server/   Express app, Better Auth config, authorization, routes, email providers, DB schema/client
src/shared/   Zod schemas and types shared by API and UI
src/web/      React app (pages, components, auth client)
drizzle/      SQL migrations (shared by PGlite and PostgreSQL)
scripts/      email-test.ts
tests/        Vitest + Supertest suites
```
