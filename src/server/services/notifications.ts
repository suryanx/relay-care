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
  type NotificationStatus,
  type NotificationType,
} from "../db/schema.js";
import { ConsoleEmailProvider } from "../email/console.js";
import { EmailSendError, type EmailProvider } from "../email/types.js";
import { markOverdueUnconfirmed } from "./adherence.js";
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
 * Deterministic recipient rules (Checkpoint 4):
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
/* Content (non-clinical: no medicine names, no dosing advice)         */
/* ------------------------------------------------------------------ */

interface Content {
  subject: string;
  text: string;
}

const FOOTER = "Relay helps families stay in touch. It does not give medical advice and does not replace a doctor, pharmacist or emergency services.";

function render(type: NotificationType, v: { name: string; time?: string; date?: string; link: string; reporter?: string }): Content {
  switch (type) {
    case "dose_reminder":
      return {
        subject: `Medicine reminder: ${v.name} at ${v.time}`,
        text: `${v.name} has a medicine scheduled for ${v.time} today.\n\nOpen Relay to see the details: ${v.link}`,
      };
    case "dose_snooze_reminder":
      return {
        subject: `Reminder again: ${v.name}'s ${v.time} medicine`,
        text: `${v.name} asked to be reminded again about the medicine scheduled for ${v.time}. The scheduled time has not changed.\n\nOpen Relay: ${v.link}`,
      };
    case "dose_unconfirmed":
      return {
        subject: `Unconfirmed: ${v.name}'s ${v.time} medicine`,
        text: `No one has confirmed yet whether ${v.name} took the medicine scheduled for ${v.time}. Unconfirmed does not mean missed — it has simply not been confirmed. You may want to check in.\n\nRecord what happened in Relay: ${v.link}`,
      };
    case "dose_not_taken":
      return {
        subject: `Reported not taken: ${v.name}'s ${v.time} medicine`,
        text: `${v.reporter ?? "Someone"} reported in Relay that the medicine scheduled for ${v.time} was not taken. This was reported, not assumed. If you are unsure what to do, please ask the pharmacist or doctor.\n\nOpen Relay: ${v.link}`,
      };
    case "appointment_reminder":
      return {
        subject: `Appointment reminder: ${v.name}, ${v.date} at ${v.time}`,
        text: `${v.name} has a doctor's appointment on ${v.date} at ${v.time}.\n\nSee the details in Relay: ${v.link}`,
      };
    case "help_request":
      return {
        subject: `${v.name} asked for help in Relay`,
        text: `${v.name} pressed "I need help" in Relay. Please check in with them. If this could be an emergency, contact local emergency services.\n\nOpen Relay: ${v.link}`,
      };
  }
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const toHtml = (text: string) =>
  `${text
    .split("\n\n")
    .map((p) => `<p>${escapeHtml(p)}</p>`)
    .join("")}<p style="color:#666;font-size:12px">${escapeHtml(FOOTER)}</p>`;

const previewOf = (c: Content) => c.text.split("\n\n")[0]!.slice(0, 240);

/* ------------------------------------------------------------------ */
/* Relevance — re-checked at send time so stale alerts never go out    */
/* ------------------------------------------------------------------ */

type NotificationRow = typeof notifications.$inferSelect;
type Relevance = { ok: true; content: Content; email: string } | { ok: false; status: "cancelled" | "failed"; reason: string };

export async function checkRelevance(db: Database, n: NotificationRow, cfg: NotifierConfig, now: Date): Promise<Relevance> {
  if (now > n.expiresAt) return { ok: false, status: "cancelled", reason: "expired" };
  const [p] = await db.select().from(profiles).where(eq(profiles.id, n.profileId));
  if (!p) return { ok: false, status: "cancelled", reason: "profile_removed" };
  if (p.archivedAt) return { ok: false, status: "cancelled", reason: "profile_archived" };

  // Recipient must still be an eligible member with the preference on.
  const rule = PREF_FOR[n.type];
  if (!n.recipientUserId || !(await recipients(db, n.profileId, rule.pref, rule.roles)).includes(n.recipientUserId)) {
    return { ok: false, status: "cancelled", reason: "recipient_not_eligible" };
  }
  const [r] = await db.select({ email: user.email }).from(user).where(eq(user.id, n.recipientUserId));
  if (!r?.email) return { ok: false, status: "failed", reason: "no_valid_email" };

  const name = p.preferredName;
  const local = (d: Date) => DateTime.fromJSDate(d, { zone: p.timezone });

  // Alerts that announce a follow-up are pointless once someone is handling it or it is closed.
  if (n.type === "dose_unconfirmed" || n.type === "dose_not_taken" || n.type === "help_request") {
    const sourceId = n.doseId ?? n.helpRequestId;
    if (sourceId) {
      const [inc] = await db.select({ status: incidents.status }).from(incidents).where(eq(incidents.dedupeKey, `${n.type}:${sourceId}`));
      if (inc && inc.status !== "open") return { ok: false, status: "cancelled", reason: `incident_${inc.status}` };
    }
  }

  if (n.doseId) {
    const [d] = await db.select().from(doses).where(and(eq(doses.id, n.doseId), eq(doses.profileId, n.profileId)));
    if (!d) return { ok: false, status: "cancelled", reason: "dose_removed" };
    const link = `${cfg.appUrl}/profiles/${p.id}/schedule`;
    const time = d.localTime;
    switch (n.type) {
      case "dose_reminder":
        if (d.status !== "scheduled") return { ok: false, status: "cancelled", reason: `dose_${d.status}` };
        if (d.snoozeCount > 0) return { ok: false, status: "cancelled", reason: "superseded_by_snooze" };
        break;
      case "dose_snooze_reminder":
        if (d.status !== "scheduled") return { ok: false, status: "cancelled", reason: `dose_${d.status}` };
        break;
      case "dose_unconfirmed":
        if (d.status !== "unconfirmed") return { ok: false, status: "cancelled", reason: `now_${d.status}` };
        break;
      case "dose_not_taken":
        if (d.status !== "not_taken") return { ok: false, status: "cancelled", reason: `corrected_to_${d.status}` };
        break;
    }
    let reporter: string | undefined;
    if (n.type === "dose_not_taken" && d.outcomeRecordedBy) {
      const [u] = await db.select({ name: user.name }).from(user).where(eq(user.id, d.outcomeRecordedBy));
      reporter = u?.name;
    }
    return { ok: true, email: r.email, content: render(n.type, { name, time, link, reporter }) };
  }

  if (n.appointmentId) {
    const [a] = await db.select().from(appointments).where(and(eq(appointments.id, n.appointmentId), eq(appointments.profileId, n.profileId)));
    if (!a || a.status !== "scheduled") return { ok: false, status: "cancelled", reason: "appointment_cancelled" };
    // expiresAt was set to the start time when queued; a moved appointment gets a new dedupe key.
    if (a.startsAt.getTime() !== n.expiresAt.getTime()) return { ok: false, status: "cancelled", reason: "appointment_rescheduled" };
    const l = local(a.startsAt);
    return {
      ok: true,
      email: r.email,
      content: render(n.type, { name, date: l.toFormat("ccc d LLL"), time: l.toFormat("HH:mm"), link: `${cfg.appUrl}/profiles/${p.id}/appointments` }),
    };
  }

  if (n.helpRequestId) {
    const [h] = await db.select().from(helpRequests).where(eq(helpRequests.id, n.helpRequestId));
    if (!h || h.status === "resolved") return { ok: false, status: "cancelled", reason: "help_resolved" };
    return { ok: true, email: r.email, content: render(n.type, { name, link: `${cfg.appUrl}/profiles/${p.id}` }) };
  }

  return { ok: false, status: "cancelled", reason: "unknown_subject" };
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

export async function queueDueNotifications(db: Database, now: Date, profileId?: string): Promise<number> {
  const scope = <T extends { profileId: typeof doses.profileId | typeof appointments.profileId | typeof helpRequests.profileId }>(t: T) =>
    profileId ? eq(t.profileId, profileId) : undefined;
  const dayAgo = new Date(now.getTime() - 24 * 60 * MIN);
  const candidates: Candidate[] = [];

  // a) Upcoming-dose reminders: reminder time reached, still within grace, not snoozed, active medicine.
  const upcoming = await db
    .select({ id: doses.id, profileId: doses.profileId, scheduledAt: doses.scheduledAt, lead: medications.reminderLeadMinutes, grace: profiles.graceMinutes })
    .from(doses)
    .innerJoin(medications, eq(medications.id, doses.medicationId))
    .innerJoin(profiles, eq(profiles.id, doses.profileId))
    .where(
      and(
        scope(doses),
        eq(doses.kind, "medication"),
        eq(doses.status, "scheduled"),
        eq(doses.snoozeCount, 0),
        eq(medications.active, true),
        gte(doses.scheduledAt, dayAgo),
        lte(sql`${doses.scheduledAt} - make_interval(mins => ${medications.reminderLeadMinutes})`, now),
        gt(sql`${doses.scheduledAt} + make_interval(mins => ${profiles.graceMinutes})`, now),
      ),
    );
  for (const d of upcoming) {
    candidates.push({
      type: "dose_reminder",
      profileId: d.profileId,
      key: `dose_reminder:${d.id}`,
      dueAt: new Date(d.scheduledAt.getTime() - d.lead * MIN),
      expiresAt: new Date(d.scheduledAt.getTime() + d.grace * MIN),
      doseId: d.id,
    });
  }

  // b) "Remind me later" follow-ups, due when the snooze ends.
  const snoozed = await db
    .select({ id: doses.id, profileId: doses.profileId, snoozeUntil: doses.snoozeUntil, count: doses.snoozeCount })
    .from(doses)
    .innerJoin(medications, eq(medications.id, doses.medicationId))
    .where(
      and(
        scope(doses),
        eq(doses.kind, "medication"),
        eq(doses.status, "scheduled"),
        eq(medications.active, true),
        gt(doses.snoozeCount, 0),
        isNotNull(doses.snoozeUntil),
        lte(doses.snoozeUntil, now),
        gt(doses.snoozeUntil, new Date(now.getTime() - 30 * MIN)),
      ),
    );
  for (const d of snoozed) {
    candidates.push({
      type: "dose_snooze_reminder",
      profileId: d.profileId,
      key: `dose_snooze_reminder:${d.id}:${d.count}`,
      dueAt: d.snoozeUntil!,
      expiresAt: new Date(d.snoozeUntil!.getTime() + 30 * MIN),
      doseId: d.id,
    });
  }

  // c) Unconfirmed alerts (the adherence engine already moved the dose; we only notify).
  const unconfirmed = await db
    .select({ id: doses.id, profileId: doses.profileId, scheduledAt: doses.scheduledAt })
    .from(doses)
    .where(and(scope(doses), eq(doses.kind, "medication"), eq(doses.status, "unconfirmed"), gte(doses.scheduledAt, dayAgo)));
  for (const d of unconfirmed) {
    candidates.push({
      type: "dose_unconfirmed",
      profileId: d.profileId,
      key: `dose_unconfirmed:${d.id}`,
      dueAt: now,
      expiresAt: new Date(d.scheduledAt.getTime() + 24 * 60 * MIN),
      doseId: d.id,
    });
  }

  // d) Explicitly reported Not Taken.
  const notTaken = await db
    .select({ id: doses.id, profileId: doses.profileId, at: doses.outcomeRecordedAt })
    .from(doses)
    .where(and(scope(doses), eq(doses.kind, "medication"), eq(doses.status, "not_taken"), gte(doses.outcomeRecordedAt, dayAgo)));
  for (const d of notTaken) {
    candidates.push({
      type: "dose_not_taken",
      profileId: d.profileId,
      key: `dose_not_taken:${d.id}`,
      dueAt: now,
      expiresAt: new Date(d.at!.getTime() + 24 * 60 * MIN),
      doseId: d.id,
    });
  }

  // e) Appointment reminders: within the reminder window, still in the future, not cancelled.
  const appts = await db
    .select({ id: appointments.id, profileId: appointments.profileId, startsAt: appointments.startsAt, hours: appointments.reminderHoursBefore })
    .from(appointments)
    .where(
      and(
        scope(appointments),
        eq(appointments.status, "scheduled"),
        gt(appointments.startsAt, now),
        lte(sql`${appointments.startsAt} - make_interval(hours => ${appointments.reminderHoursBefore})`, now),
      ),
    );
  for (const a of appts) {
    candidates.push({
      type: "appointment_reminder",
      profileId: a.profileId,
      // The start time is part of the key: rescheduling creates a new reminder; the old one is cancelled at send time.
      key: `appointment_reminder:${a.id}:${a.startsAt.toISOString()}`,
      dueAt: new Date(a.startsAt.getTime() - a.hours * 60 * MIN),
      expiresAt: a.startsAt,
      appointmentId: a.id,
    });
  }

  // f) Help requests (simple alert to administrators; full follow-up is Checkpoint 5).
  const help = await db
    .select({ id: helpRequests.id, profileId: helpRequests.profileId, createdAt: helpRequests.createdAt })
    .from(helpRequests)
    .where(and(scope(helpRequests), eq(helpRequests.status, "open"), gte(helpRequests.createdAt, dayAgo)));
  for (const h of help) {
    candidates.push({
      type: "help_request",
      profileId: h.profileId,
      key: `help_request:${h.id}`,
      dueAt: h.createdAt,
      expiresAt: new Date(h.createdAt.getTime() + 24 * 60 * MIN),
      helpRequestId: h.id,
    });
  }

  // Fan out to recipients (cached per profile + rule) and insert idempotently.
  const recipientCache = new Map<string, string[]>();
  const rows: (typeof notifications.$inferInsert)[] = [];
  for (const c of candidates) {
    const rule = PREF_FOR[c.type];
    const cacheKey = `${c.profileId}:${c.type}`;
    let to = recipientCache.get(cacheKey);
    if (!to) {
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

export async function processQueue(db: Database, cfg: NotifierConfig, now: Date, profileId?: string): Promise<ProcessSummary> {
  const summary = emptySummary();
  const claimed = await claimDue(db, now, cfg.maxPerSweep, profileId);
  summary.claimed = claimed.length;
  const external = isExternal(cfg);
  const preview = new ConsoleEmailProvider(() => {});
  const perProfile = new Map<string, number>();
  // The sweep lease prevents concurrent workers, so a local counter on top of the persisted count is exact.
  let used = external ? await realSendsUsed(db) : 0;

  for (const n of claimed) {
    const count = perProfile.get(n.profileId) ?? 0;
    if (count >= cfg.maxPerProfilePerSweep) {
      // Over this sweep's per-profile budget: hand it back for the next sweep.
      await finish(db, n.id, { status: "queued", claimedAt: null }, now);
      summary.deferred++;
      continue;
    }

    const rel = await checkRelevance(db, n, cfg, now);
    if (!rel.ok) {
      await finish(db, n.id, { status: rel.status, cancelReason: rel.status === "cancelled" ? rel.reason : null, lastError: rel.status === "failed" ? rel.reason : null }, now);
      if (rel.status === "cancelled") summary.cancelled++;
      else summary.failed++;
      continue;
    }
    perProfile.set(n.profileId, count + 1);
    const message = { to: rel.email, subject: rel.content.subject, text: `${rel.content.text}\n\n${FOOTER}`, html: toHtml(rel.content.text) };
    const safe = { subject: rel.content.subject, preview: previewOf(rel.content) };

    if (!external) {
      await preview.send(message);
      await finish(db, n.id, { ...safe, status: "previewed", provider: "console", attempts: n.attempts + 1, sentAt: now, lastError: null }, now);
      summary.previewed++;
      continue;
    }

    if (used >= cfg.realSendCap) {
      await finish(db, n.id, { ...safe, status: "paused_limit", lastError: `Real-send cap reached (${cfg.realSendCap}). Held, not sent.` }, now);
      summary.pausedLimit++;
      continue;
    }

    // Mark as an external attempt BEFORE the request leaves, so a crash is counted and never blindly retried.
    await db.update(notifications).set({ ...safe, provider: "brevo", attempts: n.attempts + 1, updatedAt: now }).where(eq(notifications.id, n.id));
    used++;
    try {
      const res = await cfg.provider.send(message);
      await finish(db, n.id, { status: "accepted", providerMessageId: res.providerMessageId ?? null, sentAt: now, lastError: null }, now);
      summary.accepted++;
    } catch (err) {
      const attempts = n.attempts + 1;
      if (err instanceof EmailSendError && err.status !== undefined) {
        // The provider answered: we know it was NOT accepted.
        used--;
        const retryable = err.status === 429 || err.status >= 500;
        if (retryable && attempts < MAX_ATTEMPTS) {
          await finish(
            db,
            n.id,
            { status: "queued", claimedAt: null, nextAttemptAt: new Date(now.getTime() + backoffMinutes(attempts) * MIN), lastError: sanitizeError(err.message) },
            now,
          );
          summary.retryScheduled++;
        } else {
          await finish(db, n.id, { status: "failed", lastError: sanitizeError(err.message) }, now);
          summary.failed++;
        }
      } else {
        // Timeout / network error after the request may have left: outcome unknown. Do not retry (avoid duplicates).
        await finish(db, n.id, { status: "uncertain", lastError: sanitizeError(err instanceof Error ? err.message : String(err)) }, now);
        summary.uncertain++;
      }
    }
  }
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
