import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/* ------------------------------------------------------------------ */
/* Better Auth core tables (+ username plugin fields, DB rate limiting) */
/* ------------------------------------------------------------------ */

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  username: text("username").unique(),
  displayUsername: text("display_username"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_user_id_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("account_user_id_idx").on(t.userId)],
);

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const rateLimit = pgTable("rate_limit", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});

/* ------------------------------------------------------------------ */
/* Relay domain tables                                                 */
/* ------------------------------------------------------------------ */

/** How the administrator says they are authorised to manage this profile. Recorded, not verified. */
export const CONSENT_BASES = [
  "elder_consented", // the elderly person agreed directly
  "legal_authority", // e.g. power of attorney / guardianship (documents not verified by Relay)
  "other",
] as const;
export type ConsentBasis = (typeof CONSENT_BASES)[number];

export const profiles = pgTable("profiles", {
  id: text("id")
    .primaryKey()
    .default(sql`gen_random_uuid()::text`),
  fullName: text("full_name").notNull(),
  preferredName: text("preferred_name").notNull(),
  timezone: text("timezone").notNull(),
  // Consent / authorisation record (an attestation by the admin — not legal proof).
  consentBasis: text("consent_basis").$type<ConsentBasis>().notNull(),
  consentStatement: text("consent_statement").notNull(),
  consentRecordedBy: text("consent_recorded_by")
    .notNull()
    .references(() => user.id),
  consentRecordedAt: timestamp("consent_recorded_at", { withTimezone: true }).notNull().defaultNow(),
  /** Minutes after a dose's time before the system marks it Unconfirmed. */
  graceMinutes: integer("grace_minutes").notNull().default(60),
  elderUserId: text("elder_user_id")
    .unique()
    .references(() => user.id, { onDelete: "set null" }),
  createdBy: text("created_by")
    .notNull()
    .references(() => user.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const MEMBER_ROLES = ["admin", "caregiver", "elder"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const profileMembers = pgTable(
  "profile_members",
  {
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").$type<MemberRole>().notNull(),
    // Email preferences (ignored for elder accounts, which never receive email).
    notifyDoseReminders: boolean("notify_dose_reminders").notNull().default(true),
    notifyAlerts: boolean("notify_alerts").notNull().default(true),
    notifyAppointments: boolean("notify_appointments").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.profileId, t.userId] }),
    index("profile_members_user_idx").on(t.userId),
    // An account can be the elderly person for at most one profile.
    uniqueIndex("profile_members_one_elder_per_user")
      .on(t.userId)
      .where(sql`${t.role} = 'elder'`),
  ],
);

/* ------------------------------------------------------------------ */
/* Care plan: medications, routines, appointments, generated doses     */
/* ------------------------------------------------------------------ */

/**
 * A medication as entered by an authorised person. Relay never derives or changes these values.
 * Schedule: taken daily at each local time in `times` ("HH:mm"), between startDate and endDate (inclusive).
 */
export const medications = pgTable(
  "medications",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    strength: text("strength"),
    instructions: text("instructions"),
    times: text("times").array().notNull(),
    startDate: text("start_date").notNull(), // YYYY-MM-DD in the profile's time zone
    endDate: text("end_date"), // inclusive; null = ongoing
    reminderLeadMinutes: integer("reminder_lead_minutes").notNull().default(15),
    active: boolean("active").notNull().default(true),
    /** Doses scheduled before this instant are never generated (avoids back-filling past doses after an edit). */
    scheduleEffectiveFrom: timestamp("schedule_effective_from", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    updatedBy: text("updated_by")
      .notNull()
      .references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
  },
  (t) => [index("medications_profile_idx").on(t.profileId)],
);

/** A non-medical, user-configured daily task (e.g. "Drink a glass of water"). Not a prescription. */
export const routines = pgTable(
  "routines",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    notes: text("notes"),
    times: text("times").array().notNull(),
    startDate: text("start_date").notNull(),
    endDate: text("end_date"),
    active: boolean("active").notNull().default(true),
    scheduleEffectiveFrom: timestamp("schedule_effective_from", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    updatedBy: text("updated_by")
      .notNull()
      .references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
  },
  (t) => [index("routines_profile_idx").on(t.profileId)],
);

export const DOSE_KINDS = ["medication", "routine"] as const;
export type DoseKind = (typeof DOSE_KINDS)[number];
export const DOSE_STATUSES = ["scheduled", "taken", "not_taken", "unconfirmed", "void"] as const;
export type DoseStatus = (typeof DOSE_STATUSES)[number];
export const OUTCOME_SOURCES = ["self_reported", "observed", "reported_by_other", "system"] as const;
export type OutcomeSource = (typeof OUTCOME_SOURCES)[number];
export const DOSE_EVENT_TYPES = ["outcome", "correction", "unconfirmed", "snooze", "void"] as const;
export type DoseEventType = (typeof DOSE_EVENT_TYPES)[number];

/**
 * One planned occurrence of a medication or routine.
 * id is deterministic: `${kind}:${sourceId}:${localDate}T${localTime}` — regeneration can never duplicate.
 * label/detail are snapshots so history stays readable after the source is edited.
 */
export const doses = pgTable(
  "doses",
  {
    id: text("id").primaryKey(),
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    kind: text("kind").$type<DoseKind>().notNull(),
    medicationId: text("medication_id").references(() => medications.id, { onDelete: "cascade" }),
    routineId: text("routine_id").references(() => routines.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    detail: text("detail"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    localDate: text("local_date").notNull(),
    localTime: text("local_time").notNull(),
    status: text("status").$type<DoseStatus>().notNull().default("scheduled"),
    /** Optimistic-concurrency counter; every state change increments it. */
    version: integer("version").notNull().default(0),
    // Current outcome (denormalised from dose_events for fast reads).
    outcomeSource: text("outcome_source").$type<OutcomeSource>(),
    outcomeRecordedBy: text("outcome_recorded_by").references(() => user.id, { onDelete: "set null" }),
    outcomeRecordedAt: timestamp("outcome_recorded_at", { withTimezone: true }),
    /** When the person says the dose was actually taken (may differ from when it was reported). */
    outcomeOccurredAt: timestamp("outcome_occurred_at", { withTimezone: true }),
    outcomeNote: text("outcome_note"),
    // "Remind me later": postpones the next reminder only; scheduledAt never changes.
    snoozeCount: integer("snooze_count").notNull().default(0),
    snoozeUntil: timestamp("snooze_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("doses_profile_status_idx").on(t.profileId, t.status),
    index("doses_profile_date_idx").on(t.profileId, t.localDate),
    index("doses_profile_scheduled_idx").on(t.profileId, t.scheduledAt),
  ],
);

/** Append-only audit trail of every dose state change. Rows are never updated or deleted by the app. */
export const doseEvents = pgTable(
  "dose_events",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    doseId: text("dose_id")
      .notNull()
      .references(() => doses.id, { onDelete: "cascade" }),
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    type: text("type").$type<DoseEventType>().notNull(),
    fromStatus: text("from_status").$type<DoseStatus>().notNull(),
    toStatus: text("to_status").$type<DoseStatus>().notNull(),
    source: text("source").$type<OutcomeSource>().notNull(),
    /** null only for system events. */
    actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "set null" }),
    note: text("note"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    correctionOf: text("correction_of"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("dose_events_dose_idx").on(t.doseId), index("dose_events_profile_recorded_idx").on(t.profileId, t.recordedAt)],
);

export const HELP_STATUSES = ["open", "acknowledged", "resolved"] as const;
export type HelpStatus = (typeof HELP_STATUSES)[number];

/** "I need help" requests from the elder. Notification/follow-up arrives in Checkpoint 5. */
export const helpRequests = pgTable(
  "help_requests",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    doseId: text("dose_id").references(() => doses.id, { onDelete: "set null" }),
    requestedBy: text("requested_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    note: text("note"),
    status: text("status").$type<HelpStatus>().notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("help_requests_profile_idx").on(t.profileId, t.status)],
);

export const APPOINTMENT_STATUSES = ["scheduled", "cancelled"] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export const appointments = pgTable(
  "appointments",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    doctorName: text("doctor_name").notNull(),
    specialty: text("specialty"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    location: text("location"),
    notes: text("notes"),
    reminderHoursBefore: integer("reminder_hours_before").notNull().default(24),
    status: text("status").$type<AppointmentStatus>().notNull().default("scheduled"),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    updatedBy: text("updated_by")
      .notNull()
      .references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  },
  (t) => [index("appointments_profile_starts_idx").on(t.profileId, t.startsAt)],
);

/* ------------------------------------------------------------------ */
/* Notification outbox                                                 */
/* ------------------------------------------------------------------ */

export const NOTIFICATION_TYPES = [
  "dose_reminder",
  "dose_snooze_reminder",
  "dose_unconfirmed",
  "dose_not_taken",
  "appointment_reminder",
  "help_request",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/**
 * queued      → waiting (also used for retry, with next_attempt_at in the future)
 * sending     → claimed by one sweep worker
 * accepted    → the email provider ACCEPTED it (not proof of inbox delivery)
 * previewed   → rendered in preview mode; no external email was sent
 * failed      → gave up (permanent provider error, no valid recipient, or retries exhausted)
 * uncertain   → outcome unknown (e.g. timeout after the request left); never auto-retried, to avoid duplicates
 * paused_limit→ held because the real-send cap was reached
 * cancelled   → no longer relevant (state changed, corrected, expired, appointment moved/cancelled)
 */
export const NOTIFICATION_STATUSES = ["queued", "sending", "accepted", "previewed", "failed", "uncertain", "paused_limit", "cancelled"] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export const notifications = pgTable(
  "notifications",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    /** Deterministic per logical reminder + recipient; the unique index makes queueing idempotent. */
    dedupeKey: text("dedupe_key").notNull().unique(),
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    type: text("type").$type<NotificationType>().notNull(),
    recipientUserId: text("recipient_user_id").references(() => user.id, { onDelete: "set null" }),
    /** Safe, non-clinical text only (no medicine names). Re-rendered at send time. */
    subject: text("subject").notNull(),
    preview: text("preview").notNull(),
    doseId: text("dose_id"),
    appointmentId: text("appointment_id"),
    helpRequestId: text("help_request_id"),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    status: text("status").$type<NotificationStatus>().notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull(),
    /** "console" (preview) or "brevo" (real external request). */
    provider: text("provider"),
    providerMessageId: text("provider_message_id"),
    lastError: text("last_error"),
    cancelReason: text("cancel_reason"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("notifications_status_next_idx").on(t.status, t.nextAttemptAt),
    index("notifications_profile_created_idx").on(t.profileId, t.createdAt),
  ],
);

/** Single-row lease so only one sweep runs at a time (works across instances). */
export const sweepLocks = pgTable("sweep_locks", {
  id: text("id").primaryKey(),
  lockedUntil: timestamp("locked_until", { withTimezone: true }).notNull(),
  holder: text("holder"),
});

export const sweepRuns = pgTable(
  "sweep_runs",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    trigger: text("trigger").$type<"scheduler" | "manual">().notNull(),
    profileId: text("profile_id").references(() => profiles.id, { onDelete: "cascade" }),
    triggeredBy: text("triggered_by").references(() => user.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    summary: text("summary"),
  },
  (t) => [index("sweep_runs_profile_started_idx").on(t.profileId, t.startedAt)],
);

export const schema = {
  user,
  session,
  account,
  verification,
  rateLimit,
  profiles,
  profileMembers,
  medications,
  routines,
  doses,
  doseEvents,
  helpRequests,
  appointments,
  notifications,
  sweepLocks,
  sweepRuns,
};
