import { and, asc, eq } from "drizzle-orm";
import { DateTime } from "luxon";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { doseEvents, doses, helpRequests } from "../src/server/db/schema.js";
import { SYSTEM_ACTOR, applyDoseAction, markOverdueUnconfirmed } from "../src/server/services/adherence.js";
import { doseId } from "../src/server/services/schedule.js";
import { BASE_URL, makeTestApp, signUpAgent, syntheticProfile, type TestContext } from "./helpers.js";

const ZONE = syntheticProfile.timezone; // Asia/Kolkata

describe("adherence engine (database + API)", () => {
  let ctx: TestContext;
  let admin: Awaited<ReturnType<typeof signUpAgent>>;
  let profileId: string;
  let medId: string;
  let elderAgent: ReturnType<typeof request.agent>;
  let elderUserId: string;
  let otherAdmin: Awaited<ReturnType<typeof signUpAgent>>;
  let otherProfileId: string;
  let otherDoseId: string;
  let seq = 0;

  /** Inserts a medication dose at `minutesFromNow` (synthetic), returning its id. */
  async function insertDose(minutesFromNow: number, pId = profileId, mId = medId): Promise<string> {
    // Unique minute per call so ids never collide between tests.
    const at = DateTime.now().setZone(ZONE).plus({ minutes: minutesFromNow }).startOf("minute").plus({ seconds: ++seq });
    const local = at.startOf("minute");
    const id = `${doseId("medication", mId, local.toISODate()!, local.toFormat("HH:mm"))}#${seq}`;
    await ctx.handle.db.insert(doses).values({
      id,
      profileId: pId,
      kind: "medication",
      medicationId: mId,
      label: "Demo Tablet (10 mg)",
      scheduledAt: at.toJSDate(),
      localDate: local.toISODate()!,
      localTime: local.toFormat("HH:mm"),
    });
    return id;
  }
  const eventsOf = (id: string) => ctx.handle.db.select().from(doseEvents).where(eq(doseEvents.doseId, id)).orderBy(asc(doseEvents.recordedAt));
  const doseRow = async (id: string) => (await ctx.handle.db.select().from(doses).where(eq(doses.id, id)))[0]!;

  beforeAll(async () => {
    ctx = await makeTestApp();
    admin = await signUpAgent(ctx.app);
    profileId = (await admin.agent.post("/api/profiles").send(syntheticProfile)).body.id;
    medId = (
      await admin.agent.post(`/api/profiles/${profileId}/medications`).send({
        name: "Demo Tablet",
        strength: "10 mg",
        times: ["03:00"],
        startDate: DateTime.now().setZone(ZONE).toISODate(),
      })
    ).body.id;
    await admin.agent.post(`/api/profiles/${profileId}/elder-account`).send({ username: "adh.elder", passcode: "sunrise garden 42" });
    elderAgent = request.agent(ctx.app);
    const signIn = await elderAgent.post("/api/auth/sign-in/username").set("origin", BASE_URL).send({ username: "adh.elder", password: "sunrise garden 42" });
    elderUserId = signIn.body.user.id;

    otherAdmin = await signUpAgent(ctx.app);
    otherProfileId = (await otherAdmin.agent.post("/api/profiles").send({ ...syntheticProfile, preferredName: "Other" })).body.id;
    const otherMed = (
      await otherAdmin.agent
        .post(`/api/profiles/${otherProfileId}/medications`)
        .send({ name: "Secret Other Med", times: ["03:00"], startDate: DateTime.now().setZone(ZONE).toISODate() })
    ).body.id;
    otherDoseId = await insertDose(-5, otherProfileId, otherMed);
  });
  afterAll(() => ctx.handle.close());

  describe("elder actions", () => {
    let due: string;
    beforeEach(async () => {
      due = await insertDose(-5);
    });

    it("1. Scheduled → Taken (self-reported) with provenance and one event", async () => {
      const res = await elderAgent.post(`/api/elder/doses/${encodeURIComponent(due)}/outcome`).set("origin", BASE_URL).send({ outcome: "taken" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: "taken", changed: true });
      const row = await doseRow(due);
      expect(row).toMatchObject({ status: "taken", outcomeSource: "self_reported", outcomeRecordedBy: elderUserId });
      expect(row.outcomeRecordedAt).toBeInstanceOf(Date);
      const ev = await eventsOf(due);
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ type: "outcome", fromStatus: "scheduled", toStatus: "taken", source: "self_reported", actorUserId: elderUserId });
    });

    it("2. Scheduled → Not Taken only when explicitly reported", async () => {
      const res = await elderAgent.post(`/api/elder/doses/${encodeURIComponent(due)}/outcome`).set("origin", BASE_URL).send({ outcome: "not_taken" });
      expect(res.body.status).toBe("not_taken");
      expect((await doseRow(due)).outcomeOccurredAt).toBeNull();
    });

    it("6. duplicate confirmations (refresh / double tap) are idempotent", async () => {
      const path = `/api/elder/doses/${encodeURIComponent(due)}/outcome`;
      const first = await elderAgent.post(path).set("origin", BASE_URL).send({ outcome: "taken" });
      const second = await elderAgent.post(path).set("origin", BASE_URL).send({ outcome: "taken" });
      expect(first.body.changed).toBe(true);
      expect(second.status).toBe(200);
      expect(second.body.changed).toBe(false);
      expect(await eventsOf(due)).toHaveLength(1);
      const conflicting = await elderAgent.post(path).set("origin", BASE_URL).send({ outcome: "not_taken" });
      expect(conflicting.status).toBe(409);
      expect(conflicting.body.error.code).toBe("OUTCOME_ALREADY_RECORDED");
    });

    it("12. remind me later: 15 minutes, twice, scheduled time unchanged", async () => {
      const before = await doseRow(due);
      const path = `/api/elder/doses/${encodeURIComponent(due)}/snooze`;
      const a = await elderAgent.post(path).set("origin", BASE_URL).send({});
      expect(a.status).toBe(200);
      expect(a.body).toMatchObject({ snoozeCount: 1, remaining: 1 });
      const until = new Date(a.body.snoozeUntil).getTime();
      expect(until - Date.now()).toBeGreaterThan(14 * 60_000);
      expect(until - Date.now()).toBeLessThanOrEqual(15 * 60_000);
      expect((await elderAgent.post(path).set("origin", BASE_URL).send({})).body.snoozeCount).toBe(2);
      const third = await elderAgent.post(path).set("origin", BASE_URL).send({});
      expect(third.status).toBe(409);
      expect(third.body.error.code).toBe("SNOOZE_LIMIT");
      const after = await doseRow(due);
      expect(after.scheduledAt).toEqual(before.scheduledAt);
      expect(after.status).toBe("scheduled");
    });

    it("12b. a future dose cannot be snoozed or confirmed yet", async () => {
      const later = await insertDose(180);
      expect((await elderAgent.post(`/api/elder/doses/${encodeURIComponent(later)}/snooze`).set("origin", BASE_URL).send({})).body.error.code).toBe("TOO_EARLY");
      expect(
        (await elderAgent.post(`/api/elder/doses/${encodeURIComponent(later)}/outcome`).set("origin", BASE_URL).send({ outcome: "taken" })).body.error.code,
      ).toBe("TOO_EARLY");
    });

    it("13. help requests persist and report honestly that no one was notified yet", async () => {
      const res = await elderAgent.post("/api/elder/help").set("origin", BASE_URL).send({ doseId: due, note: "I feel dizzy" });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ status: "open", notified: false });
      const [row] = await ctx.handle.db.select().from(helpRequests).where(eq(helpRequests.id, res.body.id));
      expect(row).toMatchObject({ profileId, doseId: due, requestedBy: elderUserId, note: "I feel dizzy", status: "open" });

      const view = await admin.agent.get(`/api/profiles/${profileId}/adherence`);
      expect(view.body.openHelpRequests.map((h: { id: string }) => h.id)).toContain(res.body.id);
    });

    it("validates outcome input", async () => {
      const res = await elderAgent.post(`/api/elder/doses/${encodeURIComponent(due)}/outcome`).set("origin", BASE_URL).send({ outcome: "maybe" });
      expect(res.status).toBe(400);
    });
  });

  describe("system transition and late confirmation", () => {
    it("3. Scheduled → Unconfirmed after the grace period, idempotently, by the system only", async () => {
      const overdue = await insertDose(-61);
      const fresh = await insertDose(-30);
      const first = await markOverdueUnconfirmed(ctx.handle.db, new Date(), profileId);
      expect(first).toContain(overdue);
      expect(first).not.toContain(fresh);
      expect(await markOverdueUnconfirmed(ctx.handle.db, new Date(), profileId)).not.toContain(overdue); // idempotent
      expect((await doseRow(overdue)).status).toBe("unconfirmed");
      expect((await doseRow(fresh)).status).toBe("scheduled");
      const ev = await eventsOf(overdue);
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ type: "unconfirmed", source: "system", actorUserId: null });
    });

    it("4. Unconfirmed → Taken by the care team, keeping claimed vs reported time", async () => {
      const id = await insertDose(-120);
      await markOverdueUnconfirmed(ctx.handle.db, new Date(), profileId);
      const claimed = DateTime.now().minus({ minutes: 110 }).toUTC().toISO();
      const res = await admin.agent
        .post(`/api/profiles/${profileId}/doses/${encodeURIComponent(id)}/outcome`)
        .send({ outcome: "taken", source: "observed", note: "Saw the empty blister", occurredAt: claimed });
      expect(res.status).toBe(200);
      const row = await doseRow(id);
      expect(row).toMatchObject({ status: "taken", outcomeSource: "observed", outcomeRecordedBy: admin.userId });
      expect(row.outcomeOccurredAt!.toISOString()).toBe(new Date(claimed!).toISOString());
      expect(row.outcomeRecordedAt!.getTime()).toBeGreaterThan(row.outcomeOccurredAt!.getTime());
      expect((await eventsOf(id)).map((e) => `${e.fromStatus}→${e.toStatus}`)).toEqual(["scheduled→unconfirmed", "unconfirmed→taken"]);
    });

    it("5. Unconfirmed → Not Taken (late explicit report)", async () => {
      const id = await insertDose(-120);
      await markOverdueUnconfirmed(ctx.handle.db, new Date(), profileId);
      const res = await elderAgent.post(`/api/elder/doses/${encodeURIComponent(id)}/outcome`).set("origin", BASE_URL).send({ outcome: "not_taken" });
      expect(res.body.status).toBe("not_taken");
    });

    it("8. a late confirmation racing the unconfirmed sweep ends Taken, never Not Taken", async () => {
      const id = await insertDose(-90);
      await Promise.all([
        markOverdueUnconfirmed(ctx.handle.db, new Date(), profileId),
        applyDoseAction(ctx.handle.db, profileId, id, { type: "record", outcome: "taken", source: "self_reported" }, { userId: elderUserId, role: "elder" }),
      ]);
      expect((await doseRow(id)).status).toBe("taken");
      const transitions = (await eventsOf(id)).map((e) => e.toStatus);
      expect(transitions.at(-1)).toBe("taken");
      expect(transitions).not.toContain("not_taken");
    });

    it("users cannot perform the system transition", async () => {
      const id = await insertDose(-90);
      await expect(
        applyDoseAction(ctx.handle.db, profileId, id, { type: "mark_unconfirmed" }, { userId: admin.userId, role: "admin" }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(applyDoseAction(ctx.handle.db, profileId, id, { type: "void", reason: "x" }, { userId: admin.userId, role: "admin" })).rejects.toMatchObject({
        status: 403,
      });
      expect((await applyDoseAction(ctx.handle.db, profileId, id, { type: "mark_unconfirmed" }, SYSTEM_ACTOR)).changed).toBe(true);
    });
  });

  describe("concurrency", () => {
    it("7. two actors recording different outcomes at once: exactly one wins, the other gets 409", async () => {
      const id = await insertDose(-5);
      const results = await Promise.allSettled([
        applyDoseAction(ctx.handle.db, profileId, id, { type: "record", outcome: "taken", source: "self_reported" }, { userId: elderUserId, role: "elder" }),
        applyDoseAction(ctx.handle.db, profileId, id, { type: "record", outcome: "not_taken", source: "observed" }, { userId: admin.userId, role: "admin" }),
      ]);
      const ok = results.filter((r) => r.status === "fulfilled");
      const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      expect(ok).toHaveLength(1);
      expect(failed).toHaveLength(1);
      expect(failed[0]!.reason).toMatchObject({ status: 409 });
      const outcomes = (await eventsOf(id)).filter((e) => e.type === "outcome");
      expect(outcomes).toHaveLength(1);
      expect((await doseRow(id)).version).toBe(1);
    });

    it("many identical concurrent confirmations produce one event", async () => {
      const id = await insertDose(-5);
      await Promise.all(
        Array.from({ length: 5 }, () =>
          applyDoseAction(ctx.handle.db, profileId, id, { type: "record", outcome: "taken", source: "self_reported" }, { userId: elderUserId, role: "elder" }),
        ),
      );
      expect(await eventsOf(id)).toHaveLength(1);
    });
  });

  describe("corrections", () => {
    it("9. admin correction appends a linked event and preserves the original", async () => {
      const id = await insertDose(-5);
      await elderAgent.post(`/api/elder/doses/${encodeURIComponent(id)}/outcome`).set("origin", BASE_URL).send({ outcome: "taken" });
      const noReason = await admin.agent.post(`/api/profiles/${profileId}/doses/${encodeURIComponent(id)}/correct`).send({ outcome: "not_taken" });
      expect(noReason.status).toBe(400);

      const res = await admin.agent
        .post(`/api/profiles/${profileId}/doses/${encodeURIComponent(id)}/correct`)
        .send({ outcome: "not_taken", note: "Tablet found in the organiser", source: "observed" });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("not_taken");

      const ev = await eventsOf(id);
      expect(ev.map((e) => e.type)).toEqual(["outcome", "correction"]);
      expect(ev[1]).toMatchObject({ fromStatus: "taken", toStatus: "not_taken", correctionOf: ev[0]!.id, actorUserId: admin.userId, source: "observed" });
      expect(ev[0]).toMatchObject({ toStatus: "taken", actorUserId: elderUserId }); // original kept

      const history = await admin.agent.get(`/api/profiles/${profileId}/doses/${encodeURIComponent(id)}/events`);
      expect(history.body.map((e: { type: string }) => e.type)).toEqual(["outcome", "correction"]);
      expect(history.body[0].actor).toBe("Swastik");
    });

    it("the elder may correct their own entry; outcomes cannot be corrected on unrecorded doses", async () => {
      const id = await insertDose(-5);
      await elderAgent.post(`/api/elder/doses/${encodeURIComponent(id)}/outcome`).set("origin", BASE_URL).send({ outcome: "not_taken" });
      const res = await elderAgent.post(`/api/elder/doses/${encodeURIComponent(id)}/correct`).set("origin", BASE_URL).send({ outcome: "taken", note: "I did take it after all" });
      expect(res.body.status).toBe("taken");
      const blank = await insertDose(-5);
      const bad = await admin.agent.post(`/api/profiles/${profileId}/doses/${encodeURIComponent(blank)}/correct`).send({ outcome: "taken", note: "fix" });
      expect(bad.status).toBe(409);
    });
  });

  describe("authorization", () => {
    it("10. unauthenticated and non-member outcome changes are refused", async () => {
      const id = await insertDose(-5);
      expect((await request(ctx.app).post(`/api/elder/doses/${encodeURIComponent(id)}/outcome`).send({ outcome: "taken" })).status).toBe(401);
      expect(
        (await otherAdmin.agent.post(`/api/profiles/${profileId}/doses/${encodeURIComponent(id)}/outcome`).send({ outcome: "taken", source: "observed" })).status,
      ).toBe(403);
      // Another family's dose through your own profile path: 404 with no detail leaked.
      const leak = await admin.agent.post(`/api/profiles/${profileId}/doses/${encodeURIComponent(otherDoseId)}/outcome`).send({ outcome: "taken", source: "observed" });
      expect(leak.status).toBe(404);
      expect(JSON.stringify(leak.body)).not.toContain("Secret Other Med");
      expect((await doseRow(id)).status).toBe("scheduled");
    });

    it("11. the elder device acts only on its own profile and cannot use care-team routes", async () => {
      const res = await elderAgent.post(`/api/elder/doses/${encodeURIComponent(otherDoseId)}/outcome`).set("origin", BASE_URL).send({ outcome: "taken" });
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain("Secret Other Med");
      expect((await doseRow(otherDoseId)).status).toBe("scheduled");
      const id = await insertDose(-5);
      expect(
        (await elderAgent.post(`/api/profiles/${profileId}/doses/${encodeURIComponent(id)}/outcome`).set("origin", BASE_URL).send({ outcome: "taken", source: "observed" }))
          .status,
      ).toBe(403);
      expect((await elderAgent.get(`/api/profiles/${profileId}/adherence`)).status).toBe(403);
      expect((await elderAgent.post("/api/elder/help").set("origin", BASE_URL).send({ doseId: otherDoseId })).status).toBe(404);
    });

    it("family accounts cannot use elder routes", async () => {
      expect((await admin.agent.get("/api/elder/today")).status).toBe(403);
    });
  });

  describe("schedule edits", () => {
    it("14. editing a medication never deletes or alters recorded or snoozed doses", async () => {
      const recorded = await insertDose(-5);
      await elderAgent.post(`/api/elder/doses/${encodeURIComponent(recorded)}/outcome`).set("origin", BASE_URL).send({ outcome: "taken" });
      const snoozed = await insertDose(30); // within the 60-min early window → snoozable, and in the future
      await elderAgent.post(`/api/elder/doses/${encodeURIComponent(snoozed)}/snooze`).set("origin", BASE_URL).send({});
      const untouched = await insertDose(240);

      const edit = await admin.agent
        .put(`/api/profiles/${profileId}/medications/${medId}`)
        .send({ name: "Demo Tablet", strength: "20 mg", times: ["04:00"], startDate: DateTime.now().setZone(ZONE).toISODate() });
      expect(edit.status).toBe(200);

      expect(await doseRow(recorded)).toMatchObject({ status: "taken", label: "Demo Tablet (10 mg)" });
      const s = await doseRow(snoozed);
      expect(s.status).toBe("void"); // not in the new plan → voided with an audit event, not deleted
      expect((await eventsOf(snoozed)).map((e) => e.type)).toEqual(["snooze", "void"]);
      expect(await ctx.handle.db.select().from(doses).where(eq(doses.id, untouched))).toHaveLength(0); // no history → replaced
    });
  });

  describe("schedule edits (still-planned dose with history)", () => {
    it("keeps a snoozed future dose that is still planned, updating only its label", async () => {
      const soon = DateTime.now().setZone(ZONE).plus({ minutes: 30 });
      if (soon.toISODate() !== DateTime.now().setZone(ZONE).toISODate()) return; // skip within 30 min of local midnight
      const hhmm = soon.toFormat("HH:mm");
      const med = await admin.agent
        .post(`/api/profiles/${profileId}/medications`)
        .send({ name: "Kept Tablet", strength: "1 mg", times: [hhmm], startDate: soon.toISODate() });
      const id = doseId("medication", med.body.id, soon.toISODate()!, hhmm);
      expect((await doseRow(id)).status).toBe("scheduled");
      expect((await elderAgent.post(`/api/elder/doses/${encodeURIComponent(id)}/snooze`).set("origin", BASE_URL).send({})).status).toBe(200);

      await admin.agent
        .put(`/api/profiles/${profileId}/medications/${med.body.id}`)
        .send({ name: "Kept Tablet", strength: "2 mg", times: [hhmm], startDate: soon.toISODate() });
      const row = await doseRow(id);
      expect(row).toMatchObject({ status: "scheduled", label: "Kept Tablet (2 mg)", snoozeCount: 1 });
      expect((await eventsOf(id)).map((e) => e.type)).toEqual(["snooze"]);
    });
  });

  describe("summaries and time zones", () => {
    it("15. today's summary keeps Not Taken and Unconfirmed separate and excludes Void", async () => {
      const res = await admin.agent.get(`/api/profiles/${profileId}/adherence`);
      expect(res.status).toBe(200);
      const today = res.body.doses.filter((d: { kind: string }) => d.kind === "medication");
      const count = (s: string) => today.filter((d: { status: string }) => d.status === s).length;
      expect(res.body.counts).toEqual({
        total: today.length,
        taken: count("taken"),
        notTaken: count("not_taken"),
        unconfirmed: count("unconfirmed"),
        pending: count("scheduled"),
      });
      expect(res.body.counts.unconfirmed).toBeGreaterThan(0);
      expect(res.body.counts.notTaken).toBeGreaterThan(0);
      expect(today.some((d: { status: string }) => d.status === "void")).toBe(false);
      expect(res.body.recentActivity.length).toBeGreaterThan(0);
      const sample = res.body.doses.find((d: { outcome: unknown }) => d.outcome);
      expect(sample.outcome).toHaveProperty("source");
      expect(sample.outcome).toHaveProperty("recordedBy");
    });

    it("16. 'today' follows the profile's time zone, not the server's", async () => {
      const kiri = await otherAdmin.agent.post("/api/profiles").send({ ...syntheticProfile, timezone: "Pacific/Kiritimati" });
      const res = await otherAdmin.agent.get(`/api/profiles/${kiri.body.id}/adherence`);
      expect(res.body.date).toBe(DateTime.now().setZone("Pacific/Kiritimati").toISODate());
      expect(res.body.timezone).toBe("Pacific/Kiritimati");

      const elderView = await elderAgent.get("/api/elder/today");
      expect(elderView.status).toBe(200);
      expect(elderView.body.date).toBe(DateTime.now().setZone(ZONE).toISODate());
      expect(elderView.body.preferredName).toBe("Swastik");
      for (const d of elderView.body.doses) expect(d.localDate).toBe(elderView.body.date);
    });

    it("elder view exposes only allowed actions per state", async () => {
      const due = await insertDose(-5);
      const view = await elderAgent.get("/api/elder/today");
      const d = view.body.doses.find((x: { id: string }) => x.id === due);
      if (d) {
        // (Only present if the inserted dose falls on today's local date.)
        expect(d).toMatchObject({ phase: "due", canRecord: true, canSnooze: true });
      }
      const recorded = view.body.doses.find((x: { status: string }) => x.status === "taken");
      if (recorded) expect(recorded).toMatchObject({ canRecord: false, canSnooze: false });
      expect(await ctx.handle.db.select().from(doses).where(and(eq(doses.profileId, profileId), eq(doses.status, "void")))).not.toHaveLength(0);
    });
  });
});
