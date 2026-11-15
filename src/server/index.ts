import { randomBytes } from "node:crypto";
import { createApp, serveStaticWeb } from "./app.js";
import { createAuth } from "./auth.js";
import { loadEnv } from "./config.js";
import { openDatabase } from "./db/client.js";
import { resolveRealSending } from "./email/index.js";

async function main() {
  const env = loadEnv();
  const isProd = env.NODE_ENV === "production";

  const handle = await openDatabase(
    env.DATABASE_URL ? { kind: "postgres", url: env.DATABASE_URL } : { kind: "pglite", dataDir: ".data/pglite" },
  );

  let secret = env.BETTER_AUTH_SECRET;
  if (!secret) {
    // Development only (production refuses to start without it, see loadEnv). Sessions reset on restart.
    secret = randomBytes(32).toString("base64url");
    console.warn("[relay] BETTER_AUTH_SECRET not set — using an ephemeral development secret.");
  }

  const auth = createAuth({ db: handle.db, baseURL: env.BETTER_AUTH_URL, secret });
  const { realSendEnabled, provider } = resolveRealSending(env);
  const app = createApp({
    db: handle.db,
    auth,
    baseURL: env.BETTER_AUTH_URL,
    trustProxy: env.TRUST_PROXY === "1",
    devMode: !isProd,
    sweepSecret: env.SWEEP_SECRET,
    demoSecret: secret,
    notifier: {
      provider,
      realSendEnabled,
      realSendCap: env.EMAIL_REAL_SEND_CAP,
      maxPerSweep: env.SWEEP_MAX_PER_RUN,
      maxPerProfilePerSweep: env.SWEEP_MAX_PER_PROFILE,
      appUrl: env.BETTER_AUTH_URL,
    },
  });
  // No in-process polling loop: reminders run only when /internal/sweep (or the admin check) is called.
  console.info(`[relay] email mode: ${realSendEnabled ? `REAL (cap ${env.EMAIL_REAL_SEND_CAP})` : "preview (no emails sent)"}; sweep endpoint ${env.SWEEP_SECRET ? "enabled" : "disabled"}`);

  if (isProd) {
    serveStaticWeb(app);
  } else {
    const { createServer } = await import("vite");
    const vite = await createServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  }

  const server = app.listen(env.PORT, () => {
    console.info(`[relay] ${env.NODE_ENV} server on http://localhost:${env.PORT} (db: ${handle.kind})`);
  });

  const shutdown = () => {
    server.close(() => {
      handle.close().finally(() => process.exit(0));
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("[relay] failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});
