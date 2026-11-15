import { existsSync } from "node:fs";
import { z } from "zod";

if (existsSync(".env")) process.loadEnvFile(".env");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  BETTER_AUTH_URL: z.url().default("http://localhost:3000"),
  BETTER_AUTH_SECRET: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  EMAIL_PROVIDER: z.enum(["console", "brevo"]).optional(),
  BREVO_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  EMAIL_FROM_NAME: z.string().default("Relay Care"),
  TRUST_PROXY: z.enum(["0", "1"]).default("0"),
});

export type Env = z.infer<typeof envSchema>;

/** Parses the environment and enforces production-only safety rules. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // Treat empty strings from .env as "unset".
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ""));
  const env = envSchema.parse(cleaned);

  if (env.NODE_ENV === "production") {
    if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required in production (PGlite is dev/test only).");
    if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32) {
      throw new Error("BETTER_AUTH_SECRET must be set to at least 32 characters in production.");
    }
  }
  return env;
}
