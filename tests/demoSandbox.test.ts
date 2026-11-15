import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { demoSandboxes, notifications, profiles, user } from "../src/server/db/schema.js";
import { EmailSendError, type EmailMessage, type EmailProvider, type SendResult } from "../src/server/email/types.js";
import { purgeExpiredSandboxes } from "../src/server/services/demoSandbox.js";
import { previewConfig, runSweep } from "../src/server/services/notifications.js";
import { BASE_URL, makeTestApp, signUpAgent, syntheticProfile, type TestContext } from "./helpers.js";

const DEMO_SECRET = "test-secret-test-secret-test-secret-123";

class FakeBrevo implements EmailProvider {
  readonly name = "brevo" as const;
  sent: EmailMessage[] = [];
  async send(m: EmailMessage): Promise<SendResult> {
    this.sent.push(m);
    if (!m.to) throw new EmailSendError("no recipient", 400);
    return { provider: "brevo", accepted: true, externalRequest: true };
  }
}

/** A visitor's browser: its own cookie jar, starting the demo as a persona. */
async function startDemo(agent: ReturnType<typeof request.agent>, role: string) {
  return agent.post("/api/demo/start").set("origin", BASE_URL).send({ role });
}

describe("interactive demo sandboxes", () => {
  let ctx: TestContext;
  let visitorA: ReturnType<typeof request.agent>;
  let profileA: string;

  beforeAll(async () => {
    ctx = await makeTestApp(undefined, { demoSecret: DEMO_SECRET });
    visitorA = request.agent(ctx.app);
  });
  afterAll(() => ctx.handle.close());

  it("opens the real elder dashboard with synthetic data, no credentials involved", async () => {
    const res = await startDemo(visitorA, "elder");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ redirect: "/elder" });
    const cookies = ([] as string[]).concat(res.headers["set-cookie"] ?? []);
    expect(cookies.find((c) => c.startsWith("relay_demo="))).toMatch(/HttpOnly/);
    expect(JSON.stringify(res.body)).not.toMatch(/password|token/i);

    const me = await visitorA.get("/api/me");
    expect(me.body).toMatchObject({ isElder: true, demo: "elder" });
    const today = await visitorA.get("/api/elder/today");
    expect(today.body.preferredName).toBe("Swastik");
    expect(today.body.doses.some((d: { label: string; canRecord: boolean }) => d.label.startsWith("Amlodipine") && d.canRecord)).toBe(true);
  });

  it("switching persona stays inside the same private circle", async () => {
    const res = await startDemo(visitorA, "caregiver");
    expect(res.body.redirect).toMatch(/^\/profiles\/.+\/follow-ups$/);
    profileA = res.body.redirect.split("/")[2];
    const me = await visitorA.get("/api/me");
    expect(me.body).toMatchObject({ demo: "caregiver", isElder: false });
    expect(me.body.memberships).toEqual([expect.objectContaining({ id: profileA, role: "caregiver" })]);

    const list = await visitorA.get(`/api/profiles/${profileA}/incidents`);
    const kinds = list.body.incidents.map((i: { sourceType: string; status: string }) => `${i.sourceType}:${i.status}`);
    expect(kinds).toEqual(expect.arrayContaining(["dose_unconfirmed:open", "help_request:claimed"]));

    const fam = await startDemo(visitorA, "family");
    expect(fam.body.redirect).toBe(`/profiles/${profileA}`);
    expect((await visitorA.get("/api/me")).body.memberships[0]).toMatchObject({ id: profileA, role: "admin" });
    expect(await ctx.handle.db.select().from(demoSandboxes)).toHaveLength(1); // no new circle for a switch
  });

  it("another visitor gets a separate circle and cannot reach the first one", async () => {
    const visitorB = request.agent(ctx.app);
    const res = await startDemo(visitorB, "family");
    const profileB = res.body.redirect.split("/")[2];
    expect(profileB).not.toBe(profileA);
    expect((await visitorB.get(`/api/profiles/${profileA}`)).status).toBe(403);
    expect((await visitorB.get(`/api/profiles/${profileA}/incidents`)).status).toBe(403);
    expect((await visitorB.get("/api/profiles")).body.map((p: { id: string }) => p.id)).toEqual([profileB]);
  });

  it("a forged or missing demo cookie can never switch into someone else's circle", async () => {
    const forged = request.agent(ctx.app);
    const res = await forged
      .post("/api/demo/start")
      .set("origin", BASE_URL)
      .set("cookie", "relay_demo=not-a-real-token")
      .send({ role: "family" });
    expect(res.body.redirect.split("/")[2]).not.toBe(profileA); // a brand-new circle, not A's
  });

  it("demo accounts cannot invite people, create care circles, create sign-ins or accept invitations", async () => {
    expect((await visitorA.post(`/api/profiles/${profileA}/invitations`).set("origin", BASE_URL).send({ email: "real.person@example.test" })).status).toBe(403);
    expect((await visitorA.post("/api/profiles").set("origin", BASE_URL).send(syntheticProfile)).status).toBe(403);
    expect((await visitorA.post(`/api/profiles/${profileA}/elder-account`).set("origin", BASE_URL).send({ username: "x_user", passcode: "0123456789" })).status).toBe(403);
    expect((await visitorA.post("/api/invitations/accept").set("origin", BASE_URL).send({ token: "x".repeat(43) })).status).toBe(403);
  });

  it("never emails anyone, even with real sending switched on", async () => {
    const fake = new FakeBrevo();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await runSweep(ctx.handle.db, { ...previewConfig(BASE_URL), provider: fake, realSendEnabled: true }, { trigger: "scheduler", profileId: profileA });
    expect(fake.sent).toHaveLength(0);
    expect(await ctx.handle.db.select().from(notifications).where(eq(notifications.profileId, profileA))).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("real accounts are unaffected and never see demo circles", async () => {
    const real = await signUpAgent(ctx.app);
    const me = await real.agent.get("/api/me");
    expect(me.body).toMatchObject({ demo: null, memberships: [] });
    expect((await real.agent.get(`/api/profiles/${profileA}`)).status).toBe(403);
  });

  it("rejects unknown personas", async () => {
    expect((await startDemo(request.agent(ctx.app), "admin")).status).toBe(400);
  });

  it("expired circles are deleted with their accounts; the old cookie no longer works", async () => {
    await ctx.handle.db.update(demoSandboxes).set({ createdAt: new Date(Date.now() - 25 * 3_600_000) }).where(eq(demoSandboxes.profileId, profileA));
    const [sb] = await ctx.handle.db.select().from(demoSandboxes).where(eq(demoSandboxes.profileId, profileA));
    expect(await purgeExpiredSandboxes(ctx.handle.db)).toBe(1);
    expect(await ctx.handle.db.select().from(profiles).where(eq(profiles.id, profileA))).toHaveLength(0);
    expect(await ctx.handle.db.select().from(user).where(eq(user.id, sb!.adminUserId))).toHaveLength(0);
    expect((await visitorA.get("/api/me")).status).toBe(401); // its sessions went with the accounts
    const again = await startDemo(visitorA, "elder");
    expect(again.status).toBe(200); // a fresh circle
  });

  it("limits how many circles one address can create, ignoring spoofed forwarding headers", async () => {
    const fresh = await makeTestApp(undefined, { demoSecret: DEMO_SECRET });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await request(fresh.app).post("/api/demo/start").set("origin", BASE_URL).set("x-forwarded-for", `203.0.113.${i}`).send({ role: "elder" })).status);
    }
    expect(statuses.slice(0, 5).every((s) => s === 200)).toBe(true);
    expect(statuses[5]).toBe(429);
    await fresh.handle.close();
  });

  it("is disabled without a server secret", async () => {
    const off = await makeTestApp();
    expect((await request(off.app).post("/api/demo/start").set("origin", BASE_URL).send({ role: "elder" })).status).toBe(503);
    await off.handle.close();
  });
});
