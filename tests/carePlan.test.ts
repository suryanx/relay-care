import { and, eq, gt, lt } from "drizzle-orm";
import { DateTime } from "luxon";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { doses, medications, session } from "../src/server/db/schema.js";
import { generateDosesForProfile } from "../src/server/services/schedule.js";
import { BASE_URL, makeTestApp, signUpAgent, syntheticProfile, type TestContext } from "./helpers.js";

const ZONE = syntheticProfile.timezone; // Asia/Kolkata (no DST)
const localToday = () => DateTime.now().setZone(ZONE).toISODate()!;
const localTomorrow = () => DateTime.now().setZone(ZONE).plus({ days: 1 }).toISODate()!;

const med = (over: Record<string, unknown> = {}) => ({
  name: "Demo Tablet",
  strength: "10 mg",
  instructions: "As written on the synthetic prescription label.",
  times: ["08:00", "20:00"],
  startDate: localToday(),
  endDate: null,
  reminderLeadMinutes: 15,
  ...over,
});

describe("care plan", () => {
  let ctx: TestContext;
  let admin: Awaited<ReturnType<typeof signUpAgent>>;
  let profileId: string;
  let otherAdmin: Awaited<ReturnType<typeof signUpAgent>>;
  let otherProfileId: string;
  let elderAgent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    ctx = await makeTestApp();
    admin = await signUpAgent(ctx.app);
    profileId = (await admin.agent.post("/api/profiles").send(syntheticProfile)).body.id;
    otherAdmin = await signUpAgent(ctx.app);
    otherProfileId = (await otherAdmin.agent.post("/api/profiles").send({ ...syntheticProfile, preferredName: "Other" })).body.id;

    await admin.agent.post(`/api/profiles/${profileId}/elder-account`).send({ username: "careplan.elder", passcode: "sunrise garden 42" });
    elderAgent = request.agent(ctx.app);
    await elderAgent.post("/api/auth/sign-in/username").set("origin", BASE_URL).send({ username: "careplan.elder", password: "sunrise garden 42" });
  });
  afterAll(() => ctx.handle.close());

  describe("medications", () => {
    let medId: string;

    it("creates, reads and lists a medication", async () => {
      const created = await admin.agent.post(`/api/profiles/${profileId}/medications`).send(med());
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ name: "Demo Tablet", times: ["08:00", "20:00"], active: true, profileId });
      medId = created.body.id;

      expect((await admin.agent.get(`/api/profiles/${profileId}/medications/${medId}`)).body.name).toBe("Demo Tablet");
      const list = await admin.agent.get(`/api/profiles/${profileId}/medications`);
      expect(list.body.map((m: { id: string }) => m.id)).toEqual([medId]);
    });

    it("persists doses that appear in tomorrow's schedule (two per day)", async () => {
      const res = await admin.agent.get(`/api/profiles/${profileId}/schedule`).query({ date: localTomorrow() });
      expect(res.status).toBe(200);
      const items = res.body.items.filter((i: { kind: string }) => i.kind === "medication");
      expect(items.map((i: { localTime: string }) => i.localTime)).toEqual(["08:00", "20:00"]);
      expect(items[0]).toMatchObject({ label: "Demo Tablet (10 mg)", status: "scheduled", id: `medication:${medId}:${localTomorrow()}T08:00` });

      const rows = await ctx.handle.db.select().from(doses).where(and(eq(doses.medicationId, medId), eq(doses.localDate, localTomorrow())));
      expect(rows).toHaveLength(2);
    });

    it("dose generation is idempotent", async () => {
      const before = await ctx.handle.db.select().from(doses).where(eq(doses.profileId, profileId));
      expect(await generateDosesForProfile(ctx.handle.db, profileId)).toBe(0);
      expect(await generateDosesForProfile(ctx.handle.db, profileId)).toBe(0);
      const after = await ctx.handle.db.select().from(doses).where(eq(doses.profileId, profileId));
      expect(after).toHaveLength(before.length);
    });

    it("editing the schedule replaces future doses but preserves past and recorded ones", async () => {
      const now = new Date();
      // Back-date the schedule so past doses exist, then materialise them.
      await ctx.handle.db
        .update(medications)
        .set({ scheduleEffectiveFrom: new Date(now.getTime() - 3 * 86_400_000), startDate: DateTime.now().setZone(ZONE).minus({ days: 3 }).toISODate()! })
        .where(eq(medications.id, medId));
      await generateDosesForProfile(ctx.handle.db, profileId, now);

      const past = await ctx.handle.db.select().from(doses).where(and(eq(doses.medicationId, medId), lt(doses.scheduledAt, now)));
      expect(past.length).toBeGreaterThan(0);
      // One past dose has an outcome; one future dose was recorded early (e.g. taken ahead of time).
      await ctx.handle.db.update(doses).set({ status: "taken" }).where(eq(doses.id, past[0]!.id));
      const [futureTaken] = await ctx.handle.db
        .select()
        .from(doses)
        .where(and(eq(doses.medicationId, medId), gt(doses.scheduledAt, now)))
        .limit(1);
      await ctx.handle.db.update(doses).set({ status: "taken" }).where(eq(doses.id, futureTaken!.id));

      const edit = await admin.agent
        .put(`/api/profiles/${profileId}/medications/${medId}`)
        .send(med({ name: "Demo Tablet", strength: "20 mg", times: ["09:30"], startDate: past[0]!.localDate }));
      expect(edit.status).toBe(200);
      expect(edit.body).toMatchObject({ strength: "20 mg", times: ["09:30"] });

      const all = await ctx.handle.db.select().from(doses).where(eq(doses.medicationId, medId));
      const editedAt = new Date();
      // Past doses are untouched (ids, labels, outcomes).
      for (const p of past) {
        const still = all.find((d) => d.id === p.id);
        expect(still).toBeDefined();
        expect(still!.label).toBe("Demo Tablet (10 mg)");
      }
      expect(all.find((d) => d.id === past[0]!.id)!.status).toBe("taken");
      // The future dose with a recorded outcome survives the edit.
      expect(all.find((d) => d.id === futureTaken!.id)!.status).toBe("taken");
      // Every other future dose follows the new schedule.
      const futureUnrecorded = all.filter((d) => d.scheduledAt > editedAt && d.id !== futureTaken!.id);
      expect(futureUnrecorded.length).toBeGreaterThan(0);
      expect(futureUnrecorded.every((d) => d.localTime === "09:30" && d.label === "Demo Tablet (20 mg)")).toBe(true);
    });

    it("deactivates a medication, removes its future unrecorded doses, and blocks further edits", async () => {
      const res = await admin.agent.post(`/api/profiles/${profileId}/medications/${medId}/deactivate`).send({});
      expect(res.status).toBe(200);
      expect(res.body.active).toBe(false);

      const future = await ctx.handle.db
        .select()
        .from(doses)
        .where(and(eq(doses.medicationId, medId), gt(doses.scheduledAt, new Date()), eq(doses.status, "scheduled")));
      expect(future).toHaveLength(0);
      expect(await generateDosesForProfile(ctx.handle.db, profileId)).toBe(0); // inactive → nothing new

      const list = await admin.agent.get(`/api/profiles/${profileId}/medications`);
      expect(list.body[0].active).toBe(false); // still visible as inactive
      expect((await admin.agent.put(`/api/profiles/${profileId}/medications/${medId}`).send(med())).status).toBe(409);
    });

    it("validates input", async () => {
      const res = await admin.agent.post(`/api/profiles/${profileId}/medications`).send(
        med({ name: "", times: ["25:00", "08:00", "08:00"], startDate: "2026-02-30", endDate: "2020-01-01" }),
      );
      expect(res.status).toBe(400);
      const paths = res.body.error.fields.map((f: { path: string }) => f.path);
      expect(paths).toEqual(expect.arrayContaining(["name", "times.0", "startDate"]));

      const dup = await admin.agent.post(`/api/profiles/${profileId}/medications`).send(med({ times: ["08:00", "08:00"] }));
      expect(dup.status).toBe(400);
      const order = await admin.agent.post(`/api/profiles/${profileId}/medications`).send(med({ startDate: "2026-12-10", endDate: "2026-12-01" }));
      expect(order.status).toBe(400);
      expect(order.body.error.fields[0].path).toBe("endDate");
    });
  });

  describe("authorization", () => {
    let otherMedId: string;
    beforeAll(async () => {
      otherMedId = (await otherAdmin.agent.post(`/api/profiles/${otherProfileId}/medications`).send(med())).body.id;
    });

    it("rejects unauthenticated access", async () => {
      const anon = request(ctx.app);
      expect((await anon.get(`/api/profiles/${profileId}/medications`)).status).toBe(401);
      expect((await anon.post(`/api/profiles/${profileId}/medications`).send(med())).status).toBe(401);
      expect((await anon.post(`/api/profiles/${profileId}/appointments`).send({})).status).toBe(401);
    });

    it("denies another family's admin reads and writes", async () => {
      expect((await admin.agent.get(`/api/profiles/${otherProfileId}/medications`)).status).toBe(403);
      expect((await admin.agent.put(`/api/profiles/${otherProfileId}/medications/${otherMedId}`).send(med())).status).toBe(403);
      expect((await admin.agent.post(`/api/profiles/${otherProfileId}/medications/${otherMedId}/deactivate`).send({})).status).toBe(403);
      expect((await admin.agent.post(`/api/profiles/${otherProfileId}/appointments`).send({})).status).toBe(403);
    });

    it("does not let a member reach another profile's record through their own profile path", async () => {
      const res = await admin.agent.put(`/api/profiles/${profileId}/medications/${otherMedId}`).send(med());
      expect(res.status).toBe(404);
      const [row] = await ctx.handle.db.select().from(medications).where(eq(medications.id, otherMedId));
      expect(row!.profileId).toBe(otherProfileId);
      expect(row!.strength).toBe("10 mg");
    });

    it("denies the elder account every care-plan write (and the management reads)", async () => {
      expect((await elderAgent.get("/api/elder/home")).status).toBe(200); // sanity: elder is signed in
      expect((await elderAgent.post(`/api/profiles/${profileId}/medications`).send(med())).status).toBe(403);
      expect((await elderAgent.post(`/api/profiles/${profileId}/routines`).send({})).status).toBe(403);
      expect((await elderAgent.post(`/api/profiles/${profileId}/appointments`).send({})).status).toBe(403);
      expect((await elderAgent.get(`/api/profiles/${profileId}/medications`)).status).toBe(403);
    });
  });

  describe("routines", () => {
    it("creates, edits and deactivates a routine that is distinct from medication", async () => {
      const created = await admin.agent
        .post(`/api/profiles/${profileId}/routines`)
        .send({ title: "Drink a glass of water", notes: "Synthetic routine", times: ["10:00", "15:00"], startDate: localToday() });
      expect(created.status).toBe(201);
      const id = created.body.id;

      const sched = await admin.agent.get(`/api/profiles/${profileId}/schedule`).query({ date: localTomorrow() });
      const rts = sched.body.items.filter((i: { kind: string }) => i.kind === "routine");
      expect(rts.map((i: { localTime: string; label: string }) => `${i.localTime} ${i.label}`)).toEqual([
        "10:00 Drink a glass of water",
        "15:00 Drink a glass of water",
      ]);

      const edited = await admin.agent
        .put(`/api/profiles/${profileId}/routines/${id}`)
        .send({ title: "Short walk", notes: null, times: ["17:00"], startDate: localToday() });
      expect(edited.status).toBe(200);
      expect(edited.body).toMatchObject({ title: "Short walk", times: ["17:00"] });

      const deactivated = await admin.agent.post(`/api/profiles/${profileId}/routines/${id}/deactivate`).send({});
      expect(deactivated.body.active).toBe(false);
    });

    it("follows the same lifecycle rules as medicines, with routine wording and API surface", async () => {
      const created = await admin.agent
        .post(`/api/profiles/${profileId}/routines`)
        .send({ title: "Evening stretch", times: ["18:00"], startDate: localToday() });
      const id = created.body.id;

      // Deactivating twice keeps the first deactivation and never re-activates.
      const first = await admin.agent.post(`/api/profiles/${profileId}/routines/${id}/deactivate`).send({});
      const again = await admin.agent.post(`/api/profiles/${profileId}/routines/${id}/deactivate`).send({});
      expect(again.status).toBe(200);
      expect(again.body.active).toBe(false);
      expect(first.body.active).toBe(false);

      // Its future doses are gone from the schedule.
      const sched = await admin.agent.get(`/api/profiles/${profileId}/schedule`).query({ date: localTomorrow() });
      expect(sched.body.items.some((i: { label: string }) => i.label === "Evening stretch")).toBe(false);

      const edit = await admin.agent.put(`/api/profiles/${profileId}/routines/${id}`).send({ title: "x", times: ["09:00"], startDate: localToday() });
      expect(edit.status).toBe(409);
      expect(edit.body.error).toMatchObject({ code: "INACTIVE", message: "This routine is no longer active." });

      const missing = await admin.agent.put(`/api/profiles/${profileId}/routines/does-not-exist`).send({ title: "x", times: ["09:00"], startDate: localToday() });
      expect(missing.status).toBe(404);
      expect(missing.body.error.message).toBe("Routine not found.");

      // Routines have no single-item GET (unlike medicines); that route stays absent.
      expect((await admin.agent.get(`/api/profiles/${profileId}/routines/${id}`)).status).toBe(404);
      expect((await admin.agent.get(`/api/profiles/${profileId}/medications/does-not-exist`)).body.error.message).toBe("Medication not found.");
    });

    it("validates routine input", async () => {
      const res = await admin.agent.post(`/api/profiles/${profileId}/routines`).send({ title: " ", times: [], startDate: "x" });
      expect(res.status).toBe(400);
    });
  });

  describe("appointments", () => {
    const appt = (over: Record<string, unknown> = {}) => ({
      doctorName: "Dr. Demo Rao",
      specialty: "Cardiology",
      date: DateTime.now().setZone(ZONE).plus({ days: 5 }).toISODate(),
      time: "10:30",
      location: "Synthetic Clinic, Room 4",
      notes: "Bring medicine list.",
      reminderHoursBefore: 24,
      ...over,
    });
    let apptId: string;

    it("creates an appointment in the profile's time zone and lists it as upcoming", async () => {
      const res = await admin.agent.post(`/api/profiles/${profileId}/appointments`).send(appt());
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ doctorName: "Dr. Demo Rao", localTime: "10:30", status: "scheduled" });
      expect(res.body.startsAt.endsWith("05:00:00.000Z")).toBe(true); // 10:30 IST = 05:00 UTC
      apptId = res.body.id;
      const list = await admin.agent.get(`/api/profiles/${profileId}/appointments`);
      expect(list.body.map((a: { id: string }) => a.id)).toContain(apptId);
    });

    it("edits an appointment", async () => {
      const res = await admin.agent.put(`/api/profiles/${profileId}/appointments/${apptId}`).send(appt({ time: "11:15", location: "Room 7" }));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ localTime: "11:15", location: "Room 7" });
    });

    it("cancels an appointment, hides it from upcoming, and blocks edits", async () => {
      const res = await admin.agent.post(`/api/profiles/${profileId}/appointments/${apptId}/cancel`).send({});
      expect(res.body.status).toBe("cancelled");
      expect((await admin.agent.post(`/api/profiles/${profileId}/appointments/${apptId}/cancel`).send({})).status).toBe(200); // idempotent

      const upcoming = await admin.agent.get(`/api/profiles/${profileId}/appointments`);
      expect(upcoming.body.map((a: { id: string }) => a.id)).not.toContain(apptId);
      const all = await admin.agent.get(`/api/profiles/${profileId}/appointments`).query({ include: "all" });
      expect(all.body.find((a: { id: string }) => a.id === apptId).status).toBe("cancelled");
      expect((await admin.agent.put(`/api/profiles/${profileId}/appointments/${apptId}`).send(appt())).status).toBe(409);
    });

    it("rejects past appointments and invalid input", async () => {
      expect((await admin.agent.post(`/api/profiles/${profileId}/appointments`).send(appt({ date: "2020-01-01" }))).status).toBe(400);
      const bad = await admin.agent.post(`/api/profiles/${profileId}/appointments`).send(appt({ doctorName: "", time: "9am" }));
      expect(bad.status).toBe(400);
      expect(bad.body.error.fields.map((f: { path: string }) => f.path)).toEqual(expect.arrayContaining(["doctorName", "time"]));
    });
  });

  describe("session policy", () => {
    it("expires family sessions older than 7 days but keeps elder device sessions", async () => {
      const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000);
      await ctx.handle.db.update(session).set({ createdAt: eightDaysAgo }).where(eq(session.userId, otherAdmin.userId));
      const res = await otherAdmin.agent.get("/api/profiles");
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("SESSION_EXPIRED");
      expect(await ctx.handle.db.select().from(session).where(eq(session.userId, otherAdmin.userId))).toHaveLength(0);

      const me = await elderAgent.get("/api/me");
      const elderId = me.body.user.id as string;
      await ctx.handle.db.update(session).set({ createdAt: eightDaysAgo }).where(eq(session.userId, elderId));
      expect((await elderAgent.get("/api/elder/home")).status).toBe(200);
    });
  });
});
