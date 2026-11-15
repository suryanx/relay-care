import { describe, expect, it } from "vitest";
import { NOTIFICATION_TYPES } from "../src/server/db/schema.js";
import { FOOTER, buildEmail, renderContent, storedSummary } from "../src/server/services/notificationContent.js";
import { EmailSendError } from "../src/server/email/types.js";
import { MAX_ATTEMPTS, classifySendFailure, staleDoseReason } from "../src/server/services/notifications.js";

describe("send-time staleness rules for dose notifications", () => {
  const dose = (status: "scheduled" | "taken" | "not_taken" | "unconfirmed" | "void", snoozeCount = 0) => ({ status, snoozeCount });

  it("a reminder is valid only for a scheduled, un-snoozed dose", () => {
    expect(staleDoseReason("dose_reminder", dose("scheduled"))).toBeNull();
    expect(staleDoseReason("dose_reminder", dose("scheduled", 1))).toBe("superseded_by_snooze");
    expect(staleDoseReason("dose_reminder", dose("taken"))).toBe("dose_taken");
  });

  it("a snooze reminder is valid while the dose is still scheduled", () => {
    expect(staleDoseReason("dose_snooze_reminder", dose("scheduled", 2))).toBeNull();
    expect(staleDoseReason("dose_snooze_reminder", dose("void"))).toBe("dose_void");
  });

  it("an Unconfirmed alert is withdrawn once anyone records an outcome", () => {
    expect(staleDoseReason("dose_unconfirmed", dose("unconfirmed"))).toBeNull();
    expect(staleDoseReason("dose_unconfirmed", dose("taken"))).toBe("now_taken");
  });

  it("a Not Taken alert is withdrawn if the report is corrected", () => {
    expect(staleDoseReason("dose_not_taken", dose("not_taken"))).toBeNull();
    expect(staleDoseReason("dose_not_taken", dose("taken"))).toBe("corrected_to_taken");
  });

  it("non-dose types have no dose rule", () => {
    expect(staleDoseReason("appointment_reminder", dose("taken"))).toBeNull();
  });
});

describe("email content", () => {
  const values = { name: "Swastik", time: "08:00", date: "Mon 16 Nov", link: "https://relay.example.test/x", reporter: "Ravi" };

  it("every type renders a subject and body that never mention a medicine or doctor", () => {
    for (const type of NOTIFICATION_TYPES) {
      const c = renderContent(type, values);
      expect(c.subject.length).toBeGreaterThan(0);
      expect(c.text).toContain(values.link);
      expect(`${c.subject} ${c.text}`).not.toMatch(/Amlodipine|Metformin|Dr\.|mg\b/);
    }
  });

  it("escapes HTML and appends the footer to both parts", () => {
    const email = buildEmail("ravi@example.test", { subject: "S", text: `<script>alert("x")</script>\n\nSecond & last` });
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(email.html).toContain("Second &amp; last");
    expect(email.text.endsWith(FOOTER)).toBe(true);
    expect(email.html).toContain(FOOTER);
  });

  it("stores only the subject and the first paragraph, capped at 240 characters", () => {
    const s = storedSummary({ subject: "S", text: `${"a".repeat(300)}\n\nlink` });
    expect(s).toEqual({ subject: "S", preview: "a".repeat(240) });
  });
});

describe("send-failure policy", () => {
  it("retries rate limits and server errors with backoff, up to the attempt limit", () => {
    expect(classifySendFailure(new EmailSendError("busy", 429), 1)).toEqual({ status: "queued", retryInMinutes: 2 });
    expect(classifySendFailure(new EmailSendError("down", 503), 2)).toEqual({ status: "queued", retryInMinutes: 4 });
    expect(classifySendFailure(new EmailSendError("down", 503), MAX_ATTEMPTS)).toEqual({ status: "failed" });
  });

  it("fails other provider rejections without retrying", () => {
    expect(classifySendFailure(new EmailSendError("bad key", 401), 1)).toEqual({ status: "failed" });
    expect(classifySendFailure(new EmailSendError("bad request", 400), 1)).toEqual({ status: "failed" });
  });

  it("treats a missing answer (timeout or network error) as uncertain, never retried", () => {
    expect(classifySendFailure(new EmailSendError("timed out"), 1)).toEqual({ status: "uncertain" });
    expect(classifySendFailure(new TypeError("fetch failed"), 1)).toEqual({ status: "uncertain" });
    expect(classifySendFailure("weird", 1)).toEqual({ status: "uncertain" });
  });
});
