import { and, eq } from "drizzle-orm";
import { DateTime } from "luxon";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { appointments, doses, notifications, profileMembers } from "../src/server/db/schema.js";
import { resolveRealSending, selectEmailProvider } from "../src/server/email/index.js";
import { EmailSendError, type EmailMessage, type EmailProvider, type SendResult } from "../src/server/email/types.js";
import { applyDoseAction, snoozeUntilFor } from "../src/server/services/adherence.js";
import {
  backoffMinutes,
  claimDue,
  maskEmail,
  previewConfig,
  processQueue,
  queueDueNotifications,
  runSweep,
  sanitizeError,
  type NotifierConfig,
} from "../src/server/services/notifications.js";
import { BASE_URL, makeTestApp, signUpAgent, syntheticProfile, type TestContext } from "./helpers.js";

const ZONE = syntheticProfile.timezone; // Asia/Kolkata
const MIN = 60_000;
const SECRET = "test-sweep-secret-test-sweep-secret-0123456789";

/** Pretends to be Brevo without any network access. */
class FakeBrevo implements EmailProvider {
  readonly name = "brevo" as const;
  sent: EmailMessage[] = [];
  mode: "ok" | "http500" | "http400" | "timeout" = "ok";
  async send(m: EmailMessage): Promise<SendResult> {
    if (this.mode === "http500") throw new EmailSendError("Brevo rejected the request (HTTP 500): oops", 500);
    if (this.mode === "http400") throw new EmailSendError("Brevo rejected the request (HTTP 400): bad sender xkeysib-abc123", 400);
    if (this.mode === "timeout") throw new Error("The operation was aborted due to timeout");
    this.sent.push(m);
    return { provider: "brevo", accepted: true, externalRequest: true, providerMessageId: `<msg-${this.sent.length}@fake>` };
  }
}

const realCfg = (provider: EmailProvider, over: Partial<NotifierConfig> = {}): NotifierConfig => ({
  ...previewConfig(BASE_URL),
  provider,
  realSendEnabled: true,
  realSendCap: 20,
  ...over,
});

describe("notifications", () => {
  let ctx: TestContext;
  let admin: Awaited<ReturnType<typeof signUpAgent>>;
  let profileId: string;
  let medId: string;
  let elderAgent: ReturnType<typeof request.agent>;
  let elderUserId: string;
  let other: Awaited<ReturnType<typeof signUpAgent>>;
  let otherProfileId: string;
  let seq = 0;

  const db = () => ctx.handle.db;
  const notifs = (where = eq(notifications.profileId, profileId)) => db().select().from(notifications).where(where);

  /** A synthetic medication dose at `minutes` from `base` (unique id per call). */
  async function insertDose(minutes: number, base = new Date(), pId = profileId, mId = medId) {
    const at = DateTime.fromJSDate(base).setZone(ZONE).plus({ minutes }).startOf("minute");
    const id = `medication:${mId}:${at.toISODate()}T${at.toFormat("HH:mm")}#n${++seq}`;
    await db().insert(doses).values({
      id,
      profileId: pId,
      kind: "medication",
      medicationId: mId,
      label: "Demo Tablet (10 mg)",
      scheduledAt: at.toJSDate(),
      localDate: at.toISODate()!,
      localTime: at.toFormat("HH:mm"),
    });
    return id;
  }

  /** Clears queue state so each test reasons about its own rows. */
  async function resetOutbox() {
    await db().delete(notifications);
    await db().delete(doses).where(eq(doses.profileId, profileId));
    await db().delete(appointments);
  }

  beforeAll(async () => {
    ctx = await makeTestApp(undefined, { sweepSecret: SECRET });
    admin = await signUpAgent(ctx.app);
    profileId = (await admin.agent.post("/api/profiles").send(syntheticProfile)).body.id;
    // Medicine starts tomorrow so routine generation does not add doses during these tests.
    medId = (
      await admin.agent.post(`/api/profiles/${profileId}/medications`).send({
        name: "Demo Tablet",
        strength: "10 mg",
        times: ["03:00"],
        startDate: DateTime.now().setZone(ZONE).plus({ days: 5 }).toISODate(),
        reminderLeadMinutes: 15,
      })
    ).body.id;
    await admin.agent.post(`/api/profiles/${profileId}/elder-account`).send({ username: "notif.elder", passcode: "sunrise garden 42" });
    elderAgent = request.agent(ctx.app);
    elderUserId = (await elderAgent.post("/api/auth/sign-in/username").set("origin", BASE_URL).send({ username: "notif.elder", password: "sunrise garden 42" })).body
      .user.id;
    other = await signUpAgent(ctx.app);
    otherProfileId = (await other.agent.post("/api/profiles").send({ ...syntheticProfile, preferredName: "Other" })).body.id;
  });
  afterAll(() => ctx.handle.close());
  afterEach(() => vi.restoreAllMocks());

  describe("medication reminders", () => {
    it("1+3. queues an upcoming-dose reminder for the admin only, in the profile's local time", async () => {
      await resetOutbox();
      const now = new Date();
      const id = await insertDose(10, now); // lead 15 → reminder due now
      const s = await runSweep(db(), previewConfig(BASE_URL), { trigger: "scheduler", now, profileId });
      expect(s.status).toBe("completed");
      const rows = await notifs();
      expect(rows).toHaveLength(1);
      const [n] = rows;
      expect(n).toMatchObject({ type: "dose_reminder", doseId: id, recipientUserId: admin.userId, status: "previewed", provider: "console" });
      const localTime = DateTime.fromJSDate(now).setZone(ZONE).plus({ minutes: 10 }).toFormat("HH:mm");
      expect(n!.subject).toBe(`Medicine reminder: Swastik at ${localTime}`);
      expect(n!.preview).not.toContain("Demo Tablet"); // no medicine names in email content
      expect(rows.some((r) => r.recipientUserId === elderUserId)).toBe(false); // elder never emailed
    });

    it("2. respects the reminder lead time", async () => {
      await resetOutbox();
      const now = new Date();
      await insertDose(30, now);
      expect(await queueDueNotifications(db(), now, profileId)).toBe(0); // 30 min away, lead 15
      expect(await queueDueNotifications(db(), new Date(now.getTime() + 16 * MIN), profileId)).toBe(1);
    });

    it("never reminds for void, taken or not-taken doses", async () => {
      await resetOutbox();
      const now = new Date();
      const a = await insertDose(5, now);
      const b = await insertDose(6, now);
      const c = await insertDose(7, now);
      await db().update(doses).set({ status: "void" }).where(eq(doses.id, a));
      await applyDoseAction(db(), profileId, b, { type: "record", outcome: "taken", source: "self_reported" }, { userId: elderUserId, role: "elder" });
      await applyDoseAction(db(), profileId, c, { type: "record", outcome: "taken", source: "self_reported" }, { userId: elderUserId, role: "elder" });
      await queueDueNotifications(db(), now, profileId);
      expect((await notifs()).filter((n) => n.type === "dose_reminder")).toHaveLength(0);
    });

    it("8. a reminder queued before a medicine is stopped is cancelled, never sent", async () => {
      await resetOutbox();
      const now = new Date();
      const med = (
        await admin.agent.post(`/api/profiles/${profileId}/medications`).send({
          name: "Stopping Soon",
          times: [DateTime.fromJSDate(now).setZone(ZONE).plus({ minutes: 10 }).toFormat("HH:mm")],
          startDate: DateTime.now().setZone(ZONE).toISODate(),
        })
      ).body;
      await queueDueNotifications(db(), new Date(), profileId);
      const queued = (await notifs()).filter((n) => n.type === "dose_reminder");
      if (queued.length === 0) return; // only when +10 min crosses local midnight
      await admin.agent.post(`/api/profiles/${profileId}/medications/${med.id}/deactivate`).send({});
      const fake = new FakeBrevo();
      await processQueue(db(), realCfg(fake), new Date(), profileId);
      expect(fake.sent).toHaveLength(0);
      expect((await notifs()).find((n) => n.id === queued[0]!.id)).toMatchObject({ status: "cancelled", cancelReason: "dose_removed" });
    });
  });

  describe("unconfirmed and not-taken alerts", () => {
    it("4. marks an overdue dose Unconfirmed and alerts the admin without calling it missed", async () => {
      await resetOutbox();
      const now = new Date();
      const id = await insertDose(-61, now);
      const s = await runSweep(db(), previewConfig(BASE_URL), { trigger: "scheduler", now, profileId });
      expect(s.markedUnconfirmed).toBe(1);
      expect((await db().select().from(doses).where(eq(doses.id, id)))[0]!.status).toBe("unconfirmed");
      const alert = (await notifs()).find((n) => n.type === "dose_unconfirmed");
      expect(alert).toMatchObject({ status: "previewed", recipientUserId: admin.userId });
      expect(alert!.subject.startsWith("Unconfirmed:")).toBe(true);
      expect(alert!.preview).toContain("Unconfirmed does not mean missed");
    });

    it("5. sends a separate Not Taken alert, once, labelled as reported", async () => {
      await resetOutbox();
      const now = new Date();
      const id = await insertDose(-5, now);
      await applyDoseAction(db(), profileId, id, { type: "record", outcome: "not_taken", source: "self_reported" }, { userId: elderUserId, role: "elder" });
      await runSweep(db(), previewConfig(BASE_URL), { trigger: "scheduler", now, profileId });
      await runSweep(db(), previewConfig(BASE_URL), { trigger: "scheduler", now: new Date(now.getTime() + MIN), profileId });
      const alerts = (await notifs()).filter((n) => n.type === "dose_not_taken");
      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.preview).toContain("This was reported, not assumed");
      expect(alerts[0]!.preview).toContain("Swastik reported");
    });

    it("cancels an unsent alert that a correction made obsolete", async () => {
      await resetOutbox();
      const now = new Date();
      const id = await insertDose(-5, now);
      await applyDoseAction(db(), profileId, id, { type: "record", outcome: "not_taken", source: "self_reported" }, { userId: elderUserId, role: "elder" });
      await queueDueNotifications(db(), now, profileId);
      await applyDoseAction(db(), profileId, id, { type: "correct", outcome: "taken", source: "self_reported", note: "Took it" }, { userId: elderUserId, role: "elder" });
      const fake = new FakeBrevo();
      await processQueue(db(), realCfg(fake), now, profileId);
      expect(fake.sent).toHaveLength(0);
      expect((await notifs()).find((n) => n.type === "dose_not_taken")).toMatchObject({ status: "cancelled", cancelReason: "corrected_to_taken" });
    });

    it("a late confirmation suppresses a queued Unconfirmed alert", async () => {
      await resetOutbox();
      const now = new Date();
      const id = await insertDose(-90, now);
      await runSweep(db(), { ...previewConfig(BASE_URL), maxPerSweep: 1 }, { trigger: "scheduler", now, profileId }); // marks + previews 1
      await db().update(notifications).set({ status: "queued", nextAttemptAt: now }).where(eq(notifications.type, "dose_unconfirmed")); // pretend unsent
      await applyDoseAction(db(), profileId, id, { type: "record", outcome: "taken", source: "observed" }, { userId: admin.userId, role: "admin" });
      await processQueue(db(), previewConfig(BASE_URL), now, profileId);
      expect((await notifs()).find((n) => n.type === "dose_unconfirmed")).toMatchObject({ status: "cancelled", cancelReason: "now_taken" });
    });
  });

  describe("appointment reminders", () => {
    async function addAppt(hoursAhead: number) {
      const at = DateTime.now().setZone(ZONE).plus({ hours: hoursAhead }).startOf("minute");
      return (
        await admin.agent.post(`/api/profiles/${profileId}/appointments`).send({ doctorName: "Dr. Demo", date: at.toISODate(), time: at.toFormat("HH:mm"), reminderHoursBefore: 24 })
      ).body;
    }

    it("6. queues a reminder 24 h before, in local time, and not earlier", async () => {
      await resetOutbox();
      const soon = await addAppt(23);
      await addAppt(30);
      await runSweep(db(), previewConfig(BASE_URL), { trigger: "scheduler", profileId });
      const rows = (await notifs()).filter((n) => n.type === "appointment_reminder");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.appointmentId).toBe(soon.id);
      const local = DateTime.fromISO(soon.startsAt).setZone(ZONE);
      expect(rows[0]!.subject).toBe(`Appointment reminder: Swastik, ${local.toFormat("ccc d LLL")} at ${local.toFormat("HH:mm")}`);
      expect(rows[0]!.preview).not.toContain("Dr. Demo"); // details stay in the app
    });

    it("7. cancelled or rescheduled appointments never send the obsolete reminder", async () => {
      await resetOutbox();
      const a = await addAppt(20);
      const b = await addAppt(21);
      await queueDueNotifications(db(), new Date(), profileId);
      await admin.agent.post(`/api/profiles/${profileId}/appointments/${a.id}/cancel`).send({});
      const moved = DateTime.now().setZone(ZONE).plus({ hours: 22 }).startOf("minute");
      await admin.agent.put(`/api/profiles/${profileId}/appointments/${b.id}`).send({ doctorName: "Dr. Demo", date: moved.toISODate(), time: moved.toFormat("HH:mm"), reminderHoursBefore: 24 });
      await runSweep(db(), previewConfig(BASE_URL), { trigger: "scheduler", profileId });

      const rows = (await notifs()).filter((n) => n.type === "appointment_reminder");
      expect(rows.find((n) => n.appointmentId === a.id)).toMatchObject({ status: "cancelled", cancelReason: "appointment_cancelled" });
      const forB = rows.filter((n) => n.appointmentId === b.id);
      expect(forB.map((n) => n.status).sort()).toEqual(["cancelled", "previewed"]);
      expect(forB.find((n) => n.status === "cancelled")!.cancelReason).toBe("appointment_rescheduled");
    });

    it("does not notify about past appointments when the scheduler first starts", async () => {
      await resetOutbox();
      await db().insert(appointments).values({ profileId, doctorName: "Past", startsAt: new Date(Date.now() - 3600_000), createdBy: admin.userId, updatedBy: admin.userId });
      expect(await queueDueNotifications(db(), new Date(), profileId)).toBe(0);
    });
  });

  describe("deduplication and concurrency", () => {
    it("9. repeated sweeps never duplicate notifications", async () => {
      await resetOutbox();
      const now = new Date();
      await insertDose(5, now);
      await insertDose(-70, now);
      for (let i = 0; i < 4; i++) await runSweep(db(), previewConfig(BASE_URL), { trigger: "scheduler", now: new Date(now.getTime() + i * 1000), profileId });
      const rows = await notifs();
      expect(new Set(rows.map((r) => r.dedupeKey)).size).toBe(rows.length);
      expect(rows.filter((r) => r.type === "dose_reminder")).toHaveLength(1);
      expect(rows.filter((r) => r.type === "dose_unconfirmed")).toHaveLength(1);
    });

    it("10. concurrent sweeps: the lease lets one run; no duplicates; each email sent once", async () => {
      await resetOutbox();
      const now = new Date();
      await insertDose(5, now);
      await insertDose(-70, now);
      const fake = new FakeBrevo();
      const results = await Promise.all([1, 2, 3].map(() => runSweep(db(), realCfg(fake), { trigger: "scheduler", now })));
      expect(results.filter((r) => r.status === "completed").length).toBeGreaterThanOrEqual(1);
      const rows = await notifs();
      expect(new Set(rows.map((r) => r.dedupeKey)).size).toBe(rows.length);
      expect(fake.sent).toHaveLength(rows.filter((r) => r.status === "accepted").length);
      expect(new Set(fake.sent.map((m) => m.subject)).size).toBe(fake.sent.length);
    });

    it("11. concurrent claimers never claim the same notification", async () => {
      await resetOutbox();
      const now = new Date();
      for (let i = 0; i < 6; i++) await insertDose(-61 - i, now);
      const first = await runSweep(db(), { ...previewConfig(BASE_URL), maxPerSweep: 1 }, { trigger: "scheduler", now, profileId }); // queue all, process 1
      expect(first).toMatchObject({ queued: 6, claimed: 1, previewed: 1 }); // per-sweep limit honoured even with tied due times
      const [a, b] = await Promise.all([claimDue(db(), now, 10, profileId), claimDue(db(), now, 10, profileId)]);
      const ids = [...a, ...b].map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.length).toBe(5);
    });
  });

  describe("delivery outcomes, retries and caps", () => {
    it("12. retries 5xx with exponential backoff, then gives up; 4xx fails at once; timeouts become uncertain", async () => {
      expect([1, 2, 3, 10].map(backoffMinutes)).toEqual([2, 4, 8, 30]);
      await resetOutbox();
      const now = new Date();
      await insertDose(-5, now);
      const id = (await db().select().from(doses).where(eq(doses.profileId, profileId)))[0]!.id;
      await applyDoseAction(db(), profileId, id, { type: "record", outcome: "not_taken", source: "self_reported" }, { userId: elderUserId, role: "elder" });
      const fake = new FakeBrevo();
      fake.mode = "http500";
      await runSweep(db(), realCfg(fake), { trigger: "scheduler", now, profileId });
      let [n] = await notifs(eq(notifications.type, "dose_not_taken"));
      expect(n).toMatchObject({ status: "queued", attempts: 1 });
      expect(n!.nextAttemptAt.getTime() - now.getTime()).toBe(2 * MIN);

      await processQueue(db(), realCfg(fake), new Date(now.getTime() + MIN), profileId); // too early: untouched
      [n] = await notifs(eq(notifications.type, "dose_not_taken"));
      expect(n!.attempts).toBe(1);

      await processQueue(db(), realCfg(fake), new Date(now.getTime() + 2 * MIN), profileId);
      [n] = await notifs(eq(notifications.type, "dose_not_taken"));
      expect(n).toMatchObject({ status: "queued", attempts: 2 });
      await processQueue(db(), realCfg(fake), new Date(now.getTime() + 7 * MIN), profileId);
      [n] = await notifs(eq(notifications.type, "dose_not_taken"));
      expect(n).toMatchObject({ status: "failed", attempts: 3 });

      // 4xx: permanent, and the error text is sanitised.
      await db().update(notifications).set({ status: "queued", attempts: 0, nextAttemptAt: now }).where(eq(notifications.id, n!.id));
      fake.mode = "http400";
      await processQueue(db(), realCfg(fake), now, profileId);
      [n] = await notifs(eq(notifications.type, "dose_not_taken"));
      expect(n!.status).toBe("failed");
      expect(n!.lastError).not.toContain("xkeysib-abc123");

      // Timeout: outcome unknown → uncertain, and never retried.
      await db().update(notifications).set({ status: "queued", attempts: 0, nextAttemptAt: now }).where(eq(notifications.id, n!.id));
      fake.mode = "timeout";
      await processQueue(db(), realCfg(fake), now, profileId);
      await processQueue(db(), realCfg(fake), new Date(now.getTime() + 60 * MIN), profileId);
      [n] = await notifs(eq(notifications.type, "dose_not_taken"));
      expect(n).toMatchObject({ status: "uncertain", attempts: 1 });
    });

    it("13. the real-send cap is persistent across configs/restarts and pauses (not drops) the rest", async () => {
      await resetOutbox();
      const now = new Date();
      for (let i = 0; i < 5; i++) await insertDose(-61 - i, now);
      const fake = new FakeBrevo();
      await runSweep(db(), realCfg(fake, { realSendCap: 2 }), { trigger: "scheduler", now, profileId });
      let rows = await notifs(eq(notifications.type, "dose_unconfirmed"));
      expect(rows.filter((r) => r.status === "accepted")).toHaveLength(2);
      expect(rows.filter((r) => r.status === "paused_limit")).toHaveLength(3);
      expect(fake.sent).toHaveLength(2);

      // A "restarted" server with a fresh config object still sees the persisted count.
      await insertDose(-80, now);
      const fake2 = new FakeBrevo();
      await runSweep(db(), realCfg(fake2, { realSendCap: 2 }), { trigger: "scheduler", now: new Date(now.getTime() + 1000), profileId });
      expect(fake2.sent).toHaveLength(0);
      rows = await notifs(eq(notifications.type, "dose_unconfirmed"));
      expect(rows.filter((r) => r.status === "paused_limit")).toHaveLength(4);
      expect(rows.find((r) => r.status === "paused_limit")!.lastError).toContain("cap reached");
    });

    it("applies the per-profile limit per sweep and defers the rest", async () => {
      await resetOutbox();
      const now = new Date();
      for (let i = 0; i < 4; i++) await insertDose(-61 - i, now);
      const s = await runSweep(db(), { ...previewConfig(BASE_URL), maxPerProfilePerSweep: 2 }, { trigger: "scheduler", now, profileId });
      expect(s.previewed).toBe(2);
      expect(s.deferred).toBe(2);
      expect((await notifs()).filter((r) => r.status === "queued")).toHaveLength(2);
    });

    it("14. real sending is off by default — a Brevo key alone never enables it", () => {
      const keyOnly = { NODE_ENV: "development", BREVO_API_KEY: "xkeysib-x", EMAIL_FROM: "r@example.test", EMAIL_PROVIDER: "brevo" as const };
      expect(resolveRealSending(keyOnly).realSendEnabled).toBe(false);
      expect(resolveRealSending({ ...keyOnly, REAL_EMAIL_SEND_ENABLED: "true" }).realSendEnabled).toBe(true);
      expect(resolveRealSending({ ...keyOnly, NODE_ENV: "test", REAL_EMAIL_SEND_ENABLED: "true" }).realSendEnabled).toBe(false);
      expect(() => resolveRealSending({ NODE_ENV: "production", REAL_EMAIL_SEND_ENABLED: "true" })).toThrow(/BREVO_API_KEY/);
      expect(selectEmailProvider({ ...keyOnly, NODE_ENV: "test" }).name).toBe("console");
    });

    it("14b. with real sending disabled, even a Brevo provider is never called", async () => {
      await resetOutbox();
      const now = new Date();
      await insertDose(-61, now);
      const fake = new FakeBrevo();
      await runSweep(db(), { ...realCfg(fake), realSendEnabled: false }, { trigger: "scheduler", now, profileId });
      expect(fake.sent).toHaveLength(0);
      expect((await notifs()).every((r) => r.status === "previewed" && r.provider === "console")).toBe(true);
    });

    it("15. no network request is made to Brevo by the default app sweep", async () => {
      await resetOutbox();
      await insertDose(-61);
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const res = await request(ctx.app).post("/internal/sweep").set("authorization", `Bearer ${SECRET}`);
      expect(res.status).toBe(200);
      expect(res.body.mode).toBe("preview");
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("snooze timing (regression)", () => {
    it("16. a snooze requested before the dose is due ends after the scheduled time", () => {
      const scheduledAt = new Date("2026-11-15T06:15:00Z");
      const early = new Date("2026-11-15T06:03:00Z"); // 12 min before
      expect(snoozeUntilFor({ scheduledAt, snoozeUntil: null }, early).toISOString()).toBe("2026-11-15T06:30:00.000Z");
      const after = new Date("2026-11-15T06:20:00Z");
      expect(snoozeUntilFor({ scheduledAt, snoozeUntil: null }, after).toISOString()).toBe("2026-11-15T06:35:00.000Z");
      // A second snooze extends from the current snooze end, never backwards.
      expect(snoozeUntilFor({ scheduledAt, snoozeUntil: new Date("2026-11-15T06:30:00Z") }, early).toISOString()).toBe("2026-11-15T06:45:00.000Z");
    });

    it("16b. the sweep honours snoozes: no base reminder, one follow-up once the snooze ends", async () => {
      await resetOutbox();
      const now = new Date();
      const id = await insertDose(10, now);
      const res = await elderAgent.post(`/api/elder/doses/${encodeURIComponent(id)}/snooze`).set("origin", BASE_URL).send({});
      expect(res.status).toBe(200);
      const until = new Date(res.body.snoozeUntil);
      const [d] = await db().select().from(doses).where(eq(doses.id, id));
      expect(until.getTime()).toBeGreaterThan(d!.scheduledAt.getTime()); // after the prescribed time
      expect(d!.scheduledAt.getTime()).toBe(DateTime.fromJSDate(now).setZone(ZONE).plus({ minutes: 10 }).startOf("minute").toMillis()); // unchanged

      await runSweep(db(), previewConfig(BASE_URL), { trigger: "scheduler", now, profileId });
      expect(await notifs()).toHaveLength(0); // base reminder suppressed by the snooze
      await runSweep(db(), previewConfig(BASE_URL), { trigger: "scheduler", now: new Date(until.getTime() - 1000), profileId });
      expect(await notifs()).toHaveLength(0); // not before the snooze ends
      await runSweep(db(), previewConfig(BASE_URL), { trigger: "scheduler", now: until, profileId });
      const rows = await notifs();
      expect(rows.map((r) => r.type)).toEqual(["dose_snooze_reminder"]);
    });
  });

  describe("endpoints and access control", () => {
    it("17+20. only this profile's admin can read its notification center; addresses are masked", async () => {
      await resetOutbox();
      await insertDose(-61);
      await runSweep(db(), previewConfig(BASE_URL), { trigger: "scheduler", profileId });
      const res = await admin.agent.get(`/api/profiles/${profileId}/notifications`);
      expect(res.status).toBe(200);
      expect(res.body.mode).toBe("preview");
      expect(res.body.items.length).toBeGreaterThan(0);
      expect(JSON.stringify(res.body)).not.toContain(admin.email);
      expect(res.body.items[0].recipientMasked).toMatch(/^a•+@example\.test$/);

      expect((await elderAgent.get(`/api/profiles/${profileId}/notifications`)).status).toBe(403);
      expect((await other.agent.get(`/api/profiles/${profileId}/notifications`)).status).toBe(403);
      expect((await request(ctx.app).get(`/api/profiles/${profileId}/notifications`)).status).toBe(401);
      const own = await other.agent.get(`/api/profiles/${otherProfileId}/notifications`);
      expect(own.body.items).toEqual([]); // no cross-profile rows
    });

    it("18. manual check: admin-only, profile-scoped, preview by default, with a cooldown", async () => {
      await resetOutbox();
      await insertDose(-61);
      expect((await elderAgent.post(`/api/profiles/${profileId}/notifications/run-check`).set("origin", BASE_URL).send({})).status).toBe(403);
      expect((await other.agent.post(`/api/profiles/${profileId}/notifications/run-check`).send({})).status).toBe(403);

      const first = await admin.agent.post(`/api/profiles/${profileId}/notifications/run-check`).send({ now: "2000-01-01", to: "x@evil.test" });
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ status: "completed", mode: "preview", profiles: 1 });
      expect(JSON.stringify(await notifs())).not.toContain("evil.test"); // client cannot choose recipients
      const second = await admin.agent.post(`/api/profiles/${profileId}/notifications/run-check`).send({});
      expect(second.status).toBe(429);
      expect(second.body.error.code).toBe("COOLDOWN");
    });

    it("19. /internal/sweep rejects missing or wrong secrets and is disabled without one", async () => {
      expect((await request(ctx.app).post("/internal/sweep")).status).toBe(401);
      expect((await request(ctx.app).post("/internal/sweep").set("authorization", "Bearer wrong")).status).toBe(401);
      expect((await request(ctx.app).post("/internal/sweep").set("authorization", SECRET)).status).toBe(401); // no Bearer prefix
      const ok = await request(ctx.app).post("/internal/sweep").set("authorization", `Bearer ${SECRET}`);
      expect(ok.status).toBe(200);
      expect(Object.keys(ok.body)).not.toContain("items");

      const noSecret = await makeTestApp();
      expect((await request(noSecret.app).post("/internal/sweep").set("authorization", `Bearer ${SECRET}`)).status).toBe(503);
      await noSecret.handle.close();
    });

    it("preferences: a member can turn their own alerts off, and is then not emailed", async () => {
      await resetOutbox();
      const off = await admin.agent
        .put(`/api/profiles/${profileId}/notification-preferences`)
        .send({ notifyDoseReminders: true, notifyAlerts: false, notifyAppointments: true });
      expect(off.body.notifyAlerts).toBe(false);
      await insertDose(-61);
      await runSweep(db(), previewConfig(BASE_URL), { trigger: "scheduler", profileId });
      expect((await notifs()).filter((r) => r.type === "dose_unconfirmed")).toHaveLength(0);
      await db().update(profileMembers).set({ notifyAlerts: true }).where(and(eq(profileMembers.profileId, profileId), eq(profileMembers.userId, admin.userId)));
      expect((await elderAgent.put(`/api/profiles/${profileId}/notification-preferences`).set("origin", BASE_URL).send({ notifyDoseReminders: true, notifyAlerts: true, notifyAppointments: true })).status).toBe(403);
    });
  });

  describe("helpers", () => {
    it("masks addresses and sanitises provider errors", () => {
      expect(maskEmail("priya.demo@example.test")).toBe("p••••••@example.test");
      expect(sanitizeError("HTTP 401 key xkeysib-abc-123 for priya@example.test")).toBe("HTTP 401 key [redacted-key] for [redacted-email]");
    });
  });
});
