import { and, eq, isNull } from "drizzle-orm";
import { Router } from "express";
import { APIError } from "better-auth/api";
import {
  createElderAccountSchema,
  createProfileSchema,
  type MeResponse,
  type ProfileDetail,
  type ProfileSummary,
} from "../../shared/schemas.js";
import type { Auth } from "../auth.js";
import { HttpError, asyncHandler, requireFreshSession, requireMember, requireSession } from "../authz.js";
import type { Database } from "../db/client.js";
import { profileMembers, profiles, session, user } from "../db/schema.js";

/** Elder accounts sign in by username; Better Auth still needs a unique, non-routable email. */
const elderPlaceholderEmail = (profileId: string) => `elder-${profileId}@accounts.relay.invalid`;

async function listMemberships(db: Database, userId: string): Promise<ProfileSummary[]> {
  return db
    .select({
      id: profiles.id,
      fullName: profiles.fullName,
      preferredName: profiles.preferredName,
      timezone: profiles.timezone,
      role: profileMembers.role,
    })
    .from(profileMembers)
    .innerJoin(profiles, eq(profiles.id, profileMembers.profileId))
    .where(eq(profileMembers.userId, userId))
    .orderBy(profiles.createdAt);
}

export function profileRoutes(db: Database, auth: Auth): Router {
  const router = Router();
  const signedIn = requireSession(auth, db);

  router.get(
    "/me",
    signedIn,
    asyncHandler(async (req, res) => {
      const ctx = req.authCtx!;
      const memberships = await listMemberships(db, ctx.userId);
      const isElder = memberships.some((m) => m.role === "elder");
      const body: MeResponse = {
        user: {
          id: ctx.user.id,
          name: ctx.user.name,
          email: isElder ? null : ctx.user.email,
          username: ctx.user.username ?? null,
        },
        memberships,
        isElder,
      };
      res.json(body);
    }),
  );

  router.post(
    "/profiles",
    signedIn,
    asyncHandler(async (req, res) => {
      const ctx = req.authCtx!;
      const memberships = await listMemberships(db, ctx.userId);
      if (memberships.some((m) => m.role === "elder")) {
        throw new HttpError(403, "FORBIDDEN", "Elder accounts cannot create profiles.");
      }
      const input = createProfileSchema.parse(req.body);

      const created = await db.transaction(async (tx) => {
        const [profile] = await tx
          .insert(profiles)
          .values({ ...input, consentRecordedBy: ctx.userId, createdBy: ctx.userId })
          .returning();
        await tx.insert(profileMembers).values({ profileId: profile!.id, userId: ctx.userId, role: "admin" });
        return profile!;
      });

      const body: ProfileSummary = {
        id: created.id,
        fullName: created.fullName,
        preferredName: created.preferredName,
        timezone: created.timezone,
        role: "admin",
      };
      res.status(201).json(body);
    }),
  );

  router.get(
    "/profiles",
    signedIn,
    asyncHandler(async (req, res) => {
      res.json(await listMemberships(db, req.authCtx!.userId));
    }),
  );

  router.get(
    "/profiles/:profileId",
    signedIn,
    requireMember(db, ["admin", "caregiver"]),
    asyncHandler(async (req, res) => {
      const { profileId, role } = req.membership!;
      const [profile] = await db.select().from(profiles).where(eq(profiles.id, profileId)).limit(1);
      if (!profile) throw new HttpError(404, "NOT_FOUND", "Profile not found.");

      const members = await db
        .select({ userId: profileMembers.userId, name: user.name, role: profileMembers.role, username: user.username })
        .from(profileMembers)
        .innerJoin(user, eq(user.id, profileMembers.userId))
        .where(eq(profileMembers.profileId, profileId))
        .orderBy(profileMembers.createdAt);
      const [recorder] = await db.select({ name: user.name }).from(user).where(eq(user.id, profile.consentRecordedBy));

      const body: ProfileDetail = {
        id: profile.id,
        fullName: profile.fullName,
        preferredName: profile.preferredName,
        timezone: profile.timezone,
        role,
        consent: {
          basis: profile.consentBasis,
          statement: profile.consentStatement,
          recordedBy: recorder?.name ?? "Unknown",
          recordedAt: profile.consentRecordedAt.toISOString(),
        },
        hasElderAccount: profile.elderUserId !== null,
        elderUsername: members.find((m) => m.role === "elder")?.username ?? null,
        members: members.map(({ userId, name, role: r }) => ({ userId, name, role: r })),
      };
      res.json(body);
    }),
  );

  router.post(
    "/profiles/:profileId/elder-account",
    signedIn,
    requireMember(db, ["admin"]),
    requireFreshSession,
    asyncHandler(async (req, res) => {
      const { profileId } = req.membership!;
      const input = createElderAccountSchema.parse(req.body);

      const [profile] = await db.select().from(profiles).where(eq(profiles.id, profileId)).limit(1);
      if (!profile) throw new HttpError(404, "NOT_FOUND", "Profile not found.");
      if (profile.elderUserId) throw new HttpError(409, "ELDER_ACCOUNT_EXISTS", "This profile already has an elder account.");

      // Create the account through Better Auth's supported sign-up (hashing, validation, username checks).
      let elderUserId: string;
      try {
        const result = await auth.api.signUpEmail({
          body: {
            name: profile.preferredName,
            email: elderPlaceholderEmail(profileId),
            password: input.passcode,
            username: input.username,
          },
        });
        elderUserId = result.user.id;
      } catch (err) {
        if (err instanceof APIError) {
          throw new HttpError(err.statusCode === 422 || err.statusCode === 400 ? 409 : 400, "ELDER_ACCOUNT_REJECTED", err.message);
        }
        throw err;
      }

      try {
        await db.transaction(async (tx) => {
          const updated = await tx
            .update(profiles)
            .set({ elderUserId, updatedAt: new Date() })
            .where(and(eq(profiles.id, profileId), isNull(profiles.elderUserId)))
            .returning({ id: profiles.id });
          if (updated.length === 0) throw new HttpError(409, "ELDER_ACCOUNT_EXISTS", "This profile already has an elder account.");
          await tx.insert(profileMembers).values({ profileId, userId: elderUserId, role: "elder" });
        });
      } catch (err) {
        await db.delete(user).where(eq(user.id, elderUserId)); // roll back the orphaned account
        throw err;
      }

      // Sign-up auto-creates a session; the admin's request must not hold it. The elder signs in on their own device.
      await db.delete(session).where(eq(session.userId, elderUserId));

      res.status(201).json({ username: input.username });
    }),
  );

  router.post(
    "/profiles/:profileId/elder-account/revoke-sessions",
    signedIn,
    requireMember(db, ["admin"]),
    requireFreshSession,
    asyncHandler(async (req, res) => {
      const [profile] = await db
        .select({ elderUserId: profiles.elderUserId })
        .from(profiles)
        .where(eq(profiles.id, req.membership!.profileId));
      if (!profile?.elderUserId) throw new HttpError(404, "NOT_FOUND", "No elder account on this profile.");
      const revoked = await db.delete(session).where(eq(session.userId, profile.elderUserId)).returning({ id: session.id });
      res.json({ revoked: revoked.length });
    }),
  );

  router.get(
    "/elder/home",
    signedIn,
    asyncHandler(async (req, res) => {
      const [row] = await db
        .select({ preferredName: profiles.preferredName, timezone: profiles.timezone, profileId: profiles.id })
        .from(profileMembers)
        .innerJoin(profiles, eq(profiles.id, profileMembers.profileId))
        .where(and(eq(profileMembers.userId, req.authCtx!.userId), eq(profileMembers.role, "elder")))
        .limit(1);
      if (!row) throw new HttpError(403, "FORBIDDEN", "This page is for elder accounts.");
      res.json(row);
    }),
  );

  return router;
}
