import { and, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { HttpError } from "../authz.js";
import type { Database } from "../db/client.js";
import {
  doseEvents,
  doses,
  profiles,
  type DoseEventType,
  type DoseStatus,
  type MemberRole,
  type OutcomeSource,
} from "../db/schema.js";

/* ------------------------------------------------------------------ */
/* Policy constants                                                    */
/* ------------------------------------------------------------------ */

/** A dose may be confirmed or snoozed from this many minutes before its time. */
export const EARLY_WINDOW_MINUTES = 60;
export const SNOOZE_MINUTES = 15;
export const MAX_SNOOZES = 2;
export const CORRECTION_WINDOW_HOURS = 24;
export const DEFAULT_GRACE_MINUTES = 60;

const MIN = 60_000;

export type Outcome = "taken" | "not_taken";

export type DoseAction =
  | { type: "record"; outcome: Outcome; source: Exclude<OutcomeSource, "system">; note?: string | null; occurredAt?: Date | null }
  | { type: "correct"; outcome: Outcome; source: Exclude<OutcomeSource, "system">; note: string }
  | { type: "snooze" }
  | { type: "mark_unconfirmed" }
  | { type: "void"; reason: string };

export interface Actor {
  /** null = the system. */
  userId: string | null;
  role: MemberRole | "system";
}

export const SYSTEM_ACTOR: Actor = { userId: null, role: "system" };

/** The subset of a dose row the state machine needs. */
export interface DoseState {
  kind: "medication" | "routine";
  status: DoseStatus;
  scheduledAt: Date;
  snoozeCount: number;
  snoozeUntil: Date | null;
  outcomeRecordedBy: string | null;
  outcomeRecordedAt: Date | null;
}

type Patch = Partial<typeof doses.$inferInsert>;
export type Decision =
  | { kind: "apply"; patch: Patch; event: { type: DoseEventType; to: DoseStatus; source: OutcomeSource; note?: string | null; occurredAt?: Date | null } }
  | { kind: "noop"; reason: string }
  | { kind: "reject"; status: number; code: string; message: string };

const reject = (status: number, code: string, message: string): Decision => ({ kind: "reject", status, code, message });

/** When a still-scheduled dose becomes Unconfirmed: grace period after its time, or after a snooze ends. */
export function unconfirmedDeadline(dose: Pick<DoseState, "scheduledAt" | "snoozeUntil">, graceMinutes: number): Date {
  const afterGrace = dose.scheduledAt.getTime() + graceMinutes * MIN;
  return new Date(Math.max(afterGrace, dose.snoozeUntil?.getTime() ?? 0));
}

/**
 * "Remind me later" postpones the NEXT REMINDER, never the prescribed time:
 * 15 minutes after the later of now, the scheduled time, and any current snooze.
 * So a snooze requested before the dose is due can never end before the dose is due.
 */
export function snoozeUntilFor(dose: Pick<DoseState, "scheduledAt" | "snoozeUntil">, now: Date): Date {
  const from = Math.max(now.getTime(), dose.scheduledAt.getTime(), dose.snoozeUntil?.getTime() ?? 0);
  return new Date(from + SNOOZE_MINUTES * MIN);
}

/**
 * Pure, deterministic state machine. Given the current dose and an action, decides what happens.
 * The database layer applies the decision with an optimistic-concurrency check.
 */
export function decide(dose: DoseState, action: DoseAction, actor: Actor, now: Date, graceMinutes: number): Decision {
  const opensAt = dose.scheduledAt.getTime() - EARLY_WINDOW_MINUTES * MIN;

  switch (action.type) {
    case "record": {
      if (actor.role === "system") return reject(403, "FORBIDDEN", "The system cannot record an outcome.");
      if (dose.status === "void") return reject(409, "DOSE_VOID", "This dose is no longer part of the schedule.");
      if (dose.status === "taken" || dose.status === "not_taken") {
        return dose.status === action.outcome
          ? { kind: "noop", reason: "already_recorded" }
          : reject(409, "OUTCOME_ALREADY_RECORDED", "An outcome is already recorded for this dose. Use a correction to change it.");
      }
      if (now.getTime() < opensAt) return reject(409, "TOO_EARLY", "This dose is not due yet.");
      const occurredAt = action.occurredAt ?? now;
      if (occurredAt.getTime() > now.getTime() + MIN) return reject(400, "VALIDATION_FAILED", "The time taken cannot be in the future.");
      if (occurredAt.getTime() < opensAt) return reject(400, "VALIDATION_FAILED", "The time taken is too long before the scheduled time.");
      return {
        kind: "apply",
        patch: {
          status: action.outcome,
          outcomeSource: action.source,
          outcomeRecordedBy: actor.userId,
          outcomeRecordedAt: now,
          outcomeOccurredAt: action.outcome === "taken" ? occurredAt : null,
          outcomeNote: action.note ?? null,
          snoozeUntil: null,
        },
        event: { type: "outcome", to: action.outcome, source: action.source, note: action.note, occurredAt: action.outcome === "taken" ? occurredAt : null },
      };
    }

    case "correct": {
      if (dose.status !== "taken" && dose.status !== "not_taken") {
        return reject(409, "NOTHING_TO_CORRECT", "There is no recorded outcome to correct.");
      }
      if (dose.status === action.outcome) return { kind: "noop", reason: "no_change" };
      const isAdmin = actor.role === "admin";
      const isOriginalRecorder = actor.userId !== null && actor.userId === dose.outcomeRecordedBy;
      if (!isAdmin && !isOriginalRecorder) {
        return reject(403, "FORBIDDEN", "Only a family administrator or the person who recorded it can correct this.");
      }
      const recordedAt = dose.outcomeRecordedAt?.getTime() ?? 0;
      if (now.getTime() - recordedAt > CORRECTION_WINDOW_HOURS * 3_600_000) {
        return reject(409, "CORRECTION_WINDOW_CLOSED", `Corrections are allowed within ${CORRECTION_WINDOW_HOURS} hours.`);
      }
      return {
        kind: "apply",
        patch: {
          status: action.outcome,
          outcomeSource: action.source,
          outcomeRecordedBy: actor.userId,
          outcomeRecordedAt: now,
          outcomeOccurredAt: action.outcome === "taken" ? now : null,
          outcomeNote: action.note,
        },
        event: { type: "correction", to: action.outcome, source: action.source, note: action.note },
      };
    }

    case "snooze": {
      if (dose.status !== "scheduled") return reject(409, "NOT_SNOOZABLE", "Only an upcoming or due dose can be postponed.");
      if (now.getTime() < opensAt) return reject(409, "TOO_EARLY", "This dose is not due yet.");
      if (now >= unconfirmedDeadline(dose, graceMinutes)) return reject(409, "TOO_LATE", "This dose can no longer be postponed.");
      if (dose.snoozeCount >= MAX_SNOOZES) return reject(409, "SNOOZE_LIMIT", `“Remind me later” can be used ${MAX_SNOOZES} times per dose.`);
      return {
        kind: "apply",
        patch: { snoozeCount: dose.snoozeCount + 1, snoozeUntil: snoozeUntilFor(dose, now) },
        event: { type: "snooze", to: "scheduled", source: "self_reported" },
      };
    }

    case "mark_unconfirmed": {
      // Only the system, only medication, only from Scheduled, only after the deadline. Never → not_taken.
      if (actor.role !== "system") return reject(403, "FORBIDDEN", "Only the system marks doses unconfirmed.");
      if (dose.kind !== "medication") return { kind: "noop", reason: "routine" };
      if (dose.status !== "scheduled") return { kind: "noop", reason: "not_scheduled" };
      if (now < unconfirmedDeadline(dose, graceMinutes)) return { kind: "noop", reason: "not_overdue" };
      return { kind: "apply", patch: { status: "unconfirmed" }, event: { type: "unconfirmed", to: "unconfirmed", source: "system" } };
    }

    case "void": {
      if (actor.role !== "system") return reject(403, "FORBIDDEN", "Doses cannot be deleted by users.");
      if (dose.status === "taken" || dose.status === "not_taken") return { kind: "noop", reason: "has_outcome" };
      if (dose.status === "void") return { kind: "noop", reason: "already_void" };
      return { kind: "apply", patch: { status: "void", snoozeUntil: null }, event: { type: "void", to: "void", source: "system", note: action.reason } };
    }
  }
}

/* ------------------------------------------------------------------ */
/* Database layer                                                      */
/* ------------------------------------------------------------------ */

export type DoseRow = typeof doses.$inferSelect;

async function graceFor(db: Database, profileId: string): Promise<number> {
  const [p] = await db.select({ grace: profiles.graceMinutes }).from(profiles).where(eq(profiles.id, profileId));
  return p?.grace ?? DEFAULT_GRACE_MINUTES;
}

/**
 * Applies an action to one dose. Concurrency-safe: the update only succeeds if the dose's
 * `version` is unchanged since it was read; otherwise the action is re-evaluated against the
 * fresh state (which yields an idempotent no-op or a 409). Each change appends one event.
 */
export async function applyDoseAction(
  db: Database,
  profileId: string,
  doseId: string,
  action: DoseAction,
  actor: Actor,
  now: Date = new Date(),
): Promise<{ dose: DoseRow; changed: boolean }> {
  const grace = await graceFor(db, profileId);

  for (let attempt = 0; attempt < 3; attempt++) {
    const [dose] = await db
      .select()
      .from(doses)
      .where(and(eq(doses.id, doseId), eq(doses.profileId, profileId)));
    // Same message whether it never existed or belongs to someone else: no cross-profile leakage.
    if (!dose) throw new HttpError(404, "NOT_FOUND", "Dose not found.");

    const decision = decide(dose, action, actor, now, grace);
    if (decision.kind === "reject") throw new HttpError(decision.status, decision.code, decision.message);
    if (decision.kind === "noop") return { dose, changed: false };

    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(doses)
        .set({ ...decision.patch, version: dose.version + 1, updatedAt: now })
        .where(and(eq(doses.id, dose.id), eq(doses.version, dose.version)))
        .returning();
      if (!row) return null; // lost the race; re-read and re-decide

      let correctionOf: string | null = null;
      if (decision.event.type === "correction") {
        const [prev] = await tx
          .select({ id: doseEvents.id })
          .from(doseEvents)
          .where(and(eq(doseEvents.doseId, dose.id), inArray(doseEvents.type, ["outcome", "correction"])))
          .orderBy(desc(doseEvents.recordedAt))
          .limit(1);
        correctionOf = prev?.id ?? null;
      }
      await tx.insert(doseEvents).values({
        doseId: dose.id,
        profileId,
        type: decision.event.type,
        fromStatus: dose.status,
        toStatus: decision.event.to,
        source: decision.event.source,
        actorUserId: actor.userId,
        note: decision.event.note ?? null,
        occurredAt: decision.event.occurredAt ?? null,
        correctionOf,
        recordedAt: now,
      });
      return row;
    });
    if (updated) return { dose: updated, changed: true };
  }
  throw new HttpError(409, "CONCURRENT_UPDATE", "This dose was just changed by someone else. Please refresh.");
}

/**
 * System transition: marks overdue Scheduled medication doses as Unconfirmed.
 * Idempotent and safe to run concurrently with confirmations (the notification sweep reuses it).
 * Returns the ids that changed.
 */
export async function markOverdueUnconfirmed(db: Database, now: Date = new Date(), profileId?: string): Promise<string[]> {
  const candidates = await db
    .select({ id: doses.id, profileId: doses.profileId })
    .from(doses)
    .innerJoin(profiles, eq(profiles.id, doses.profileId))
    .where(
      and(
        profileId ? eq(doses.profileId, profileId) : undefined,
        isNull(profiles.archivedAt),
        eq(doses.kind, "medication"),
        eq(doses.status, "scheduled"),
        lte(sql`${doses.scheduledAt} + make_interval(mins => ${profiles.graceMinutes})`, now),
        or(isNull(doses.snoozeUntil), lte(doses.snoozeUntil, now)),
      ),
    );

  const changed: string[] = [];
  for (const c of candidates) {
    try {
      const res = await applyDoseAction(db, c.profileId, c.id, { type: "mark_unconfirmed" }, SYSTEM_ACTOR, now);
      if (res.changed) changed.push(c.id);
    } catch (err) {
      // A concurrent confirmation or schedule change won; that is the correct outcome.
      if (!(err instanceof HttpError && (err.status === 409 || err.status === 404))) throw err;
    }
  }
  return changed;
}

/** Where a dose sits for display: separates "not yet due" from "due" without changing stored state. */
export type DosePhase = "upcoming" | "due" | "unconfirmed" | "taken" | "not_taken" | "void";

export function dosePhase(dose: Pick<DoseState, "status" | "scheduledAt">, now: Date): DosePhase {
  if (dose.status !== "scheduled") return dose.status;
  return now.getTime() < dose.scheduledAt.getTime() - EARLY_WINDOW_MINUTES * MIN ? "upcoming" : "due";
}

export interface AdherenceCounts {
  total: number;
  taken: number;
  notTaken: number;
  unconfirmed: number;
  /** Still SCHEDULED — not yet due or within grace. Never counted as missed. */
  pending: number;
}

/** Counts medication doses only; VOID is excluded; Not Taken and Unconfirmed are always separate. */
export function summarize(rows: Pick<DoseState, "kind" | "status">[]): AdherenceCounts {
  const meds = rows.filter((r) => r.kind === "medication" && r.status !== "void");
  return {
    total: meds.length,
    taken: meds.filter((r) => r.status === "taken").length,
    notTaken: meds.filter((r) => r.status === "not_taken").length,
    unconfirmed: meds.filter((r) => r.status === "unconfirmed").length,
    pending: meds.filter((r) => r.status === "scheduled").length,
  };
}
