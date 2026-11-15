import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { notifications, profiles, session } from "../src/server/db/schema.js";
import { BASE_URL, makeTestApp, signUpAgent, syntheticProfile, uniqueEmail, type TestContext } from "./helpers.js";

describe("care profile creation and lifecycle", () => {
  let ctx: TestContext;
  let admin: Awaited<ReturnType<typeof signUpAgent>>;
  beforeAll(async () => {
    ctx = await makeTestApp();
    admin = await signUpAgent(ctx.app);
  });
  afterAll(() => ctx.handle.close());

  describe("creation", () => {
    it("needs no free-text agreement for the common 'they agreed' case, and records an honest declaration", async () => {
      const res = await admin.agent.post("/api/profiles").send({ fullName: "Asha Demo", preferredName: "Asha", timezone: "Asia/Kolkata", consentBasis: "elder_consented" });
      expect(res.status).toBe(201);
      const [p] = await ctx.handle.db.select().from(profiles).where(eq(profiles.id, res.body.id));
      expect(p!.consentStatement).toContain("administrator confirmed");
      expect(p!.consentRecordedBy).toBe(admin.userId);
      expect(p!.consentRecordedAt).toBeInstanceOf(Date);
    });

    it("records a legal-authority declaration as unverified", async () => {
      const res = await admin.agent.post("/api/profiles").send({ fullName: "Bina Demo", preferredName: "Bina", timezone: "UTC", consentBasis: "legal_authority" });
      const [p] = await ctx.handle.db.select().from(profiles).where(eq(profiles.id, res.body.id));
      expect(p!.consentStatement).toContain("has not verified");
    });

    it("still requires a description for 'other' and a choice of arrangement", async () => {
      const other = await admin.agent.post("/api/profiles").send({ fullName: "C D", preferredName: "C", timezone: "UTC", consentBasis: "other" });
      expect(other.status).toBe(400);
      expect(other.body.error.fields[0].path).toBe("consentStatement");
      const none = await admin.agent.post("/api/profiles").send({ fullName: "C D", preferredName: "C", timezone: "UTC" });
      expect(none.status).toBe(400);
    });
  });

  describe("archive and restore", () => {
    let profileId: string;
    let care: Awaited<ReturnType<typeof signUpAgent>>;
    let elder: ReturnType<typeof request.agent>;

    beforeAll(async () => {
      profileId = (await admin.agent.post("/api/profiles").send(syntheticProfile)).body.id;
      const email = uniqueEmail("arch-care");
      const inv = await admin.agent.post(`/api/profiles/${profileId}/invitations`).send({ email });
      care = await signUpAgent(ctx.app, email);
      await care.agent.post("/api/invitations/accept").send({ token: inv.body.inviteUrl.split("#")[1] });
      await admin.agent.post(`/api/profiles/${profileId}/elder-account`).send({ username: "arch.elder", passcode: "sunrise garden 42" });
      elder = request.agent(ctx.app);
      await elder.post("/api/auth/sign-in/username").set("origin", BASE_URL).send({ username: "arch.elder", password: "sunrise garden 42" });
      await ctx.handle.db.insert(notifications).values({
        dedupeKey: `test:${profileId}`,
        profileId,
        type: "help_request",
        subject: "s",
        preview: "p",
        dueAt: new Date(),
        expiresAt: new Date(Date.now() + 3600_000),
        nextAttemptAt: new Date(),
      });
    });

    it("a caregiver, the elder and outsiders cannot archive (server-side)", async () => {
      expect((await care.agent.post(`/api/profiles/${profileId}/archive`).send({ confirmName: "Swastik" })).status).toBe(403);
      expect((await elder.post(`/api/profiles/${profileId}/archive`).set("origin", BASE_URL).send({ confirmName: "Swastik" })).status).toBe(403);
      const outsider = await signUpAgent(ctx.app);
      expect((await outsider.agent.post(`/api/profiles/${profileId}/archive`).send({ confirmName: "Swastik" })).status).toBe(403);
    });

    it("requires typing the person's name", async () => {
      const res = await admin.agent.post(`/api/profiles/${profileId}/archive`).send({ confirmName: "Someone else" });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("CONFIRMATION_MISMATCH");
    });

    it("archives: hidden from everyone, access ends, reminders cancelled, records kept", async () => {
      const res = await admin.agent.post(`/api/profiles/${profileId}/archive`).send({ confirmName: "swastik" });
      expect(res.status).toBe(200);

      expect((await admin.agent.get("/api/profiles")).body.map((p: { id: string }) => p.id)).not.toContain(profileId);
      expect((await care.agent.get("/api/profiles")).body).toEqual([]);
      expect((await care.agent.get(`/api/profiles/${profileId}`)).status).toBe(404);
      expect((await admin.agent.get(`/api/profiles/${profileId}/medications`)).status).toBe(404);
      expect((await elder.get("/api/elder/today")).status).toBe(401); // device signed out

      const [n] = await ctx.handle.db.select().from(notifications).where(eq(notifications.profileId, profileId));
      expect(n).toMatchObject({ status: "cancelled", cancelReason: "profile_archived" });
      const [p] = await ctx.handle.db.select().from(profiles).where(eq(profiles.id, profileId));
      expect(p!.archivedBy).toBe(admin.userId); // the row (and its history) still exists

      const archived = await admin.agent.get("/api/profiles-archived");
      expect(archived.body.map((a: { id: string }) => a.id)).toContain(profileId);
      expect((await care.agent.get("/api/profiles-archived")).body).toEqual([]);
    });

    it("only an administrator can restore", async () => {
      expect((await care.agent.post(`/api/profiles/${profileId}/restore`).send({})).status).toBe(403);
      expect((await admin.agent.post(`/api/profiles/${profileId}/restore`).send({})).status).toBe(200);
      expect((await care.agent.get(`/api/profiles/${profileId}`)).status).toBe(200);
      expect((await admin.agent.post(`/api/profiles/${profileId}/restore`).send({})).status).toBe(409);
    });

    it("archiving requires a recent sign-in", async () => {
      await ctx.handle.db.update(session).set({ createdAt: new Date(Date.now() - 20 * 60_000) }).where(eq(session.userId, admin.userId));
      const res = await admin.agent.post(`/api/profiles/${profileId}/archive`).send({ confirmName: "Swastik" });
      expect(res.body.error.code).toBe("REAUTH_REQUIRED");
    });
  });
});
