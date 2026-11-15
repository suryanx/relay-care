import { EmailSendError, type EmailMessage, type EmailProvider, type SendResult } from "./types.js";

const BREVO_ENDPOINT = "https://api.brevo.com/v3/smtp/email";

export interface BrevoConfig {
  apiKey: string;
  fromEmail: string;
  fromName: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Brevo transactional email over HTTPS (works on any host; no SMTP ports needed). */
export class BrevoEmailProvider implements EmailProvider {
  readonly name = "brevo" as const;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: BrevoConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async send(message: EmailMessage): Promise<SendResult> {
    const response = await this.fetchImpl(BREVO_ENDPOINT, {
      method: "POST",
      headers: {
        "api-key": this.config.apiKey,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        sender: { email: this.config.fromEmail, name: this.config.fromName },
        to: [{ email: message.to }],
        subject: message.subject,
        textContent: message.text,
        ...(message.html ? { htmlContent: message.html } : {}),
      }),
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 10_000),
    });

    if (!response.ok) {
      // Never echo the API key; include only status and provider error text.
      const detail = await response.text().catch(() => "");
      throw new EmailSendError(`Brevo rejected the request (HTTP ${response.status}): ${detail.slice(0, 300)}`, response.status);
    }
    const body = (await response.json().catch(() => ({}))) as { messageId?: string };
    return { provider: "brevo", accepted: true, externalRequest: true, providerMessageId: body.messageId };
  }
}
