import { gte, sql } from "drizzle-orm";
import { Router, type Request } from "express";
import { z } from "zod";
import type { Auth } from "../auth.js";
import { HttpError, asyncHandler } from "../authz.js";
import type { Database } from "../db/client.js";
import { demoSandboxes } from "../db/schema.js";
import { DEMO_PERSONAS, SANDBOX_TTL_HOURS, createSandbox, findSandbox, landingPath, signInAs } from "../services/demoSandbox.js";

const COOKIE = "relay_demo";
const startSchema = z.object({ role: z.enum(DEMO_PERSONAS) });

/** Small per-IP limiter for sandbox creation (persona switching within a sandbox is not limited). */
const PER_IP_LIMIT = 5;
const PER_IP_WINDOW_MS = 10 * 60_000;
const GLOBAL_PER_HOUR = 300;
/** Per-IP limiter (per app instance). Uses Express's resolved client IP, never a client-supplied header. */
function createLimiter() {
  const recent = new Map<string, number[]>();
  return (ip: string, now: number): boolean => {
    const list = (recent.get(ip) ?? []).filter((t) => now - t < PER_IP_WINDOW_MS);
    if (list.length >= PER_IP_LIMIT) {
      recent.set(ip, list);
      return false;
    }
    list.push(now);
    recent.set(ip, list);
    if (recent.size > 10_000) recent.clear(); // bound memory
    return true;
  };
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

export function demoRoutes(db: Database, auth: Auth, secret: string | undefined, baseURL: string): Router {
  const router = Router();
  const secure = baseURL.startsWith("https://");
  const allowCreate = createLimiter();

  /**
   * Opens the interactive demo as Swastik, Ravi or Priya inside the visitor's OWN synthetic care circle.
   * Reuses the circle from the visitor's demo cookie, or creates a new one (rate-limited).
   */
  router.post(
    "/demo/start",
    asyncHandler(async (req, res) => {
      if (!secret) throw new HttpError(503, "DEMO_DISABLED", "The interactive demo is not available.");
      const { role } = startSchema.parse(req.body);
      const now = new Date();

      let sandbox = await findSandbox(db, readCookie(req, COOKIE), now);
      if (!sandbox) {
        if (!allowCreate(req.ip ?? "unknown", now.getTime())) {
          throw new HttpError(429, "DEMO_RATE_LIMITED", "Too many demos started from here. Please wait a few minutes.");
        }
        const [{ n }] = (await db
          .select({ n: sql<number>`count(*)::int` })
          .from(demoSandboxes)
          .where(gte(demoSandboxes.createdAt, new Date(now.getTime() - 3_600_000)))) as [{ n: number }];
        if (n >= GLOBAL_PER_HOUR) throw new HttpError(429, "DEMO_BUSY", "The demo is busy right now. Please try again shortly.");
        const created = await createSandbox(db, auth, secret, now);
        sandbox = created.sandbox;
        res.append(
          "Set-Cookie",
          `${COOKIE}=${encodeURIComponent(created.token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SANDBOX_TTL_HOURS * 3600}${secure ? "; Secure" : ""}`,
        );
      }

      for (const c of await signInAs(auth, secret, sandbox, role)) res.append("Set-Cookie", c);
      res.json({ redirect: landingPath(sandbox, role) });
    }),
  );

  /** Forgets the visitor's demo circle in this browser (the client signs out separately). */
  router.post("/demo/end", (_req, res) => {
    res.append("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`);
    res.json({ ended: true });
  });

  return router;
}

