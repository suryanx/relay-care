import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { session, user } from "../src/server/db/schema.js";
import { BASE_URL, makeTestApp, signUpAgent, uniqueEmail, type TestContext } from "./helpers.js";

describe("authentication", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await makeTestApp();
  });
  afterAll(() => ctx.handle.close());

  it("registers an administrator, sets an HttpOnly session cookie and persists user + session", async () => {
    const email = uniqueEmail();
    const res = await request(ctx.app)
      .post("/api/auth/sign-up/email")
      .set("origin", BASE_URL)
      .send({ name: "Priya Test", email, password: "correct horse battery" });

    expect(res.status).toBe(200);
    const cookies = ([] as string[]).concat(res.headers["set-cookie"] ?? []);
    const sessionCookie = cookies.find((c) => c.includes("session_token"));
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toMatch(/HttpOnly/i);
    expect(sessionCookie).toMatch(/SameSite=Lax/i);

    const [row] = await ctx.handle.db.select().from(user).where(eq(user.email, email));
    expect(row?.name).toBe("Priya Test");
    const sessions = await ctx.handle.db.select().from(session).where(eq(session.userId, row!.id));
    expect(sessions).toHaveLength(1);
  });

  it("rejects passcodes shorter than 10 characters", async () => {
    const res = await request(ctx.app)
      .post("/api/auth/sign-up/email")
      .set("origin", BASE_URL)
      .send({ name: "Short", email: uniqueEmail(), password: "short" });
    expect(res.status).toBe(400);
  });

  it("signs in with the right passcode, rejects the wrong one, and signs out", async () => {
    const { email, password } = await signUpAgent(ctx.app);

    const bad = await request(ctx.app).post("/api/auth/sign-in/email").set("origin", BASE_URL).send({ email, password: "wrong passcode!!" });
    expect(bad.status).toBe(401);

    const agent = request.agent(ctx.app);
    const good = await agent.post("/api/auth/sign-in/email").set("origin", BASE_URL).send({ email, password });
    expect(good.status).toBe(200);
    expect((await agent.get("/api/me")).status).toBe(200);

    const out = await agent.post("/api/auth/sign-out").set("origin", BASE_URL).send({});
    expect(out.status).toBe(200);
    expect((await agent.get("/api/me")).status).toBe(401);
  });

  it("does not store the passcode in plain text", async () => {
    const { userId, password } = await signUpAgent(ctx.app);
    const rows = await ctx.handle.db.query.account.findMany({ where: (a, { eq: e }) => e(a.userId, userId) });
    expect(rows[0]?.password).toBeTruthy();
    expect(rows[0]?.password).not.toContain(password);
  });
});

describe("authentication rate limiting", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await makeTestApp({ window: 60, max: 5 });
  });
  afterAll(() => ctx.handle.close());

  it("returns 429 after 5 sign-in attempts per minute from one client", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await request(ctx.app)
        .post("/api/auth/sign-in/email")
        .set("origin", BASE_URL)
        .send({ email: "nobody@example.test", password: "wrong passcode!!" });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(statuses[5]).toBe(429);
  });

  it("ignores a client-supplied IP header (cannot reset its own limit)", async () => {
    const res = await request(ctx.app)
      .post("/api/auth/sign-in/email")
      .set("origin", BASE_URL)
      .set("x-relay-client-ip", "203.0.113.9")
      .set("x-forwarded-for", "203.0.113.9")
      .send({ email: "nobody@example.test", password: "wrong passcode!!" });
    expect(res.status).toBe(429);
  });
});
