import { BrevoEmailProvider } from "./brevo.js";
import { ConsoleEmailProvider } from "./console.js";
import type { EmailProvider } from "./types.js";

export interface EmailEnv {
  NODE_ENV?: string;
  EMAIL_PROVIDER?: "console" | "brevo";
  BREVO_API_KEY?: string;
  EMAIL_FROM?: string;
  EMAIL_FROM_NAME?: string;
}

/**
 * Chooses the email provider from configuration.
 * - Tests always use the console provider.
 * - EMAIL_PROVIDER=brevo requires BREVO_API_KEY and EMAIL_FROM (fails loudly otherwise).
 * - With no explicit choice, Brevo is used only when fully configured.
 */
export function selectEmailProvider(env: EmailEnv): EmailProvider {
  if (env.NODE_ENV === "test") return new ConsoleEmailProvider(() => {});

  const brevoReady = Boolean(env.BREVO_API_KEY && env.EMAIL_FROM);
  if (env.EMAIL_PROVIDER === "brevo" && !brevoReady) {
    throw new Error("EMAIL_PROVIDER=brevo requires BREVO_API_KEY and EMAIL_FROM.");
  }
  if (env.EMAIL_PROVIDER === "console" || !brevoReady) return new ConsoleEmailProvider();

  return new BrevoEmailProvider({
    apiKey: env.BREVO_API_KEY!,
    fromEmail: env.EMAIL_FROM!,
    fromName: env.EMAIL_FROM_NAME ?? "Relay Care",
  });
}

export * from "./types.js";
export { BrevoEmailProvider, ConsoleEmailProvider };

export interface NotifierEnv extends EmailEnv {
  REAL_EMAIL_SEND_ENABLED?: "true" | "false";
}

/**
 * Real sending requires BOTH an explicit REAL_EMAIL_SEND_ENABLED=true AND a configured Brevo key.
 * A Brevo key alone never causes background sending. Tests are always preview-only.
 */
export function resolveRealSending(env: NotifierEnv): { realSendEnabled: boolean; provider: EmailProvider } {
  const console = new ConsoleEmailProvider(() => {});
  if (env.NODE_ENV === "test" || env.REAL_EMAIL_SEND_ENABLED !== "true") return { realSendEnabled: false, provider: console };
  if (!env.BREVO_API_KEY || !env.EMAIL_FROM) {
    throw new Error("REAL_EMAIL_SEND_ENABLED=true requires BREVO_API_KEY and EMAIL_FROM.");
  }
  return {
    realSendEnabled: true,
    provider: new BrevoEmailProvider({ apiKey: env.BREVO_API_KEY, fromEmail: env.EMAIL_FROM, fromName: env.EMAIL_FROM_NAME ?? "Relay Care" }),
  };
}
