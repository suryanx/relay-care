export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Result of handing a message to a provider.
 * `accepted` means the provider accepted the request — it is NOT proof of delivery.
 */
export interface SendResult {
  provider: "console" | "brevo";
  accepted: boolean;
  /** True only when a real external API request was made. */
  externalRequest: boolean;
  providerMessageId?: string;
}

export interface EmailProvider {
  readonly name: SendResult["provider"];
  send(message: EmailMessage): Promise<SendResult>;
}

export class EmailSendError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}
