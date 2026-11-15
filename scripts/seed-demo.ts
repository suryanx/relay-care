/**
 * Opt-in, re-runnable demo care circle (synthetic data only).
 *
 *   DEMO_SEED=enabled DEMO_PASSWORD='<at least 10 chars>' npm run seed:demo
 *
 * - Refuses to run unless DEMO_SEED=enabled. Refuses in production unless ALLOW_PRODUCTION_DEMO_SEED=true.
 * - No credentials live in source: every demo account uses DEMO_PASSWORD from the environment.
 * - Re-running resets the demo profile's care data to the same shape (users are reused).
 * - With local PGlite, stop `npm run dev` first (PGlite allows one process at a time).
 */
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { DateTime } from "luxon";
import { createAuth } from "../src/server/auth.js";
import { loadEnv } from "../src/server/config.js";
import { openDatabase, type Database } from "../src/server/db/client.js";
import { appointments, helpRequests, medications, profileMembers, profiles, session, user } from "../src/server/db/schema.js";
import { markOverdueUnconfirmed } from "../src/server/services/adherence.js";
import { syncIncidents } from "../src/server/services/incidents.js";
import { generateDosesForProfile } from "../src/server/services/schedule.js";

const DEMO = {
  zone: "Asia/Kolkata",
  profileName: "Swastik Demo (seed)",
  admin: { name: "Priya (demo admin)", email: "admin.demo@relay.test" },
  caregivers: [
    { name: "Ravi (demo caregiver)", email: "ravi.demo@relay.test" },
    { name: "Meera (demo caregiver)", email: "meera.demo@relay.test" },
  ],
  elder: { name: "Swastik", username: "swastik.seed" },
};

function fail(msg: string): never {
  console.error(`[seed] ${msg}`);
  process.exit(1);
}

const env = loadEnv();
if (process.env.DEMO_SEED !== "enabled") fail("Disabled. Set DEMO_SEED=enabled to run the demo seed.");
if (env.NODE_ENV === "production" && process.env.ALLOW_PRODUCTION_DEMO_SEED !== "true") fail("Refusing to seed demo data in production.");
const password = process.env.DEMO_PASSWORD ?? "";
if (password.length < 10) fail("Set DEMO_PASSWORD (at least 10 characters) in your shell. It is never stored in source.");

const handle = await openDatabase(
  env.DATABASE_URL ? { kind: "postgres", url: env.DATABASE_URL } : { kind: "pglite", dataDir: process.env.PGLITE_DIR ?? ".data/pglite" },
);
const db: Database = handle.db;
const auth = createAuth({ db, baseURL: env.BETTER_AUTH_URL, secret: env.BETTER_AUTH_SECRET ?? randomBytes(32).toString("base64url") });

/** Creates the account through Better Auth (proper hashing) unless it already exists. */
async function ensureUser(name: string, email: string, username?: string): Promise<string> {
  const [existing] = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
  if (existing) return existing.id;
  const res = await auth.api.signUpEmail({ body: { name, email, password, ...(username ? { username } : {}) } });
  await db.delete(session).where(eq(session.userId, res.user.id)); // seeding must not leave live sessions
  return res.user.id;
}

try {
  const now = new Date();
  const local = DateTime.fromJSDate(now, { zone: DEMO.zone });

  const adminId = await ensureUser(DEMO.admin.name, DEMO.admin.email);
  const careIds = [];
  for (const c of DEMO.caregivers) careIds.push(await ensureUser(c.name, c.email));

  // Reset: remove the previous demo profile (cascades to its care data).
  await db.delete(profiles).where(and(eq(profiles.createdBy, adminId), eq(profiles.fullName, DEMO.profileName)));

  const [profile] = await db
    .insert(profiles)
    .values({
      fullName: DEMO.profileName,
      preferredName: "Swastik",
      timezone: DEMO.zone,
      consentBasis: "elder_consented",
      consentStatement: "Synthetic demo record: Swastik agreed to share his care schedule with this care team.",
      consentRecordedBy: adminId,
      createdBy: adminId,
    })
    .returning();
  const profileId = profile!.id;

  // The elder account is created once and re-linked on every run.
  const elderEmail = `elder-seed@accounts.relay.invalid`;
  const elderId = await ensureUser(DEMO.elder.name, elderEmail, DEMO.elder.username);
  await db.update(profiles).set({ elderUserId: elderId }).where(eq(profiles.id, profileId));
  await db.insert(profileMembers).values([
    { profileId, userId: adminId, role: "admin" },
    ...careIds.map((userId) => ({ profileId, userId, role: "caregiver" as const })),
    { profileId, userId: elderId, role: "elder" },
  ]);

  const yesterday = local.minus({ days: 1 }).toISODate()!;
  // Upcoming medicine (~45 min from now) and one that is already 2 h overdue → Unconfirmed.
  await db.insert(medications).values([
    {
      profileId,
      name: "Demo Amlodipine",
      strength: "5 mg",
      instructions: "One tablet (synthetic demo)",
      times: [local.plus({ minutes: 45 }).toFormat("HH:mm")],
      startDate: yesterday,
      scheduleEffectiveFrom: now,
      createdBy: adminId,
      updatedBy: adminId,
    },
    {
      profileId,
      name: "Demo Metformin",
      strength: "500 mg",
      instructions: "One tablet with a meal (synthetic demo)",
      times: [local.minus({ hours: 2 }).toFormat("HH:mm")],
      startDate: yesterday,
      scheduleEffectiveFrom: new Date(now.getTime() - 3 * 3_600_000),
      createdBy: adminId,
      updatedBy: adminId,
    },
  ]);
  await generateDosesForProfile(db, profileId, now);
  await markOverdueUnconfirmed(db, now, profileId);

  const appt = local.plus({ days: 3 }).set({ hour: 10, minute: 30, second: 0, millisecond: 0 });
  await db.insert(appointments).values({
    profileId,
    doctorName: "Dr. Demo Rao",
    specialty: "Cardiology",
    startsAt: appt.toJSDate(),
    location: "Synthetic Heart Clinic",
    createdBy: adminId,
    updatedBy: adminId,
  });
  await db.insert(helpRequests).values({ profileId, requestedBy: elderId, note: "Synthetic demo: I feel a little dizzy" });
  const { created } = await syncIncidents(db, now, profileId);

  console.info(`[seed] Demo care circle ready (profile ${profileId}).`);
  console.info(`[seed] Admin: ${DEMO.admin.email} · Caregivers: ${DEMO.caregivers.map((c) => c.email).join(", ")} · Elder username: ${DEMO.elder.username}`);
  console.info(`[seed] ${created} follow-up(s) open. All accounts use DEMO_PASSWORD (not printed).`);
} finally {
  await handle.close();
}
