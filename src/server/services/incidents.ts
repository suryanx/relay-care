import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { HttpError } from "../authz.js";
import type { Database } from "../db/client.js";
import {
  doses,
  helpRequests,
  incidentEvents,
  incidents,
  type IncidentEventType,
  type IncidentResolution,
  type IncidentSource,
  type MemberRole,
} from "../db/schema.js";
import { applyDoseAction } from "./adherence.js";

const DAY = 24 * 3_600_000;

export type IncidentRow = typeof incidents.$inferSelect;

/** Deterministic, explainable priority — not clinical triage. */
export const PRIORITY: Record<IncidentSource, { priority: "high" | "normal"; reason: string }> = {
  help_request: { priority: "high", reason: "The person asked for help" },
  dose_not_taken: { priority: "normal", reason: "A medicine was reported as not taken" },
  dose_unconfirmed: { priority: "normal", reason: "No one has confirmed a medicine yet" },
};

/** Which resolutions make sense for which source. */
export const ALLOWED_RESOLUTIONS: Record<IncidentSource, IncidentResolution[]> = {
  dose_unconfirmed: ["taken_confirmed", "not_taken_confirmed", "unable_to_verify"],
  dose_not_taken: ["not_taken_confirmed", "taken_confirmed", "unable_to_verify"],
  help_request: ["help_addressed", "unable_to_verify"],
};

export const incidentKey = (source: IncidentSource, sourceId: string) => `${source}:${sourceId}`;

type Tx = Pick<Database, "insert" | "update" | "select">;

async function addEvent(db: Tx, incident: Pick<IncidentRow, "id" | "profileId">, type: IncidentEventType, actorUserId: string | null, note: string | null, now: Date) {
  await db.insert(incidentEvents).values({ incidentId: incident.id, profileId: incident.profileId, type, actorUserId, note, recordedAt: now });
}

/** Keeps a help request's own status in step with its incident (shown on the elder's screen). */
async function syncHelpStatus(db: Tx, incident: Pick<IncidentRow, "sourceType" | "sourceId">, status: "open" | "acknowledged" | "resolved") {
  if (incident.sourceType !== "help_request") return;
  await db.update(helpRequests).set({ status }).where(eq(helpRequests.id, incident.sourceId));
}

/**
 * Idempotently creates incidents from real records and reconciles open ones whose source changed.
 * - Unconfirmed dose → incident; if later confirmed Taken/Not Taken it is closed as "reconciled".
 * - Not Taken (explicit) → incident, unless it was itself the outcome of resolving a follow-up;
 *   if later corrected to Taken it is cancelled.
 * - Open help request → incident.
 * Bounded to the last 24 h of sources. Safe to run on every read, sweep and state change.
 */
export async function syncIncidents(db: Database, now: Date = new Date(), profileId?: string): Promise<{ created: number; closed: number }> {
  const since = new Date(now.getTime() - DAY);
  const scopeDose = profileId ? eq(doses.profileId, profileId) : undefined;
  const scopeHelp = profileId ? eq(helpRequests.profileId, profileId) : undefined;

  const unconfirmed = await db
    .select({ id: doses.id, profileId: doses.profileId })
    .from(doses)
    .where(and(scopeDose, eq(doses.kind, "medication"), eq(doses.status, "unconfirmed"), gte(doses.scheduledAt, since)));
  const notTaken = await db
    .select({ id: doses.id, profileId: doses.profileId })
    .from(doses)
    .where(and(scopeDose, eq(doses.kind, "medication"), eq(doses.status, "not_taken"), gte(doses.outcomeRecordedAt, since)));
  const help = await db
    .select({ id: helpRequests.id, profileId: helpRequests.profileId })
    .from(helpRequests)
    .where(and(scopeHelp, eq(helpRequests.status, "open"), gte(helpRequests.createdAt, since)));

  // A Not Taken that was recorded as the resolution of a follow-up is already handled.
  const handled = notTaken.length
    ? new Set(
        (
          await db
            .select({ sourceId: incidents.sourceId })
            .from(incidents)
            .where(and(inArray(incidents.sourceId, notTaken.map((d) => d.id)), eq(incidents.resolution, "not_taken_confirmed")))
        ).map((r) => r.sourceId),
      )
    : new Set<string>();

  const candidates: { profileId: string; sourceType: IncidentSource; sourceId: string }[] = [
    ...unconfirmed.map((d) => ({ profileId: d.profileId, sourceType: "dose_unconfirmed" as const, sourceId: d.id })),
    ...notTaken.filter((d) => !handled.has(d.id)).map((d) => ({ profileId: d.profileId, sourceType: "dose_not_taken" as const, sourceId: d.id })),
    ...help.map((h) => ({ profileId: h.profileId, sourceType: "help_request" as const, sourceId: h.id })),
  ];

  let created = 0;
  if (candidates.length) {
    const rows = await db
      .insert(incidents)
      .values(
        candidates.map((c) => ({
          ...c,
          dedupeKey: incidentKey(c.sourceType, c.sourceId),
          priority: PRIORITY[c.sourceType].priority,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .onConflictDoNothing({ target: incidents.dedupeKey })
      .returning();
    for (const r of rows) await addEvent(db, r, "created", null, PRIORITY[r.sourceType].reason, now);
    created = rows.length;
  }

  const closed = await reconcileDoseIncidents(db, now, profileId);
  return { created, closed };
}

/** Closes active dose incidents that a later adherence change made obsolete. History is preserved. */
async function reconcileDoseIncidents(db: Database, now: Date, profileId?: string): Promise<number> {
  const active = await db
    .select({ i: incidents, doseStatus: doses.status })
    .from(incidents)
    .innerJoin(doses, eq(doses.id, incidents.sourceId))
    .where(and(profileId ? eq(incidents.profileId, profileId) : undefined, inArray(incidents.status, ["open", "claimed"]), inArray(incidents.sourceType, ["dose_unconfirmed", "dose_not_taken"])));

  let closed = 0;
  for (const { i, doseStatus } of active) {
    let next: { status: "resolved" | "cancelled"; resolution: IncidentResolution | null; note: string } | null = null;
    if (i.sourceType === "dose_unconfirmed" && (doseStatus === "taken" || doseStatus === "not_taken")) {
      next = { status: "resolved", resolution: "reconciled", note: `Dose was later recorded as ${doseStatus === "taken" ? "taken" : "not taken"}` };
    } else if (i.sourceType === "dose_not_taken" && doseStatus === "taken") {
      next = { status: "cancelled", resolution: null, note: "The not-taken report was corrected to taken" };
    } else if (doseStatus === "void") {
      next = { status: "cancelled", resolution: null, note: "The dose was removed by a schedule change" };
    }
    if (!next) continue;
    const [row] = await db
      .update(incidents)
      .set({ status: next.status, resolution: next.resolution, resolutionNote: next.note, resolvedAt: now, version: i.version + 1, updatedAt: now })
      .where(and(eq(incidents.id, i.id), eq(incidents.version, i.version)))
      .returning();
    if (row) {
      await addEvent(db, row, next.status === "resolved" ? "reconciled" : "cancelled", null, next.note, now);
      closed++;
    }
  }
  return closed;
}

async function load(db: Database, profileId: string, incidentId: string): Promise<IncidentRow> {
  const [i] = await db
    .select()
    .from(incidents)
    .where(and(eq(incidents.id, incidentId), eq(incidents.profileId, profileId)));
  if (!i) throw new HttpError(404, "NOT_FOUND", "Follow-up not found.");
  return i;
}

export interface IncidentActor {
  userId: string;
  role: MemberRole;
}

/**
 * "I'll check on this." Atomic single-owner claim: a conditional update from `open`.
 * Repeating your own claim is a no-op; anyone else gets 409 with the current owner.
 */
export async function claimIncident(db: Database, profileId: string, incidentId: string, actor: IncidentActor, now: Date = new Date()) {
  if (actor.role === "elder") throw new HttpError(403, "FORBIDDEN", "Not allowed.");
  const [row] = await db
    .update(incidents)
    .set({ status: "claimed", claimedBy: actor.userId, claimedAt: now, version: sql`${incidents.version} + 1`, updatedAt: now })
    .where(and(eq(incidents.id, incidentId), eq(incidents.profileId, profileId), eq(incidents.status, "open")))
    .returning();
  if (row) {
    await addEvent(db, row, "claimed", actor.userId, null, now);
    await syncHelpStatus(db, row, "acknowledged");
    return { incident: row, changed: true };
  }
  const current = await load(db, profileId, incidentId);
  if (current.status === "claimed" && current.claimedBy === actor.userId) return { incident: current, changed: false };
  if (current.status === "claimed") throw new HttpError(409, "ALREADY_CLAIMED", "Someone else is already checking on this.");
  throw new HttpError(409, "NOT_OPEN", "This follow-up is already closed.");
}

/** Gives a claim back. The owner may release their own; an administrator may release anyone's (abandoned claim). */
export async function releaseIncident(db: Database, profileId: string, incidentId: string, actor: IncidentActor, note: string | null, now: Date = new Date()) {
  const current = await load(db, profileId, incidentId);
  if (current.status !== "claimed") throw new HttpError(409, "NOT_CLAIMED", "This follow-up is not claimed.");
  if (current.claimedBy !== actor.userId && actor.role !== "admin") {
    throw new HttpError(403, "FORBIDDEN", "Only the person handling this, or a family administrator, can release it.");
  }
  const [row] = await db
    .update(incidents)
    .set({ status: "open", claimedBy: null, claimedAt: null, version: current.version + 1, updatedAt: now })
    .where(and(eq(incidents.id, current.id), eq(incidents.version, current.version)))
    .returning();
  if (!row) throw new HttpError(409, "CONCURRENT_UPDATE", "This follow-up just changed. Please refresh.");
  await addEvent(db, row, "released", actor.userId, note ?? (current.claimedBy === actor.userId ? null : "Released by family administrator"), now);
  await syncHelpStatus(db, row, "open");
  return row;
}

export interface Resolution {
  resolution: Exclude<IncidentResolution, "reconciled">;
  /** How the resolver knows — required when recording a medicine outcome. */
  source?: "observed" | "reported_by_other";
  note?: string | null;
}

/**
 * Resolves a claimed incident. Taken / Not Taken outcomes go through the adherence engine
 * (same provenance and history as any other record). "Unable to verify" never marks a dose taken.
 */
export async function resolveIncident(db: Database, profileId: string, incidentId: string, actor: IncidentActor, input: Resolution, now: Date = new Date()) {
  const current = await load(db, profileId, incidentId);
  if (current.status !== "claimed") throw new HttpError(409, "NOT_CLAIMED", "Claim this follow-up before resolving it.");
  if (current.claimedBy !== actor.userId && actor.role !== "admin") {
    throw new HttpError(403, "FORBIDDEN", "Someone else is handling this follow-up.");
  }
  if (!ALLOWED_RESOLUTIONS[current.sourceType].includes(input.resolution)) {
    throw new HttpError(400, "VALIDATION_FAILED", "That outcome does not apply to this follow-up.");
  }

  if (input.resolution === "taken_confirmed" || input.resolution === "not_taken_confirmed") {
    if (!input.source) throw new HttpError(400, "VALIDATION_FAILED", "Say how you know (you saw it, or you were told).");
    const outcome = input.resolution === "taken_confirmed" ? "taken" : "not_taken";
    const [dose] = await db.select({ status: doses.status }).from(doses).where(eq(doses.id, current.sourceId));
    if (dose && (dose.status === "taken" || dose.status === "not_taken") && dose.status !== outcome) {
      // Changing an existing outcome is a correction (admin or original recorder, with its own rules).
      await applyDoseAction(db, profileId, current.sourceId, { type: "correct", outcome, source: input.source, note: input.note ?? "Updated after follow-up" }, actor, now);
    } else {
      await applyDoseAction(db, profileId, current.sourceId, { type: "record", outcome, source: input.source, note: input.note ?? null }, actor, now);
    }
  }

  const [row] = await db
    .update(incidents)
    .set({
      status: "resolved",
      resolution: input.resolution,
      resolutionNote: input.note ?? null,
      resolvedBy: actor.userId,
      resolvedAt: now,
      version: current.version + 1,
      updatedAt: now,
    })
    .where(and(eq(incidents.id, current.id), eq(incidents.version, current.version), eq(incidents.status, "claimed")))
    .returning();
  if (!row) throw new HttpError(409, "CONCURRENT_UPDATE", "This follow-up just changed. Please refresh.");
  await addEvent(db, row, "resolved", actor.userId, [input.resolution.replaceAll("_", " "), input.note].filter(Boolean).join(" — "), now);
  await syncHelpStatus(db, row, "resolved");
  return row;
}

