import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serveStaticWeb } from "../src/server/app.js";
import { makeTestApp, type TestContext } from "./helpers.js";

describe("production static serving", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await makeTestApp();
    const dir = mkdtempSync(path.join(tmpdir(), "relay-web-"));
    writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Relay</title>");
    serveStaticWeb(ctx.app, dir);
  });
  afterAll(() => ctx.handle.close());

  it("serves the SPA shell for client-side routes", async () => {
    const res = await request(ctx.app).get("/profiles/abc");
    expect(res.status).toBe(200);
    expect(res.text).toContain("<title>Relay</title>");
  });

  it("does not let the SPA fallback swallow unknown API routes", async () => {
    const res = await request(ctx.app).get("/api/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("sends security headers", async () => {
    const res = await request(ctx.app).get("/healthz");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBeDefined();
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
});
