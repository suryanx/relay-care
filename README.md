# Relay — care that stays connected

Relay is a shared care platform for an elderly person, their family and their caregivers. Its central idea: **a dose nobody confirmed is not the same as a missed dose.** Relay tracks that uncertainty honestly, and routes each follow-up to exactly one accountable caregiver.

> Built for the Catalyst Solo AI Hackathon 2026. All demo data is synthetic. Relay does not give medical advice and does not replace professional or emergency care.

## Status

**Checkpoint 1 (foundation) is complete.** It covers sign-in, profiles, roles, an elder device sign-in, the email provider abstraction and tests. Medicines, adherence, appointments, follow-ups and scheduled emails come in later checkpoints.

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

- Passcodes are hashed by Better Auth and must be at least 10 characters. Sessions are database-backed, stored in HttpOnly, SameSite=Lax cookies (also `Secure` over HTTPS), and last 30 days, renewed on use.
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
