import type { EmailMessage, EmailProvider, SendResult } from "./types.js";

/** Development/test provider: records messages in memory and logs a short line. Sends nothing. */
export class ConsoleEmailProvider implements EmailProvider {
  readonly name = "console" as const;
  readonly sent: EmailMessage[] = [];

  constructor(private readonly log: (line: string) => void = (line) => console.info(line)) {}

  async send(message: EmailMessage): Promise<SendResult> {
    this.sent.push(message);
    this.log(`[email:console] to=${message.to} subject="${message.subject}" (not sent externally)`);
    return { provider: "console", accepted: true, externalRequest: false };
  }
}
