import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/server/app.js";
import { createAuth, type AuthRateLimit } from "../src/server/auth.js";
import { openDatabase, type DatabaseHandle } from "../src/server/db/client.js";

export const BASE_URL = "http://localhost:3000";

export interface TestContext {
  app: Express;
  handle: DatabaseHandle;
}

/** Fresh in-memory PGlite database + app per suite. */
export async function makeTestApp(credentialRateLimit: AuthRateLimit = { window: 60, max: 1000 }): Promise<TestContext> {
  const handle = await openDatabase({ kind: "pglite" });
  const auth = createAuth({
    db: handle.db,
    baseURL: BASE_URL,
    secret: "test-secret-test-secret-test-secret-123",
    credentialRateLimit,
  });
  const app = createApp({ db: handle.db, auth, baseURL: BASE_URL });
  return { app, handle };
}

let counter = 0;
export const uniqueEmail = (prefix = "admin") => `${prefix}.${Date.now()}.${++counter}@example.test`;

/** Signs up a family administrator and returns a cookie-carrying agent. */
export async function signUpAgent(app: Express, email = uniqueEmail(), password = "correct horse battery") {
  const agent = request.agent(app);
  const res = await agent
    .post("/api/auth/sign-up/email")
    .set("origin", BASE_URL)
    .send({ name: "Priya Test", email, password });
  if (res.status !== 200) throw new Error(`sign-up failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { agent, email, password, userId: res.body.user.id as string };
}

export const syntheticProfile = {
  fullName: "Swastik Demo",
  preferredName: "Swastik",
  timezone: "Asia/Kolkata",
  consentBasis: "elder_consented",
  consentStatement: "Swastik agreed on 14 Nov (synthetic demo record).",
} as const;
