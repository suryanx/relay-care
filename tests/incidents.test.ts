import { and, asc, eq, ne } from "drizzle-orm";
import { DateTime } from "luxon";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { doseEvents, doses, helpRequests, incidentEvents, incidents, notifications } from "../src/server/db/schema.js";
import { applyDoseAction, markOverdueUnconfirmed } from "../src/server/services/adherence.js";
import { claimIncident, syncIncidents } from "../src/server/services/incidents.js";
import { previewConfig, processQueue, queueDueNotifications, runSweep } from "../src/server/services/notifications.js";
import { BASE_URL, makeTestApp, signUpAgent, syntheticProfile, uniqueEmail, type TestContext } from "./helpers.js";

const ZONE = syntheticProfile.timezone;

describe("follow-up incidents", () => {
  let ctx: TestContext;
  let admin: Awaited<ReturnType<typeof signUpAgent>>;
  let careA: Awaited<ReturnType<typeof signUpAgent>>;
  let careB: Awaited<ReturnType<typeof signUpAgent>>;
  let outsider: Awaited<ReturnType<typeof signUpAgent>>;
  let elderAgent: ReturnType<typeof request.agent>;
  let elderUserId: string;
  let profileId: string;
  let medId: string;
  let seq = 0;
  const db = () => ctx.handle.db;

  async function insertDose(minutes: number) {
    const at = DateTime.now().setZone(ZONE).plus({ minutes }).startOf("minute");
    const id = `medication:${medId}:${at.toISODate()}T${at.toFormat("HH:mm")}#i${++seq}`;
    await db().insert(doses).values({
      id,
      profileId,
      kind: "medication",
      medicationId: medId,
      label: "Demo Tablet (10 mg)",
      scheduledAt: at.toJSDate(),
      localDate: at.toISODate()!,
      localTime: at.toFormat("HH:mm"),
    });
    return id;
  }
  async function unconfirmedIncident() {
    const doseId = await insertDose(-61 - seq);
    await markOverdueUnconfirmed(db(), new Date(), profileId);
    await syncIncidents(db(), new Date(), profileId);
    const [inc] = await db().select().from(incidents).where(eq(incidents.sourceId, doseId));
    return { doseId, incidentId: inc!.id };
  }
  const incidentRow = async (id: string) => (await db().select().from(incidents).where(eq(incidents.id, id)))[0]!;
  const eventsOf = async (id: string) => (await db().select().from(incidentEvents).where(eq(incidentEvents.incidentId, id)).orderBy(asc(incidentEvents.recordedAt))).map((e) => e.type);
  const path = (incidentId: string, action = "") => `/api/profiles/${profileId}/incidents/${incidentId}${action}`;

  async function joinAsCaregiver(email: string) {
    const inv = await admin.agent.post(`/api/profiles/${profileId}/invitations`).send({ email });
    const agent = await signUpAgent(ctx.app, email);
    await agent.agent.post("/api/invitations/accept").send({ token: inv.body.inviteUrl.split("#")[1] });
    return agent;
  }

  beforeAll(async () => {
    ctx = await makeTestApp();
    admin = await signUpAgent(ctx.app);
    profileId = (await admin.agent.post("/api/profiles").send(syntheticProfile)).body.id;
    medId = (
      await admin.agent
        .post(`/api/profiles/${profileId}/medications`)
        .send({ name: "Demo Tablet", strength: "10 mg", times: ["03:00"], startDate: DateTime.now().setZone(ZONE).plus({ days: 5 }).toISODate() })
    ).body.id;
    await admin.agent.post(`/api/profiles/${profileId}/elder-account`).send({ username: "inc.elder", passcode: "sunrise garden 42" });
    elderAgent = request.agent(ctx.app);
    elderUserId = (await elderAgent.post("/api/auth/sign-in/username").set("origin", BASE_URL).send({ username: "inc.elder", password: "sunrise garden 42" })).body.user.id;
    careA = await joinAsCaregiver(uniqueEmail("careA"));
    careB = await joinAsCaregiver(uniqueEmail("careB"));
    outsider = await signUpAgent(ctx.app);
  });
  afterAll(() => ctx.handle.close());

  describe("creation", () => {
    it("11. an Unconfirmed dose creates an open incident with an explainable priority", async () => {
      const { incidentId } = await unconfirmedIncident();
      const row = await incidentRow(incidentId);
      expect(row).toMatchObject({ sourceType: "dose_unconfirmed", status: "open", priority: "normal" });
      expect(await eventsOf(incidentId)).toEqual(["created"]);
      const list = await careA.agent.get(`/api/profiles/${profileId}/incidents`);
      const view = list.body.incidents.find((i: { id: string }) => i.id === incidentId);
      expect(view).toMatchObject({ reason: "No one has confirmed a medicine yet", status: "open", claimedBy: null });
    });

    it("12. an explicit Not Taken creates its own incident", async () => {
      const doseId = await insertDose(-5);
      await elderAgent.post(`/api/elder/doses/${encodeURIComponent(doseId)}/outcome`).set("origin", BASE_URL).send({ outcome: "not_taken" });
      const [inc] = await db().select().from(incidents).where(eq(incidents.sourceId, doseId));
      expect(inc).toMatchObject({ sourceType: "dose_not_taken", status: "open" });
    });

    it("13. 'I need help' creates a high-priority incident immediately", async () => {
      const res = await elderAgent.post("/api/elder/help").set("origin", BASE_URL).send({ note: "Feeling unwell" });
      const [inc] = await db().select().from(incidents).where(eq(incidents.sourceId, res.body.id));
      expect(inc).toMatchObject({ sourceType: "help_request", priority: "high", status: "open" });
      const today = await elderAgent.get("/api/elder/today");
      expect(today.body.helpRequests[0]).toMatchObject({ id: res.body.id, status: "open", handledBy: null });
    });

    it("14. repeated and concurrent syncs never duplicate incidents", async () => {
      const before = (await db().select().from(incidents)).length;
      await Promise.all([1, 2, 3].map(() => syncIncidents(db(), new Date(), profileId)));
      await runSweep(db(), previewConfig(BASE_URL), { trigger: "scheduler", profileId });
      const rows = await db().select().from(incidents);
      expect(rows.length).toBe(before);
      expect(new Set(rows.map((r) => r.dedupeKey)).size).toBe(rows.length);
    });
  });

  describe("claiming", () => {
    it("15. two concurrent claims: exactly one winner, the other gets 409", async () => {
      const { incidentId } = await unconfirmedIncident();
      const [a, b] = await Promise.all([careA.agent.post(path(incidentId, "/claim")).send({}), careB.agent.post(path(incidentId, "/claim")).send({})]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 409]);
      const loser = a.status === 409 ? a : b;
      expect(loser.body.error.code).toBe("ALREADY_CLAIMED");
      const row = await incidentRow(incidentId);
      expect([careA.userId, careB.userId]).toContain(row.claimedBy);
      expect((await eventsOf(incidentId)).filter((t) => t === "claimed")).toHaveLength(1);
    });

    it("15b. the same race at the service level, many claimers", async () => {
      const { incidentId } = await unconfirmedIncident();
      const results = await Promise.allSettled(
        [careA, careB, admin].map((u) => claimIncident(db(), profileId, incidentId, { userId: u.userId, role: u === admin ? "admin" : "caregiver" })),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    });

    it("16. repeating your own claim is idempotent; others see who owns it", async () => {
      const { incidentId } = await unconfirmedIncident();
      expect((await careA.agent.post(path(incidentId, "/claim")).send({})).body).toEqual({ status: "claimed", changed: true });
      expect((await careA.agent.post(path(incidentId, "/claim")).send({})).body).toEqual({ status: "claimed", changed: false });
      expect(await eventsOf(incidentId)).toEqual(["created", "claimed"]);
      const viewB = (await careB.agent.get(`/api/profiles/${profileId}/incidents`)).body.incidents.find((i: { id: string }) => i.id === incidentId);
      expect(viewB).toMatchObject({ status: "claimed", claimedByMe: false, canResolve: false, claimedBy: { name: "Priya Test" } });
      const viewAdmin = (await admin.agent.get(`/api/profiles/${profileId}/incidents`)).body.incidents.find((i: { id: string }) => i.id === incidentId);
      expect(viewAdmin.claimedBy.id).toBe(careA.userId);
    });

    it("elders and outsiders cannot claim", async () => {
      const { incidentId } = await unconfirmedIncident();
      expect((await elderAgent.post(path(incidentId, "/claim")).set("origin", BASE_URL).send({})).status).toBe(403);
      expect((await outsider.agent.post(path(incidentId, "/claim")).send({})).status).toBe(403);
    });
  });

  describe("resolution", () => {
    it("17. another caregiver cannot resolve or release someone else's claim; an admin can intervene", async () => {
      const { incidentId } = await unconfirmedIncident();
      await careA.agent.post(path(incidentId, "/claim")).send({});
      const res = await careB.agent.post(path(incidentId, "/resolve")).send({ resolution: "unable_to_verify" });
      expect(res.status).toBe(403);
      expect((await careB.agent.post(path(incidentId, "/release")).send({})).status).toBe(403);
      // Admin intervention for an abandoned claim.
      expect((await admin.agent.post(path(incidentId, "/release")).send({ note: "Priya is unreachable" })).status).toBe(200);
      expect((await incidentRow(incidentId)).status).toBe("open");
      expect((await careB.agent.post(path(incidentId, "/claim")).send({})).status).toBe(200);
    });

    it("cannot resolve without claiming, or with an outcome that does not fit the source", async () => {
      const { incidentId } = await unconfirmedIncident();
      expect((await careA.agent.post(path(incidentId, "/resolve")).send({ resolution: "unable_to_verify" })).body.error.code).toBe("NOT_CLAIMED");
      await careA.agent.post(path(incidentId, "/claim")).send({});
      expect((await careA.agent.post(path(incidentId, "/resolve")).send({ resolution: "help_addressed" })).status).toBe(400);
      expect((await careA.agent.post(path(incidentId, "/resolve")).send({ resolution: "taken_confirmed" })).status).toBe(400); // must say how they know
    });

    it("18+21. resolving with 'taken' records the dose through the adherence engine, with provenance and full history", async () => {
      const { doseId, incidentId } = await unconfirmedIncident();
      await careA.agent.post(path(incidentId, "/claim")).send({});
      const res = await careA.agent.post(path(incidentId, "/resolve")).send({ resolution: "taken_confirmed", source: "reported_by_other", note: "Called Swastik, he took it at 9" });
      expect(res.body).toEqual({ status: "resolved", resolution: "taken_confirmed" });
      const [dose] = await db().select().from(doses).where(eq(doses.id, doseId));
      expect(dose).toMatchObject({ status: "taken", outcomeSource: "reported_by_other", outcomeRecordedBy: careA.userId });
      const doseHistory = await db().select().from(doseEvents).where(eq(doseEvents.doseId, doseId)).orderBy(asc(doseEvents.recordedAt));
      expect(doseHistory.map((e) => `${e.type}:${e.toStatus}`)).toEqual(["unconfirmed:unconfirmed", "outcome:taken"]);
      expect(await eventsOf(incidentId)).toEqual(["created", "claimed", "resolved"]);
      expect((await incidentRow(incidentId)).resolvedBy).toBe(careA.userId);
    });

    it("19. resolving with 'not taken' records it — and does not spawn a second follow-up", async () => {
      const { doseId, incidentId } = await unconfirmedIncident();
      await careB.agent.post(path(incidentId, "/claim")).send({});
      await careB.agent.post(path(incidentId, "/resolve")).send({ resolution: "not_taken_confirmed", source: "observed" });
      expect((await db().select().from(doses).where(eq(doses.id, doseId)))[0]!.status).toBe("not_taken");
      await syncIncidents(db(), new Date(), profileId);
      expect(await db().select().from(incidents).where(eq(incidents.sourceId, doseId))).toHaveLength(1);
    });

    it("20. 'unable to verify' closes the follow-up but never marks the dose taken", async () => {
      const { doseId, incidentId } = await unconfirmedIncident();
      await careA.agent.post(path(incidentId, "/claim")).send({});
      await careA.agent.post(path(incidentId, "/resolve")).send({ resolution: "unable_to_verify", note: "No answer by phone" });
      expect((await incidentRow(incidentId))).toMatchObject({ status: "resolved", resolution: "unable_to_verify" });
      expect((await db().select().from(doses).where(eq(doses.id, doseId)))[0]!.status).toBe("unconfirmed");
    });

    it("help requests: the elder sees 'being handled', then 'resolved'", async () => {
      const help = await elderAgent.post("/api/elder/help").set("origin", BASE_URL).send({});
      const [inc] = await db().select().from(incidents).where(eq(incidents.sourceId, help.body.id));
      await careA.agent.post(path(inc!.id, "/claim")).send({});
      let today = await elderAgent.get("/api/elder/today");
      expect(today.body.helpRequests.find((h: { id: string }) => h.id === help.body.id)).toMatchObject({ status: "acknowledged", handledBy: "Priya" });
      await careA.agent.post(path(inc!.id, "/resolve")).send({ resolution: "help_addressed", note: "Visited, all fine" });
      today = await elderAgent.get("/api/elder/today");
      expect(today.body.helpRequests.find((h: { id: string }) => h.id === help.body.id).status).toBe("resolved");
    });
  });

  describe("reconciliation and notifications", () => {
    it("22. a late confirmation closes the follow-up as reconciled, preserving history", async () => {
      const { doseId, incidentId } = await unconfirmedIncident();
      await careA.agent.post(path(incidentId, "/claim")).send({});
      await elderAgent.post(`/api/elder/doses/${encodeURIComponent(doseId)}/outcome`).set("origin", BASE_URL).send({ outcome: "taken" });
      expect(await incidentRow(incidentId)).toMatchObject({ status: "resolved", resolution: "reconciled" });
      expect(await eventsOf(incidentId)).toEqual(["created", "claimed", "reconciled"]);
    });

    it("a Not Taken later corrected to Taken cancels that follow-up", async () => {
      const doseId = await insertDose(-5);
      await applyDoseAction(db(), profileId, doseId, { type: "record", outcome: "not_taken", source: "self_reported" }, { userId: elderUserId, role: "elder" });
      await syncIncidents(db(), new Date(), profileId);
      await applyDoseAction(db(), profileId, doseId, { type: "correct", outcome: "taken", source: "self_reported", note: "Found I took it" }, { userId: elderUserId, role: "elder" });
      await syncIncidents(db(), new Date(), profileId);
      const [inc] = await db().select().from(incidents).where(eq(incidents.sourceId, doseId));
      expect(inc!.status).toBe("cancelled");
    });

    it("23. claiming a follow-up cancels its unsent alert emails; caregivers are alert recipients", async () => {
      await db().delete(notifications);
      const { doseId, incidentId } = await unconfirmedIncident();
      await queueDueNotifications(db(), new Date(), profileId);
      // Keep only this dose's alerts so per-sweep limits don't hide the result behind earlier tests' rows.
      await db().delete(notifications).where(ne(notifications.doseId, doseId));
      const queued = await db().select().from(notifications).where(and(eq(notifications.doseId, doseId), eq(notifications.type, "dose_unconfirmed")));
      expect(new Set(queued.map((n) => n.recipientUserId))).toEqual(new Set([admin.userId, careA.userId, careB.userId]));
      await careA.agent.post(path(incidentId, "/claim")).send({});
      await processQueue(db(), previewConfig(BASE_URL), new Date(), profileId);
      const after = await db().select().from(notifications).where(eq(notifications.doseId, doseId));
      expect(after.length).toBe(3);
      expect(after.every((n) => n.status === "cancelled" && n.cancelReason === "incident_claimed")).toBe(true);
    });

    it("removed caregivers are no longer emailed and their claims return to the queue", async () => {
      const careC = await joinAsCaregiver(uniqueEmail("careC"));
      const { doseId, incidentId } = await unconfirmedIncident();
      await careC.agent.post(path(incidentId, "/claim")).send({});
      await admin.agent.post(`/api/profiles/${profileId}/members/${careC.userId}/remove`).send({});
      expect(await incidentRow(incidentId)).toMatchObject({ status: "open", claimedBy: null });
      expect(await eventsOf(incidentId)).toEqual(["created", "claimed", "released"]);
      expect((await careC.agent.post(path(incidentId, "/claim")).send({})).status).toBe(403);
      await queueDueNotifications(db(), new Date(), profileId);
      const toC = await db().select().from(notifications).where(and(eq(notifications.doseId, doseId), eq(notifications.recipientUserId, careC.userId)));
      expect(toC).toHaveLength(0);
    });

    it("24. none of this contacts Brevo", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      await unconfirmedIncident();
      await runSweep(db(), previewConfig(BASE_URL), { trigger: "scheduler", profileId });
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it("help request rows remain (status changes only) — audit preserved", async () => {
      const rows = await db().select().from(helpRequests).where(eq(helpRequests.profileId, profileId));
      expect(rows.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("follow-up summary lists only the caller's profiles", async () => {
    const summary = await careA.agent.get("/api/follow-ups/summary");
    expect(summary.body.map((s: { profileId: string }) => s.profileId)).toEqual([profileId]);
    expect((await outsider.agent.get("/api/follow-ups/summary")).body).toEqual([]);
  });
});

describe("follow-up ordering", () => {
  it("lists active before closed and high priority first", async () => {
    const ctx = await makeTestApp();
    const admin = await signUpAgent(ctx.app);
    const profileId = (await admin.agent.post("/api/profiles").send(syntheticProfile)).body.id;
    await admin.agent.post(`/api/profiles/${profileId}/elder-account`).send({ username: "order.elder", passcode: "sunrise garden 42" });
    const elder = request.agent(ctx.app);
    await elder.post("/api/auth/sign-in/username").set("origin", BASE_URL).send({ username: "order.elder", password: "sunrise garden 42" });
    const med = (await admin.agent.post(`/api/profiles/${profileId}/medications`).send({ name: "M", times: ["03:00"], startDate: "2030-01-01" })).body.id;
    await elder.post("/api/elder/help").set("origin", BASE_URL).send({});
    const at = DateTime.now().setZone(ZONE).minus({ minutes: 5 }).startOf("minute");
    await ctx.handle.db.insert(doses).values({ id: `o1`, profileId, kind: "medication", medicationId: med, label: "M", scheduledAt: at.toJSDate(), localDate: at.toISODate()!, localTime: at.toFormat("HH:mm") });
    await elder.post(`/api/elder/doses/o1/outcome`).set("origin", BASE_URL).send({ outcome: "not_taken" }); // newer, normal priority
    const list = (await admin.agent.get(`/api/profiles/${profileId}/incidents`)).body.incidents;
    expect(list.map((i: { priority: string }) => i.priority)).toEqual(["high", "normal"]);
    await ctx.handle.close();
  });
});
