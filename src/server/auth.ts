import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { username } from "better-auth/plugins";
import type { Database } from "./db/client.js";
import { schema } from "./db/schema.js";

/** Header our own server sets from Express's resolved client IP (client-sent values are overwritten). */
export const CLIENT_IP_HEADER = "x-relay-client-ip";

export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // elder devices: 30 days, renewed on use
export const FAMILY_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // admins/caregivers: re-sign-in weekly
export const SESSION_RENEW_AFTER_SECONDS = 60 * 60 * 24; // extend at most once a day
export const FRESH_SESSION_SECONDS = 60 * 15; // sensitive actions need a sign-in within 15 min

export interface AuthRateLimit {
  window: number;
  max: number;
}

export interface CreateAuthOptions {
  db: Database;
  baseURL: string;
  secret: string;
  /** Limit for sign-in / sign-up attempts per client IP. */
  credentialRateLimit?: AuthRateLimit;
}

export const DEFAULT_CREDENTIAL_RATE_LIMIT: AuthRateLimit = { window: 60, max: 5 };

export function createAuth({ db, baseURL, secret, credentialRateLimit = DEFAULT_CREDENTIAL_RATE_LIMIT }: CreateAuthOptions) {
  return betterAuth({
    baseURL,
    secret,
    database: drizzleAdapter(db, { provider: "pg", schema }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      maxPasswordLength: 128,
      autoSignIn: true,
    },
    plugins: [username({ minUsernameLength: 3, maxUsernameLength: 32 })],
    session: {
      expiresIn: SESSION_TTL_SECONDS,
      updateAge: SESSION_RENEW_AFTER_SECONDS,
      freshAge: FRESH_SESSION_SECONDS,
    },
    rateLimit: {
      // Enabled in every environment (Better Auth defaults to production-only).
      enabled: true,
      storage: "database",
      modelName: "rateLimit",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/*": credentialRateLimit,
        "/sign-up/*": credentialRateLimit,
      },
    },
    advanced: {
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
      useSecureCookies: baseURL.startsWith("https://"),
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax" },
    },
    telemetry: { enabled: false },
  });
}

export type Auth = ReturnType<typeof createAuth>;
