import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { eq, inArray, lt } from "drizzle-orm";
import { DateTime } from "luxon";
import type { Auth } from "../auth.js";
import type { Database } from "../db/client.js";
import { appointments, demoSandboxes, helpRequests, incidents, medications, profileMembers, profiles, routines, session, user } from "../db/schema.js";
import { markOverdueUnconfirmed } from "./adherence.js";
import { claimIncident, syncIncidents } from "./incidents.js";
import { generateDosesForProfile } from "./schedule.js";

/**
 * Interactive demo: every visitor gets a PRIVATE synthetic care circle inside the real app.
 * - Accounts use @demo.relay.invalid addresses, which the email rules never send to.
 * - Passwords are derived with HMAC(server secret, sandbox, persona): never shown, never stored.
 * - A sandbox is only reachable through the HttpOnly demo cookie that created it, and is deleted after 24 h.
 */

export const DEMO_PERSONAS = ["elder", "caregiver", "family"] as const;
export type DemoPersona = (typeof DEMO_PERSONAS)[number];
export const DEMO_DOMAIN = "demo.relay.invalid";
export const SANDBOX_TTL_HOURS = 24;
const ZONE = "Asia/Kolkata";

export type SandboxRow = typeof demoSandboxes.$inferSelect;

export const hashDemoToken = (t: string) => createHash("sha256").update(t).digest("hex");
const derivePassword = (secret: string, sandboxId: string, who: string) => createHmac("sha256", secret).update(`relay-demo:${sandboxId}:${who}`).digest("base64url");
const emailFor = (sandboxId: string, who: string) => `${who}-${sandboxId}@${DEMO_DOMAIN}`;
const elderUsername = (sandboxId: string) => `demo_${sandboxId}`;

export const isDemoEmail = (email: string | null | undefined) => Boolean(email?.toLowerCase().endsWith(`@${DEMO_DOMAIN}`));

/** Creates the synthetic care circle. Returns the sandbox row and the raw cookie token (shown once). */
export async function createSandbox(db: Database, auth: Auth, secret: string, now: Date = new Date()): Promise<{ sandbox: SandboxRow; token: string }> {
  const sandboxId = randomUUID().replaceAll("-", "").slice(0, 16);
  const signUp = async (name: string, who: string, username?: string) => {
    const res = await auth.api.signUpEmail({
      body: { name, email: emailFor(sandboxId, who), password: derivePassword(secret, sandboxId, who), ...(username ? { username } : {}) },
    });
    await db.delete(session).where(eq(session.userId, res.user.id)); // sign-up session not needed
    return res.user.id;
  };

  const adminId = await signUp("Priya (demo)", "priya");
  const raviId = await signUp("Ravi (demo)", "ravi");
  const meeraId = await signUp("Meera (demo)", "meera");
  const elderId = await signUp("Swastik", "swastik", elderUsername(sandboxId));

  const local = DateTime.fromJSDate(now, { zone: ZONE });
  const yesterday = local.minus({ days: 1 }).toISODate()!;
  const [profile] = await db
    .insert(profiles)
    .values({
      fullName: "Swastik Sharma (demo)",
      preferredName: "Swastik",
      timezone: ZONE,
      consentBasis: "elder_consented",
      consentStatement: "Synthetic demo record. No real person is involved.",
      consentRecordedBy: adminId,
      createdBy: adminId,
      elderUserId: elderId,
    })
    .returning();
  const profileId = profile!.id;
  await db.insert(profileMembers).values([
    { profileId, userId: adminId, role: "admin" },
    { profileId, userId: raviId, role: "caregiver" },
    { profileId, userId: meeraId, role: "caregiver" },
    { profileId, userId: elderId, role: "elder" },
  ]);

  const hhmm = (d: DateTime) => d.toFormat("HH:mm");
  await db.insert(medications).values([
    // Due now: the elder can confirm it immediately.
    {
      profileId,
      name: "Amlodipine",
      strength: "5 mg",
      instructions: "One tablet",
      times: [hhmm(local.plus({ minutes: 10 }))],
      startDate: yesterday,
      scheduleEffectiveFrom: now,
      reminderLeadMinutes: 15,
      createdBy: adminId,
      updatedBy: adminId,
    },
    // Two hours ago with no answer: becomes Unconfirmed and opens a follow-up.
    {
      profileId,
      name: "Metformin",
      strength: "500 mg",
      instructions: "One tablet with a meal",
      times: [hhmm(local.minus({ hours: 2 }))],
      startDate: yesterday,
      scheduleEffectiveFrom: new Date(now.getTime() - 3 * 3_600_000),
      createdBy: adminId,
      updatedBy: adminId,
    },
    // Later today.
    {
      profileId,
      name: "Atorvastatin",
      strength: "10 mg",
      instructions: "One tablet at bedtime",
      times: [hhmm(local.plus({ hours: 6 }))],
      startDate: yesterday,
      scheduleEffectiveFrom: now,
      createdBy: adminId,
      updatedBy: adminId,
    },
  ]);
  await db.insert(routines).values({
    profileId,
    title: "Drink a glass of water",
    times: [hhmm(local.plus({ minutes: 40 }))],
    startDate: yesterday,
    scheduleEffectiveFrom: now,
    createdBy: adminId,
    updatedBy: adminId,
  });
  await db.insert(appointments).values({
    profileId,
    doctorName: "Dr. Anjali Rao",
    specialty: "Cardiology",
    location: "Lakeside Clinic, Room 4 (fictional)",
    startsAt: local.plus({ days: 3 }).set({ hour: 10, minute: 30, second: 0, millisecond: 0 }).toJSDate(),
    createdBy: adminId,
    updatedBy: adminId,
  });
  const [help] = await db
    .insert(helpRequests)
    .values({ profileId, requestedBy: elderId, note: "My knee hurts on the stairs", createdAt: new Date(now.getTime() - 40 * 60_000) })
    .returning();

  await generateDosesForProfile(db, profileId, now);
  await markOverdueUnconfirmed(db, now, profileId);
  await syncIncidents(db, now, profileId);
  // Meera is already handling the help request, so visitors see shared ownership in action.
  const [helpIncident] = await db.select().from(incidents).where(eq(incidents.sourceId, help!.id));
  if (helpIncident) await claimIncident(db, profileId, helpIncident.id, { userId: meeraId, role: "caregiver" }, now);

  const token = randomBytes(32).toString("base64url");
  const [sandbox] = await db
    .insert(demoSandboxes)
    .values({ id: sandboxId, tokenHash: hashDemoToken(token), profileId, adminUserId: adminId, caregiverUserId: raviId, otherCaregiverUserId: meeraId, elderUserId: elderId, createdAt: now })
    .returning();
  return { sandbox: sandbox!, token };
}

export async function findSandbox(db: Database, token: string | undefined, now: Date = new Date()): Promise<SandboxRow | null> {
  if (!token || token.length > 200) return null;
  const [row] = await db.select().from(demoSandboxes).where(eq(demoSandboxes.tokenHash, hashDemoToken(token)));
  if (!row || !row.profileId || now.getTime() - row.createdAt.getTime() > SANDBOX_TTL_HOURS * 3_600_000) return null;
  return row;
}

/** Signs in as one persona through Better Auth's normal sign-in; returns its Set-Cookie headers. */
export async function signInAs(auth: Auth, secret: string, sandbox: SandboxRow, persona: DemoPersona): Promise<string[]> {
  const res =
    persona === "elder"
      ? await auth.api.signInUsername({ body: { username: elderUsername(sandbox.id), password: derivePassword(secret, sandbox.id, "swastik") }, asResponse: true })
      : await auth.api.signInEmail({
          body: {
            email: emailFor(sandbox.id, persona === "caregiver" ? "ravi" : "priya"),
            password: derivePassword(secret, sandbox.id, persona === "caregiver" ? "ravi" : "priya"),
          },
          asResponse: true,
        });
  if (!res.ok) throw new Error(`Demo sign-in failed (${res.status})`);
  return res.headers.getSetCookie();
}

export function landingPath(sandbox: SandboxRow, persona: DemoPersona): string {
  if (persona === "elder") return "/elder";
  return persona === "caregiver" ? `/profiles/${sandbox.profileId}/follow-ups` : `/profiles/${sandbox.profileId}`;
}

/** Which persona a signed-in demo user is, or null for real accounts. */
export async function demoPersonaFor(db: Database, userId: string): Promise<DemoPersona | null> {
  const [u] = await db.select({ email: user.email }).from(user).where(eq(user.id, userId));
  if (!isDemoEmail(u?.email)) return null;
  const local = u!.email.split("@")[0]!.split("-")[0];
  return local === "swastik" ? "elder" : local === "ravi" || local === "meera" ? "caregiver" : "family";
}

/** Deletes sandboxes older than the TTL: their profile (cascading its records) and their four accounts. */
export async function purgeExpiredSandboxes(db: Database, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - SANDBOX_TTL_HOURS * 3_600_000);
  const old = await db.select().from(demoSandboxes).where(lt(demoSandboxes.createdAt, cutoff));
  for (const s of old) {
    if (s.profileId) await db.delete(profiles).where(eq(profiles.id, s.profileId));
    await db.delete(user).where(inArray(user.id, [s.adminUserId, s.caregiverUserId, s.otherCaregiverUserId, s.elderUserId]));
    await db.delete(demoSandboxes).where(eq(demoSandboxes.id, s.id));
  }
  return old.length;
}
