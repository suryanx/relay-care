import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { caregiverInvitations, profileMembers } from "../src/server/db/schema.js";
import { hashToken } from "../src/server/services/invitations.js";
import { BASE_URL, makeTestApp, signUpAgent, syntheticProfile, uniqueEmail, type TestContext } from "./helpers.js";

const tokenOf = (inviteUrl: string) => inviteUrl.split("#")[1]!;

describe("caregiver invitations and membership", () => {
  let ctx: TestContext;
  let admin: Awaited<ReturnType<typeof signUpAgent>>;
  let profileId: string;
  let otherAdmin: Awaited<ReturnType<typeof signUpAgent>>;
  let otherProfileId: string;

  async function invite(email: string) {
    const res = await admin.agent.post(`/api/profiles/${profileId}/invitations`).send({ email });
    expect(res.status).toBe(201);
    return { id: res.body.id as string, token: tokenOf(res.body.inviteUrl) };
  }

  beforeAll(async () => {
    ctx = await makeTestApp();
    admin = await signUpAgent(ctx.app);
    profileId = (await admin.agent.post("/api/profiles").send(syntheticProfile)).body.id;
    otherAdmin = await signUpAgent(ctx.app);
    otherProfileId = (await otherAdmin.agent.post("/api/profiles").send({ ...syntheticProfile, preferredName: "Other" })).body.id;
  });
  afterAll(() => ctx.handle.close());

  it("1. creates a valid invitation: link carries the token in the fragment and only its hash is stored", async () => {
    const email = uniqueEmail("care");
    const res = await admin.agent.post(`/api/profiles/${profileId}/invitations`).send({ email });
    expect(res.status).toBe(201);
    expect(res.body.inviteUrl).toMatch(new RegExp(`^${BASE_URL}/invite#[A-Za-z0-9_-]{40,}$`));
    const token = tokenOf(res.body.inviteUrl);
    const [row] = await ctx.handle.db.select().from(caregiverInvitations).where(eq(caregiverInvitations.id, res.body.id));
    expect(row!.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(row)).not.toContain(token);

    const preview = await request(ctx.app).post("/api/invitations/preview").set("origin", BASE_URL).send({ token });
    expect(preview.body).toMatchObject({ state: "pending", careRecipient: "Swastik", invitedBy: "Priya Test" });

    const list = await admin.agent.get(`/api/profiles/${profileId}/invitations`);
    expect(list.body[0]).toMatchObject({ state: "pending" });
    expect(JSON.stringify(list.body)).not.toContain(email); // masked
  });

  it("6. a new caregiver registers with their own credentials and accepts", async () => {
    const email = uniqueEmail("newcare");
    const { token } = await invite(email);
    const care = await signUpAgent(ctx.app, email, "caregiver own passcode");
    expect((await care.agent.get(`/api/profiles/${profileId}`)).status).toBe(403); // no access before accepting
    const res = await care.agent.post("/api/invitations/accept").send({ token });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ profileId, alreadyMember: false });
    const detail = await care.agent.get(`/api/profiles/${profileId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.role).toBe("caregiver");
  });

  it("5. an existing account accepts; 3. the link is single-use", async () => {
    const email = uniqueEmail("existing");
    const care = await signUpAgent(ctx.app, email);
    const { token } = await invite(email);
    expect((await care.agent.post("/api/invitations/accept").send({ token })).status).toBe(200);
    expect((await care.agent.post("/api/invitations/accept").send({ token })).body.alreadyMember).toBe(true); // idempotent for the same person
    const someoneElse = await signUpAgent(ctx.app, uniqueEmail("thief"));
    const reuse = await someoneElse.agent.post("/api/invitations/accept").send({ token });
    expect(reuse.status).toBe(409);
    expect(reuse.body.error.code).toBe("INVITATION_USED");
  });

  it("concurrent acceptance of one invitation creates exactly one membership", async () => {
    const email = uniqueEmail("race");
    const care = await signUpAgent(ctx.app, email);
    const { token } = await invite(email);
    const results = await Promise.all([1, 2, 3].map(() => care.agent.post("/api/invitations/accept").send({ token })));
    expect(results.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
    const rows = await ctx.handle.db.select().from(profileMembers).where(eq(profileMembers.userId, care.userId));
    expect(rows).toHaveLength(1);
  });

  it("requires the invited email address", async () => {
    const { token } = await invite(uniqueEmail("intended"));
    const wrong = await signUpAgent(ctx.app, uniqueEmail("wrong"));
    const res = await wrong.agent.post("/api/invitations/accept").send({ token });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("EMAIL_MISMATCH");
  });

  it("2. expired invitations cannot be used", async () => {
    const email = uniqueEmail("late");
    const { id, token } = await invite(email);
    await ctx.handle.db.update(caregiverInvitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(caregiverInvitations.id, id));
    const care = await signUpAgent(ctx.app, email);
    const res = await care.agent.post("/api/invitations/accept").send({ token });
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe("INVITATION_EXPIRED");
    expect((await admin.agent.get(`/api/profiles/${profileId}/invitations`)).body.find((i: { id: string }) => i.id === id).state).toBe("expired");
  });

  it("4. revoked invitations cannot be used (and a new invitation replaces the old one)", async () => {
    const email = uniqueEmail("revoked");
    const first = await invite(email);
    const second = await invite(email);
    const care = await signUpAgent(ctx.app, email);
    expect((await care.agent.post("/api/invitations/accept").send({ token: first.token })).body.error.code).toBe("INVITATION_REVOKED");
    expect((await admin.agent.post(`/api/profiles/${profileId}/invitations/${second.id}/revoke`).send({})).status).toBe(200);
    expect((await care.agent.post("/api/invitations/accept").send({ token: second.token })).status).toBe(410);
    expect((await care.agent.get(`/api/profiles/${profileId}`)).status).toBe(403);
  });

  it("invalid tokens reveal nothing", async () => {
    const res = await request(ctx.app).post("/api/invitations/preview").set("origin", BASE_URL).send({ token: "x".repeat(43) });
    expect(res.body).toEqual({ state: "invalid" });
  });

  describe("access boundaries", () => {
    let care: Awaited<ReturnType<typeof signUpAgent>>;
    beforeAll(async () => {
      const email = uniqueEmail("bounded");
      const { token } = await invite(email);
      care = await signUpAgent(ctx.app, email);
      await care.agent.post("/api/invitations/accept").send({ token });
    });

    it("7+8. a caregiver sees only assigned profiles and is denied other families", async () => {
      const list = await care.agent.get("/api/profiles");
      expect(list.body.map((p: { id: string }) => p.id)).toEqual([profileId]);
      expect((await care.agent.get(`/api/profiles/${otherProfileId}`)).status).toBe(403);
      expect((await care.agent.get(`/api/profiles/${otherProfileId}/medications`)).status).toBe(403);
      expect((await care.agent.get(`/api/profiles/${otherProfileId}/incidents`)).status).toBe(403);
      // But day-to-day care on the assigned profile works.
      expect((await care.agent.get(`/api/profiles/${profileId}/medications`)).status).toBe(200);
      expect((await care.agent.get(`/api/profiles/${profileId}/incidents`)).status).toBe(200);
    });

    it("10. a caregiver cannot invite, remove members, manage the elder sign-in or read the notification center", async () => {
      expect((await care.agent.post(`/api/profiles/${profileId}/invitations`).send({ email: uniqueEmail("x") })).status).toBe(403);
      expect((await care.agent.post(`/api/profiles/${profileId}/members/${admin.userId}/remove`).send({})).status).toBe(403);
      expect((await care.agent.post(`/api/profiles/${profileId}/members/${care.userId}/remove`).send({})).status).toBe(403);
      expect((await care.agent.post(`/api/profiles/${profileId}/elder-account`).send({ username: "nope_x", passcode: "0123456789" })).status).toBe(403);
      expect((await care.agent.get(`/api/profiles/${profileId}/notifications`)).status).toBe(403);
      const [m] = await ctx.handle.db.select().from(profileMembers).where(eq(profileMembers.userId, care.userId));
      expect(m!.role).toBe("caregiver");
    });

    it("admins cannot remove other admins through the caregiver route", async () => {
      expect((await admin.agent.post(`/api/profiles/${profileId}/members/${admin.userId}/remove`).send({})).status).toBe(403);
    });

    it("9. removing a caregiver takes effect immediately for an already signed-in session", async () => {
      expect((await care.agent.get(`/api/profiles/${profileId}`)).status).toBe(200);
      expect((await admin.agent.post(`/api/profiles/${profileId}/members/${care.userId}/remove`).send({})).status).toBe(200);
      expect((await care.agent.get(`/api/profiles/${profileId}`)).status).toBe(403);
      expect((await care.agent.get(`/api/profiles/${profileId}/incidents`)).status).toBe(403);
      expect((await care.agent.get("/api/me")).status).toBe(200); // still signed in, just no access
    });
  });

  it("elder accounts cannot accept invitations", async () => {
    await admin.agent.post(`/api/profiles/${profileId}/elder-account`).send({ username: "team.elder", passcode: "sunrise garden 42" });
    const elder = request.agent(ctx.app);
    await elder.post("/api/auth/sign-in/username").set("origin", BASE_URL).send({ username: "team.elder", password: "sunrise garden 42" });
    // Invited to a different family's profile (inviting a current member is already refused with 409).
    expect((await admin.agent.post(`/api/profiles/${profileId}/invitations`).send({ email: `elder-${profileId}@accounts.relay.invalid` })).status).toBe(409);
    const res = await otherAdmin.agent.post(`/api/profiles/${otherProfileId}/invitations`).send({ email: `elder-${profileId}@accounts.relay.invalid` });
    const accept = await elder.post("/api/invitations/accept").set("origin", BASE_URL).send({ token: tokenOf(res.body.inviteUrl) });
    expect(accept.status).toBe(403);
  });
});
