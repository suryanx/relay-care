import type { NotificationType } from "../db/schema.js";

/**
 * Email wording for every notification type. Pure functions, no database access.
 *
 * Content rules: no medicine names, no doctor names, no dosing advice. Emails only say that
 * something needs attention and link back to Relay, where the signed-in reader sees details.
 */

export interface Content {
  subject: string;
  text: string;
}

/** Values a template may use. Only the elder's preferred name, times, dates, a link and a reporter's name. */
export interface ContentValues {
  name: string;
  time?: string;
  date?: string;
  link: string;
  reporter?: string;
}

export const FOOTER =
  "Relay helps families stay in touch. It does not give medical advice and does not replace a doctor, pharmacist or emergency services.";

export function renderContent(type: NotificationType, v: ContentValues): Content {
  switch (type) {
    case "dose_reminder":
      return {
        subject: `Medicine reminder: ${v.name} at ${v.time}`,
        text: `${v.name} has a medicine scheduled for ${v.time} today.\n\nOpen Relay to see the details: ${v.link}`,
      };
    case "dose_snooze_reminder":
      return {
        subject: `Reminder again: ${v.name}'s ${v.time} medicine`,
        text: `${v.name} asked to be reminded again about the medicine scheduled for ${v.time}. The scheduled time has not changed.\n\nOpen Relay: ${v.link}`,
      };
    case "dose_unconfirmed":
      return {
        subject: `Unconfirmed: ${v.name}'s ${v.time} medicine`,
        text: `No one has confirmed yet whether ${v.name} took the medicine scheduled for ${v.time}. Unconfirmed does not mean missed — it has simply not been confirmed. You may want to check in.\n\nRecord what happened in Relay: ${v.link}`,
      };
    case "dose_not_taken":
      return {
        subject: `Reported not taken: ${v.name}'s ${v.time} medicine`,
        text: `${v.reporter ?? "Someone"} reported in Relay that the medicine scheduled for ${v.time} was not taken. This was reported, not assumed. If you are unsure what to do, please ask the pharmacist or doctor.\n\nOpen Relay: ${v.link}`,
      };
    case "appointment_reminder":
      return {
        subject: `Appointment reminder: ${v.name}, ${v.date} at ${v.time}`,
        text: `${v.name} has a doctor's appointment on ${v.date} at ${v.time}.\n\nSee the details in Relay: ${v.link}`,
      };
    case "help_request":
      return {
        subject: `${v.name} asked for help in Relay`,
        text: `${v.name} pressed "I need help" in Relay. Please check in with them. If this could be an emergency, contact local emergency services.\n\nOpen Relay: ${v.link}`,
      };
  }
}

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);

/** The message handed to an email provider: plain text and escaped HTML, both ending with the footer. */
export function buildEmail(to: string, content: Content) {
  const paragraphs = content.text
    .split("\n\n")
    .map((p) => `<p>${escapeHtml(p)}</p>`)
    .join("");
  return {
    to,
    subject: content.subject,
    text: `${content.text}\n\n${FOOTER}`,
    html: `${paragraphs}<p style="color:#666;font-size:12px">${escapeHtml(FOOTER)}</p>`,
  };
}

/** What the Notification Center stores and shows: the subject and the first paragraph (capped). */
export const storedSummary = (c: Content) => ({ subject: c.subject, preview: c.text.split("\n\n")[0]!.slice(0, 240) });
