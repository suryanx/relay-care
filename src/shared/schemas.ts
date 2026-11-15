import { z } from "zod";

/** Validation shared by the API and the React forms. */

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const consentBasisValues = ["elder_consented", "legal_authority", "other"] as const;

export const consentBasisLabels: Record<(typeof consentBasisValues)[number], string> = {
  elder_consented: "They agreed to use Relay and to share their care information with this care team",
  legal_authority: "I hold legal authority to manage their care (e.g. power of attorney)",
  other: "Other arrangement (describe below)",
};

const name = z.string().trim().min(1, "Required").max(80, "Use 80 characters or fewer");

export const createProfileSchema = z.object({
  fullName: name,
  preferredName: name,
  timezone: z.string().trim().refine(isValidTimeZone, "Choose a valid time zone"),
  consentBasis: z.enum(consentBasisValues),
  consentStatement: z
    .string()
    .trim()
    .min(10, "Describe how this was agreed, in at least 10 characters")
    .max(1000),
});
export type CreateProfileInput = z.infer<typeof createProfileSchema>;

export const createElderAccountSchema = z.object({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_.]{3,32}$/, "3–32 letters, numbers, dots or underscores"),
  passcode: z.string().min(10, "Use at least 10 characters").max(128),
});
export type CreateElderAccountInput = z.infer<typeof createElderAccountSchema>;

export type Role = "admin" | "caregiver" | "elder";

export interface ProfileSummary {
  id: string;
  fullName: string;
  preferredName: string;
  timezone: string;
  role: Role;
}

export interface ProfileDetail extends ProfileSummary {
  consent: { basis: string; statement: string; recordedBy: string; recordedAt: string };
  hasElderAccount: boolean;
  elderUsername: string | null;
  members: { userId: string; name: string; role: Role }[];
}

export interface MeResponse {
  user: { id: string; name: string; email: string | null; username: string | null };
  memberships: ProfileSummary[];
  isElder: boolean;
}

/* ---------------------------- Care plan ---------------------------- */

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour time like 08:00");
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-15")
  .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d), "Not a real date");
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Use ${max} characters or fewer`)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional();

const timesList = z
  .array(timeOfDay)
  .min(1, "Add at least one time")
  .max(8, "Use at most 8 times per day")
  .refine((t) => new Set(t).size === t.length, "Each time can appear only once")
  .transform((t) => [...t].sort());

function endAfterStart<T extends { startDate?: string; endDate?: string | null }>(v: T) {
  return !v.startDate || !v.endDate || v.endDate >= v.startDate;
}
const endDateIssue = { message: "End date must be on or after the start date", path: ["endDate"] };

const medicationFields = z.object({
  name: z.string().trim().min(1, "Required").max(100),
  strength: optionalText(50),
  instructions: optionalText(500),
  times: timesList,
  startDate: isoDate,
  endDate: isoDate.nullable().optional(),
  reminderLeadMinutes: z.coerce.number().int().min(0).max(120).default(15),
});
export const createMedicationSchema = medicationFields.refine(endAfterStart, endDateIssue);
export type MedicationInput = z.input<typeof createMedicationSchema>;

const routineFields = z.object({
  title: z.string().trim().min(1, "Required").max(100),
  notes: optionalText(300),
  times: timesList,
  startDate: isoDate,
  endDate: isoDate.nullable().optional(),
});
export const createRoutineSchema = routineFields.refine(endAfterStart, endDateIssue);
export type RoutineInput = z.input<typeof createRoutineSchema>;

const appointmentFields = z.object({
  doctorName: z.string().trim().min(1, "Required").max(100),
  specialty: optionalText(80),
  date: isoDate,
  time: timeOfDay,
  location: optionalText(200),
  notes: optionalText(1000),
  reminderHoursBefore: z.coerce.number().int().min(1).max(72).default(24),
});
export const createAppointmentSchema = appointmentFields;
export type AppointmentInput = z.input<typeof createAppointmentSchema>;

export const scheduleQuerySchema = z.object({ date: isoDate.optional() });

export interface Medication {
  id: string;
  profileId: string;
  name: string;
  strength: string | null;
  instructions: string | null;
  times: string[];
  startDate: string;
  endDate: string | null;
  reminderLeadMinutes: number;
  active: boolean;
  updatedAt: string;
}

export interface Routine {
  id: string;
  profileId: string;
  title: string;
  notes: string | null;
  times: string[];
  startDate: string;
  endDate: string | null;
  active: boolean;
}

export interface Appointment {
  id: string;
  profileId: string;
  doctorName: string;
  specialty: string | null;
  startsAt: string;
  localDate: string;
  localTime: string;
  location: string | null;
  notes: string | null;
  reminderHoursBefore: number;
  status: "scheduled" | "cancelled";
}

export interface ScheduledItem {
  id: string;
  kind: "medication" | "routine";
  label: string;
  detail: string | null;
  scheduledAt: string;
  localDate: string;
  localTime: string;
  status: "scheduled" | "taken" | "not_taken" | "unconfirmed" | "void";
}

export interface ScheduleResponse {
  date: string;
  timezone: string;
  items: ScheduledItem[];
}

/* ---------------------------- Adherence ---------------------------- */

export const outcomeValues = ["taken", "not_taken"] as const;
export type OutcomeValue = (typeof outcomeValues)[number];
const note = z.string().trim().max(500, "Use 500 characters or fewer").optional().nullable();

/** Elder: "I have taken it" / "I did not take it". Source is always self_reported (set by the server). */
export const elderOutcomeSchema = z.object({ outcome: z.enum(outcomeValues), note });

/** Care team recording on someone's behalf: they must say how they know. */
export const teamOutcomeSchema = z.object({
  outcome: z.enum(outcomeValues),
  source: z.enum(["observed", "reported_by_other"]),
  note,
  occurredAt: z.iso.datetime({ offset: true }).optional().nullable(),
});

export const correctionSchema = z.object({
  outcome: z.enum(outcomeValues),
  note: z.string().trim().min(3, "Say briefly why this is being corrected").max(500),
  source: z.enum(["self_reported", "observed", "reported_by_other"]).optional(),
});

export const helpRequestSchema = z.object({
  doseId: z.string().min(1).max(200).optional().nullable(),
  note: z.string().trim().max(500).optional().nullable(),
});

export type DoseStatusValue = "scheduled" | "taken" | "not_taken" | "unconfirmed" | "void";
export type DosePhaseValue = "upcoming" | "due" | "unconfirmed" | "taken" | "not_taken" | "void";
export type SourceValue = "self_reported" | "observed" | "reported_by_other" | "system";

export interface DoseView {
  id: string;
  kind: "medication" | "routine";
  label: string;
  detail: string | null;
  localDate: string;
  localTime: string;
  scheduledAt: string;
  status: DoseStatusValue;
  phase: DosePhaseValue;
  snoozeCount: number;
  snoozeUntil: string | null;
  canRecord: boolean;
  canSnooze: boolean;
  outcome: null | {
    source: SourceValue | null;
    recordedBy: string | null;
    recordedAt: string | null;
    occurredAt: string | null;
    note: string | null;
  };
}

export interface ElderTodayResponse {
  preferredName: string;
  timezone: string;
  date: string;
  doses: DoseView[];
  appointments: { id: string; doctorName: string; specialty: string | null; localDate: string; localTime: string; location: string | null }[];
  openHelpRequests: number;
  /** Recent help requests: open = waiting for someone; acknowledged = being handled; resolved. */
  helpRequests: { id: string; status: "open" | "acknowledged" | "resolved"; handledBy: string | null; createdAt: string }[];
}

export interface AdherenceCountsView {
  total: number;
  taken: number;
  notTaken: number;
  unconfirmed: number;
  pending: number;
}

export interface DoseEventView {
  id: string;
  doseId: string;
  doseLabel?: string;
  doseLocalTime?: string;
  type: "outcome" | "correction" | "unconfirmed" | "snooze" | "void";
  fromStatus: DoseStatusValue;
  toStatus: DoseStatusValue;
  source: SourceValue;
  actor: string;
  note: string | null;
  occurredAt: string | null;
  recordedAt: string;
  correctionOf: string | null;
}

export interface HelpRequestView {
  id: string;
  doseId: string | null;
  doseLabel: string | null;
  note: string | null;
  status: "open" | "acknowledged" | "resolved";
  requestedBy: string;
  createdAt: string;
}

export interface AdherenceResponse {
  date: string;
  timezone: string;
  counts: AdherenceCountsView;
  doses: DoseView[];
  recentActivity: DoseEventView[];
  openHelpRequests: HelpRequestView[];
}

/* -------------------------- Notifications -------------------------- */

export const notificationPreferencesSchema = z.object({
  notifyDoseReminders: z.boolean(),
  notifyAlerts: z.boolean(),
  notifyAppointments: z.boolean(),
});
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

export type NotificationTypeValue =
  | "dose_reminder"
  | "dose_snooze_reminder"
  | "dose_unconfirmed"
  | "dose_not_taken"
  | "appointment_reminder"
  | "help_request";
export type NotificationStatusValue = "queued" | "sending" | "accepted" | "previewed" | "failed" | "uncertain" | "paused_limit" | "cancelled";

export interface NotificationItem {
  id: string;
  type: NotificationTypeValue;
  status: NotificationStatusValue;
  subject: string;
  preview: string;
  related: string | null;
  recipientName: string;
  recipientMasked: string;
  dueAt: string;
  createdAt: string;
  sentAt: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  providerAccepted: boolean;
  hasProviderMessageId: boolean;
  lastError: string | null;
  cancelReason: string | null;
}

export interface SweepSummaryView {
  status: "completed" | "skipped_locked";
  mode: "preview" | "real";
  queued: number;
  previewed: number;
  accepted: number;
  cancelled: number;
  failed: number;
  uncertain: number;
  pausedLimit: number;
  retryScheduled: number;
  deferred: number;
  markedUnconfirmed: number;
  dosesGenerated: number;
  realSendsUsed: number;
  realSendCap: number;
}

export interface NotificationCenterResponse {
  mode: "preview" | "real";
  realSendsUsed: number;
  realSendCap: number;
  cooldownSeconds: number;
  lastRun: { startedAt: string; trigger: "scheduler" | "manual"; summary: SweepSummaryView | null } | null;
  items: NotificationItem[];
}

/* --------------------------- Care team ----------------------------- */

export const createInvitationSchema = z.object({ email: z.email("Enter a valid email address").max(200) });
export const invitationTokenSchema = z.object({ token: z.string().min(20).max(200) });

export interface InvitationView {
  id: string;
  emailMasked: string;
  state: "pending" | "accepted" | "revoked" | "expired";
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
  acceptedBy: string | null;
}

export interface InvitationPreview {
  state: "invalid" | "pending" | "accepted" | "revoked" | "expired";
  careRecipient?: string;
  invitedBy?: string;
  invitedEmail?: string;
  invitedEmailMasked?: string;
}

/* --------------------------- Follow-ups ---------------------------- */

export const incidentResolutionValues = ["taken_confirmed", "not_taken_confirmed", "unable_to_verify", "help_addressed"] as const;
export const resolveIncidentSchema = z.object({
  resolution: z.enum(incidentResolutionValues),
  source: z.enum(["observed", "reported_by_other"]).optional(),
  note: z.string().trim().max(500).optional().nullable(),
});
export const releaseIncidentSchema = z.object({ note: z.string().trim().max(300).optional().nullable() });

export interface IncidentEventView {
  id: string;
  type: "created" | "claimed" | "released" | "resolved" | "cancelled" | "reconciled";
  actor: string;
  note: string | null;
  recordedAt: string;
}

export interface IncidentView {
  id: string;
  sourceType: "dose_unconfirmed" | "dose_not_taken" | "help_request";
  priority: "high" | "normal";
  reason: string;
  status: "open" | "claimed" | "resolved" | "cancelled";
  subject: string;
  claimedBy: { id: string; name: string } | null;
  claimedByMe: boolean;
  claimedAt: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolution: string | null;
  resolutionNote: string | null;
  createdAt: string;
  allowedResolutions: string[];
  canResolve: boolean;
  canRelease: boolean;
  events: IncidentEventView[];
}

export interface IncidentListResponse {
  role: "admin" | "caregiver";
  counts: { open: number; claimed: number; mine: number; resolvedToday: number };
  incidents: IncidentView[];
}

export interface FollowUpSummary {
  profileId: string;
  preferredName: string;
  role: Role;
  open: number;
  mine: number;
}
