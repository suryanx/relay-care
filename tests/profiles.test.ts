import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { profileMembers, profiles, session } from "../src/server/db/schema.js";
import { BASE_URL, makeTestApp, signUpAgent, syntheticProfile, type TestContext } from "./helpers.js";

describe("profiles and authorization", () => {
  let ctx: TestContext;
  let admin: Awaited<ReturnType<typeof signUpAgent>>;
  let profileId: string;

  beforeAll(async () => {
    ctx = await makeTestApp();
    admin = await signUpAgent(ctx.app);
    const res = await admin.agent.post("/api/profiles").send(syntheticProfile);
    expect(res.status).toBe(201);
    profileId = res.body.id;
  });
  afterAll(() => ctx.handle.close());

  it("returns 401 for unauthenticated requests", async () => {
    const anon = request(ctx.app);
    expect((await anon.get("/api/me")).status).toBe(401);
    expect((await anon.get("/api/profiles")).status).toBe(401);
    expect((await anon.get(`/api/profiles/${profileId}`)).status).toBe(401);
    expect((await anon.post("/api/profiles").send(syntheticProfile)).status).toBe(401);
  });

  it("creates a profile with the creator as admin and a recorded consent attestation", async () => {
    const [p] = await ctx.handle.db.select().from(profiles).where(eq(profiles.id, profileId));
    expect(p).toMatchObject({ preferredName: "Swastik", timezone: "Asia/Kolkata", consentBasis: "elder_consented" });
    expect(p!.consentRecordedBy).toBe(admin.userId);
    const members = await ctx.handle.db.select().from(profileMembers).where(eq(profileMembers.profileId, profileId));
    expect(members).toEqual([expect.objectContaining({ userId: admin.userId, role: "admin" })]);
  });

  it("retrieves the profile and lists it for its admin", async () => {
    const detail = await admin.agent.get(`/api/profiles/${profileId}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ id: profileId, role: "admin", hasElderAccount: false });
    expect(detail.body.consent.statement).toContain("synthetic");

    const list = await admin.agent.get("/api/profiles");
    expect(list.body.map((p: { id: string }) => p.id)).toContain(profileId);
  });

  it("validates input (bad time zone, missing consent statement)", async () => {
    const res = await admin.agent.post("/api/profiles").send({ ...syntheticProfile, timezone: "Mars/Olympus", consentBasis: "other", consentStatement: "" });
    expect(res.status).toBe(400);
    const paths = res.body.error.fields.map((f: { path: string }) => f.path);
    expect(paths).toEqual(expect.arrayContaining(["timezone", "consentStatement"]));
  });

  it("denies non-members access to another family's profile", async () => {
    const stranger = await signUpAgent(ctx.app);
    expect((await stranger.agent.get(`/api/profiles/${profileId}`)).status).toBe(403);
    expect((await stranger.agent.post(`/api/profiles/${profileId}/elder-account`).send({ username: "x_user", passcode: "0123456789" })).status).toBe(403);
    expect((await stranger.agent.get("/api/profiles")).body).toEqual([]);
  });

  it("rejects cross-origin state-changing requests", async () => {
    const res = await admin.agent.post("/api/profiles").set("origin", "https://evil.example").send(syntheticProfile);
    expect(res.status).toBe(403);
  });

  describe("elder account", () => {
    const elderCreds = { username: "swastik.demo", passcode: "sunrise garden 42" };
    const elder = () => request.agent(ctx.app);
    let elderAgent: ReturnType<typeof elder>;

    it("lets the admin create a username sign-in without handing the admin an elder session", async () => {
      const res = await admin.agent.post(`/api/profiles/${profileId}/elder-account`).send(elderCreds);
      expect(res.status).toBe(201);

      const [p] = await ctx.handle.db.select().from(profiles).where(eq(profiles.id, profileId));
      expect(p!.elderUserId).toBeTruthy();
      const elderSessions = await ctx.handle.db.select().from(session).where(eq(session.userId, p!.elderUserId!));
      expect(elderSessions).toHaveLength(0);

      // Admin is still themselves.
      const me = await admin.agent.get("/api/me");
      expect(me.body.user.id).toBe(admin.userId);
    });

    it("refuses a second elder account for the same profile", async () => {
      const res = await admin.agent.post(`/api/profiles/${profileId}/elder-account`).send({ username: "another_one", passcode: "another passcode" });
      expect(res.status).toBe(409);
    });

    it("lets the elder sign in by username and reach only the elder home", async () => {
      elderAgent = elder();
      const signIn = await elderAgent.post("/api/auth/sign-in/username").set("origin", BASE_URL).send({
        username: elderCreds.username,
        password: elderCreds.passcode,
      });
      expect(signIn.status).toBe(200);

      const me = await elderAgent.get("/api/me");
      expect(me.body.isElder).toBe(true);
      expect(me.body.user.email).toBeNull(); // placeholder address is never exposed

      const home = await elderAgent.get("/api/elder/home");
      expect(home.status).toBe(200);
      expect(home.body).toMatchObject({ preferredName: "Swastik", timezone: "Asia/Kolkata" });
    });

    it("denies the elder account every administrator route", async () => {
      expect((await elderAgent.get(`/api/profiles/${profileId}`)).status).toBe(403);
      expect((await elderAgent.post(`/api/profiles/${profileId}/elder-account`).send(elderCreds)).status).toBe(403);
      expect((await elderAgent.post(`/api/profiles/${profileId}/elder-account/revoke-sessions`).send({})).status).toBe(403);
      expect((await elderAgent.post("/api/profiles").send(syntheticProfile)).status).toBe(403);
    });

    it("denies the elder home to non-elder accounts", async () => {
      expect((await admin.agent.get("/api/elder/home")).status).toBe(403);
    });

    it("lets the admin revoke all elder device sessions", async () => {
      const res = await admin.agent.post(`/api/profiles/${profileId}/elder-account/revoke-sessions`).send({});
      expect(res.status).toBe(200);
      expect(res.body.revoked).toBeGreaterThanOrEqual(1);
      expect((await elderAgent.get("/api/elder/home")).status).toBe(401);
    });

    it("requires a recent sign-in for sensitive admin actions", async () => {
      // Age the admin's session beyond the 15-minute freshness window.
      await ctx.handle.db
        .update(session)
        .set({ createdAt: new Date(Date.now() - 20 * 60 * 1000) })
        .where(eq(session.userId, admin.userId));
      const res = await admin.agent.post(`/api/profiles/${profileId}/elder-account/revoke-sessions`).send({});
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("REAUTH_REQUIRED");
    });
  });
});

describe("health", () => {
  it("GET /healthz returns ok", async () => {
    const ctx = await makeTestApp();
    const res = await request(ctx.app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
    await ctx.handle.close();
  });
});
