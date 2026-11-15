import { and, asc, eq, gte, ne } from "drizzle-orm";
import { Router, type Request } from "express";
import { DateTime } from "luxon";
import {
  createAppointmentSchema,
  createMedicationSchema,
  createRoutineSchema,
  scheduleQuerySchema,
  type Appointment,
  type Medication,
  type Routine,
  type ScheduleResponse,
} from "../../shared/schemas.js";
import type { Auth } from "../auth.js";
import { HttpError, asyncHandler, requireMember, requireSession } from "../authz.js";
import type { Database } from "../db/client.js";
import { appointments, doses, medications, profiles, routines } from "../db/schema.js";
import { generateDosesForProfile, replanSource, resolveLocalTime } from "../services/schedule.js";

/** Care-plan reads and writes are for the care team; elder accounts never reach these routes. */
const CARE_TEAM = ["admin", "caregiver"] as const;

const ctx = (req: Request) => ({ profileId: req.membership!.profileId, userId: req.authCtx!.userId });

async function profileTimezone(db: Database, profileId: string): Promise<string> {
  const [p] = await db.select({ timezone: profiles.timezone }).from(profiles).where(eq(profiles.id, profileId));
  if (!p) throw new HttpError(404, "NOT_FOUND", "Profile not found.");
  return p.timezone;
}

const toMedication = (m: typeof medications.$inferSelect): Medication => ({
  id: m.id,
  profileId: m.profileId,
  name: m.name,
  strength: m.strength,
  instructions: m.instructions,
  times: m.times,
  startDate: m.startDate,
  endDate: m.endDate,
  reminderLeadMinutes: m.reminderLeadMinutes,
  active: m.active,
  updatedAt: m.updatedAt.toISOString(),
});

const toRoutine = (r: typeof routines.$inferSelect): Routine => ({
  id: r.id,
  profileId: r.profileId,
  title: r.title,
  notes: r.notes,
  times: r.times,
  startDate: r.startDate,
  endDate: r.endDate,
  active: r.active,
});

function toAppointment(a: typeof appointments.$inferSelect, zone: string): Appointment {
  const local = DateTime.fromJSDate(a.startsAt, { zone });
  return {
    id: a.id,
    profileId: a.profileId,
    doctorName: a.doctorName,
    specialty: a.specialty,
    startsAt: a.startsAt.toISOString(),
    localDate: local.toISODate()!,
    localTime: local.toFormat("HH:mm"),
    location: a.location,
    notes: a.notes,
    reminderHoursBefore: a.reminderHoursBefore,
    status: a.status,
  };
}

export function carePlanRoutes(db: Database, auth: Auth): Router {
  const router = Router();
  const team = [requireSession(auth, db), requireMember(db, CARE_TEAM)];
  const base = "/profiles/:profileId";

  /* ----------------------------- Medications ----------------------------- */

  router.get(
    `${base}/medications`,
    ...team,
    asyncHandler(async (req, res) => {
      const rows = await db
        .select()
        .from(medications)
        .where(eq(medications.profileId, ctx(req).profileId))
        .orderBy(asc(medications.name));
      res.json(rows.map(toMedication));
    }),
  );

  async function loadMedication(profileId: string, id: string) {
    const [m] = await db
      .select()
      .from(medications)
      .where(and(eq(medications.id, id), eq(medications.profileId, profileId)));
    if (!m) throw new HttpError(404, "NOT_FOUND", "Medication not found.");
    return m;
  }

  router.get(
    `${base}/medications/:medicationId`,
    ...team,
    asyncHandler(async (req, res) => {
      res.json(toMedication(await loadMedication(ctx(req).profileId, String(req.params.medicationId))));
    }),
  );

  router.post(
    `${base}/medications`,
    ...team,
    asyncHandler(async (req, res) => {
      const { profileId, userId } = ctx(req);
      const input = createMedicationSchema.parse(req.body);
      const now = new Date();
      const created = await db.transaction(async (tx) => {
        const [m] = await tx
          .insert(medications)
          .values({ ...input, endDate: input.endDate ?? null, profileId, createdBy: userId, updatedBy: userId, scheduleEffectiveFrom: now })
          .returning();
        await generateDosesForProfile(tx, profileId, now);
        return m!;
      });
      res.status(201).json(toMedication(created));
    }),
  );

  router.put(
    `${base}/medications/:medicationId`,
    ...team,
    asyncHandler(async (req, res) => {
      const { profileId, userId } = ctx(req);
      const existing = await loadMedication(profileId, String(req.params.medicationId));
      if (!existing.active) throw new HttpError(409, "INACTIVE", "This medication is no longer active.");
      const input = createMedicationSchema.parse(req.body);
      const now = new Date();
      const updated = await db.transaction(async (tx) => {
        const [m] = await tx
          .update(medications)
          .set({ ...input, endDate: input.endDate ?? null, updatedBy: userId, updatedAt: now, scheduleEffectiveFrom: now })
          .where(eq(medications.id, existing.id))
          .returning();
        await replanSource(tx, "medication", existing.id, profileId, now);
        return m!;
      });
      res.json(toMedication(updated));
    }),
  );

  router.post(
    `${base}/medications/:medicationId/deactivate`,
    ...team,
    asyncHandler(async (req, res) => {
      const { profileId, userId } = ctx(req);
      const existing = await loadMedication(profileId, String(req.params.medicationId));
      const now = new Date();
      const updated = await db.transaction(async (tx) => {
        const [m] = await tx
          .update(medications)
          .set({ active: false, deactivatedAt: existing.deactivatedAt ?? now, updatedBy: userId, updatedAt: now })
          .where(eq(medications.id, existing.id))
          .returning();
        await replanSource(tx, "medication", existing.id, profileId, now); // removes future, unrecorded doses
        return m!;
      });
      res.json(toMedication(updated));
    }),
  );

  /* ------------------------------- Routines ------------------------------- */

  router.get(
    `${base}/routines`,
    ...team,
    asyncHandler(async (req, res) => {
      const rows = await db
        .select()
        .from(routines)
        .where(eq(routines.profileId, ctx(req).profileId))
        .orderBy(asc(routines.title));
      res.json(rows.map(toRoutine));
    }),
  );

  async function loadRoutine(profileId: string, id: string) {
    const [r] = await db
      .select()
      .from(routines)
      .where(and(eq(routines.id, id), eq(routines.profileId, profileId)));
    if (!r) throw new HttpError(404, "NOT_FOUND", "Routine not found.");
    return r;
  }

  router.post(
    `${base}/routines`,
    ...team,
    asyncHandler(async (req, res) => {
      const { profileId, userId } = ctx(req);
      const input = createRoutineSchema.parse(req.body);
      const now = new Date();
      const created = await db.transaction(async (tx) => {
        const [r] = await tx
          .insert(routines)
          .values({ ...input, endDate: input.endDate ?? null, profileId, createdBy: userId, updatedBy: userId, scheduleEffectiveFrom: now })
          .returning();
        await generateDosesForProfile(tx, profileId, now);
        return r!;
      });
      res.status(201).json(toRoutine(created));
    }),
  );

  router.put(
    `${base}/routines/:routineId`,
    ...team,
    asyncHandler(async (req, res) => {
      const { profileId, userId } = ctx(req);
      const existing = await loadRoutine(profileId, String(req.params.routineId));
      if (!existing.active) throw new HttpError(409, "INACTIVE", "This routine is no longer active.");
      const input = createRoutineSchema.parse(req.body);
      const now = new Date();
      const updated = await db.transaction(async (tx) => {
        const [r] = await tx
          .update(routines)
          .set({ ...input, endDate: input.endDate ?? null, updatedBy: userId, updatedAt: now, scheduleEffectiveFrom: now })
          .where(eq(routines.id, existing.id))
          .returning();
        await replanSource(tx, "routine", existing.id, profileId, now);
        return r!;
      });
      res.json(toRoutine(updated));
    }),
  );

  router.post(
    `${base}/routines/:routineId/deactivate`,
    ...team,
    asyncHandler(async (req, res) => {
      const { profileId, userId } = ctx(req);
      const existing = await loadRoutine(profileId, String(req.params.routineId));
      const now = new Date();
      const updated = await db.transaction(async (tx) => {
        const [r] = await tx
          .update(routines)
          .set({ active: false, deactivatedAt: existing.deactivatedAt ?? now, updatedBy: userId, updatedAt: now })
          .where(eq(routines.id, existing.id))
          .returning();
        await replanSource(tx, "routine", existing.id, profileId, now);
        return r!;
      });
      res.json(toRoutine(updated));
    }),
  );

  /* ------------------------------- Schedule ------------------------------- */

  router.get(
    `${base}/schedule`,
    ...team,
    asyncHandler(async (req, res) => {
      const { profileId } = ctx(req);
      const { date } = scheduleQuerySchema.parse(req.query);
      const zone = await profileTimezone(db, profileId);
      const now = new Date();
      await generateDosesForProfile(db, profileId, now); // idempotent top-up of the bounded window
      const localDate = date ?? DateTime.fromJSDate(now, { zone }).toISODate()!;
      const rows = await db
        .select()
        .from(doses)
        .where(and(eq(doses.profileId, profileId), eq(doses.localDate, localDate), ne(doses.status, "void")))
        .orderBy(asc(doses.scheduledAt));
      const body: ScheduleResponse = {
        date: localDate,
        timezone: zone,
        items: rows.map((d) => ({
          id: d.id,
          kind: d.kind,
          label: d.label,
          detail: d.detail,
          scheduledAt: d.scheduledAt.toISOString(),
          localDate: d.localDate,
          localTime: d.localTime,
          status: d.status,
        })),
      };
      res.json(body);
    }),
  );

  /* ----------------------------- Appointments ----------------------------- */

  router.get(
    `${base}/appointments`,
    ...team,
    asyncHandler(async (req, res) => {
      const { profileId } = ctx(req);
      const zone = await profileTimezone(db, profileId);
      const showAll = req.query.include === "all";
      const rows = await db
        .select()
        .from(appointments)
        .where(
          showAll
            ? eq(appointments.profileId, profileId)
            : and(eq(appointments.profileId, profileId), eq(appointments.status, "scheduled"), gte(appointments.startsAt, new Date())),
        )
        .orderBy(asc(appointments.startsAt));
      res.json(rows.map((a) => toAppointment(a, zone)));
    }),
  );

  async function loadAppointment(profileId: string, id: string) {
    const [a] = await db
      .select()
      .from(appointments)
      .where(and(eq(appointments.id, id), eq(appointments.profileId, profileId)));
    if (!a) throw new HttpError(404, "NOT_FOUND", "Appointment not found.");
    return a;
  }

  function toStartsAt(date: string, time: string, zone: string): Date {
    const startsAt = resolveLocalTime(date, time, zone).toJSDate();
    if (startsAt.getTime() <= Date.now()) {
      throw new HttpError(400, "VALIDATION_FAILED", "Appointments must be in the future.");
    }
    return startsAt;
  }

  router.get(
    `${base}/appointments/:appointmentId`,
    ...team,
    asyncHandler(async (req, res) => {
      const { profileId } = ctx(req);
      const zone = await profileTimezone(db, profileId);
      res.json(toAppointment(await loadAppointment(profileId, String(req.params.appointmentId)), zone));
    }),
  );

  router.post(
    `${base}/appointments`,
    ...team,
    asyncHandler(async (req, res) => {
      const { profileId, userId } = ctx(req);
      const zone = await profileTimezone(db, profileId);
      const { date, time, ...rest } = createAppointmentSchema.parse(req.body);
      const [a] = await db
        .insert(appointments)
        .values({ ...rest, startsAt: toStartsAt(date, time, zone), profileId, createdBy: userId, updatedBy: userId })
        .returning();
      res.status(201).json(toAppointment(a!, zone));
    }),
  );

  router.put(
    `${base}/appointments/:appointmentId`,
    ...team,
    asyncHandler(async (req, res) => {
      const { profileId, userId } = ctx(req);
      const zone = await profileTimezone(db, profileId);
      const existing = await loadAppointment(profileId, String(req.params.appointmentId));
      if (existing.status === "cancelled") throw new HttpError(409, "CANCELLED", "Cancelled appointments cannot be edited.");
      const { date, time, ...rest } = createAppointmentSchema.parse(req.body);
      const [a] = await db
        .update(appointments)
        .set({ ...rest, startsAt: toStartsAt(date, time, zone), updatedBy: userId, updatedAt: new Date() })
        .where(eq(appointments.id, existing.id))
        .returning();
      res.json(toAppointment(a!, zone));
    }),
  );

  router.post(
    `${base}/appointments/:appointmentId/cancel`,
    ...team,
    asyncHandler(async (req, res) => {
      const { profileId, userId } = ctx(req);
      const zone = await profileTimezone(db, profileId);
      const existing = await loadAppointment(profileId, String(req.params.appointmentId));
      if (existing.status === "cancelled") {
        res.json(toAppointment(existing, zone)); // idempotent
        return;
      }
      const now = new Date();
      const [a] = await db
        .update(appointments)
        .set({ status: "cancelled", cancelledAt: now, updatedBy: userId, updatedAt: now })
        .where(eq(appointments.id, existing.id))
        .returning();
      res.json(toAppointment(a!, zone));
    }),
  );

  return router;
}
