/**
 * Sends one test email through the configured provider.
 *   npm run email:test -- someone@example.com
 * Reports honestly: which provider ran, whether an external API request was made,
 * and that provider acceptance is not proof of delivery.
 */
import { loadEnv } from "../src/server/config.js";
import { selectEmailProvider } from "../src/server/email/index.js";

const to = process.argv[2];
if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
  console.error("Usage: npm run email:test -- recipient@example.com");
  process.exit(2);
}

const env = loadEnv();
const provider = selectEmailProvider(env);
console.info(`Provider selected: ${provider.name}`);

try {
  const result = await provider.send({
    to,
    subject: "Relay test email",
    text: "This is a test message from Relay (synthetic data only). If you received it, email sending works.",
    html: "<p>This is a test message from <strong>Relay</strong> (synthetic data only).</p><p>If you received it, email sending works.</p>",
  });
  if (!result.externalRequest) {
    console.info("RESULT: console provider used — NO external email was sent.");
    console.info("STATUS: external email verification PENDING (set BREVO_API_KEY and a Brevo-verified EMAIL_FROM in .env).");
  } else {
    console.info(`RESULT: Brevo accepted the request (messageId: ${result.providerMessageId ?? "n/a"}).`);
    console.info("STATUS: accepted by provider — delivery NOT confirmed. Check the recipient inbox (and spam folder).");
  }
} catch (err) {
  console.error(`RESULT: send FAILED — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
