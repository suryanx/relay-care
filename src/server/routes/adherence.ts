import { and, asc, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { Router, type Request } from "express";
import { DateTime } from "luxon";
import {
  correctionSchema,
  elderOutcomeSchema,
  helpRequestSchema,
  scheduleQuerySchema,
  teamOutcomeSchema,
  type AdherenceResponse,
  type DoseEventView,
  type DoseView,
  type ElderTodayResponse,
  type HelpRequestView,
} from "../../shared/schemas.js";
import type { Auth } from "../auth.js";
import { HttpError, asyncHandler, requireElder, requireMember, requireSession } from "../authz.js";
import type { Database } from "../db/client.js";
import { appointments, doseEvents, doses, helpRequests, incidents, profiles, user } from "../db/schema.js";
import {
  EARLY_WINDOW_MINUTES,
  MAX_SNOOZES,
  applyDoseAction,
  dosePhase,
  markOverdueUnconfirmed,
  summarize,
  unconfirmedDeadline,
  type Actor,
  type DoseRow,
} from "../services/adherence.js";
import { syncIncidents } from "../services/incidents.js";
import { generateDosesForProfile } from "../services/schedule.js";

/** Brings a profile up to date before reading: top up doses, then apply due system transitions. */
export async function evaluateProfile(db: Database, profileId: string, now: Date = new Date()) {
  await generateDosesForProfile(db, profileId, now);
  await markOverdueUnconfirmed(db, now, profileId);
  await syncIncidents(db, now, profileId);
}

async function loadProfile(db: Database, profileId: string) {
  const [p] = await db.select().from(profiles).where(eq(profiles.id, profileId));
  if (!p) throw new HttpError(404, "NOT_FOUND", "Profile not found.");
  return p;
}

async function userNames(db: Database, ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((i): i is string => Boolean(i)))];
  if (unique.length === 0) return new Map();
  const rows = await db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

function toDoseView(d: DoseRow, now: Date, grace: number, names: Map<string, string>): DoseView {
  const phase = dosePhase(d, now);
  const opens = d.scheduledAt.getTime() - EARLY_WINDOW_MINUTES * 60_000;
  const hasOutcome = d.status === "taken" || d.status === "not_taken";
  return {
    id: d.id,
    kind: d.kind,
    label: d.label,
    detail: d.detail,
    localDate: d.localDate,
    localTime: d.localTime,
    scheduledAt: d.scheduledAt.toISOString(),
    status: d.status,
    phase,
    snoozeCount: d.snoozeCount,
    snoozeUntil: d.snoozeUntil?.toISOString() ?? null,
    canRecord: (d.status === "scheduled" && now.getTime() >= opens) || d.status === "unconfirmed",
    canSnooze:
      d.status === "scheduled" &&
      d.kind === "medication" &&
      now.getTime() >= opens &&
      d.snoozeCount < MAX_SNOOZES &&
      now < unconfirmedDeadline(d, grace),
    outcome: hasOutcome
      ? {
          source: d.outcomeSource,
          recordedBy: d.outcomeRecordedBy ? (names.get(d.outcomeRecordedBy) ?? "Former member") : null,
          recordedAt: d.outcomeRecordedAt?.toISOString() ?? null,
          occurredAt: d.outcomeOccurredAt?.toISOString() ?? null,
          note: d.outcomeNote,
        }
      : null,
  };
}

async function dosesForDate(db: Database, profileId: string, localDate: string) {
  return db
    .select()
    .from(doses)
    .where(and(eq(doses.profileId, profileId), eq(doses.localDate, localDate), ne(doses.status, "void")))
    .orderBy(asc(doses.scheduledAt));
}

function toEventView(e: typeof doseEvents.$inferSelect, names: Map<string, string>, dose?: { label: string; localTime: string }): DoseEventView {
  return {
    id: e.id,
    doseId: e.doseId,
    doseLabel: dose?.label,
    doseLocalTime: dose?.localTime,
    type: e.type,
    fromStatus: e.fromStatus,
    toStatus: e.toStatus,
    source: e.source,
    actor: e.actorUserId ? (names.get(e.actorUserId) ?? "Former member") : "Relay (automatic)",
    note: e.note,
    occurredAt: e.occurredAt?.toISOString() ?? null,
    recordedAt: e.recordedAt.toISOString(),
    correctionOf: e.correctionOf,
  };
}

const parseOccurredAt = (v: string | null | undefined) => (v ? new Date(v) : null);

export function adherenceRoutes(db: Database, auth: Auth): Router {
  const router = Router();
  const signedIn = requireSession(auth, db);
  const elder = [signedIn, requireElder(db)];
  const team = [signedIn, requireMember(db, ["admin", "caregiver"])];
  const actorOf = (req: Request): Actor => ({ userId: req.authCtx!.userId, role: req.membership!.role });

  /* --------------------------- Elder device --------------------------- */

  router.get(
    "/elder/today",
    ...elder,
    asyncHandler(async (req, res) => {
      const { profileId } = req.membership!;
      const now = new Date();
      await evaluateProfile(db, profileId, now);
      const profile = await loadProfile(db, profileId);
      const date = DateTime.fromJSDate(now, { zone: profile.timezone }).toISODate()!;
      const rows = await dosesForDate(db, profileId, date);
      const names = await userNames(db, rows.map((r) => r.outcomeRecordedBy));
      const appts = await db
        .select()
        .from(appointments)
        .where(and(eq(appointments.profileId, profileId), eq(appointments.status, "scheduled"), gte(appointments.startsAt, now)))
        .orderBy(asc(appointments.startsAt))
        .limit(3);
      const open = await db
        .select({ id: helpRequests.id })
        .from(helpRequests)
        .where(and(eq(helpRequests.profileId, profileId), eq(helpRequests.status, "open")));
      const recentHelp = await db
        .select({ h: helpRequests, claimedBy: incidents.claimedBy, handler: user.name })
        .from(helpRequests)
        .leftJoin(incidents, eq(incidents.dedupeKey, sql`'help_request:' || ${helpRequests.id}`))
        .leftJoin(user, eq(user.id, incidents.claimedBy))
        .where(and(eq(helpRequests.profileId, profileId), gte(helpRequests.createdAt, new Date(now.getTime() - 24 * 3_600_000))))
        .orderBy(desc(helpRequests.createdAt))
        .limit(3);

      const body: ElderTodayResponse = {
        preferredName: profile.preferredName,
        timezone: profile.timezone,
        date,
        doses: rows.map((d) => toDoseView(d, now, profile.graceMinutes, names)),
        appointments: appts.map((a) => {
          const local = DateTime.fromJSDate(a.startsAt, { zone: profile.timezone });
          return {
            id: a.id,
            doctorName: a.doctorName,
            specialty: a.specialty,
            localDate: local.toISODate()!,
            localTime: local.toFormat("HH:mm"),
            location: a.location,
          };
        }),
        openHelpRequests: open.length,
        helpRequests: recentHelp.map(({ h, handler }) => ({
          id: h.id,
          status: h.status,
          handledBy: h.status === "acknowledged" && handler ? handler.split(" ")[0]! : null,
          createdAt: h.createdAt.toISOString(),
        })),
      };
      res.json(body);
    }),
  );

  router.post(
    "/elder/doses/:doseId/outcome",
    ...elder,
    asyncHandler(async (req, res) => {
      const input = elderOutcomeSchema.parse(req.body);
      const { dose, changed } = await applyDoseAction(
        db,
        req.membership!.profileId,
        String(req.params.doseId),
        { type: "record", outcome: input.outcome, source: "self_reported", note: input.note },
        actorOf(req),
      );
      await syncIncidents(db, new Date(), req.membership!.profileId);
      res.json({ status: dose.status, changed });
    }),
  );

  router.post(
    "/elder/doses/:doseId/snooze",
    ...elder,
    asyncHandler(async (req, res) => {
      const { dose } = await applyDoseAction(db, req.membership!.profileId, String(req.params.doseId), { type: "snooze" }, actorOf(req));
      res.json({ snoozeCount: dose.snoozeCount, snoozeUntil: dose.snoozeUntil?.toISOString() ?? null, remaining: MAX_SNOOZES - dose.snoozeCount });
    }),
  );

  router.post(
    "/elder/doses/:doseId/correct",
    ...elder,
    asyncHandler(async (req, res) => {
      const input = correctionSchema.parse(req.body);
      const { dose, changed } = await applyDoseAction(
        db,
        req.membership!.profileId,
        String(req.params.doseId),
        { type: "correct", outcome: input.outcome, source: "self_reported", note: input.note },
        actorOf(req),
      );
      await syncIncidents(db, new Date(), req.membership!.profileId);
      res.json({ status: dose.status, changed });
    }),
  );

  router.post(
    "/elder/help",
    ...elder,
    asyncHandler(async (req, res) => {
      const { profileId } = req.membership!;
      const input = helpRequestSchema.parse(req.body ?? {});
      if (input.doseId) {
        const [d] = await db.select({ id: doses.id }).from(doses).where(and(eq(doses.id, input.doseId), eq(doses.profileId, profileId)));
        if (!d) throw new HttpError(404, "NOT_FOUND", "Dose not found.");
      }
      const [row] = await db
        .insert(helpRequests)
        .values({ profileId, doseId: input.doseId ?? null, requestedBy: req.authCtx!.userId, note: input.note ?? null })
        .returning();
      await syncIncidents(db, new Date(), profileId); // becomes a follow-up the care team can claim
      // Honest: saved and visible to the care team in Relay. Email alerts go out only on the next reminder check.
      res.status(201).json({ id: row!.id, status: row!.status, notified: false });
    }),
  );

  /* ----------------------------- Care team ----------------------------- */

  router.get(
    "/profiles/:profileId/adherence",
    ...team,
    asyncHandler(async (req, res) => {
      const { profileId } = req.membership!;
      const { date: requested } = scheduleQuerySchema.parse(req.query);
      const now = new Date();
      await evaluateProfile(db, profileId, now);
      const profile = await loadProfile(db, profileId);
      const date = requested ?? DateTime.fromJSDate(now, { zone: profile.timezone }).toISODate()!;
      const rows = await dosesForDate(db, profileId, date);

      const events = await db
        .select({ e: doseEvents, label: doses.label, localTime: doses.localTime })
        .from(doseEvents)
        .innerJoin(doses, eq(doses.id, doseEvents.doseId))
        .where(and(eq(doseEvents.profileId, profileId), ne(doseEvents.type, "snooze")))
        .orderBy(desc(doseEvents.recordedAt))
        .limit(15);
      const help = await db
        .select({ h: helpRequests, label: doses.label })
        .from(helpRequests)
        .leftJoin(doses, eq(doses.id, helpRequests.doseId))
        .where(and(eq(helpRequests.profileId, profileId), eq(helpRequests.status, "open")))
        .orderBy(desc(helpRequests.createdAt));

      const names = await userNames(db, [
        ...rows.map((r) => r.outcomeRecordedBy),
        ...events.map((e) => e.e.actorUserId),
        ...help.map((h) => h.h.requestedBy),
      ]);

      const body: AdherenceResponse = {
        date,
        timezone: profile.timezone,
        counts: summarize(rows),
        doses: rows.map((d) => toDoseView(d, now, profile.graceMinutes, names)),
        recentActivity: events.map(({ e, label, localTime }) => toEventView(e, names, { label, localTime })),
        openHelpRequests: help.map(
          ({ h, label }): HelpRequestView => ({
            id: h.id,
            doseId: h.doseId,
            doseLabel: label,
            note: h.note,
            status: h.status,
            requestedBy: names.get(h.requestedBy) ?? "Former member",
            createdAt: h.createdAt.toISOString(),
          }),
        ),
      };
      res.json(body);
    }),
  );

  router.get(
    "/profiles/:profileId/doses/:doseId/events",
    ...team,
    asyncHandler(async (req, res) => {
      const { profileId } = req.membership!;
      const [dose] = await db
        .select()
        .from(doses)
        .where(and(eq(doses.id, String(req.params.doseId)), eq(doses.profileId, profileId)));
      if (!dose) throw new HttpError(404, "NOT_FOUND", "Dose not found.");
      const events = await db.select().from(doseEvents).where(eq(doseEvents.doseId, dose.id)).orderBy(asc(doseEvents.recordedAt));
      const names = await userNames(db, events.map((e) => e.actorUserId));
      res.json(events.map((e) => toEventView(e, names, { label: dose.label, localTime: dose.localTime })));
    }),
  );

  router.post(
    "/profiles/:profileId/doses/:doseId/outcome",
    ...team,
    asyncHandler(async (req, res) => {
      const input = teamOutcomeSchema.parse(req.body);
      const { dose, changed } = await applyDoseAction(
        db,
        req.membership!.profileId,
        String(req.params.doseId),
        { type: "record", outcome: input.outcome, source: input.source, note: input.note, occurredAt: parseOccurredAt(input.occurredAt) },
        actorOf(req),
      );
      await syncIncidents(db, new Date(), req.membership!.profileId);
      res.json({ status: dose.status, changed });
    }),
  );

  router.post(
    "/profiles/:profileId/doses/:doseId/correct",
    ...team,
    asyncHandler(async (req, res) => {
      const input = correctionSchema.parse(req.body);
      const { dose, changed } = await applyDoseAction(
        db,
        req.membership!.profileId,
        String(req.params.doseId),
        { type: "correct", outcome: input.outcome, source: input.source === "self_reported" || !input.source ? "reported_by_other" : input.source, note: input.note },
        actorOf(req),
      );
      await syncIncidents(db, new Date(), req.membership!.profileId);
      res.json({ status: dose.status, changed });
    }),
  );

  return router;
}
