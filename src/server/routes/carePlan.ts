import { and, asc, eq, gte, ne } from "drizzle-orm";
import { Router, type Request, type RequestHandler } from "express";
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
import { markOverdueUnconfirmed } from "../services/adherence.js";
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

type MedicationRow = typeof medications.$inferSelect;
type RoutineRow = typeof routines.$inferSelect;
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Fields every new medicine or routine row gets besides the validated input. */
interface NewSourceFields {
  endDate: string | null;
  profileId: string;
  createdBy: string;
  updatedBy: string;
  scheduleEffectiveFrom: Date;
}
/** What an edit or a deactivation writes. */
type SourcePatch<Input> =
  | (Input & { endDate: string | null; updatedBy: string; updatedAt: Date; scheduleEffectiveFrom: Date })
  | { active: false; deactivatedAt: Date; updatedBy: string; updatedAt: Date };

/**
 * Medicines and routines are both daily schedules that generate doses, so they share one lifecycle:
 * - create → insert, then generate doses (one transaction);
 * - edit → only while active; the new schedule applies from now, then future unrecorded doses are re-planned;
 * - deactivate → keeps the first deactivation time, then future unrecorded doses are removed.
 * Each kind supplies only its table access, validation and response shape.
 */
interface ScheduleSource<Row extends { id: string; active: boolean; deactivatedAt: Date | null }, Input, View> {
  kind: "medication" | "routine";
  /** URL segment, e.g. "medications". */
  collection: string;
  /** Route parameter name for one item, e.g. "medicationId". */
  idParam: string;
  /** Lower-case noun for messages, e.g. "medication". */
  noun: string;
  parse: (body: unknown) => Input;
  toView: (row: Row) => View;
  list: (db: Database, profileId: string) => Promise<Row[]>;
  find: (db: Database, profileId: string, id: string) => Promise<Row | undefined>;
  insert: (tx: Tx, values: Input & NewSourceFields) => Promise<Row>;
  update: (tx: Tx, id: string, patch: SourcePatch<Input>) => Promise<Row>;
}

const MEDICATIONS: ScheduleSource<MedicationRow, ReturnType<typeof createMedicationSchema.parse>, Medication> = {
  kind: "medication",
  collection: "medications",
  idParam: "medicationId",
  noun: "medication",
  parse: (body) => createMedicationSchema.parse(body),
  toView: toMedication,
  list: (db, profileId) => db.select().from(medications).where(eq(medications.profileId, profileId)).orderBy(asc(medications.name)),
  find: async (db, profileId, id) => (await db.select().from(medications).where(and(eq(medications.id, id), eq(medications.profileId, profileId))))[0],
  insert: async (tx, values) => (await tx.insert(medications).values(values).returning())[0]!,
  update: async (tx, id, patch) => (await tx.update(medications).set(patch).where(eq(medications.id, id)).returning())[0]!,
};

const ROUTINES: ScheduleSource<RoutineRow, ReturnType<typeof createRoutineSchema.parse>, Routine> = {
  kind: "routine",
  collection: "routines",
  idParam: "routineId",
  noun: "routine",
  parse: (body) => createRoutineSchema.parse(body),
  toView: toRoutine,
  list: (db, profileId) => db.select().from(routines).where(eq(routines.profileId, profileId)).orderBy(asc(routines.title)),
  find: async (db, profileId, id) => (await db.select().from(routines).where(and(eq(routines.id, id), eq(routines.profileId, profileId))))[0],
  insert: async (tx, values) => (await tx.insert(routines).values(values).returning())[0]!,
  update: async (tx, id, patch) => (await tx.update(routines).set(patch).where(eq(routines.id, id)).returning())[0]!,
};

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Registers list / create / edit / deactivate (and optionally get-one) for a schedule source. */
function registerScheduleSource<Row extends { id: string; active: boolean; deactivatedAt: Date | null }, Input extends { endDate?: string | null }, View>(
  router: Router,
  db: Database,
  team: RequestHandler[],
  source: ScheduleSource<Row, Input, View>,
  options: { getOne: boolean },
) {
  const collection = `/profiles/:profileId/${source.collection}`;
  const item = `${collection}/:${source.idParam}`;

  async function load(profileId: string, id: string): Promise<Row> {
    const row = await source.find(db, profileId, id);
    if (!row) throw new HttpError(404, "NOT_FOUND", `${capitalise(source.noun)} not found.`);
    return row;
  }
  const itemId = (req: Request) => String(req.params[source.idParam]);

  router.get(
    collection,
    ...team,
    asyncHandler(async (req, res) => {
      res.json((await source.list(db, ctx(req).profileId)).map(source.toView));
    }),
  );

  if (options.getOne) {
    router.get(
      item,
      ...team,
      asyncHandler(async (req, res) => {
        res.json(source.toView(await load(ctx(req).profileId, itemId(req))));
      }),
    );
  }

  router.post(
    collection,
    ...team,
    asyncHandler(async (req, res) => {
      const { profileId, userId } = ctx(req);
      const input = source.parse(req.body);
      const now = new Date();
      const created = await db.transaction(async (tx) => {
        const row = await source.insert(tx, { ...input, endDate: input.endDate ?? null, profileId, createdBy: userId, updatedBy: userId, scheduleEffectiveFrom: now });
        await generateDosesForProfile(tx, profileId, now);
        return row;
      });
      res.status(201).json(source.toView(created));
    }),
  );

  router.put(
    item,
    ...team,
    asyncHandler(async (req, res) => {
      const { profileId, userId } = ctx(req);
      const existing = await load(profileId, itemId(req));
      if (!existing.active) throw new HttpError(409, "INACTIVE", `This ${source.noun} is no longer active.`);
      const input = source.parse(req.body);
      const now = new Date();
      const updated = await db.transaction(async (tx) => {
        const row = await source.update(tx, existing.id, { ...input, endDate: input.endDate ?? null, updatedBy: userId, updatedAt: now, scheduleEffectiveFrom: now });
        await replanSource(tx, source.kind, existing.id, profileId, now);
        return row;
      });
      res.json(source.toView(updated));
    }),
  );

  router.post(
    `${item}/deactivate`,
    ...team,
    asyncHandler(async (req, res) => {
      const { profileId, userId } = ctx(req);
      const existing = await load(profileId, itemId(req));
      const now = new Date();
      const updated = await db.transaction(async (tx) => {
        const row = await source.update(tx, existing.id, { active: false, deactivatedAt: existing.deactivatedAt ?? now, updatedBy: userId, updatedAt: now });
        await replanSource(tx, source.kind, existing.id, profileId, now); // removes future, unrecorded doses
        return row;
      });
      res.json(source.toView(updated));
    }),
  );
}

export function carePlanRoutes(db: Database, auth: Auth): Router {
  const router = Router();
  const team = [requireSession(auth, db), requireMember(db, CARE_TEAM)];
  const base = "/profiles/:profileId";

  registerScheduleSource(router, db, team, MEDICATIONS, { getOne: true });
  registerScheduleSource(router, db, team, ROUTINES, { getOne: false });

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
      await markOverdueUnconfirmed(db, now, profileId);
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
