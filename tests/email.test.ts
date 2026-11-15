import { describe, expect, it, vi } from "vitest";
import { BrevoEmailProvider, ConsoleEmailProvider, EmailSendError, selectEmailProvider } from "../src/server/email/index.js";

const brevoEnv = { NODE_ENV: "development", BREVO_API_KEY: "xkeysib-test", EMAIL_FROM: "relay@example.test" };

describe("email provider selection", () => {
  it("always uses the console provider under test", () => {
    expect(selectEmailProvider({ ...brevoEnv, NODE_ENV: "test" }).name).toBe("console");
  });
  it("uses console when Brevo is not configured", () => {
    expect(selectEmailProvider({ NODE_ENV: "development" }).name).toBe("console");
  });
  it("uses Brevo when fully configured", () => {
    expect(selectEmailProvider(brevoEnv).name).toBe("brevo");
  });
  it("honours an explicit console choice even when Brevo keys exist", () => {
    expect(selectEmailProvider({ ...brevoEnv, EMAIL_PROVIDER: "console" }).name).toBe("console");
  });
  it("fails loudly when Brevo is requested without credentials", () => {
    expect(() => selectEmailProvider({ NODE_ENV: "production", EMAIL_PROVIDER: "brevo" })).toThrow(/BREVO_API_KEY/);
  });
});

describe("ConsoleEmailProvider", () => {
  it("records the message and reports that nothing was sent externally", async () => {
    const provider = new ConsoleEmailProvider(() => {});
    const result = await provider.send({ to: "a@example.test", subject: "Hi", text: "Hello" });
    expect(result).toEqual({ provider: "console", accepted: true, externalRequest: false });
    expect(provider.sent).toHaveLength(1);
  });
});

describe("BrevoEmailProvider", () => {
  it("posts the documented payload and returns the provider message id", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ messageId: "<abc@brevo>" }), { status: 201 }));
    const provider = new BrevoEmailProvider({ apiKey: "xkeysib-test", fromEmail: "relay@example.test", fromName: "Relay", fetchImpl });

    const result = await provider.send({ to: "family@example.test", subject: "Reminder", text: "Body", html: "<p>Body</p>" });

    expect(result).toEqual({ provider: "brevo", accepted: true, externalRequest: true, providerMessageId: "<abc@brevo>" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.brevo.com/v3/smtp/email");
    expect((init.headers as Record<string, string>)["api-key"]).toBe("xkeysib-test");
    expect(JSON.parse(init.body as string)).toEqual({
      sender: { email: "relay@example.test", name: "Relay" },
      to: [{ email: "family@example.test" }],
      subject: "Reminder",
      textContent: "Body",
      htmlContent: "<p>Body</p>",
    });
  });

  it("throws EmailSendError with the status (and no API key) when Brevo rejects", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"message":"unauthorized"}', { status: 401 }));
    const provider = new BrevoEmailProvider({ apiKey: "xkeysib-secret", fromEmail: "r@example.test", fromName: "R", fetchImpl });
    const err = await provider.send({ to: "x@example.test", subject: "s", text: "t" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmailSendError);
    expect((err as EmailSendError).status).toBe(401);
    expect((err as Error).message).not.toContain("xkeysib-secret");
  });
});
