import path from "node:path";
import express, { type ErrorRequestHandler, type Express } from "express";
import helmet from "helmet";
import { toNodeHandler } from "better-auth/node";
import { ZodError } from "zod";
import { CLIENT_IP_HEADER, type Auth } from "./auth.js";
import { HttpError } from "./authz.js";
import type { Database } from "./db/client.js";
import { adherenceRoutes } from "./routes/adherence.js";
import { carePlanRoutes } from "./routes/carePlan.js";
import { profileRoutes } from "./routes/profiles.js";

export interface CreateAppOptions {
  db: Database;
  auth: Auth;
  /** Public origin, used to reject cross-origin state-changing requests. */
  baseURL: string;
  trustProxy?: boolean;
  /** Content Security Policy is relaxed only for the Vite dev server. */
  devMode?: boolean;
}

/** Builds the Express app (no listening, no frontend) so tests can drive it directly. */
export function createApp({ db, auth, baseURL, trustProxy = false, devMode = false }: CreateAppOptions): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", trustProxy ? 1 : false);

  app.use(helmet({ contentSecurityPolicy: devMode ? false : undefined }));

  // Give Better Auth a client IP for rate limiting that the client cannot spoof:
  // overwrite any incoming value with Express's resolved address.
  app.use((req, _res, next) => {
    req.headers[CLIENT_IP_HEADER] = req.ip ?? req.socket.remoteAddress ?? "";
    next();
  });

  // Better Auth must see the raw body, so it is mounted before express.json().
  app.all("/api/auth/{*splat}", toNodeHandler(auth));

  app.use(express.json({ limit: "100kb" }));

  // Reject cross-origin state-changing requests to our own API (defence in depth beyond SameSite cookies).
  const allowedOrigin = new URL(baseURL).origin;
  app.use("/api", (req, _res, next) => {
    const origin = req.get("origin");
    if (req.method !== "GET" && req.method !== "HEAD" && origin && origin !== allowedOrigin) {
      next(new HttpError(403, "BAD_ORIGIN", "Cross-origin request rejected."));
      return;
    }
    next();
  });

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/api", profileRoutes(db, auth));
  app.use("/api", carePlanRoutes(db, auth));
  app.use("/api", adherenceRoutes(db, auth));

  app.use("/api", (_req, _res, next) => next(new HttpError(404, "NOT_FOUND", "Not found.")));

  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    if (err instanceof ZodError) {
      res.status(400).json({
        error: {
          code: "VALIDATION_FAILED",
          message: "Please check the highlighted fields.",
          fields: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      });
      return;
    }
    if (err instanceof SyntaxError && "body" in err) {
      res.status(400).json({ error: { code: "BAD_JSON", message: "Malformed JSON body." } });
      return;
    }
    console.error("[error]", err instanceof Error ? err.message : err);
    res.status(500).json({ error: { code: "INTERNAL", message: "Something went wrong." } });
  };
  app.use(errorHandler);

  return app;
}

/** Serves the built React app with SPA fallback (production). */
export function serveStaticWeb(app: Express, distDir = path.resolve("dist/web")): void {
  app.use(express.static(distDir, { index: false, maxAge: "1h" }));
  app.get(/^\/(?!api\/|healthz).*/, (_req, res) => {
    res.sendFile(path.join(distDir, "index.html"));
  });
}
