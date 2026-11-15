import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import type { Database } from "../db/client.js";
import {
  appointments,
  doses,
  helpRequests,
  incidents,
  medications,
  notifications,
  profileMembers,
  profiles,
  sweepLocks,
  sweepRuns,
  user,
  type DoseStatus,
  type NotificationStatus,
  type NotificationType,
} from "../db/schema.js";
import { ConsoleEmailProvider } from "../email/console.js";
import { EmailSendError, type EmailProvider } from "../email/types.js";
import { markOverdueUnconfirmed } from "./adherence.js";
import { buildEmail, renderContent, storedSummary, type Content } from "./notificationContent.js";
import { purgeExpiredSandboxes } from "./demoSandbox.js";
import { syncIncidents } from "./incidents.js";
import { generateDosesForProfile } from "./schedule.js";

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

export interface NotifierConfig {
  /** Provider used only when realSendEnabled is true. */
  provider: EmailProvider;
  /** Master switch. False → every notification is rendered as a preview; nothing leaves the server. */
  realSendEnabled: boolean;
  /** Persistent cap on real external sends (accepted + uncertain) across this database. */
  realSendCap: number;
  /** Maximum notifications processed in one sweep. */
  maxPerSweep: number;
  /** Maximum notifications processed for one profile in one sweep. */
  maxPerProfilePerSweep: number;
  /** Public app URL for links in emails. */
  appUrl: string;
}

export const MAX_ATTEMPTS = 3;
export const STUCK_SENDING_MINUTES = 10;
export const SWEEP_LOCK_SECONDS = 120;
export const MANUAL_SWEEP_COOLDOWN_SECONDS = 30;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

export function previewConfig(appUrl: string): NotifierConfig {
  return {
    provider: new ConsoleEmailProvider(() => {}),
    realSendEnabled: false,
    realSendCap: 20,
    maxPerSweep: 25,
    maxPerProfilePerSweep: 10,
    appUrl,
  };
}

/** Preview mode renders through the console provider with a silent logger: nothing leaves the server. */
const PREVIEW_PROVIDER = new ConsoleEmailProvider(() => {});

const isExternal = (cfg: NotifierConfig) => cfg.realSendEnabled && cfg.provider.name !== "console";

/** Exponential backoff for retryable failures: 2, 4, 8 … minutes, capped at 30. */
export function backoffMinutes(attempts: number): number {
  return Math.min(30, 2 ** attempts);
}

/** Removes anything that could be a credential or an email address; caps length. */
export function sanitizeError(message: string): string {
  return message
    .replace(/xkeysib-[A-Za-z0-9-]+/g, "[redacted-key]")
    .replace(/[^\s@"'<>]+@[^\s@"'<>]+/g, "[redacted-email]")
    .slice(0, 200);
}

export function maskEmail(email: string | null | undefined): string {
  if (!email) return "—";
  const [local, domain] = email.split("@");
  if (!local || !domain) return "—";
  return `${local.slice(0, 1)}${"•".repeat(Math.max(2, Math.min(6, local.length - 1)))}@${domain}`;
}

/* ------------------------------------------------------------------ */
/* Recipients                                                          */
/* ------------------------------------------------------------------ */

type Pref = "notifyDoseReminders" | "notifyAlerts" | "notifyAppointments";

/**
 * Deterministic recipient rules:
 * - Never elder accounts (they have no real email address).
 * - Never placeholder addresses (*.invalid).
 * - Unconfirmed / Not Taken / help alerts → administrators and caregivers who keep alerts on
 *   (these alerts double as the follow-up notice; no separate incident email is sent).
 * - Dose and appointment reminders → administrators and caregivers who opted in.
 */
async function recipients(db: Database, profileId: string, pref: Pref, roles: ("admin" | "caregiver")[]) {
  const rows = await db
    .select({ userId: user.id, email: user.email, role: profileMembers.role, on: profileMembers[pref] })
    .from(profileMembers)
    .innerJoin(user, eq(user.id, profileMembers.userId))
    .where(and(eq(profileMembers.profileId, profileId), inArray(profileMembers.role, roles)));
  return rows.filter((r) => r.on && r.email && !r.email.toLowerCase().endsWith(".invalid")).map((r) => r.userId);
}

const PREF_FOR: Record<NotificationType, { pref: Pref; roles: ("admin" | "caregiver")[] }> = {
  dose_reminder: { pref: "notifyDoseReminders", roles: ["admin", "caregiver"] },
  dose_snooze_reminder: { pref: "notifyDoseReminders", roles: ["admin", "caregiver"] },
  dose_unconfirmed: { pref: "notifyAlerts", roles: ["admin", "caregiver"] },
  dose_not_taken: { pref: "notifyAlerts", roles: ["admin", "caregiver"] },
  appointment_reminder: { pref: "notifyAppointments", roles: ["admin", "caregiver"] },
  help_request: { pref: "notifyAlerts", roles: ["admin", "caregiver"] },
};

/* ------------------------------------------------------------------ */
/* Relevance — re-checked at send time so stale alerts never go out    */
/* ------------------------------------------------------------------ */

type NotificationRow = typeof notifications.$inferSelect;
type ProfileRow = typeof profiles.$inferSelect;
type Relevance = { ok: true; content: Content; email: string } | { ok: false; status: "cancelled" | "failed"; reason: string };
/** A notification's subject either still warrants this email (with its wording) or is stale for a reason. */
type SubjectCheck = { content: Content } | { stale: string };

const cancelled = (reason: string): Relevance => ({ ok: false, status: "cancelled", reason });

/** Alerts that double as a follow-up notice: pointless once someone is handling it or it is closed. */
const FOLLOW_UP_ALERTS: ReadonlySet<NotificationType> = new Set(["dose_unconfirmed", "dose_not_taken", "help_request"]);

/**
 * Pure rule: why a dose notification is no longer worth sending, or null if it still is.
 * Each type is only valid while the dose is still in the state that triggered it.
 */
export function staleDoseReason(type: NotificationType, dose: { status: DoseStatus; snoozeCount: number }): string | null {
  switch (type) {
    case "dose_reminder":
      if (dose.status !== "scheduled") return `dose_${dose.status}`;
      return dose.snoozeCount > 0 ? "superseded_by_snooze" : null;
    case "dose_snooze_reminder":
      return dose.status === "scheduled" ? null : `dose_${dose.status}`;
    case "dose_unconfirmed":
      return dose.status === "unconfirmed" ? null : `now_${dose.status}`;
    case "dose_not_taken":
      return dose.status === "not_taken" ? null : `corrected_to_${dose.status}`;
    default:
      return null;
  }
}

async function isEligibleRecipient(db: Database, n: NotificationRow): Promise<boolean> {
  if (!n.recipientUserId) return false;
  const rule = PREF_FOR[n.type];
  return (await recipients(db, n.profileId, rule.pref, rule.roles)).includes(n.recipientUserId);
}

/** The status of the follow-up this alert announces, if it is no longer open. */
async function handledFollowUpStatus(db: Database, n: NotificationRow): Promise<string | null> {
  const sourceId = n.doseId ?? n.helpRequestId;
  if (!FOLLOW_UP_ALERTS.has(n.type) || !sourceId) return null;
  const [inc] = await db.select({ status: incidents.status }).from(incidents).where(eq(incidents.dedupeKey, `${n.type}:${sourceId}`));
  return inc && inc.status !== "open" ? inc.status : null;
}

async function checkDose(db: Database, n: NotificationRow, doseId: string, p: ProfileRow, appUrl: string): Promise<SubjectCheck> {
  const [d] = await db.select().from(doses).where(and(eq(doses.id, doseId), eq(doses.profileId, n.profileId)));
  if (!d) return { stale: "dose_removed" };
  const stale = staleDoseReason(n.type, d);
  if (stale) return { stale };
  let reporter: string | undefined;
  if (n.type === "dose_not_taken" && d.outcomeRecordedBy) {
    const [u] = await db.select({ name: user.name }).from(user).where(eq(user.id, d.outcomeRecordedBy));
    reporter = u?.name;
  }
  return { content: renderContent(n.type, { name: p.preferredName, time: d.localTime, link: `${appUrl}/profiles/${p.id}/schedule`, reporter }) };
}

async function checkAppointment(db: Database, n: NotificationRow, appointmentId: string, p: ProfileRow, appUrl: string): Promise<SubjectCheck> {
  const [a] = await db.select().from(appointments).where(and(eq(appointments.id, appointmentId), eq(appointments.profileId, n.profileId)));
  if (!a || a.status !== "scheduled") return { stale: "appointment_cancelled" };
  // expiresAt was set to the start time when queued; a moved appointment gets a new dedupe key.
  if (a.startsAt.getTime() !== n.expiresAt.getTime()) return { stale: "appointment_rescheduled" };
  const local = DateTime.fromJSDate(a.startsAt, { zone: p.timezone });
  return {
    content: renderContent(n.type, { name: p.preferredName, date: local.toFormat("ccc d LLL"), time: local.toFormat("HH:mm"), link: `${appUrl}/profiles/${p.id}/appointments` }),
  };
}

async function checkHelpRequest(db: Database, n: NotificationRow, helpRequestId: string, p: ProfileRow, appUrl: string): Promise<SubjectCheck> {
  const [h] = await db.select().from(helpRequests).where(eq(helpRequests.id, helpRequestId));
  if (!h || h.status === "resolved") return { stale: "help_resolved" };
  return { content: renderContent(n.type, { name: p.preferredName, link: `${appUrl}/profiles/${p.id}` }) };
}

function checkSubject(db: Database, n: NotificationRow, p: ProfileRow, appUrl: string): Promise<SubjectCheck> {
  if (n.doseId) return checkDose(db, n, n.doseId, p, appUrl);
  if (n.appointmentId) return checkAppointment(db, n, n.appointmentId, p, appUrl);
  if (n.helpRequestId) return checkHelpRequest(db, n, n.helpRequestId, p, appUrl);
  return Promise.resolve({ stale: "unknown_subject" });
}

/**
 * Decides at send time whether a queued notification should still go out, and renders it if so.
 * Checks run in order: expiry → profile → recipient → follow-up already handled → subject still current.
 */
export async function checkRelevance(db: Database, n: NotificationRow, cfg: NotifierConfig, now: Date): Promise<Relevance> {
  if (now > n.expiresAt) return cancelled("expired");
  const [p] = await db.select().from(profiles).where(eq(profiles.id, n.profileId));
  if (!p) return cancelled("profile_removed");
  if (p.archivedAt) return cancelled("profile_archived");

  if (!(await isEligibleRecipient(db, n))) return cancelled("recipient_not_eligible");
  const [r] = await db.select({ email: user.email }).from(user).where(eq(user.id, n.recipientUserId!));
  if (!r?.email) return { ok: false, status: "failed", reason: "no_valid_email" };

  const handled = await handledFollowUpStatus(db, n);
  if (handled) return cancelled(`incident_${handled}`);

  const subject = await checkSubject(db, n, p, cfg.appUrl);
  return "stale" in subject ? cancelled(subject.stale) : { ok: true, email: r.email, content: subject.content };
}

/* ------------------------------------------------------------------ */
/* Queueing (idempotent: unique dedupe_key + ON CONFLICT DO NOTHING)   */
/* ------------------------------------------------------------------ */

interface Candidate {
  type: NotificationType;
  profileId: string;
  key: string;
  dueAt: Date;
  expiresAt: Date;
  doseId?: string;
  appointmentId?: string;
  helpRequestId?: string;
}

/** The time window and optional profile a queueing pass looks at. */
interface QueueWindow {
  now: Date;
  dayAgo: Date;
  profileId?: string;
}

const inScope = (column: typeof doses.profileId | typeof appointments.profileId | typeof helpRequests.profileId, w: QueueWindow) =>
  w.profileId ? eq(column, w.profileId) : undefined;

/** a) Upcoming-dose reminders: reminder time reached, still within grace, not snoozed, active medicine. */
async function doseReminderCandidates(db: Database, w: QueueWindow): Promise<Candidate[]> {
  const rows = await db
    .select({ id: doses.id, profileId: doses.profileId, scheduledAt: doses.scheduledAt, lead: medications.reminderLeadMinutes, grace: profiles.graceMinutes })
    .from(doses)
    .innerJoin(medications, eq(medications.id, doses.medicationId))
    .innerJoin(profiles, eq(profiles.id, doses.profileId))
    .where(
      and(
        inScope(doses.profileId, w),
        eq(doses.kind, "medication"),
        eq(doses.status, "scheduled"),
        eq(doses.snoozeCount, 0),
        eq(medications.active, true),
        gte(doses.scheduledAt, w.dayAgo),
        lte(sql`${doses.scheduledAt} - make_interval(mins => ${medications.reminderLeadMinutes})`, w.now),
        gt(sql`${doses.scheduledAt} + make_interval(mins => ${profiles.graceMinutes})`, w.now),
      ),
    );
  return rows.map((d) => ({
    type: "dose_reminder",
    profileId: d.profileId,
    key: `dose_reminder:${d.id}`,
    dueAt: new Date(d.scheduledAt.getTime() - d.lead * MIN),
    expiresAt: new Date(d.scheduledAt.getTime() + d.grace * MIN),
    doseId: d.id,
  }));
}

/** b) "Remind me later" follow-ups, due when the snooze ends. One per snooze (the count is in the key). */
async function snoozeReminderCandidates(db: Database, w: QueueWindow): Promise<Candidate[]> {
  const rows = await db
    .select({ id: doses.id, profileId: doses.profileId, snoozeUntil: doses.snoozeUntil, count: doses.snoozeCount })
    .from(doses)
    .innerJoin(medications, eq(medications.id, doses.medicationId))
    .where(
      and(
        inScope(doses.profileId, w),
        eq(doses.kind, "medication"),
        eq(doses.status, "scheduled"),
        eq(medications.active, true),
        gt(doses.snoozeCount, 0),
        isNotNull(doses.snoozeUntil),
        lte(doses.snoozeUntil, w.now),
        gt(doses.snoozeUntil, new Date(w.now.getTime() - 30 * MIN)),
      ),
    );
  return rows.map((d) => ({
    type: "dose_snooze_reminder",
    profileId: d.profileId,
    key: `dose_snooze_reminder:${d.id}:${d.count}`,
    dueAt: d.snoozeUntil!,
    expiresAt: new Date(d.snoozeUntil!.getTime() + 30 * MIN),
    doseId: d.id,
  }));
}

/** c) Unconfirmed alerts. The adherence engine already moved the dose; this only notifies. */
async function unconfirmedCandidates(db: Database, w: QueueWindow): Promise<Candidate[]> {
  const rows = await db
    .select({ id: doses.id, profileId: doses.profileId, scheduledAt: doses.scheduledAt })
    .from(doses)
    .where(and(inScope(doses.profileId, w), eq(doses.kind, "medication"), eq(doses.status, "unconfirmed"), gte(doses.scheduledAt, w.dayAgo)));
  return rows.map((d) => ({
    type: "dose_unconfirmed",
    profileId: d.profileId,
    key: `dose_unconfirmed:${d.id}`,
    dueAt: w.now,
    expiresAt: new Date(d.scheduledAt.getTime() + DAY),
    doseId: d.id,
  }));
}

/** d) Explicitly reported Not Taken. */
async function notTakenCandidates(db: Database, w: QueueWindow): Promise<Candidate[]> {
  const rows = await db
    .select({ id: doses.id, profileId: doses.profileId, at: doses.outcomeRecordedAt })
    .from(doses)
    .where(and(inScope(doses.profileId, w), eq(doses.kind, "medication"), eq(doses.status, "not_taken"), gte(doses.outcomeRecordedAt, w.dayAgo)));
  return rows.map((d) => ({
    type: "dose_not_taken",
    profileId: d.profileId,
    key: `dose_not_taken:${d.id}`,
    dueAt: w.now,
    expiresAt: new Date(d.at!.getTime() + DAY),
    doseId: d.id,
  }));
}

/** e) Appointment reminders: within the reminder window, still in the future, not cancelled. */
async function appointmentCandidates(db: Database, w: QueueWindow): Promise<Candidate[]> {
  const rows = await db
    .select({ id: appointments.id, profileId: appointments.profileId, startsAt: appointments.startsAt, hours: appointments.reminderHoursBefore })
    .from(appointments)
    .where(
      and(
        inScope(appointments.profileId, w),
        eq(appointments.status, "scheduled"),
        gt(appointments.startsAt, w.now),
        lte(sql`${appointments.startsAt} - make_interval(hours => ${appointments.reminderHoursBefore})`, w.now),
      ),
    );
  return rows.map((a) => ({
    type: "appointment_reminder",
    profileId: a.profileId,
    // The start time is part of the key: rescheduling creates a new reminder; the old one is cancelled at send time.
    key: `appointment_reminder:${a.id}:${a.startsAt.toISOString()}`,
    dueAt: new Date(a.startsAt.getTime() - a.hours * 60 * MIN),
    expiresAt: a.startsAt,
    appointmentId: a.id,
  }));
}

/** f) Open help requests from the last day. */
async function helpRequestCandidates(db: Database, w: QueueWindow): Promise<Candidate[]> {
  const rows = await db
    .select({ id: helpRequests.id, profileId: helpRequests.profileId, createdAt: helpRequests.createdAt })
    .from(helpRequests)
    .where(and(inScope(helpRequests.profileId, w), eq(helpRequests.status, "open"), gte(helpRequests.createdAt, w.dayAgo)));
  return rows.map((h) => ({
    type: "help_request",
    profileId: h.profileId,
    key: `help_request:${h.id}`,
    dueAt: h.createdAt,
    expiresAt: new Date(h.createdAt.getTime() + DAY),
    helpRequestId: h.id,
  }));
}

const CANDIDATE_SOURCES = [
  doseReminderCandidates,
  snoozeReminderCandidates,
  unconfirmedCandidates,
  notTakenCandidates,
  appointmentCandidates,
  helpRequestCandidates,
] as const;

/** One outbox row per (candidate, eligible recipient). Recipients are looked up once per profile and type. */
async function fanOut(db: Database, candidates: Candidate[], now: Date): Promise<(typeof notifications.$inferInsert)[]> {
  const recipientCache = new Map<string, string[]>();
  const rows: (typeof notifications.$inferInsert)[] = [];
  for (const c of candidates) {
    const cacheKey = `${c.profileId}:${c.type}`;
    let to = recipientCache.get(cacheKey);
    if (!to) {
      const rule = PREF_FOR[c.type];
      to = await recipients(db, c.profileId, rule.pref, rule.roles);
      recipientCache.set(cacheKey, to);
    }
    for (const userId of to) {
      rows.push({
        dedupeKey: `${c.key}:${userId}`,
        profileId: c.profileId,
        type: c.type,
        recipientUserId: userId,
        subject: "Pending",
        preview: "Content is prepared when the notification is processed.",
        doseId: c.doseId ?? null,
        appointmentId: c.appointmentId ?? null,
        helpRequestId: c.helpRequestId ?? null,
        dueAt: c.dueAt,
        expiresAt: c.expiresAt,
        nextAttemptAt: c.dueAt < now ? now : c.dueAt,
        createdAt: now,
        updatedAt: now,
      });
    }
  }
  return rows;
}

/** Finds everything due and inserts it into the outbox. Idempotent: the dedupe key makes repeats no-ops. */
export async function queueDueNotifications(db: Database, now: Date, profileId?: string): Promise<number> {
  const w: QueueWindow = { now, dayAgo: new Date(now.getTime() - DAY), profileId };
  const candidates: Candidate[] = [];
  for (const collect of CANDIDATE_SOURCES) candidates.push(...(await collect(db, w)));

  const rows = await fanOut(db, candidates, now);
  if (rows.length === 0) return 0;
  const inserted = await db.insert(notifications).values(rows).onConflictDoNothing({ target: notifications.dedupeKey }).returning({ id: notifications.id });
  return inserted.length;
}

/* ------------------------------------------------------------------ */
/* Processing                                                          */
/* ------------------------------------------------------------------ */

export interface ProcessSummary {
  claimed: number;
  previewed: number;
  accepted: number;
  retryScheduled: number;
  failed: number;
  uncertain: number;
  pausedLimit: number;
  cancelled: number;
  deferred: number;
}

const emptySummary = (): ProcessSummary => ({
  claimed: 0,
  previewed: 0,
  accepted: 0,
  retryScheduled: 0,
  failed: 0,
  uncertain: 0,
  pausedLimit: 0,
  cancelled: 0,
  deferred: 0,
});

/** Real external sends that count against the cap: accepted or uncertain (a request that may have gone out). */
export async function realSendsUsed(db: Database): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.provider, "brevo"), inArray(notifications.status, ["accepted", "uncertain"])));
  return row?.n ?? 0;
}

/**
 * Atomically claims due notifications. The conditional `status = 'queued'` update (plus SKIP LOCKED on
 * PostgreSQL) guarantees two concurrent workers never claim the same row.
 */
export async function claimDue(db: Database, now: Date, limit: number, profileId?: string): Promise<NotificationRow[]> {
  if (limit <= 0) return [];
  // Two steps in one transaction. (A single UPDATE … WHERE id IN (SELECT … LIMIT n FOR UPDATE) is unsafe:
  // the planner may re-run the subquery per row, and with ties in ORDER BY each run can pick a different
  // row, silently ignoring the limit.) The id tie-breaker keeps ordering deterministic.
  return db.transaction(async (tx) => {
    const due = await tx
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.status, "queued"), lte(notifications.nextAttemptAt, now), profileId ? eq(notifications.profileId, profileId) : undefined))
      .orderBy(asc(notifications.dueAt), asc(notifications.id))
      .limit(limit)
      .for("update", { skipLocked: true });
    if (due.length === 0) return [];
    return tx
      .update(notifications)
      .set({ status: "sending", claimedAt: now, updatedAt: now })
      .where(and(inArray(notifications.id, due.map((d) => d.id)), eq(notifications.status, "queued")))
      .returning();
  });
}

async function finish(db: Database, id: string, patch: Partial<typeof notifications.$inferInsert>, now: Date) {
  await db
    .update(notifications)
    .set({ ...patch, updatedAt: now })
    .where(and(eq(notifications.id, id), eq(notifications.status, "sending")));
}

/** Pure policy for a failed provider call. */
export type SendFailureDecision = { status: "queued"; retryInMinutes: number } | { status: "failed" } | { status: "uncertain" };

/**
 * - The provider answered with an error status: it was NOT accepted. 429/5xx are retried with backoff
 *   up to MAX_ATTEMPTS; anything else fails.
 * - No answer (timeout, network error): the request may have gone out. Never retried, so nobody gets a duplicate.
 */
export function classifySendFailure(err: unknown, attempts: number): SendFailureDecision {
  if (!(err instanceof EmailSendError) || err.status === undefined) return { status: "uncertain" };
  const retryable = err.status === 429 || err.status >= 500;
  return retryable && attempts < MAX_ATTEMPTS ? { status: "queued", retryInMinutes: backoffMinutes(attempts) } : { status: "failed" };
}

type Outcome = Exclude<keyof ProcessSummary, "claimed">;
type EmailMessage = ReturnType<typeof buildEmail>;
type StoredSummary = ReturnType<typeof storedSummary>;

/** Sends one notification through the real provider and records the result. */
async function sendExternally(db: Database, cfg: NotifierConfig, n: NotificationRow, message: EmailMessage, stored: StoredSummary, now: Date): Promise<Outcome> {
  const attempts = n.attempts + 1;
  // Mark as an external attempt BEFORE the request leaves, so a crash is counted and never blindly retried.
  await db.update(notifications).set({ ...stored, provider: "brevo", attempts, updatedAt: now }).where(eq(notifications.id, n.id));
  try {
    const res = await cfg.provider.send(message);
    await finish(db, n.id, { status: "accepted", providerMessageId: res.providerMessageId ?? null, sentAt: now, lastError: null }, now);
    return "accepted";
  } catch (err) {
    const decision = classifySendFailure(err, attempts);
    const lastError = sanitizeError(err instanceof Error ? err.message : String(err));
    if (decision.status === "queued") {
      await finish(db, n.id, { status: "queued", claimedAt: null, nextAttemptAt: new Date(now.getTime() + decision.retryInMinutes * MIN), lastError }, now);
      return "retryScheduled";
    }
    await finish(db, n.id, { status: decision.status, lastError }, now);
    return decision.status;
  }
}

/** Per-sweep budgets: per-profile counts and real sends used so far (persisted count + this sweep's). */
interface SweepBudget {
  perProfile: Map<string, number>;
  realSendsUsed: number;
}

async function processOne(db: Database, cfg: NotifierConfig, n: NotificationRow, budget: SweepBudget, now: Date): Promise<Outcome> {
  const count = budget.perProfile.get(n.profileId) ?? 0;
  if (count >= cfg.maxPerProfilePerSweep) {
    // Over this sweep's per-profile budget: hand it back for the next sweep.
    await finish(db, n.id, { status: "queued", claimedAt: null }, now);
    return "deferred";
  }

  const rel = await checkRelevance(db, n, cfg, now);
  if (!rel.ok) {
    await finish(db, n.id, { status: rel.status, cancelReason: rel.status === "cancelled" ? rel.reason : null, lastError: rel.status === "failed" ? rel.reason : null }, now);
    return rel.status;
  }
  budget.perProfile.set(n.profileId, count + 1);
  const message = buildEmail(rel.email, rel.content);
  const stored = storedSummary(rel.content);

  if (!isExternal(cfg)) {
    await PREVIEW_PROVIDER.send(message);
    await finish(db, n.id, { ...stored, status: "previewed", provider: "console", attempts: n.attempts + 1, sentAt: now, lastError: null }, now);
    return "previewed";
  }

  if (budget.realSendsUsed >= cfg.realSendCap) {
    await finish(db, n.id, { ...stored, status: "paused_limit", lastError: `Real-send cap reached (${cfg.realSendCap}). Held, not sent.` }, now);
    return "pausedLimit";
  }

  budget.realSendsUsed++;
  const outcome = await sendExternally(db, cfg, n, message, stored, now);
  // The provider answered with a rejection: nothing went out, so it does not count against the cap.
  if (outcome === "retryScheduled" || outcome === "failed") budget.realSendsUsed--;
  return outcome;
}

/** Claims due notifications and sends (or previews) each one. */
export async function processQueue(db: Database, cfg: NotifierConfig, now: Date, profileId?: string): Promise<ProcessSummary> {
  const summary = emptySummary();
  const claimed = await claimDue(db, now, cfg.maxPerSweep, profileId);
  summary.claimed = claimed.length;
  // The sweep lease prevents concurrent workers, so a local counter on top of the persisted count is exact.
  const budget: SweepBudget = { perProfile: new Map(), realSendsUsed: isExternal(cfg) ? await realSendsUsed(db) : 0 };
  for (const n of claimed) summary[await processOne(db, cfg, n, budget, now)]++;
  return summary;
}

/** Recovers rows left in `sending` by a crashed worker. External ones become `uncertain` (never re-sent). */
export async function recoverStuck(db: Database, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - STUCK_SENDING_MINUTES * MIN);
  const ext = await db
    .update(notifications)
    .set({ status: "uncertain", lastError: "Worker stopped during sending; delivery unknown.", updatedAt: now })
    .where(and(eq(notifications.status, "sending"), lt(notifications.claimedAt, cutoff), eq(notifications.provider, "brevo")))
    .returning({ id: notifications.id });
  const local = await db
    .update(notifications)
    .set({ status: "queued", claimedAt: null, updatedAt: now })
    .where(
      and(
        eq(notifications.status, "sending"),
        lt(notifications.claimedAt, cutoff),
        or(ne(notifications.provider, "brevo"), sql`${notifications.provider} is null`),
      ),
    )
    .returning({ id: notifications.id });
  return ext.length + local.length;
}

/* ------------------------------------------------------------------ */
/* Sweep orchestration                                                 */
/* ------------------------------------------------------------------ */

export interface SweepSummary extends ProcessSummary {
  status: "completed" | "skipped_locked";
  mode: "preview" | "real";
  profiles: number;
  dosesGenerated: number;
  markedUnconfirmed: number;
  queued: number;
  recovered: number;
  realSendsUsed: number;
  realSendCap: number;
}

async function acquireLock(db: Database, holder: string, now: Date): Promise<boolean> {
  const rows = await db
    .insert(sweepLocks)
    .values({ id: "sweep", lockedUntil: new Date(now.getTime() + SWEEP_LOCK_SECONDS * 1000), holder })
    .onConflictDoUpdate({
      target: sweepLocks.id,
      set: { lockedUntil: new Date(now.getTime() + SWEEP_LOCK_SECONDS * 1000), holder },
      setWhere: lt(sweepLocks.lockedUntil, now),
    })
    .returning({ holder: sweepLocks.holder });
  return rows[0]?.holder === holder;
}

async function releaseLock(db: Database, holder: string) {
  await db
    .update(sweepLocks)
    .set({ lockedUntil: new Date(0) })
    .where(and(eq(sweepLocks.id, "sweep"), eq(sweepLocks.holder, holder)));
}

export interface SweepOptions {
  now?: Date;
  profileId?: string;
  trigger: "scheduler" | "manual";
  triggeredBy?: string | null;
}

/**
 * One idempotent sweep: top up doses → system Unconfirmed transitions → queue due notifications
 * → process the outbox. Guarded by a database lease so concurrent invocations cannot overlap.
 */
export async function runSweep(db: Database, cfg: NotifierConfig, opts: SweepOptions): Promise<SweepSummary> {
  const now = opts.now ?? new Date();
  const holder = randomUUID();
  const mode = isExternal(cfg) ? "real" : "preview";
  const base = { mode, realSendCap: cfg.realSendCap } as const;

  if (!(await acquireLock(db, holder, now))) {
    return { ...emptySummary(), ...base, status: "skipped_locked", profiles: 0, dosesGenerated: 0, markedUnconfirmed: 0, queued: 0, recovered: 0, realSendsUsed: await realSendsUsed(db) };
  }

  const [run] = await db
    .insert(sweepRuns)
    .values({ trigger: opts.trigger, profileId: opts.profileId ?? null, triggeredBy: opts.triggeredBy ?? null, startedAt: now })
    .returning({ id: sweepRuns.id });
  try {
    const recovered = await recoverStuck(db, now);
    if (!opts.profileId) await purgeExpiredSandboxes(db, now);
    const profileIds = opts.profileId
      ? [opts.profileId]
      : (await db.select({ id: profiles.id }).from(profiles).where(isNull(profiles.archivedAt))).map((p) => p.id);
    let dosesGenerated = 0;
    for (const id of profileIds) dosesGenerated += await generateDosesForProfile(db, id, now);
    const markedUnconfirmed = (await markOverdueUnconfirmed(db, now, opts.profileId)).length;
    await syncIncidents(db, now, opts.profileId);
    const queued = await queueDueNotifications(db, now, opts.profileId);
    const processed = await processQueue(db, cfg, now, opts.profileId);
    const summary: SweepSummary = {
      ...processed,
      ...base,
      status: "completed",
      profiles: profileIds.length,
      dosesGenerated,
      markedUnconfirmed,
      queued,
      recovered,
      realSendsUsed: await realSendsUsed(db),
    };
    await db.update(sweepRuns).set({ finishedAt: new Date(), summary: JSON.stringify(summary) }).where(eq(sweepRuns.id, run!.id));
    return summary;
  } finally {
    await releaseLock(db, holder);
  }
}

export type { NotificationStatus };
